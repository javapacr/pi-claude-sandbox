/**
 * Cross-extension contract with pi-permissions (sibling repo): before the
 * sandbox overwrites `event.input.command` with the wrap text, it stamps the
 * user's ORIGINAL command under ORIGINAL_COMMAND_SYMBOL
 * (Symbol.for("pi-claude-sandbox.original-command")). pi-permissions'
 * canonicalizer prefers that stamp so its safety floor evaluates the user's
 * command, never the wrap plumbing — whose inlined seatbelt profile embeds
 * protected paths like /Users/reevonr/.ssh on EVERY wrapped call.
 *
 * P1 regression 2026-09-04: an unstamped mutation let the permission floor
 * race the sandbox handler and false-block every bash command with
 * "references protected path ~/.ssh" (see pi-permissions/tests/sandbox-stamp.test.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ORIGINAL_COMMAND_SYMBOL, stampOriginalCommand } from "../index.ts";

test("stampOriginalCommand: stamps the original, non-enumerable, before mutation", () => {
  const input = { command: "echo probe-ok" };

  stampOriginalCommand(input, "echo probe-ok");

  assert.equal(input[ORIGINAL_COMMAND_SYMBOL], "echo probe-ok");
  const desc = Object.getOwnPropertyDescriptor(input, ORIGINAL_COMMAND_SYMBOL);
  assert.ok(desc, "stamp must exist as an own property");
  assert.equal(desc.enumerable, false, "stamp must be non-enumerable (JSONL/session persistence must not record it)");
  assert.deepEqual(Object.keys(input), ["command"], "enumerable keys unchanged");
  assert.deepEqual(Object.getOwnPropertySymbols(input), [ORIGINAL_COMMAND_SYMBOL]);

  // Simulate the subsequent mutation: the stamp survives with the original.
  input.command = "env … /usr/bin/sandbox-exec -p '(profile with /Users/reevonr/.ssh)' zsh -c 'echo probe-ok'";
  assert.equal(input[ORIGINAL_COMMAND_SYMBOL], "echo probe-ok", "original survives the command overwrite");
});

test("stampOriginalCommand: re-stamping overwrites cleanly (configurable+writable)", () => {
  const input = { command: "git status" };
  stampOriginalCommand(input, "git status");
  stampOriginalCommand(input, "git status --short --branch");
  assert.equal(input[ORIGINAL_COMMAND_SYMBOL], "git status --short --branch");
});

test("ORIGINAL_COMMAND_SYMBOL: resolves to the shared Symbol.for registry key", () => {
  assert.equal(ORIGINAL_COMMAND_SYMBOL, Symbol.for("pi-claude-sandbox.original-command"));
  assert.equal(typeof ORIGINAL_COMMAND_SYMBOL, "symbol");
});
