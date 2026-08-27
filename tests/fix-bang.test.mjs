/**
 * Regression test for shell-quote bang-escape fix
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

import assert from "node:assert";

// Copy of the fix function from index.ts
function fixShellQuoteBangEscape(s) {
  return s.replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/\\!/g, "!"));
}

// Test cases
console.log("Running fixShellQuoteBangEscape tests...\n");

// Test 1: Basic double-quoted bang escape
const input1 = 'bash -c "echo \'x \\!= y\'"';
const output1 = fixShellQuoteBangEscape(input1);
assert.strictEqual(
  output1,
  'bash -c "echo \'x != y\'"',
  "Should un-escape \\! inside double quotes",
);
console.log("✓ Test 1 passed: Basic double-quoted bang escape");

// Test 2: Multiple bang escapes in one string
const input2 = 'bash -c "if x \\!= y; then echo \\!true; fi"';
const output2 = fixShellQuoteBangEscape(input2);
assert.strictEqual(
  output2,
  'bash -c "if x != y; then echo !true; fi"',
  "Should un-escape multiple \\! inside double quotes",
);
console.log("✓ Test 2 passed: Multiple bang escapes");

// Test 3: Bare-word \! outside quotes (should be preserved)
const input3 = "echo foo\\!bar";
const output3 = fixShellQuoteBangEscape(input3);
assert.strictEqual(output3, "echo foo\\!bar", "Should preserve bare \\! outside quotes");
console.log("✓ Test 3 passed: Bare-word \\! preserved");

// Test 4: Mixed quotes
const input4 = 'bash -c "echo \\!= y" and echo z\\!=q';
const output4 = fixShellQuoteBangEscape(input4);
assert.strictEqual(
  output4,
  'bash -c "echo != y" and echo z\\!=q',
  "Should fix inside double quotes only, preserve outside",
);
console.log("✓ Test 4 passed: Mixed quotes");

// Test 5: Escaped double quote followed by bang
const input5 = 'bash -c "echo \\"x \\!= y\\""';
const output5 = fixShellQuoteBangEscape(input5);
assert.strictEqual(
  output5,
  'bash -c "echo \\"x != y\\""',
  "Should handle escaped double quotes correctly",
);
console.log("✓ Test 5 passed: Escaped double quotes");

// Test 6: Empty string
const input6 = "";
const output6 = fixShellQuoteBangEscape(input6);
assert.strictEqual(output6, "", "Should handle empty string");
console.log("✓ Test 6 passed: Empty string");

// Test 7: No double quotes
const input7 = "echo 'x != y'";
const output7 = fixShellQuoteBangEscape(input7);
assert.strictEqual(output7, "echo 'x != y'", "Should leave single-quoted strings unchanged");
console.log("✓ Test 7 passed: No double quotes");

// Test 8: Double quotes without bang
const input8 = 'bash -c "echo hello world"';
const output8 = fixShellQuoteBangEscape(input8);
assert.strictEqual(output8, 'bash -c "echo hello world"', "Should leave strings without \\! unchanged");
console.log("✓ Test 8 passed: No bang in string");

// Test 9: Backslash followed by non-bang inside double quotes
const input9 = 'bash -c "echo \\$HOME"';
const output9 = fixShellQuoteBangEscape(input9);
assert.strictEqual(output9, 'bash -c "echo \\$HOME"', "Should preserve other escape sequences");
console.log("✓ Test 9 passed: Other escape sequences preserved");

// Test 10: Double backslash followed by bang
const input10 = 'bash -c "echo \\\\!"';
const output10 = fixShellQuoteBangEscape(input10);
assert.strictEqual(
  output10,
  'bash -c "echo \\!"',
  "Should handle double backslash correctly (\\\\! becomes !)",
);
console.log("✓ Test 10 passed: Double backslash");

console.log("\n✅ All tests passed!");