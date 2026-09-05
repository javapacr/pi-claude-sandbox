# item3 — Env-scrub coverage gap: hooks + MCP server spawns (pi-core)

**Status:** upstream-candidate · **Effort:** S (to file) · **Origin:** 2026-09-05 Claude Code env-protection parity analysis

## Problem

Claude's `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` covers **Bash tool + hooks + MCP stdio servers**. Our achievable extension-land equivalent (item1) covers the bash tool only, because both other spawn sites are pi-core-owned and unreachable from an extension:

- **MCP servers**: spawned by the core MCP manager from `mcp.json`; the `env` block there is additive over pi's inherited env — no filtering hook exists.
- **Hooks**: hook scripts exec via the process spawner (execa-style), never through the bash tool's `tool_call` event, so the wrap never sees them.

Consequence: with item1 shipped, a credential stripped from every bash command is still fully exposed to any MCP stdio server (third-party code!) and any hook script.

## Plan

- File upstream pi-core issue proposing: (a) env deny-list/scrub applied at MCP spawn and hook spawn sites, and/or (b) a `MCP_ALLOWLIST_ENV`-style baseline-only mode (Claude sibling: "spawn stdio MCP servers with only a safe baseline environment plus the server's configured `env`, instead of inheriting your shell environment" — https://code.claude.com/docs/en/env-vars).
- Reference this file + item1 as the extension-side evidence that demand exists.
- Until core lands it: document the gap loudly in item1's config comment ("covers bash tool only").

## Acceptance criteria

- [ ] Upstream issue filed with reproduction shape + proposed config surface.
- [ ] Link added here; item1 doc cross-references it.

## Evidence / log

- (empty)
