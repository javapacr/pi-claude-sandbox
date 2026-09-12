import { test } from "node:test";

/**
 * Regression test for the shell-quote bang-escape fix.
 *
 * Tests the fixShellQuoteBangEscape helper that undoes shell-quote's
 * incorrect `\!` escaping inside double-quoted strings (zsh-interactive
 * heuristic that corrupts non-interactive bash -c commands).
 *
 * The fix should:
 * - Replace `\!` with `!` ONLY inside double-quoted spans
 * - Leave bare-word `\!` outside quotes untouched (valid shell)
 * - Handle escaped-quote sequences correctly
 */
import assert from "node:assert/strict";

import { fixShellQuoteBangEscape } from "../src/sandbox-runtime.ts";

test("un-escapes \\! inside double quotes", () => {
  const input = "bash -c \"echo 'x \\!= y'\"";
  assert.equal(fixShellQuoteBangEscape(input), "bash -c \"echo 'x != y'\"");
});

test("un-escapes multiple \\! inside double quotes", () => {
  const input = 'bash -c "if x \\!= y; then echo \\!true; fi"';
  assert.equal(fixShellQuoteBangEscape(input), 'bash -c "if x != y; then echo !true; fi"');
});

test("preserves bare-word \\! outside quotes", () => {
  const input = "echo foo\\!bar";
  assert.equal(fixShellQuoteBangEscape(input), "echo foo\\!bar");
});

test("fixes inside double quotes only, preserves outside", () => {
  const input = 'bash -c "echo \\!= y" and echo z\\!=q';
  assert.equal(fixShellQuoteBangEscape(input), 'bash -c "echo != y" and echo z\\!=q');
});

test("handles escaped double quotes correctly", () => {
  const input = 'bash -c "echo \\"x \\!= y\\""';
  assert.equal(fixShellQuoteBangEscape(input), 'bash -c "echo \\"x != y\\""');
});

test("handles empty string", () => {
  assert.equal(fixShellQuoteBangEscape(""), "");
});

test("leaves single-quoted strings unchanged", () => {
  assert.equal(fixShellQuoteBangEscape("echo 'x != y'"), "echo 'x != y'");
});

test("leaves strings without \\! unchanged", () => {
  assert.equal(fixShellQuoteBangEscape('bash -c "echo hello world"'), 'bash -c "echo hello world"');
});

test("preserves other escape sequences", () => {
  assert.equal(fixShellQuoteBangEscape('bash -c "echo \\$HOME"'), 'bash -c "echo \\$HOME"');
});

test("handles double backslash followed by bang", () => {
  const input = 'bash -c "echo \\\\!"';
  assert.equal(fixShellQuoteBangEscape(input), 'bash -c "echo \\!"');
});
