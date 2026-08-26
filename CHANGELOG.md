# Changelog

## [0.7.0] - 2026-08-26

This is the javapacr fork, building on tuansondinh/pi-claude-sandbox 0.6.0.

### Fixes

- **F1**: `getConfigPaths()` now uses `getAgentDir()` instead of hardcoding `~/.pi/agent/sandbox.json` — resolves the profile-aware config path bug. Five impact sites fixed: `/sandbox` display, domain grants, write grants, denyWrite hints, `/sandbox-init global`.
- **F2**: All display strings (prompt labels, `/sandbox` output, denyWrite hints) now derive from the resolved global path, displayed in tilde notation for readability.
- **F3**: `reinitializeSandbox()` now preserves `ignoreViolations` and `enableWeakerNestedSandbox` from the session's active merged config, preventing silent config loss after first grant.
- **F4**: `allowGitConfig` is now documented in README with filesystem options section, and the `/sandbox` command displays `allowGitConfig: <value>` in the filesystem block. The tool_result denyWrite hint includes a targeted message when `.git/config` or `.git/hooks` are blocked.
- **F5**: `extractDomainsFromCommand()` now catches scp-style git remotes, SSH URLs, user@host patterns, and bare hostnames after curl|wget|ping|dig|host verbs. Conservative pattern matching avoids false positives.
- **F6**: `extractBlockedWritePath()` regex now accepts child-tool errors (`cat:`, `cp:`, `mv:`, `touch:`, `tee:`, `npm:`, `yarn:`, `pip:`, `cargo:`, `gradle:`, `maven:`, `curl:`, `wget:`, `git:`, `make:`, `cmake:`) and the `bash: line N:` variant.
- **F7**: Network pre-check now denies domains in `deniedDomains` with an explicit `[Sandbox] Domain "<domain>" is in deniedDomains` message — no prompt, no grant flow.

### Cosmetic / UX

- **F11**: `/sandbox` header label corrected from `Network (bash + !cmd):` to `Network (bash subprocesses):` — accurately reflects what the fork covers.
- **F12**: `console.error` warnings for parse/reinit failures now surface via `ctx.ui.notify` (collected in module state and emitted at session_start).
- **F13**: Severity consistency: `Sandbox disabled via --no-sandbox` is now `info` level, matching `Sandbox disabled via config`.
- **F14**: Header doc comment rewritten for git-install reality, with fork lineage and profile-aware config documentation.
- **F15**: README corrected to use `@zackify/pi-claude-permissions` (the actual installed package) instead of the incorrect `pi-claude-permissions` name.

### Documentation

- **FM**: README now documents `filesystem.allowGitConfig` with a table entry and side effects section.
- README includes `How configs merge` section explaining the array replacement behavior (referencing upstream carderne/pi-sandbox#11).
- README updated with git-install instructions and profile-aware config path notes.
- CHANGELOG added 0.7.0 entry summarizing all fork changes.

### Infrastructure

- **F16**: Normalized imports from `@mariozechner/pi-coding-agent` to `@earendil-works/pi-coding-agent` throughout.
- `package.json` updated: repository/homepage/bugs → `https://github.com/javapacr/pi-claude-sandbox`, version `0.7.0`, description mentions fork lineage, peerDependencies/devDependencies → `@earendil-works/pi-coding-agent: "*"` (mirroring pi-mempalace/pi-atlassian precedence), author Son Dinh + contributors retained, MIT license retained.
- Manifest `pi.extensions` remains string-array `["./index.ts"]` per pi-extension-authoring rules.

### Credits

- Fork fixes based on 2026-08-15 upstream audit (see `docs/upstream-bug-getconfigpaths-ignores-agent-dir.md`).

## [0.6.0] - 2026-04-25

### Features

- **Auto-retry on grant.** When the OS sandbox blocks a bash write, the user grants access, and the extension now re-executes the original command in-place and replaces the tool result content with the retry output. The model sees the final outcome only — no extra LLM turn, no "Please retry" round-trip.
- Pre-check `denyWrite` before prompting. If the blocked path matches a `denyWrite` pattern, the user is no longer asked to grant access (it would be a no-op since `denyWrite` always wins). The tool result returns a clear explanation pointing at the relevant config file instead.
- Toast distinguishes auto-retry success from "sandbox cleared but command still failed" (e.g. underlying Unix permission denial). Success uses `✓ info`, post-grant command failure uses `⚠ warning` with explicit reason.

### Bug Fixes

- `extractBlockedWritePath` now handles relative (`.env`), absolute (`/tmp/.env`), and `~`-prefixed paths from bash redirect errors. Previously the regex required a leading `/`, silently dropping relative paths and skipping the prompt entirely.
- `matchesPattern` now uses a proper glob → regex converter that supports `**` (any depth), `*` (single segment), and `?`. The previous implementation called `resolve()` on every pattern, which mangled `**/.env` into `<cwd>/**/.env` and broke recursive matches — so the `denyWrite` pre-check could never fire on glob rules.
- Final fallback message clarifies that the auto-retry was attempted and gives the user actionable next steps (manual `denyWrite` edit vs rerun).

## [0.5.3] - 2026-04-25

### Documentation

- README: kept the short differentiation paragraph at the top, added the full comparison table back as a collapsible `<details>` section for users who want the breakdown.

## [0.5.2] - 2026-04-25

### Documentation

- README: prominent comparison table at the top showing differences from upstream `pi-sandbox`. Clearer explanation of the pair design with `pi-claude-permissions`.

## [0.5.1] - 2026-04-25

### Features

- Added `/sandbox-init [global|project] [force]` command. Writes the current default config to disk so users can inspect or customize it.

## [0.5.0] - 2026-04-25

### Breaking Changes

- Removed in-process gating of Read/Write/Edit tool calls. Use [pi-claude-permissions](https://www.npmjs.com/package/pi-claude-permissions) for tool-level allow/ask/deny rules. The OS-level bash subprocess sandbox is unchanged.
- Read prompt-retry flow removed (deny regions are now hard-block only). Write prompt-retry flow remains.
- Default `denyRead` no longer includes broad home regions (`/Users`, `/home`). Reads are open by default; only specific secrets (`.env`, `*.pem`, `*.key`, `~/.ssh`, `~/.aws`, `~/.gnupg`) are blocked.

### Features

- New defaults aligned with Claude Code's "open reads, closed writes, hard deny on secrets" model.
- `allowWrite` now pre-includes common tool caches (`~/.npm`, `~/.cargo/registry`, `~/.gradle/caches`, `~/.m2/repository`) so `npm install`, `cargo build`, etc. work without prompt-spam.
- Expanded `denyWrite` defaults to cover shell rc files, `~/.ssh`, `~/.gitconfig`, and macOS LaunchAgents/LaunchDaemons.

### Documentation

- README rewritten for clarity. Explicit explanation of read/write asymmetric semantics (open-by-default reads vs whitelist writes).
- Documented complementary use with `pi-claude-permissions`.

## [0.4.0] - earlier release

- Coexists with `pi-tool-display` and other bash-overriding extensions.
- Cleaner footer status.
- Write-block retry via `tool_result`.
