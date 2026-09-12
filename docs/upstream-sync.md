# Upstream sync protocol

This repo (`javapacr/pi-claude-sandbox`) is a fork reunified with upstream
[`carderne/pi-sandbox`](https://github.com/carderne/pi-sandbox) on 2026-09-12.
The old fork history was doubly grafted (carderne → disconnected → tuansondinh
v0.6.0 → disconnected → our single-file 1389-line `index.ts`). The current
`main` was instead rebuilt off upstream `main` at `31fa506` (v0.6.8) with a
small, enumerated divergence layer re-applied on top.

## Purpose

Future upstream updates are a plain merge:

```sh
git fetch upstream
git log 31fa506..upstream/main --oneline   # review what's coming
git merge upstream/main
```

Conflicts are expected **only in the divergence lines** listed below. Because
the layer is thin and localized, merges stay cheap by design. A conflict
anywhere else is a red flag — either upstream refactored an area we diverge
into, or the merge went sideways; resolve by re-applying the divergence, never
by dropping upstream changes or adding new ones.

When in doubt on a large merge, walk the inventory file-by-file and re-apply
each divergence deliberately instead of mass-accepting conflict resolutions.

## Divergence inventory (D1–D10)

These are the only lines where merge conflicts are expected. One line each;
file pointers are the sync-time checklist.

| # | Divergence | Where |
|---|---|---|
| D1 | Fork identity — package `pi-claude-sandbox` v0.7.2, javapacr repo URLs, README fork section | `package.json`, `README.md` |
| D2 | Runtime pin — `@carderne/sandbox-runtime` resolved to `github:javapacr/sandbox-runtime#935c2ba` (fork = upstream v0.0.72 sync + allowedIPs closure port, committed dist) | `package.json`, `pnpm-lock.yaml` |
| D3 | Tildified config-path display — `~/…` paths in hints and the `/sandbox` render | `src/ui.ts` (`tildify`) |
| D5 | Exec-level hardening — `isSocksProxyReady` SOCKS5 probe, `ssh()` + `GIT_SSH_COMMAND` proxy preamble, `fixShellQuoteBangEscape`, keep-alive (30s tick / 250ms grace / 60min cap), `withTimeout`, `retryBashCommand` (upstream `waitForChildProcess` kept verbatim), `ORIGINAL_COMMAND_SYMBOL` stamp | `src/sandbox-runtime.ts` |
| D6 | Write-grant flow — denyWrite-wins pre-check + notify + tildified dual-path hints (bash path, additive), single auto-retry after grant (`autoRetriedToolCallIds`) | `src/extension.ts`, `src/hook-mode.ts` |
| D7 | Session wiring + richer block-path extraction — keep-alive/`withTimeout` on session hooks (10s timeouts on init/reset); `extractBlockedWritePath` (child tools, "line N", `~` paths) consolidated and re-exported from `src/policy.ts` | `src/extension.ts`, `src/policy.ts`, `src/sandbox-runtime.ts` |
| D10 | Hook mode — `compat.registerBashTool: false` in sandbox.json → skip bash registration and mutate `event.input.command` in `tool_call` (legacy wrap architecture). Exists because pi-patty-bg-tasks ALSO registers bash (name collision = pi exits at load). Upstream default (undefined) stays byte-equivalent to upstream behavior | `src/config.ts`, `src/hook-mode.ts` |

Two follow-up commits are part of the same layer and belong to the sync
checklist:

- Review P2 fixes — compat `registerBashTool`/`compat` spread-merge when
  layering project config over global (`src/config.ts`); original-command
  stash released on deny/allow outcomes (`src/extension.ts`, `src/hook-mode.ts`).
- Dropped `.github/workflows/` (release + test) — the fork runs gates locally,
  not GH Actions.

## Freeze model

The divergence layer is authored against an upstream tip **frozen at
`31fa506`** (v0.6.8, 2026-09-08 — "isolate sandbox managers between agent
sessions", #84). Frozen means *chosen deliberate base*, not a permanent pin —
that's what makes later merges cheap.

Re-freezing (advancing the base):

1. `git fetch upstream && git merge upstream/main`
2. Resolve conflicts only in the divergence lines above
3. Re-run the full gate checklist below
4. All green → the merge commit becomes the new freeze point; update the
   freeze SHA mentioned above to the new `upstream/main` tip it merged.

## Gate checklist (every sync)

All four must be green before pushing:

```sh
npx -y pnpm@10.34.3 install    # only if the lockfile moved
npx -y pnpm@10.34.3 run ci:fmt # oxfmt --check
npx -y pnpm@10.34.3 run check  # tsc --noEmit
npx -y pnpm@10.34.3 run test   # tsx --test
```

**pnpm-via-npx**: the mise pnpm shim can be missing in fresh shells; `pnpm`
on PATH is not a safe assumption. `npx -y pnpm@10.34.3` always works and
matches `packageManager` in `package.json` — use it in briefs, panes, and
scripts.

Additional gates and gotchas:

- **`session-isolation.test.ts` requires an UNSANDBOXED run** (herdr pane or
  user terminal). Agent sessions are themselves sandboxed; nested
  `sandbox_apply` EPERMs and the test cannot spawn its own sandboxes. A green
  run from inside an agent session is not evidence.
- **Runtime-repin discipline (D2)**: git deps consume the *committed* dist.
  Any `../sandbox-runtime` fork change must rebuild and re-commit dist
  (`git add -f` — dist is gitignored there) **before** repinning this repo to
  the new SHA. Verify the runtime change with `bun test` in the runtime repo
  UNSANDBOXED — a sandboxed run there produces ~89 false failures (nested
  seatbelt); never trust it as a verdict. Note: npm ≥12 needs
  `~/.npmrc allow-git=root` to install git deps at all.
- **Hook-mode probe (D10)**: profiles loading pi-patty-bg-tasks set
  `compat.registerBashTool: false` in sandbox.json. After a sync, probe both
  modes briefly — default (bash registered; must stay byte-equivalent to
  upstream) and hook mode (wrap via `tool_call` mutation). The cheapest
  meaningful battery: sandboxed bash write to a denied path → grant prompt →
  session grant → auto-retried exit 0 + file on disk. (Reunification battery
  was 7/7.)

## Remotes, tags, push flow

| Ref | Points at | Role |
|---|---|---|
| `upstream` | carderne/pi-sandbox | sync target (fetch + merge) |
| `origin` | javapacr/pi-claude-sandbox | push target |

(The stale `upstream-dinh` remote — tuansondinh/pi-claude-sandbox, historical
doubly-grafted ancestor — was removed 2026-09-12; its history remains reachable
via the `legacy-single-file` and `pre-unify-main` tags.)

Legacy tags (history preserved when `unified` replaced `main`; do not delete):

- `legacy-single-file` — old single-file lineage tip (the 1389-line `index.ts`
  era, plus its lockfile). Also holds the only legacy-only doc,
  `docs/upstream-bug-getconfigpaths-ignores-agent-dir.md` — reachable via
  `git show legacy-single-file:docs/…` if that bug resurfaces.
- `pre-unify-main` — the pre-force-push `main` (the manual runtime pin bump);
  the state the user's machine ran immediately before reunification.

Push flow: commit on `main`, push `origin` (ssh alias
`git@github-javapacr:javapacr/pi-claude-sandbox.git`; https push via
`gh auth token` works in-sandbox). The fork runs gates locally — the dropped
upstream workflows are deliberately not restored.
