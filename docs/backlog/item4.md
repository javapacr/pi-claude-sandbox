# item4 — Hook-mode shellCommandPrefix runs outside the sandbox wrapper

**Status:** recorded — fix deferred · **Effort:** S · **Origin:** 2026-09-27 upstream sync to `c3b2f73` (#88 "sandboxed bash respects shellCommandPrefix")

## Problem

Upstream #88 made the sandboxed bash tool honour pi's `shellCommandPrefix` setting. In default mode the fork now runs the prefix **inside** the sandbox wrapper, as upstream does. Hook mode (divergence D10, `compat.registerBashTool: false`) behaves differently:

- The bash tool that executes the command is not ours. It is pi's built-in bash or pi-patty-bg-tasks.
- Our `tool_call` mutation (`mutateStep` in `src/hook-mode.ts`) replaces `event.input.command` with the `wrapWithSandbox(...)` result.
- The executing bash tool then prepends `shellCommandPrefix` as `${prefix}\n${command}` to that already-wrapped command.
- So the prefix runs **outside** the sandbox wrapper, and any side effects it has are unsandboxed.
- Non-env shell state the prefix sets up never reaches the wrapped command: aliases, functions, `shopt` options. Exported env vars reach it only through process inheritance.

## Plan

Candidate fix (intent I6, deferred to a follow-up discussion):

- In `src/hook-mode.ts` `mutateStep`, read `SettingsManager.getShellCommandPrefix()` and wrap `preamble + prefix + "\n" + originalCommand`, so the prefix runs inside the sandbox.
- Trade-off: the executing bash still prepends the prefix outside the wrapper, so the prefix would run **twice**, once outside and once inside. That is a hazard for non-idempotent or side-effecting prefixes. An extension cannot stop the outer prepend, because it belongs to the executing bash tool.

Scope today:

- The personal profile runs hook mode with no `shellCommandPrefix` set, so it is unaffected.
- The work profile's mode and prefix are unverified, because `~/.pi/work` is read-denied from personal sessions. Check it before deciding.

## Acceptance criteria

- [ ] Decide fix or no-fix in the follow-up session. The decision weighs the prefix running unsandboxed today against the double-run hazard of the candidate fix, given the work profile's actual mode and prefix.

## Evidence / log

- `src/hook-mode.ts` `mutateStep` (~L240-264): `wrapWithSandbox(preamble + originalCommand)` then `event.input.command = wrapped`; there is no prefix handling.
- pi `dist/core/tools/bash.js:213`: ``const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;`` runs in the executing bash tool, after `tool_call` mutation.
- Upstream refs: `c3b2f73` / carderne/pi-sandbox#88. Default-mode sandboxed bash passes `commandPrefix: shellCommandPrefix` (see `docs/upstream-sync.md` D10 row).
- 2026-09-27: recorded during the sync to `c3b2f73` (`.pi/docs/upstream-assessment.md`, intent I2).
