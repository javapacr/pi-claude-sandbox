/**
 * Tests for buildSshProxyPreamble (upstream carderne #71 technique port) and
 * isSocksProxyReady.
 *
 * getSocksProxyPort now lives on the manager INSTANCE, so the guard paths are
 * exercised via a minimal fake manager object whose getSocksProxyPort is
 * stubbed, plus a process.platform stub. buildSshProxyPreamble is async and
 * only its guard paths are covered here: the disabled / non-darwin /
 * undefined-port branches return "" BEFORE any network probe. The live SOCKS5
 * handshake probe (the interesting logic) is covered directly via
 * isSocksProxyReady against real net servers.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import { test } from "node:test";

import { buildSshProxyPreamble, isSocksProxyReady } from "../src/sandbox-runtime.ts";
import type { ISandboxManager } from "@carderne/sandbox-runtime";

// ── stubs ────────────────────────────────────────────────────────────────────

function fakeManager(port: number | undefined): ISandboxManager {
  return { getSocksProxyPort: () => port } as unknown as ISandboxManager;
}

const origPlatformDesc = Object.getOwnPropertyDescriptor(process, "platform");

function withPlatform<T>(platform: string, fn: () => T): T {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    if (origPlatformDesc) {
      Object.defineProperty(process, "platform", origPlatformDesc);
    }
  }
}

const EXPECTED = (port: number) =>
  `ssh() { /usr/bin/ssh -o 'ProxyCommand=/usr/bin/nc -X 5 -x localhost:${port} %h %p' "$@"; }; ` +
  `export GIT_SSH_COMMAND="/usr/bin/ssh -o 'ProxyCommand=/usr/bin/nc -X 5 -x localhost:${port} %h %p'"; `;

// ── builder guard paths (no probe — these return "" before isSocksProxyReady) ──

test('returns "" when sshProxy disabled', async () => {
  const out = await withPlatform("darwin", () =>
    buildSshProxyPreamble(fakeManager(52832), false),
  );
  assert.equal(out, "");
});

test('returns "" on non-darwin (linux) even when enabled + port available', async () => {
  const out = await withPlatform("linux", () =>
    buildSshProxyPreamble(fakeManager(52832), true),
  );
  assert.equal(out, "");
});

test('returns "" when the SOCKS proxy port is unavailable (undefined)', async () => {
  const out = await withPlatform("darwin", () =>
    buildSshProxyPreamble(fakeManager(undefined), true),
  );
  assert.equal(out, "");
});

test("guard paths precede the probe (disabled/non-darwin/undefined-port short-circuit first)", () => {
  const src = readFileSync(new URL("../src/sandbox-runtime.ts", import.meta.url), "utf-8");
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
  // Mirror of the fixShellQuoteBangEscape guard applied to the combined string.
  const guard = (s: string) => s.replace(/"(?:[^"\\]|\\.)*"/g, (m) => m.replace(/\\!/g, "!"));
  const preamble = EXPECTED(52832);
  const combined = preamble + 'echo "hi\\!"';
  const result = guard(combined);
  assert.ok(result.startsWith(preamble), "preamble must survive the guard verbatim");
  assert.ok(result.includes('echo "hi!"'), "guard must still collapse \\! inside double quotes");
  assert.ok(!result.includes("\\!"), "no escaped bang may remain");
});

// ── isSocksProxyReady — real SOCKS5 handshake probes (node:test + net) ───────

function listen(server: net.Server) {
  return new Promise<void>((resolve) => server.listen(0, "localhost", () => resolve()));
}
function close(server: net.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

test("isSocksProxyReady: true when server answers the greeting with \\x05\\x00", async () => {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.write(Buffer.from([5, 0])));
  });
  await listen(server);
  const { port } = server.address() as net.AddressInfo;
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
  const { port } = server.address() as net.AddressInfo;
  try {
    assert.equal(await isSocksProxyReady(port), false);
  } finally {
    await close(server);
  }
});

test("isSocksProxyReady: false when nothing listens (ECONNREFUSED)", async () => {
  const server = net.createServer();
  await listen(server);
  const { port } = server.address() as net.AddressInfo;
  await close(server); // port now free → connect is refused
  assert.equal(await isSocksProxyReady(port), false);
});
