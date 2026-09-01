/**
 * Tests for the I-1 turn-aware keep-alive helpers (armKeepAlive /
 * releaseKeepAlive / releaseKeepAliveWithGrace / isKeepAliveActive).
 *
 * Imports the REAL helpers from index.ts (Node >= 23.6 strips TS types by
 * default). These helpers only touch timers — no sandbox-manager interaction —
 * so this file is safe to run standalone. Total runtime < 2s.
 */
import assert from "node:assert";
import { test } from "node:test";
import {
  armKeepAlive,
  isKeepAliveActive,
  releaseKeepAlive,
  releaseKeepAliveWithGrace,
} from "../index.ts";

test("armKeepAlive → active", () => {
  armKeepAlive();
  assert.equal(isKeepAliveActive(), true);
});

test("double-armKeepAlive is idempotent (no throw, still active)", () => {
  armKeepAlive(); // second arm while already active must be a no-op
  assert.equal(isKeepAliveActive(), true);
  // One release below fully disarms — no leaked interval from the second arm.
  releaseKeepAlive();
  assert.equal(isKeepAliveActive(), false);
  armKeepAlive(); // re-arm for the next test's precondition
});

test("releaseKeepAliveWithGrace: active immediately, released after the grace window", async () => {
  armKeepAlive();
  releaseKeepAliveWithGrace();
  assert.equal(isKeepAliveActive(), true, "still active during the grace window");
  await new Promise((r) => setTimeout(r, 400)); // grace is 250ms
  assert.equal(isKeepAliveActive(), false, "released after grace elapses");
});

test("re-arm after grace release, then hard releaseKeepAlive → inactive immediately", () => {
  armKeepAlive();
  assert.equal(isKeepAliveActive(), true);
  releaseKeepAlive();
  assert.equal(isKeepAliveActive(), false);
});

test("final state: keep-alive fully released (no lingering timers)", () => {
  releaseKeepAlive();
  assert.equal(isKeepAliveActive(), false);
});
