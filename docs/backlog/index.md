# pi-claude-sandbox — backlog

One item per file (`item<N>.md`). The Status column is the truth; item files carry problem/design/acceptance/evidence. Created 2026-09-05 from the Claude Code env-protection parity analysis (claude code docs: `env-vars`, `sandboxing`, `security` — see item docs for URLs). The registry's inline scout backlog (PORT #76 / #75 / #68 / #62; SKIP cb205ca / #73 / #65) is unchanged and separate.

Carried to the unified lineage 2026-09-12 (reunification with carderne/pi-sandbox); item notes updated for the post-reunification structure — see [`../upstream-sync.md`](../upstream-sync.md) for the sync protocol. The analysis was originally made against the legacy single-file `index.ts` (tag `legacy-single-file`).

| Item | Title | Status | Effort |
|---|---|---|---|
| [item1](item1.md) | Env deny-scrub: strip credential env vars from sandboxed subprocesses | ready — re-base pending on unified | S–M |
| [item2](item2.md) | Sentinel + proxy credential masking (TLS-terminating MITM) | parked (needs concrete driver) | L–XL |
| [item3](item3.md) | Env-scrub coverage gap: hooks + MCP server spawns (pi-core) | upstream-candidate (file against carderne/pi-sandbox) | S (to file) |
| [item4](item4.md) | Hook-mode shellCommandPrefix runs outside the sandbox wrapper | recorded — fix deferred | S |
| [item5](item5.md) | Write-block detection trusts output text: bogus grant prompts and command re-runs | recorded — fix pending | S–M |
| [item6](item6.md) | Post-sync review: trim D1–D10, verify work profile and Linux, re-sync README fork list | open | S–M |

## Considered and dismissed (do not re-derive)

- **PID-namespace isolation** (Claude's Linux-only `/proc/*/environ` mitigation): N/A on macOS — no procfs, same-user processes cannot read each other's environ. Only relevant if a Linux runtime target ever appears (would need bwrap, different runtime).
- **"Repo settings can't self-authorize"**: pi-permissions' floor is already non-overridable by project config (deny floor; production-support ignores allows; project `.pi/` layer can only add protection). Parity with Claude's user/managed-settings-only mask rule exists by design.
