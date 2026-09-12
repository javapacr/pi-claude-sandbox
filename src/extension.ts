import { createSandboxManager } from "@carderne/sandbox-runtime";
import { type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  isBashToolResult,
  isToolCallEventType,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

import {
  addDomainToConfig,
  addReadPathToConfig,
  addWritePathToConfig,
  getConfigPaths,
  loadConfig,
} from "./config.ts";
import {
  handleBlockedWrite,
  wireHookMode,
  type MutateStep,
  type WriteGrantContext,
} from "./hook-mode.ts";
import {
  canonicalizePath,
  domainIsAllowed,
  extractBlockedWritePath,
  extractDomainsFromCommand,
  matchesPattern,
  resolveWritePermission,
} from "./policy.ts";
import {
  armKeepAlive,
  createSandboxedBashOps,
  initializeSandbox,
  releaseKeepAlive,
  releaseKeepAliveWithGrace,
  stampOriginalCommand,
  updateSandboxConfig,
  resolveAllowances,
  type SessionAllowances,
  supportsNodeEnvProxy,
  withTimeout,
} from "./sandbox-runtime.ts";
import {
  formatSandboxConfiguration,
  formatSandboxStatus,
  type PermissionPromptResult,
  promptDomainBlock,
  promptReadBlock,
  showPermissionPrompt,
  promptWriteBlock,
  tildify,
  warnIfAllDomainsAllowed,
} from "./ui.ts";

export default function (pi: ExtensionAPI) {
  const sandboxManager = createSandboxManager();
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  const localCwd = process.cwd();
  const userShellPath = SettingsManager.create(localCwd).getShellPath();
  const localBash = createBashToolDefinition(localCwd, { shellPath: userShellPath });

  // D10 hook mode: when another extension registers a bash tool (e.g.
  // pi-patty-bg-tasks), skip registering ours (two bash registrants make pi
  // exit at load) and instead wrap the shared bash command in place.
  const hookMode = loadConfig(localCwd).compat?.registerBashTool === false;

  let sandboxEnabled = false;
  let sandboxInitialized = false;
  const allowances: SessionAllowances = { domains: [], readPaths: [], writePaths: [] };
  // Stashed in the bash tool_call handler before any wrap mutation, so the
  // bash write-block auto-retry can re-execute the user's original command
  // exactly once per tool call with the newly granted policy.
  const originalCommandsByToolCallId = new Map<string, string>();
  const autoRetriedToolCallIds = new Set<string>();
  let turnEndKeepAliveRegistered = false;
  // Set when hook mode is active (config.compat.registerBashTool === false).
  // The main bash tool_call handler calls this at the END of its bash branch,
  // giving a single-handler guarantee that stamping runs before the wrap
  // mutation (see wireHookMode in hook-mode.ts).
  let mutateStep: MutateStep | undefined;

  const effectiveAllowances = (cwd: string) => resolveAllowances(loadConfig(cwd), allowances);
  const effectiveDomains = (cwd: string) => effectiveAllowances(cwd).domains;
  const effectiveReadPaths = (cwd: string) => effectiveAllowances(cwd).readPaths;
  const effectiveWritePaths = (cwd: string) => effectiveAllowances(cwd).writePaths;

  async function refreshSandbox(cwd: string): Promise<void> {
    if (!sandboxInitialized) return;
    try {
      updateSandboxConfig(sandboxManager, loadConfig(cwd), allowances);
    } catch (error) {
      console.error(`Warning: Failed to update sandbox configuration: ${error}`);
    }
  }

  async function applyChoice(
    choice: Exclude<PermissionPromptResult["action"], "abort">,
    kind: "domain" | "read" | "write",
    value: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    const target = choice === "project" ? projectPath : globalPath;

    if (kind === "domain") {
      if (!allowances.domains.includes(value)) allowances.domains.push(value);
      if (choice !== "session") addDomainToConfig(target, value);
    } else if (kind === "read") {
      if (!allowances.readPaths.includes(value)) allowances.readPaths.push(value);
      if (choice !== "session") addReadPathToConfig(target, value);
    } else {
      if (!allowances.writePaths.includes(value)) allowances.writePaths.push(value);
      if (choice !== "session") addWritePathToConfig(target, value);
    }
    await refreshSandbox(cwd);
  }

  function updateStatus(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    config: ReturnType<typeof loadConfig>,
  ) {
    ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("accent", formatSandboxStatus(config)));
  }

  async function enableSandbox(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
    setProxyEnvironment: boolean,
  ): Promise<boolean> {
    if (sandboxEnabled) {
      ctx.ui.notify("Sandbox is already enabled", "info");
      return false;
    }

    const config = loadConfig(ctx.cwd);
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
      return false;
    }

    try {
      await withTimeout(
        initializeSandbox(sandboxManager, config, allowances),
        10_000,
        "Sandbox initialize",
      );
      if (setProxyEnvironment && supportsNodeEnvProxy(process.versions.node)) {
        process.env.NODE_USE_ENV_PROXY ??= "1";
      }
      sandboxEnabled = true;
      sandboxInitialized = true;
      armKeepAlive(); // I-1: keep the host event loop warm so the manager stays valid
      warnIfAllDomainsAllowed(ctx, config);
      updateStatus(ctx, config);
      return true;
    } catch (error) {
      sandboxEnabled = false;
      ctx.ui.notify(
        `Sandbox initialization failed: ${error instanceof Error ? error.message : error}`,
        "error",
      );
      return false;
    }
  }

  async function disableSandbox(
    ctx: Parameters<typeof warnIfAllDomainsAllowed>[0],
  ): Promise<boolean> {
    if (!sandboxEnabled) {
      ctx.ui.notify("Sandbox is already disabled", "info");
      return false;
    }

    if (sandboxInitialized) {
      releaseKeepAlive(); // I-1: hard release on disable
      try {
        await withTimeout(sandboxManager.reset(), 10_000, "Sandbox reset").catch(() => {});
      } catch {
        // Ignore cleanup errors.
      }
    }
    sandboxEnabled = false;
    sandboxInitialized = false;
    ctx.ui.setStatus("sandbox", "");
    return true;
  }

  async function toggleSandbox(ctx: Parameters<typeof warnIfAllDomainsAllowed>[0]): Promise<void> {
    if (sandboxEnabled) {
      if (await disableSandbox(ctx)) ctx.ui.notify("Sandbox disabled", "info");
      return;
    }
    if (await enableSandbox(ctx, false)) ctx.ui.notify("Sandbox enabled", "info");
  }

  const grantContext: WriteGrantContext = {
    pi,
    manager: sandboxManager,
    loadConfig,
    getConfigPaths,
    effectiveWritePaths,
    applyWriteChoice: (choice, value, cwd) => applyChoice(choice, "write", value, cwd),
    refreshSandbox,
    originalCommands: originalCommandsByToolCallId,
    autoRetried: autoRetriedToolCallIds,
  };

  if (hookMode) {
    const wired = wireHookMode(pi, {
      manager: sandboxManager,
      getConfig: loadConfig,
      isEnabled: () => sandboxEnabled && sandboxInitialized,
      grant: grantContext,
    });
    mutateStep = wired.mutateStep;
  } else {
    pi.registerTool({
      ...localBash,
      label: "bash (sandboxed)",
      async execute(id, params, signal, onUpdate, ctx) {
        const runBash = () => {
          if (!sandboxEnabled || !sandboxInitialized) {
            return localBash.execute(id, params, signal, onUpdate, ctx);
          }
          return createBashToolDefinition(localCwd, {
            operations: createSandboxedBashOps(
              sandboxManager,
              userShellPath,
              loadConfig(ctx.cwd).network?.sshProxy !== false,
            ),
            shellPath: userShellPath,
          }).execute(id, params, signal, onUpdate, ctx);
        };

        let result: AgentToolResult<any>;
        try {
          result = await runBash();
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("Operation not permitted")) {
            throw error;
          }
          result = {
            content: [
              {
                type: "text",
                text: `Error: Command failed with OS-level sandbox restriction: ${error.message}`,
              },
            ],
            details: {},
          };
        }

        if (sandboxEnabled && sandboxInitialized && ctx?.hasUI) {
          const output = result.content
            .filter((content: any) => content.type === "text")
            .map((content: any) => content.text)
            .join("\n");
          // Shared grant flow (also used by hook mode) — detect the blocked path,
          // pre-check denyWrite, prompt, apply the grant, and auto-retry once.
          const outcome = await handleBlockedWrite(grantContext, ctx, output, id);

          if (outcome.kind === "pass-through") {
            return result;
          }
          if (outcome.kind === "result") {
            return outcome.result;
          }
          if (outcome.kind === "allow") {
            return runBash();
          }
          // granted-fallback: grant took effect but the auto-retry still hit a
          // block. Re-run via the agent bash tool so the LLM can grant the next
          // blocked path.
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `\n--- Write access granted for "${outcome.blockedPath}", retrying ---\n`,
              },
            ],
            details: {},
          });
          return runBash();
        }
        return result;
      },
    });
  }

  pi.on("user_bash", async (event, ctx) => {
    if (!sandboxEnabled || !sandboxInitialized) return;

    const config = loadConfig(ctx.cwd);
    if (config.sandboxUserShell === false) return;
    for (const domain of extractDomainsFromCommand(event.command)) {
      if (!domainIsAllowed(domain, effectiveDomains(ctx.cwd))) {
        const choice = await promptDomainBlock(
          pi,
          ctx,
          domain,
          config.permissionPromptTimeoutSeconds,
        );
        if (choice.action === "abort") {
          return {
            result: {
              output: `Blocked: "${domain}" is not in allowedDomains. Use /sandbox to review your config.`,
              exitCode: 1,
              cancelled: false,
              truncated: false,
            },
          };
        }
        await applyChoice(choice.action, "domain", choice.value, ctx.cwd);
      }
    }
    return {
      operations: createSandboxedBashOps(
        sandboxManager,
        userShellPath,
        loadConfig(ctx.cwd).network?.sshProxy !== false,
      ),
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!sandboxEnabled) return;
    const config = loadConfig(ctx.cwd);
    if (!config.enabled) return;
    const { projectPath, globalPath } = getConfigPaths(ctx.cwd);

    if (sandboxInitialized && isToolCallEventType("bash", event)) {
      // D7 stamp + stash: before any wrap mutation, record the user's original
      // command. The downstream pi-permissions canonicalizer (dormant, contract
      // retained) prefers the stamp so rules evaluate the user's command, never
      // the wrap plumbing whose inlined seatbelt profile embeds protected paths.
      const originalCommand = event.input.command;
      stampOriginalCommand(event.input, originalCommand);
      originalCommandsByToolCallId.set(event.toolCallId, originalCommand);
      armKeepAlive(); // I-1: re-arm on user bash activity

      for (const domain of extractDomainsFromCommand(event.input.command)) {
        if (!domainIsAllowed(domain, effectiveDomains(ctx.cwd))) {
          const choice = await promptDomainBlock(
            pi,
            ctx,
            domain,
            config.permissionPromptTimeoutSeconds,
          );
          if (choice.action === "abort") {
            return {
              block: true,
              reason: `Network access to "${domain}" is blocked (not in allowedDomains).`,
            };
          }
          await applyChoice(choice.action, "domain", choice.value, ctx.cwd);
        }
      }

      // D10 hook mode: if active, wrap the command AFTER the stamp/stash/domain
      // checks so stamping stays first within this one handler (single-handler
      // design — see wireHookMode). No-op in upstream (registered-tool) mode.
      await mutateStep?.(event, ctx);
    }

    if (isToolCallEventType("read", event)) {
      const path = canonicalizePath(event.input.path);
      if (!matchesPattern(path, effectiveReadPaths(ctx.cwd))) {
        const choice = await promptReadBlock(pi, ctx, path, config.permissionPromptTimeoutSeconds);
        if (choice.action === "abort") {
          return { block: true, reason: `Sandbox: read access denied for "${path}"` };
        }
        await applyChoice(choice.action, "read", choice.value, ctx.cwd);
        return;
      }
    }

    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const path = canonicalizePath((event.input as { path: string }).path);
      const writePermission = await resolveWritePermission({
        path,
        allowWrite: effectiveWritePaths(ctx.cwd),
        denyWrite: config.filesystem?.denyWrite ?? [],
        prompt: (path) => promptWriteBlock(pi, ctx, path, config.permissionPromptTimeoutSeconds),
        saveWritePermission: (choice, value) => applyChoice(choice, "write", value, ctx.cwd),
      });
      if (writePermission.action === "deny") {
        return {
          block: true,
          reason:
            `Sandbox: write access denied for "${path}" (in denyWrite). ` +
            `To change this, edit denyWrite in:\n  ${tildify(projectPath)}\n  ${tildify(globalPath)}`,
        };
      }
      if (writePermission.action === "abort") {
        return {
          block: true,
          reason: `Sandbox: write access denied for "${path}" (not in allowWrite)`,
        };
      }
      if (writePermission.action === "granted") {
        return;
      }
    }
  });

  pi.on("tool_result", async (event) => {
    if (!sandboxEnabled || !sandboxInitialized) return;
    if (!isBashToolResult(event)) return;
    const output = event.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    // No block detected — release the stash so we don't leak memory.
    if (extractBlockedWritePath(output) === null) {
      originalCommandsByToolCallId.delete(event.toolCallId);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    if (pi.getFlag("no-sandbox") as boolean) {
      sandboxEnabled = false;
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }
    if (!loadConfig(ctx.cwd).enabled) {
      sandboxEnabled = false;
      ctx.ui.notify("Sandbox disabled via config", "info");
      return;
    }
    await enableSandbox(ctx, true);
  });

  // I-1: graceful release between turns so concurrent host activity isn't
  // cut short, hard release at shutdown. Guard against double-registration.
  if (!turnEndKeepAliveRegistered) {
    turnEndKeepAliveRegistered = true;
    pi.on("turn_end", async () => {
      releaseKeepAliveWithGrace();
    });
  }

  pi.on("session_shutdown", async () => {
    releaseKeepAlive(); // I-1: hard release at shutdown
    if (!sandboxInitialized) return;
    try {
      await withTimeout(sandboxManager.reset(), 10_000, "Sandbox reset").catch(() => {});
    } catch {
      // Ignore cleanup errors.
    }
  });

  pi.registerShortcut(Key.alt("s"), {
    description: "Toggle sandbox on/off for this session",
    handler: toggleSandbox,
  });

  pi.registerCommand("sandbox-enable", {
    description: "Enable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (await enableSandbox(ctx, false)) ctx.ui.notify("Sandbox enabled", "info");
    },
  });

  pi.registerCommand("sandbox-disable", {
    description: "Disable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (await disableSandbox(ctx)) ctx.ui.notify("Sandbox disabled", "info");
    },
  });

  pi.registerCommand("sandbox-allow", {
    description: "Prompt to allow a domain or read/write access to a file path",
    handler: async (args, ctx) => {
      const [kind, ...targetParts] = args.trim().split(/\s+/);
      const targetArg = targetParts.join(" ");

      if ((kind !== "domain" && kind !== "read" && kind !== "write") || !targetArg) {
        ctx.ui.notify("Usage: /sandbox-allow <domain|read|write> <domain-or-path>", "error");
        return;
      }

      const target = kind === "domain" ? targetArg : canonicalizePath(targetArg);
      const config = loadConfig(ctx.cwd);
      const configKey =
        kind === "domain" ? "allowedDomains" : kind === "read" ? "allowRead" : "allowWrite";
      const choice = await showPermissionPrompt(
        pi,
        ctx,
        `Add ${target} to ${configKey}?`,
        target,
        (value) => {
          if (!value) return "Rule cannot be empty.";
          const matches =
            kind === "domain" ? domainIsAllowed(target, [value]) : matchesPattern(target, [value]);
          return matches ? null : `Rule must match "${target}".`;
        },
        config.permissionPromptTimeoutSeconds,
      );
      if (choice.action === "abort") {
        ctx.ui.notify("Allow cancelled", "info");
        return;
      }

      await applyChoice(choice.action, kind, choice.value, ctx.cwd);
      ctx.ui.notify(`Added ${choice.value} to ${configKey}`, "info");
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox configuration",
    handler: async (_args, ctx) => {
      if (!sandboxEnabled) {
        ctx.ui.notify("Sandbox is disabled", "info");
        return;
      }
      ctx.ui.notify(
        formatSandboxConfiguration(loadConfig(ctx.cwd), getConfigPaths(ctx.cwd), allowances),
        "info",
      );
    },
  });
}
