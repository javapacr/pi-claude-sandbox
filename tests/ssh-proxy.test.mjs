/**
 * Tests for buildSshProxyPreamble (upstream carderne #71 technique port) and
 * the network.allowUnauthenticatedSocksProxy / network.sshProxy config
 * defaults (upstream #61 port).
 *
 * Imports the REAL helper from index.ts (Node >= 23.6 strips TS types by
 * default) and stubs SandboxManager.getSocksProxyPort + process.platform.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SandboxManager } from "@carderne/sandbox-runtime";
import { buildSshProxyPreamble } from "../index.ts";

// ── stubs ────────────────────────────────────────────────────────────────────
const origGetPort = SandboxManager.getSocksProxyPort;
const origPlatformDesc = Object.getOwnPropertyDescriptor(process, "platform");

function withEnv(platform, port, fn) {
  SandboxManager.getSocksProxyPort = () => port;
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
  try {
    return fn();
  } finally {
    SandboxManager.getSocksProxyPort = origGetPort;
    if (origPlatformDesc) {
      Object.defineProperty(process, "platform", origPlatformDesc);
    }
  }
}

const EXPECTED = (port) =>
  `ssh() { /usr/bin/ssh -o 'ProxyCommand=/usr/bin/nc -X 5 -x localhost:${port} %h %p' "$@"; }; ` +
  `export GIT_SSH_COMMAND="/usr/bin/ssh -o 'ProxyCommand=/usr/bin/nc -X 5 -x localhost:${port} %h %p'"; `;

test("darwin + enabled + port available → exact ssh() + GIT_SSH_COMMAND preamble", () => {
  const out = withEnv("darwin", 52832, () => buildSshProxyPreamble(true));
  assert.equal(out, EXPECTED(52832));
});

test('returns "" when sshProxy disabled', () => {
  const out = withEnv("darwin", 52832, () => buildSshProxyPreamble(false));
  assert.equal(out, "");
});

test('returns "" on non-darwin (linux) even when enabled + port available', () => {
  const out = withEnv("linux", 52832, () => buildSshProxyPreamble(true));
  assert.equal(out, "");
});

test('returns "" when the SOCKS proxy port is unavailable', () => {
  const out = withEnv("darwin", undefined, () => buildSshProxyPreamble(true));
  assert.equal(out, "");
});

test("preamble contains no '!' (must pass fixShellQuoteBangEscape untouched)", () => {
  const out = withEnv("darwin", 52832, () => buildSshProxyPreamble(true));
  assert.ok(!out.includes("!"), "preamble must not contain a bang character");
});

test("combined preamble + bang-bearing command: guard collapses \\! in double quotes, preamble verbatim", () => {
  // Mirror of fixShellQuoteBangEscape (tests/fix-bang.test.mjs precedent —
  // the guard itself is not exported from index.ts).
  const guard = (s) =>
    s.replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/\\!/g, "!"));
  const preamble = withEnv("darwin", 52832, () => buildSshProxyPreamble(true));
  const combined = preamble + 'echo "hi\\!"';
  const result = guard(combined);
  assert.ok(result.startsWith(preamble), "preamble must survive the guard verbatim");
  assert.ok(
    result.includes('echo "hi!"'),
    "guard must still collapse \\! inside double quotes",
  );
  assert.ok(!result.includes("\\!"), "no escaped bang may remain");
});

test("DEFAULT_CONFIG defaults: allowUnauthenticatedSocksProxy true on darwin, sshProxy true", () => {
  // Read the source and assert the two defaults are present (structural
  // check — DEFAULT_CONFIG is not exported).
  const src = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");
  assert.match(
    src,
    /allowUnauthenticatedSocksProxy: process\.platform === "darwin"/,
  );
  assert.match(src, /^\s+sshProxy: true,/m);
});
