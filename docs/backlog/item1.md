# item1 — Env deny-scrub: strip credential env vars from sandboxed subprocesses

**Status:** ready · **Effort:** S–M · **Origin:** 2026-09-05 Claude Code env-protection parity analysis (this session; user question "how does claude protect env")

Claude reference: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` — https://code.claude.com/docs/en/env-vars ("strip credentials from subprocess environments (Bash tool, hooks, MCP stdio servers)… The parent Claude process keeps these credentials for API calls, but child processes cannot read them, reducing exposure to prompt injection attacks that attempt to exfiltrate secrets via shell expansion"). Our scope for this item: the bash-tool surface only (hooks/MCP = item3).

## Problem

By default (verified against Claude's own docs, and true for us): sandboxed bash inherits the full pi-process environment including credentials; there is no credential deny list anywhere in the stack. pi-permissions blocks *contact with protected paths* but cannot stop `echo $GITHUB_TOKEN` — the secret is in the process env, not on disk. Claude's answer is environmental (reshape what the child can see), which composes with our textual floor instead of duplicating it.

## Design / plan

- **Mechanism**: seatbelt cannot filter env; we own the spawn line instead. Both wrap paths (tool_call + user_bash ops) already rewrite `event.input.command` into the `sandbox-exec` invocation — prepend `env -u VAR1 -u VAR2 …` before `sandbox-exec` (macOS `/usr/bin/env -u` is fine). Child tree inherits the scrubbed env; nothing inside can recover stripped values.
- **Config** (`sandbox.json`): `credentials.envVars: string[]` — explicit deny list. Plus a small built-in recognizer (Claude's "any var it recognizes as a credential" is heuristics): names matching `TOKEN|SECRET|KEY|PASSWORD|_CREDENTIALS`, `AWS_`/`GH_`/`GITHUB_`/`NPM_`/`SLACK_` prefixes, and creds embedded in registry URLs (`npm_...://user:pass@`). Recognizer on by default; explicit list extends it.
- **Stamp contract**: scrub consumes the stamped ORIGINAL_COMMAND_SYMBOL original like everyone else; the `env -u` prefix lands in the mutated command text. Note: var *names* (not values) become visible to pi-permissions' matcher — benign (no protected paths), but floor reasons may quote them; acceptable.
- **Enforcement honestly tied to the sandbox**: an unwrapped (unsandboxed) call gets no scrub. Document this in the config key comment.
- Do NOT touch parent pi process env — it needs its creds (same as Claude's parent-keeps model).

## Acceptance criteria

- [ ] Sandboxed `printenv GITHUB_TOKEN` → empty; same command unsandboxed → set.
- [ ] Recognizer catches a synthetic `MY_API_SECRET_KEY` without explicit config.
- [ ] Explicit `credentials.envVars` adds a var the recognizer missed.
- [ ] RTK + pi-mise wrap-order still correct (stamp contract intact); pi-permissions still blocks genuine `~/.ssh` contact with scrub engaged.
- [ ] Unit tests (wrap output, config parse, recognizer) + repo `tsc --noEmit` + suite green; live probe battery in a herdr pane.

## Evidence / log

- (empty)
