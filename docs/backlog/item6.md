# item6 — Post-sync review: trim D1–D10 and close verification gaps

**Status:** open · **Effort:** S–M · **Origin:** 2026-09-27 upstream sync to `c3b2f73` (intent I7; [sync record](../sync-log/2026-09-27-c3b2f73.md))

## Problem

The divergence layer ([inventory](../upstream-sync.md#divergence-inventory-d1d10)) was authored against `31fa506`. Each row is merge cost on every future sync. Nobody has re-checked whether upstream now covers, or partly covers, any of them. The 2026-09-27 sync (#88) made no row redundant, but it was not a review.

Three verification gaps also came out of the sync:

- **Work profile unverified.** Its sandbox mode (default or hook) and its `shellCommandPrefix` are unknown, because `~/.pi/work` is read-denied from personal sessions. The [item4](item4.md) decision depends on both.
- **Linux untested.** The upstream prefix test is darwin-only, and the fork has never run on Linux.
- **README drift.** The README fork section's divergence list does not match the inventory. It omits the D6 pre-check and D10 hook mode, and it lists "ported tests", which has no D row.

## Plan

- Walk D1–D10 against current `upstream/main`. For each row, decide keep, shrink, drop, or upstream (file a PR against carderne/pi-sandbox), and record the reason in the inventory.
- From a work-profile session, read `~/.pi/work/sandbox.json` (`compat.registerBashTool`) and `~/.pi/work/settings.json` (`shellCommandPrefix`). Record both in item4.
- Decide whether Linux is a target. If it is, run the full suite on a Linux host; if not, state it as unsupported in the README fork section.
- Re-sync the README fork list with the inventory after trimming.

## Acceptance criteria

- [ ] Every D row has a recorded keep/shrink/drop/upstream decision, and dropped rows are removed from code and inventory.
- [ ] The work profile's mode and prefix are recorded in item4.
- [ ] Linux is either verified (suite green on a Linux host) or documented as unsupported.
- [ ] The README fork list matches the inventory.

## Evidence / log

- 2026-09-27: created from the sync's deferred goal I7 and its accepted residual risks R11 (work profile) and R13 (Linux). See the [proof comment](https://github.com/javapacr/pi-claude-sandbox/pull/1#issuecomment-5853241654) ("Not verified").
