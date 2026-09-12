/**
 * Tests for retryBashCommand — the sandbox-wrapped single-shot runner used by
 * the auto-retry/permission flow. Uses a fake manager whose wrapWithSandbox
 * returns the command unchanged (identity wrap, no OS sandbox session), then
 * exercises a REAL child process.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";

import type { ISandboxManager } from "@carderne/sandbox-runtime";

import { retryBashCommand } from "../src/sandbox-runtime.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function terminateRecordedProcess(pidPath: string): void {
  try {
    const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "ENOENT" && error.code !== "ESRCH")
    ) {
      throw error;
    }
  }
}

function backgroundNodeCommand(cwd: string, source: string): { command: string; pidPath: string } {
  const pidPath = join(cwd, "background.pid");
  const childSource = [
    `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    source,
  ].join("\n");
  const command = [
    `${shellQuote(process.execPath)} -e ${shellQuote(childSource)} &`,
    `while [ ! -s ${shellQuote(pidPath)} ]; do sleep 0.01; done`,
  ].join(" ");
  return { command, pidPath };
}

function createRetryContext(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-sandbox-retry-"));
  const backgroundPidPaths: string[] = [];

  // Identity wrap — no OS sandbox session, no SSH proxy; a real child runs.
  const manager = {
    wrapWithSandbox: async (command: string) => command,
    cleanupAfterCommand: () => {},
  } as unknown as ISandboxManager;

  t.after(() => {
    try {
      for (const pidPath of backgroundPidPaths) terminateRecordedProcess(pidPath);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  return {
    cwd,
    manager,
    trackBackgroundProcess: (pidPath: string) => backgroundPidPaths.push(pidPath),
  };
}

test("retryBashCommand resolves with output + exitCode even if a daemonized grandchild holds the pipes", async (t) => {
  const { cwd, manager, trackBackgroundProcess } = createRetryContext(t);
  // The background process inherits stdout/stderr indefinitely. retryBashCommand
  // should return after `echo output` completes (post-exit idle grace), not wait
  // for natural pipe EOF.
  const background = backgroundNodeCommand(cwd, "setInterval(() => {}, 1000);");
  trackBackgroundProcess(background.pidPath);
  const command = `${background.command}; echo output; exit 3`;

  const started = Date.now();
  const result = await retryBashCommand(manager, command, cwd);
  const elapsed = Date.now() - started;

  assert.equal(result.exitCode, 3);
  assert.ok(result.output.includes("output"), `missing expected output, got: ${result.output}`);
  assert.ok(elapsed < 2000, `retryBashCommand returned after ${elapsed}ms; expected early teardown`);
});

test("retryBashCommand rejects when the cwd does not exist", async (t) => {
  const { manager } = createRetryContext(t);
  await assert.rejects(
    retryBashCommand(manager, "echo x", join(tmpdir(), "definitely-missing-dir")),
    /Working directory does not exist/,
  );
});
