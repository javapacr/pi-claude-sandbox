import type { ISandboxManager } from "@carderne/sandbox-runtime";

import {
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
  isBashToolResult,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";

import { type SandboxConfig } from "./config.ts";
import {
  canonicalizePath,
  extractBlockedWritePath,
  matchesPattern,
  resolveWritePermission,
} from "./policy.ts";
import {
  buildSshProxyPreamble,
  fixShellQuoteBangEscape,
  retryBashCommand,
} from "./sandbox-runtime.ts";
import { promptWriteBlock, tildify } from "./ui.ts";

/**
 * Hook mode (divergence D10): coexist with extensions that ALSO register a
 * bash tool (e.g. pi-patty-bg-tasks). Two bash registrants make pi exit at
 * load. Instead of registering our own sandboxed bash tool, hook mode
 * intercepts the bash `tool_call` and replaces `event.input.command` with the
 * sandbox-wrapped command, letting whichever bash tool the host registered
 * (patty's or the pi builtin) execute it.
 */

/**
 * The shared blocked-write grant flow, used by BOTH the registered bash tool
 * execute path and hook mode's `tool_result` handler — one implementation.
 * Bundles the runtime closures the flow needs (config loading, allowance
 * application, sandbox refresh, the original-command stash).
 */
export interface WriteGrantContext {
  pi: ExtensionAPI;
  manager: ISandboxManager;
  loadConfig: (cwd: string) => SandboxConfig;
  getConfigPaths: (cwd: string) => { projectPath: string; globalPath: string };
  effectiveWritePaths: (cwd: string) => string[];
  applyWriteChoice: (
    choice: "session" | "project" | "global",
    value: string,
    cwd: string,
  ) => Promise<void>;
  refreshSandbox: (cwd: string) => Promise<void>;
  originalCommands: Map<string, string>;
  autoRetried: Set<string>;
}

export type BlockedWriteOutcome =
  | { kind: "pass-through" }
  | { kind: "result"; result: AgentToolResult<any> }
  | { kind: "allow"; blockedPath: string }
  | { kind: "granted-fallback"; blockedPath: string };

/**
 * After a sandboxed bash run produces "Operation not permitted" output, detect
 * the blocked path, pre-check denyWrite (denyWrite always wins over
 * allowWrite), prompt the user, apply the grant, and attempt a single
 * auto-retry of the ORIGINAL command. Returns a discriminated outcome the
 * caller renders contextually:
 *   - pass-through: user denied / no block — keep the original output.
 *   - result: a replacement tool result (denyWrite hint or a successful
 *     auto-retry output).
 *   - allow: already in allowWrite; grant applied, re-run the command.
 *   - granted-fallback: grant applied but the auto-retry still hit a block.
 */
export async function handleBlockedWrite(
  g: WriteGrantContext,
  ctx: ExtensionContext,
  output: string,
  toolCallId: string,
): Promise<BlockedWriteOutcome> {
  const cwd = ctx.cwd;
  const blockedPathRaw = extractBlockedWritePath(output);
  if (blockedPathRaw === null) {
    // No block detected — release the stash so we don't leak memory.
    g.originalCommands.delete(toolCallId);
    return { kind: "pass-through" };
  }

  const path = canonicalizePath(blockedPathRaw);
  const config = g.loadConfig(cwd);
  const { projectPath, globalPath } = g.getConfigPaths(cwd);

  // denyWrite always wins over allowWrite: granting allowWrite would be
  // misleading because the OS sandbox would still block the write. Surface the
  // conflict before prompting so the user (and LLM) can edit denyWrite by hand
  // or skip the operation.
  if (matchesPattern(path, config.filesystem?.denyWrite ?? [])) {
    ctx.ui.notify(
      `⚠️ "${path}" matches a denyWrite rule. denyWrite always wins over allowWrite — grant cannot help here. Edit denyWrite manually if needed.`,
      "warning",
    );
    let hint = `\n\n[Sandbox] Cannot grant write to "${path}": it matches a denyWrite rule (denyWrite always wins over allowWrite).\n`;
    hint += `To allow this path, manually remove the matching pattern from denyWrite in:\n  ${tildify(projectPath)}\n  ${tildify(globalPath)}\n`;
    hint += `Otherwise, choose a different path or skip this operation.`;
    return {
      kind: "result",
      result: {
        content: [{ type: "text" as const, text: output + hint }],
        details: {},
        isError: true,
      } as AgentToolResult<any>,
    };
  }

  const writePermission = await resolveWritePermission({
    path,
    allowWrite: g.effectiveWritePaths(cwd),
    denyWrite: config.filesystem?.denyWrite ?? [],
    prompt: (promptPath) =>
      promptWriteBlock(g.pi, ctx, promptPath, config.permissionPromptTimeoutSeconds),
    saveWritePermission: (choice, value) => g.applyWriteChoice(choice, value, cwd),
  });
  if (writePermission.action === "deny") {
    return { kind: "pass-through" };
  }
  if (writePermission.action === "allow") {
    await g.refreshSandbox(cwd);
    return { kind: "allow", blockedPath: path };
  }

  // granted — auto-retry the original command once with the new policy. If it
  // still blocks or throws, fall through so the caller can re-run / surface a
  // hint and let the LLM grant the next path.
  const originalCommand = g.originalCommands.get(toolCallId);
  const alreadyRetried = g.autoRetried.has(toolCallId);
  if (originalCommand && !alreadyRetried) {
    g.autoRetried.add(toolCallId);
    try {
      const ctxSignal = (ctx as { signal?: AbortSignal }).signal;
      const retry = await retryBashCommand(g.manager, originalCommand, cwd, ctxSignal);
      // If retry STILL produced a sandbox block, fall through so the caller
      // can surface a hint (the user can keep granting).
      const stillBlocked = extractBlockedWritePath(retry.output) !== null;
      if (!stillBlocked) {
        ctx.ui.notify(
          `✓ Auto-retried "${path}" after grant (exit ${retry.exitCode ?? "?"})`,
          "info",
        );
        return {
          kind: "result",
          result: {
            content: [{ type: "text" as const, text: retry.output }],
            details: {},
            isError: retry.exitCode !== 0,
          } as AgentToolResult<any>,
        };
      }
    } catch (error) {
      ctx.ui.notify(
        `Auto-retry failed: ${error instanceof Error ? error.message : error}. Falling back to LLM retry.`,
        "warning",
      );
    } finally {
      g.originalCommands.delete(toolCallId);
    }
  }
  return { kind: "granted-fallback", blockedPath: path };
}

/**
 * The tool_call wrap step. DESIGN DECISION (single-handler): rather than
 * registering a second `tool_call` listener (whose ordering vs. the main
 * stamp/stash handler would have to be trusted), extension.ts calls this from
 * the END of its EXISTING bash branch. The stamp (stampOriginalCommand) is
 * applied first in that same handler, so stamp-then-mutate is guaranteed
 * within one handler — no reliance on listener ordering.
 *
 * On wrap failure, matches legacy: swallow the error, notify, and leave
 * `event.input.command` as the user's original (runs unsandboxed).
 */
export type MutateStep = (event: ToolCallEvent, ctx: ExtensionContext) => Promise<void>;

/**
 * Wire hook mode: register the `tool_result` grant flow (the executing bash
 * tool is patty's/builtin, so the registered execute path never runs) and
 * return the `mutateStep` for extension.ts to call at the end of its bash
 * `tool_call` branch.
 */
export function wireHookMode(
  pi: ExtensionAPI,
  deps: {
    manager: ISandboxManager;
    getConfig: (cwd: string) => SandboxConfig;
    isEnabled: () => boolean;
    grant: WriteGrantContext;
  },
): { mutateStep: MutateStep } {
  pi.on("tool_result", async (event, ctx) => {
    if (!deps.isEnabled()) return;
    if (!isBashToolResult(event)) return;
    if (!ctx.hasUI) return;

    const output = event.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    const { projectPath, globalPath } = deps.grant.getConfigPaths(ctx.cwd);
    const outcome = await handleBlockedWrite(deps.grant, ctx, output, event.toolCallId);

    if (outcome.kind === "pass-through") {
      return;
    }
    if (outcome.kind === "result") {
      return outcome.result;
    }
    // allow / granted-fallback: the grant is in effect but the command is still
    // blocked. Surface the granted path AND the latest output so the LLM can
    // decide whether to retry, narrow the command, or ask the user.
    return {
      content: [
        {
          type: "text" as const,
          text:
            output +
            `\n\n[Sandbox] Granted write access for "${outcome.blockedPath}", but the auto-retry still hit a block. ` +
            `If the same path is blocked, denyWrite is overriding allowWrite — inspect ${tildify(
              projectPath,
            )} or ${tildify(globalPath)}. ` +
            `Otherwise rerun the command and grant the next blocked path when prompted.`,
        },
      ],
      isError: true,
    };
  });

  const mutateStep: MutateStep = async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    if (!deps.isEnabled()) return;
    const originalCommand = event.input.command;
    if (!originalCommand) return;

    // Re-load config per event — grants can change network/filesystem rules.
    const config = deps.getConfig(ctx.cwd);
    try {
      // Upstream #71: route ssh through the runtime SOCKS proxy on macOS
      // (git needs GIT_SSH_COMMAND — see buildSshProxyPreamble). Prepend
      // BEFORE wrap so the whole string goes through the bang-escape guard
      // once. The domain pre-check in the main tool_call handler already ran
      // on the original command; the preamble adds no network domains.
      const preamble = await buildSshProxyPreamble(
        deps.manager,
        config.network?.sshProxy !== false,
      );
      const wrapped = fixShellQuoteBangEscape(
        await deps.manager.wrapWithSandbox(preamble + originalCommand),
      );
      // mutateStep runs at the END of the main bash tool_call branch, AFTER the
      // stamp+stash — so the stamp is already present and the stash holds the
      // raw original for the grant-flow auto-retry below.
      event.input.command = wrapped;
    } catch (error) {
      // Match legacy error behavior exactly: swallow the wrap failure, notify,
      // and let the command run unsandboxed (event.input.command unchanged).
      ctx.ui.notify(
        `Sandbox wrap failed: ${error instanceof Error ? error.message : error}. Running unsandboxed.`,
        "warning",
      );
    }
  };

  return { mutateStep };
}
