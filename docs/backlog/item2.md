# item2 — Sentinel + proxy credential masking (TLS-terminating MITM)

**Status:** parked (needs concrete driver) · **Effort:** L–XL · **Origin:** 2026-09-05 Claude Code env-protection parity analysis

Claude reference: `sandbox.credentials` `mode: "mask"` — https://code.claude.com/docs/en/sandboxing ("the sandboxed command sees a per-session sentinel value instead of the real one… the sandbox proxy replaces the sentinel with the real value. The command and anything it logs never hold the real credential").

## Problem (what this buys over item1)

Deny-scrub makes the secret *absent*; masking makes it *present but unusable* — for secrets the agent must actively call with (auth headers, request bodies) but must never see or log. This is the one tier textual blocking (pi-permissions) and env absence (item1) cannot reach.

## Design sketch (large; do not start without a driver)

- Per-session sentinel value injected in place of the masked var (item1's injection point reused).
- An **HTTP(S) MITM proxy that terminates TLS** — our current proxy story is a SOCKS relay for ssh egress; it relays bytes and cannot read them. This needs a new component: TLS termination, CA trust provisioning inside the sandbox, header/body substitution on egress to `injectHosts` destinations (each must also be admitted by `allowedDomains`).
- Edge cases Claude's docs enumerate and we would inherit: AWS SigV4 re-signing at the proxy; failures (not silent breakage) for aws-chunked streaming uploads and presigned URLs; `credentials.sigv4` passthrough opt-out.
- Hardening rule to port verbatim: **mask entries honored only from user-level config, never repo-level** (Claude ignores them in `.claude/settings.json` — a repo must not configure its own credential access).
- Blocked destinations fail with a proxy error, never a broken-signature request.

## Wake condition

A concrete secret that must be *usable-but-unreadable* (e.g. a token the agent needs for live API calls where echoing it into logs/transcripts is the actual risk). Until then this is maintenance-heavy infrastructure with no paying user.

## Evidence / log

- (empty)
