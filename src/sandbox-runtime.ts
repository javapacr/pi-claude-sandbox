import type { ISandboxManager, SandboxRuntimeConfig } from "@carderne/sandbox-runtime";

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { type BashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";

import { type SandboxConfig } from "./config.ts";
import { canonicalizePath } from "./policy.ts";

export interface SessionAllowances {
  domains: string[];
  readPaths: string[];
  writePaths: string[];
}

export interface EffectiveAllowances {
  domains: string[];
  readPaths: string[];
  writePaths: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const canonicalizeFilesystemPattern = (path: string) =>
  path.includes("*") ? path : canonicalizePath(path);

const canonicalizeFilesystemPatterns = (paths: string[]) =>
  unique(paths.map(canonicalizeFilesystemPattern));

function sandboxRuntimeReadPaths(platform: NodeJS.Platform): string[] {
  if (platform !== "linux") return [];

  // apply-seccomp executes inside the Bubblewrap namespace, so broad rules
  // such as denyRead: ["/home"] must not hide the runtime's bundled helper.
  const runtimeEntryUrl = import.meta.resolve("@carderne/sandbox-runtime");
  return [fileURLToPath(new URL("../vendor/seccomp", runtimeEntryUrl))];
}

export function resolveAllowances(
  config: SandboxConfig,
  allowances?: SessionAllowances,
): EffectiveAllowances {
  const writePaths = unique([
    ...(config.filesystem?.allowWrite ?? []),
    ...(allowances?.writePaths ?? []),
  ]);

  return {
    domains: unique([...(config.network?.allowedDomains ?? []), ...(allowances?.domains ?? [])]),
    readPaths: unique([
      ...(config.filesystem?.allowRead ?? []),
      ...(allowances?.readPaths ?? []),
      ...writePaths,
    ]),
    writePaths,
  };
}

export function buildRuntimeConfig(
  config: SandboxConfig,
  allowances?: SessionAllowances,
  platform: NodeJS.Platform = process.platform,
): SandboxRuntimeConfig {
  const effective = resolveAllowances(config, allowances);

  return {
    network: {
      ...config.network,
      allowedDomains: effective.domains,
      deniedDomains: config.network?.deniedDomains ?? [],
    },
    filesystem: {
      disabled: config.filesystem?.disabled,
      denyRead: canonicalizeFilesystemPatterns(config.filesystem?.denyRead ?? []),
      allowRead: canonicalizeFilesystemPatterns([
        ...effective.readPaths,
        ...sandboxRuntimeReadPaths(platform),
      ]),
      allowWrite: canonicalizeFilesystemPatterns(effective.writePaths),
      denyWrite: canonicalizeFilesystemPatterns(config.filesystem?.denyWrite ?? []),
    },
    ignoreViolations: config.ignoreViolations,
    enableWeakerNestedSandbox: config.enableWeakerNestedSandbox,
    allowBrowserProcess: config.allowBrowserProcess,
    allowPty: config.allowPty,
    enableWeakerNetworkIsolation: true,
  };
}

export async function initializeSandbox(
  manager: ISandboxManager,
  config: SandboxConfig,
  allowances?: SessionAllowances,
): Promise<void> {
  const runtimeConfig = buildRuntimeConfig(config, allowances);
  // The runtime checks its live allowlist. Permission prompts happen before
  // execution; a callback capturing this initial list could re-allow removed domains.
  await manager.initialize(runtimeConfig);
}

export function updateSandboxConfig(
  manager: ISandboxManager,
  config: SandboxConfig,
  allowances: SessionAllowances,
): void {
  // Permission updates must not tear down the proxy used by concurrent commands.
  // Network rules apply immediately; new commands pick up filesystem rules when wrapped.
  manager.updateConfig(buildRuntimeConfig(config, allowances));
}

export function supportsNodeEnvProxy(version: string): boolean {
  const [major, minor] = version.split(".").map(Number);
  return (major === 22 && minor >= 21) || major >= 24;
}

export function extractBlockedWritePath(output: string): string | null {
  const match = output.match(
    /(?:\/bin\/bash|bash|sh): (?:line \d: )?(\/[^\s:]+): Operation not permitted/,
  );
  return match ? match[1] : null;
}

/**
 * Probe a TCP port for a SOCKS5 no-auth handshake: connect, send the greeting
 * (5, 1, 0), and expect a (5, 0) selection reply. Resolves false on any
 * refusal, timeout, or handshake mismatch. Used to skip proxy injection while
 * the sandbox proxy port is mid-reinit (accepts TCP but closes the handshake).
 */
export function isSocksProxyReady(port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => socket.write(Uint8Array.of(5, 1, 0)));
    socket.once("data", (d: Buffer) => done(d.length >= 2 && d[0] === 5 && d[1] === 0));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
    socket.connect(port, "localhost");
  });
}

/**
 * Undo `\!` → `!` ONLY inside double-quoted spans of the wrapped command.
 * Bare-word `\!` outside quotes is valid shell and left alone.
 *
 * shell-quote's double-quote heuristic escapes `!` as `\!` (an interactive-
 * shell-ism) which corrupts non-interactive `bash -c` commands; this reverses
 * that only where the shell would not treat `\` before `!` literally.
 */
export function fixShellQuoteBangEscape(s: string): string {
  return s.replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/\\!/g, "!"));
}

/**
 * Upstream #71 (technique port): on macOS, OpenSSH ignores ALL_PROXY, so ssh
 * (and git's exec'd ssh binary) bypass the sandbox's network proxy and die
 * with EPERM. When the runtime SOCKS proxy is running, return a shell preamble
 * that (a) defines an ssh() function wrapping /usr/bin/ssh with a ProxyCommand
 * through the local SOCKS proxy, and (b) exports GIT_SSH_COMMAND with the same
 * option — the env var is what reaches `git push/pull`, since git execs the
 * ssh BINARY and never sees shell functions. nc -X 5 is macOS/BSD nc (SOCKS v5).
 * Returns "" when disabled, off-darwin, or the proxy port is unavailable
 * (ssh then fails inside the sandbox as before — acceptable fallback).
 *
 * Async: verifies the proxy port actually serves a SOCKS5 no-auth handshake
 * (\x05\x00) before injecting; a port that accepts TCP but closes the
 * handshake (reinit window) yields "" so ssh behaves exactly as pre-port.
 * Contains no "!" so it passes through fixShellQuoteBangEscape untouched.
 */
export async function buildSshProxyPreamble(
  manager: ISandboxManager,
  sshProxyEnabled: boolean,
): Promise<string> {
  if (!sshProxyEnabled || process.platform !== "darwin") return "";
  const socksProxyPort = manager.getSocksProxyPort();
  if (socksProxyPort === undefined) return "";
  const proxyOpt = `-o 'ProxyCommand=/usr/bin/nc -X 5 -x localhost:${socksProxyPort} %h %p'`;
  const ready = await isSocksProxyReady(socksProxyPort);
  if (!ready) return "";
  return `ssh() { /usr/bin/ssh ${proxyOpt} "$@"; }; export GIT_SSH_COMMAND="/usr/bin/ssh ${proxyOpt}"; `;
}

/**
 * Cross-extension contract (consumed by pi-permissions, sibling repo in this
 * monorepo — same Symbol.for string, deliberately not an import): before the
 * sandbox overwrites `event.input.command` with the wrap text, it stamps the
 * user's ORIGINAL command under this key. The permission engine's
 * canonicalizer prefers the stamp so rules + the safety floor always evaluate
 * the user's command, never the wrap plumbing (whose inlined seatbelt profile
 * embeds protected paths like /Users/reevonr/.ssh on EVERY wrapped call).
 * Symbol.for (not Symbol) so the key resolves across jiti's per-extension
 * module instances; stamped non-enumerable so session persistence/JSONL never
 * records it.
 */
export const ORIGINAL_COMMAND_SYMBOL: symbol = Symbol.for("pi-claude-sandbox.original-command");

/**
 * Stamp `originalCommand` on `input` under ORIGINAL_COMMAND_SYMBOL.
 * Stamp-then-mutate order is load-bearing: a concurrent reader of the input
 * must never observe the mutated command without the stamp present.
 */
export function stampOriginalCommand(input: Record<string, unknown>, originalCommand: string): void {
  Object.defineProperty(input, ORIGINAL_COMMAND_SYMBOL, {
    value: originalCommand,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

// I-1: keeps the host event loop warm so the sandbox manager stays valid
// between tool calls; 60-min idle cap as a hard failsafe.
const KEEP_ALIVE_TICK_MS = 30_000;
const KEEP_ALIVE_GRACE_MS = 250;
const KEEP_ALIVE_IDLE_CAP_MS = 60 * 60 * 1000;
let keepAliveTimer: NodeJS.Timeout | null = null;
let keepAliveCapTimer: NodeJS.Timeout | null = null;
let keepAliveGraceTimer: NodeJS.Timeout | null = null;
export function isKeepAliveActive(): boolean {
  return keepAliveTimer !== null;
}
export function armKeepAlive(): void {
  if (keepAliveGraceTimer) {
    clearTimeout(keepAliveGraceTimer);
    keepAliveGraceTimer = null;
  }
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {}, KEEP_ALIVE_TICK_MS);
  keepAliveCapTimer = setTimeout(() => releaseKeepAlive(), KEEP_ALIVE_IDLE_CAP_MS);
  keepAliveCapTimer.unref?.();
}
export function releaseKeepAlive(): void {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  if (keepAliveCapTimer) {
    clearTimeout(keepAliveCapTimer);
    keepAliveCapTimer = null;
  }
  if (keepAliveGraceTimer) {
    clearTimeout(keepAliveGraceTimer);
    keepAliveGraceTimer = null;
  }
}
export function releaseKeepAliveWithGrace(): void {
  if (!keepAliveTimer) return;
  if (keepAliveGraceTimer) clearTimeout(keepAliveGraceTimer);
  keepAliveGraceTimer = setTimeout(() => {
    keepAliveGraceTimer = null;
    releaseKeepAlive();
  }, KEEP_ALIVE_GRACE_MS);
  keepAliveGraceTimer.unref?.();
}

/**
 * Race a promise against a wall-clock timeout. Rejects with a labeled error
 * naming the operation so a wedged long sandbox-manager op fails loudly.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (t) clearTimeout(t);
  }) as Promise<T>;
}

const EXIT_STDIO_GRACE_MS = 100;

/**
 * Wait for a child process to exit without hanging on inherited stdio handles.
 *
 * After exit, keep reading while output is active. If a detached descendant
 * holds the pipes open but leaves them idle, release them after a short grace.
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer) {
        clearTimeout(postExitTimer);
        postExitTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };

    const armIdleTimer = () => {
      if (postExitTimer) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };

    const onData = () => {
      if (exited && !settled) armIdleTimer();
    };

    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };

    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };

    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };

    const onClose = (code: number | null) => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

export function createSandboxedBashOps(
  manager: ISandboxManager,
  shellPath?: string,
  sshProxy = true,
): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

      const { shell, args } = getShellConfig(shellPath);

      // OpenSSH does not honor ALL_PROXY, unlike most of the tools that use
      // the sandbox network proxy. Prepending the runtime's SOCKS proxy
      // preamble routes ordinary `ssh host` (and git's exec'd ssh binary via
      // GIT_SSH_COMMAND) through the local proxy. The probe is deliberately
      // async: while the proxy port is mid-reinit it accepts TCP but closes
      // the SOCKS handshake, so we verify readiness first and fall back to
      // running without a proxy rather than hanging commands. Opt-in at the
      // config layer, but enabled by default.
      const sshProxyCommand = await buildSshProxyPreamble(manager, sshProxy);
      const wrappedCommand = fixShellQuoteBangEscape(
        await manager.wrapWithSandbox(`${sshProxyCommand}${command}`, shell),
      );

      const child = spawn(shell, [...args, wrappedCommand], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const killProcessGroup = () => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };

      if (timeout !== undefined && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          killProcessGroup();
        }, timeout * 1000);
      }

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      signal?.addEventListener("abort", killProcessGroup, { once: true });

      try {
        const exitCode = await waitForChildProcess(child);
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", killProcessGroup);
        manager.cleanupAfterCommand();
      }
    },
  };
}

/**
 * Run a sandbox-wrapped command once and return its captured output, intended
 * as the workhorse for the auto-retry/permission flow. Built on the same
 * primitives as `createSandboxedBashOps.exec` (wrap → spawn detached → kill
 * group on abort → waitForChildProcess teardown), but captures stdout+stderr
 * into a single output string and reports `exitCode` alongside it.
 */
export async function retryBashCommand(
  manager: ISandboxManager,
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ output: string; exitCode: number | null }> {
  if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

  const { shell, args } = getShellConfig();
  const wrappedCommand = fixShellQuoteBangEscape(await manager.wrapWithSandbox(command));

  const child = spawn(shell, [...args, wrappedCommand], {
    cwd,
    env: process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const chunks: Buffer[] = [];
  child.stdout?.on("data", (d: Buffer) => chunks.push(d));
  child.stderr?.on("data", (d: Buffer) => chunks.push(d));

  const killProcessGroup = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };

  signal?.addEventListener("abort", killProcessGroup, { once: true });

  try {
    const exitCode = await waitForChildProcess(child);
    if (signal?.aborted) throw new Error("aborted");
    return { output: Buffer.concat(chunks).toString("utf8"), exitCode };
  } finally {
    signal?.removeEventListener("abort", killProcessGroup);
    manager.cleanupAfterCommand();
  }
}
