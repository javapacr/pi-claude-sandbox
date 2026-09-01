/**
 * Tests for buildSshProxyPreamble (upstream carderne #71 technique port) and
 * the network.allowUnauthenticatedSocksProxy / network.sshProxy config
 * defaults (upstream #61 port).
 *
 * Imports the REAL helpers from index.ts (Node >= 23.6 strips TS types by
 * default) and stubs SandboxManager.getSocksProxyPort + process.platform.
 *
 * buildSshProxyPreamble is async and only its guard paths are covered here:
 * the disabled / non-darwin / undefined-port branches return "" BEFORE any
 * network probe. The live SOCKS5 handshake probe (the interesting logic) is
 * covered directly via isSocksProxyReady against real net servers.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import net from "node:net";
import { test } from "node:test";
import { SandboxManager } from "@carderne/sandbox-runtime";
import { buildSshProxyPreamble, isSocksProxyReady } from "../index.ts";

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

// ── builder guard paths (no probe — these return "" before isSocksProxyReady) ──

test('returns "" when sshProxy disabled', async () => {
  const out = await withEnv("darwin", 52832, () => buildSshProxyPreamble(false));
  assert.equal(out, "");
});

test('returns "" on non-darwin (linux) even when enabled + port available', async () => {
  const out = await withEnv("linux", 52832, () => buildSshProxyPreamble(true));
  assert.equal(out, "");
});

test('returns "" when the SOCKS proxy port is unavailable (undefined)', async () => {
  const out = await withEnv("darwin", undefined, () => buildSshProxyPreamble(true));
  assert.equal(out, "");
});

test("guard paths precede the probe (disabled/non-darwin/undefined-port short-circuit first)", () => {
  // Structural check from source: the guards must come before the first
  // isSocksProxyReady call inside buildSshProxyPreamble, so guard-path tests
  // never touch the network.
  const src = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");
  const fnSrc = src.slice(src.indexOf("buildSshProxyPreamble("));
  const guardIndex = fnSrc.indexOf(
    'if (!sshProxyEnabled || process.platform !== "darwin") return "";',
  );
  const undefIndex = fnSrc.indexOf('if (socksProxyPort === undefined) return "";');
  const probeIndex = fnSrc.indexOf("isSocksProxyReady(");
  assert.ok(guardIndex >= 0 && undefIndex >= 0 && probeIndex >= 0);
  assert.ok(guardIndex < probeIndex, "disabled/non-darwin guard must precede the probe");
  assert.ok(undefIndex < probeIndex, "undefined-port guard must precede the probe");
});

test("preamble template contains no '!' (must pass fixShellQuoteBangEscape untouched)", () => {
  // Static property of the template — the live-builder path (darwin + a real
  // serving port) is exercised end-to-end only inside the sandbox runtime.
  assert.ok(!EXPECTED(52832).includes("!"), "preamble must not contain a bang character");
});

test("combined preamble + bang-bearing command: guard collapses \\! in double quotes, preamble verbatim", () => {
  // Mirror of fixShellQuoteBangEscape (tests/fix-bang.test.mjs precedent —
  // the guard itself is not exported from index.ts).
  const guard = (s) => s.replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/\\!/g, "!"));
  const preamble = EXPECTED(52832);
  const combined = preamble + 'echo "hi\\!"';
  const result = guard(combined);
  assert.ok(result.startsWith(preamble), "preamble must survive the guard verbatim");
  assert.ok(result.includes('echo "hi!"'), "guard must still collapse \\! inside double quotes");
  assert.ok(!result.includes("\\!"), "no escaped bang may remain");
});

// ── isSocksProxyReady — real SOCKS5 handshake probes (node:test + net) ───────

function listen(server) {
  return new Promise((resolve) => server.listen(0, "localhost", resolve));
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("isSocksProxyReady: true when server answers the greeting with \\x05\\x00", async () => {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.write(Buffer.from([5, 0])));
  });
  await listen(server);
  const { port } = server.address();
  try {
    assert.equal(await isSocksProxyReady(port), true);
  } finally {
    await close(server);
  }
});

test("isSocksProxyReady: false when server accepts TCP but closes without a handshake reply", async () => {
  // Accept-then-close — the sandbox reinit-window failure mode that motivated
  // the probe.
  const server = net.createServer((socket) => {
    socket.destroy();
  });
  await listen(server);
  const { port } = server.address();
  try {
    assert.equal(await isSocksProxyReady(port), false);
  } finally {
    await close(server);
  }
});

test("isSocksProxyReady: false when nothing listens (ECONNREFUSED)", async () => {
  const server = net.createServer();
  await listen(server);
  const { port } = server.address();
  await close(server); // port now free → connect is refused
  assert.equal(await isSocksProxyReady(port), false);
});

test("DEFAULT_CONFIG defaults: allowUnauthenticatedSocksProxy true on darwin, sshProxy true", () => {
  // Read the source and assert the two defaults are present (structural
  // check — DEFAULT_CONFIG is not exported).
  const src = readFileSync(new URL("../index.ts", import.meta.url), "utf-8");
  assert.match(src, /allowUnauthenticatedSocksProxy: process\.platform === "darwin"/);
  assert.match(src, /^\s+sshProxy: true,/m);
});
