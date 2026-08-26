# Upstream Issue — pi-claude-sandbox: `getConfigPaths()` ignores `PI_CODING_AGENT_DIR` (profile-aware agent dir)

**Package:** `pi-claude-sandbox` extension (`~/.pi/agent/npm/node_modules/pi-claude-sandbox/index.ts`)
**Runtime:** pi-coding-agent (`@earendil-works/pi-coding-agent` v0.84.1), macOS
**Date:** 2026-08-15

---

## Summary

The extension computes the global sandbox config path in **two different ways** that
disagree when `PI_CODING_AGENT_DIR` is set (i.e., when running under a non-default
pi profile):

| Function | Line | Path computed | Profile-aware? |
|---|---|---|---|
| `loadConfig()` | 149 | `join(getAgentDir(), "sandbox.json")` | ✅ yes |
| `getConfigPaths()` | 323 | `join(homedir(), ".pi", "agent", "sandbox.json")` — literal | ❌ no |

`getAgentDir()` (exported by `@mariozechner/pi-coding-agent`, implemented in pi's
`dist/config.js:412`) correctly returns `process.env.PI_CODING_AGENT_DIR` when set,
falling back to `~/.pi/agent`. `getConfigPaths()` bypasses it entirely.

## Impact

Full audit of every `getConfigPaths()` consumer — five affected code paths:

| # | Feature | Site | What breaks under `PI_CODING_AGENT_DIR` |
|---|---|---|---|
| 1 | **`/sandbox` display** | `getConfigPaths()` callers | Shows `~/.pi/agent/sandbox.json` as "the" global config — a file that is never loaded under a non-default profile |
| 2 | **Network grant** — "Allow for all projects" on a blocked domain | `applyDomainChoice` → `addDomainToConfig(globalPath)` | Domain appended to the dead file; on reload, `loadConfig()` reads the real profile config → domain still blocked. Session-only and project choices work correctly. |
| 3 | **Write grant** — "Allow for all projects" on a blocked write | `applyWriteChoice` → `addWritePathToConfig(globalPath)` | Same — path grant silently vanishes on reload |
| 4 | **`denyWrite` remediation hints** | denyWrite-blocked message | Tells the user to "edit denyWrite manually in: `<globalPath>`" — points at the dead file |
| 5 | **`/sandbox-init global`** | `writeConfigFile(globalPath, DEFAULT_CONFIG)` | Writes `DEFAULT_CONFIG` to the dead file while the real profile config sits untouched |

Plus hard-coded string literals in the UI and docs:

- `promptDomainBlock` / `promptWriteBlock` menu labels: `"Allow for all projects → ~/.pi/agent/sandbox.json"` — should derive from the resolved `globalPath`
- Header docs (lines 25, 32) make the same claim

### `homedir()` audit (for completeness)

All five `homedir()` references in the extension were checked:

| Line | Context | Verdict |
|---|---|---|
| 248 | `extractBlockedWritePath` — expand `~` in extracted paths | ✅ legitimate (`~` = OS home) |
| 295, 300 | `matchesPattern` — expand `~` in glob patterns | ✅ legitimate |
| **323** | `getConfigPaths` — global config path | ❌ **the bug** — should use `getAgentDir()` |

Lines 248/295/300 correctly treat `~` as the OS home directory; they are not profile-related and need no change. Only line 323 conflates "OS home" with "agent config dir", which diverges under profiles.

## Repro

```bash
export PI_CODING_AGENT_DIR=~/.pi/personal
pi   # any session with a sandbox write prompt

# 1. Run /sandbox — it shows ~/.pi/agent/sandbox.json
# 2. Trigger a write permission prompt, choose "Allow for all projects"
# 3. The grant lands in ~/.pi/agent/sandbox.json
# 4. Restart pi (same env var) — the grant is gone; config was read from
#    ~/.pi/personal/sandbox.json
```

## Expected fix

`getConfigPaths()` should use the same profile-aware resolution as `loadConfig()`
(one change fixes all five impact sites above):

```ts
import { getAgentDir } from "@mariozechner/pi-coding-agent";

function getConfigPaths(cwd: string): { globalPath: string; projectPath: string } {
  return {
    globalPath: join(getAgentDir(), "sandbox.json"),
    projectPath: join(cwd, ".pi", "sandbox.json"),
  };
}
```

The extension already imports `getAgentDir` (line 72) — line 323 just never uses it.

Additionally, the prompt menu labels in `promptDomainBlock`/`promptWriteBlock`
(lines 578, 595) and the header docs (lines 25, 32) should display the resolved
`globalPath` instead of the hard-coded `~/.pi/agent/sandbox.json` string.

## Related observation (separate issue candidate)

`@carderne/sandbox-runtime` hard-codes a mandatory deny for `**/.git/config` (and
`**/.git/hooks/**`) in `macGetMandatoryDenyPatterns()` unless
`filesystem.allowGitConfig: true` is set. The extension's `deepMerge` and
`initialize({ filesystem: config.filesystem })` do forward this flag correctly, but
it is undocumented in the extension and invisible in the `/sandbox` UI. Result:
`git push -u` / `git pull` / remote-URL updates fail with "Operation not permitted"
under the sandbox, and no `allowWrite` entry can override it (mandatory denies win
over allows in SBPL). Consider exposing/documented this setting, since users burn
hours tweaking `allowWrite` globs that can never work.

## Environment

- pi: `@earendil-works/pi-coding-agent` 0.84.1 (`~/.npm-global`)
- extension: `pi-claude-sandbox` (`~/.pi/agent/npm/node_modules/pi-claude-sandbox`)
- runtime: `@carderne/sandbox-runtime` 0.0.43
- OS: macOS (seatbelt/SBPL path)
- Profile: `PI_CODING_AGENT_DIR=/Users/reevonr/.pi/personal`
