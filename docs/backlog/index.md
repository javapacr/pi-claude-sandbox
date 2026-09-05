# pi-claude-sandbox — backlog

One item per file (`item<N>.md`). The Status column is the truth; item files carry problem/design/acceptance/evidence. Created 2026-09-05 from the Claude Code env-protection parity analysis (claude code docs: `env-vars`, `sandboxing`, `security` — see item docs for URLs). The registry's inline scout backlog (PORT #76 / #75 / #68 / #62; SKIP cb205ca / #73 / #65) is unchanged and separate.

| Item | Title | Status | Effort |
|---|---|---|---|
| [item1](item1.md) | Env deny-scrub: strip credential env vars from sandboxed subprocesses | ready | S–M |
| [item2](item2.md) | Sentinel + proxy credential masking (TLS-terminating MITM) | parked (needs concrete driver) | L–XL |
| [item3](item3.md) | Env-scrub coverage gap: hooks + MCP server spawns (pi-core) | upstream-candidate | S (to file) |

## Considered and dismissed (do not re-derive)

- **PID-namespace isolation** (Claude's Linux-only `/proc/*/environ` mitigation): N/A on macOS — no procfs, same-user processes cannot read each other's environ. Only relevant if a Linux runtime target ever appears (would need bwrap, different runtime).
- **"Repo settings can't self-authorize"**: pi-permissions' floor is already non-overridable by project config (deny floor; production-support ignores allows; project `.pi/` layer can only add protection). Parity with Claude's user/managed-settings-only mask rule exists by design.
