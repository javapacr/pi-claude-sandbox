# item5 — Write-block detection trusts output text: bogus grant prompts and command re-runs

**Status:** recorded — fix pending · **Effort:** S–M · **Origin:** 2026-09-27 upstream sync to `c3b2f73` (observed while probing)

## Problem

Write-block detection reads the bash tool's **output text**, not the OS sandbox's own record of a denial:

- `extractBlockedWritePath` (`src/policy.ts`, upstream #74) regex-matches `<tool>: <path>: Operation not permitted` anywhere in the output.
- In hook mode (D10), the `tool_result` handler passes the joined output to `handleBlockedWrite` (`src/hook-mode.ts`). That prompts for a grant and then **auto-retries the original command** (divergence D6).
- Default mode goes through the same `handleBlockedWrite` from the registered tool's `execute` (`src/extension.ts`, around the `Operation not permitted` catch).

So any command whose output merely **quotes** such a line looks like a blocked write. Examples: `herdr pane read` of another pi session, `cat` of a log, or `rg` over a transcript. The user then gets a grant prompt for a path the command never touched. Granting it re-executes the whole original command, and that command may not be idempotent.

Observed 2026-09-27 in a sandboxed parent session driving probe panes:

- A `herdr pane send-text` was re-executed, so the probe prompt was typed twice. Its stray `s` answered the probe's own grant prompt.
- A probe launcher script ran twice.
- The user was shown grant prompts for `~/Documents/pi-sbx-probe-*.txt`, which the parent command never wrote.

## Plan

Candidate fix (discuss with I6/I7 in the follow-up session):

- Before prompting, require corroboration that the OS actually denied a write to that path. `@carderne/sandbox-runtime` exposes `SandboxViolationStore` (`getViolationsForCommand(command)`, `getViolations()`), fed by the macOS sandbox log monitor. Prompt only when a write violation for the canonical path is recorded for this command.
- Fallback when violation monitoring is unavailable (e.g. `ignoreViolations`, log latency): prompt only when the original command text references the path (literal, `~`-expanded, or basename), and never auto-retry without that match.
- Consider making the auto-retry opt-in for commands that are not obviously idempotent, or showing the command in the grant prompt.

## Acceptance criteria

- [ ] Output that only quotes a denial line (no real violation) produces no grant prompt and no re-run, in both hook and default mode.
- [ ] A genuine blocked write still prompts, grants and auto-retries (the D10 battery stays green).
- [ ] Unit test for the corroboration path, plus a probe that runs `printf 'touch: /x/y: Operation not permitted\n'` and asserts no prompt.

## Evidence / log

- `src/policy.ts` `extractBlockedWritePath`: regex over output text (upstream #74, `3fb50d6`).
- `src/hook-mode.ts` `handleBlockedWrite` + `tool_result` handler: prompt, grant, auto-retry of the stashed original command (ours; upstream `main` has no `handleBlockedWrite`).
- `node_modules/@carderne/sandbox-runtime/dist/sandbox/sandbox-violation-store.d.ts`: `getViolationsForCommand`, `subscribe`.
- 2026-09-27: reproduced three times during the `c3b2f73` sync probes (`.pi/docs/plan.md` R10).
