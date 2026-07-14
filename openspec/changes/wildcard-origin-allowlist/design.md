## Context

`gatoway-core-foundation`'s `isOriginAllowed()` does exact-string matching against
`GATOWAY_ALLOWED_ORIGINS`. This is correct for Chrome (a published/signed extension's id
is deterministic and stable across every install) but cannot work for Firefox, where the
`Origin` header carries a random per-installation UUID regardless of any static id set in
the manifest (confirmed against Mozilla's own documentation during a design discussion —
see this change's proposal for sources). xDender targets both browsers, so this is a real
gap, not a hypothetical one.

## Goals / Non-Goals

**Goals:**
- Let an allowlist entry match either an exact origin (Chrome's case) or any origin
  sharing a prefix (Firefox's case), via a simple, explicit syntax.
- Change nothing about existing exact-match behavior for entries that don't use the new
  syntax.

**Non-Goals:**
- Full glob/regex support in the allowlist — unnecessary complexity and a needless
  footgun (regex from an env var is easy to get subtly wrong) for a problem that only
  needs "exact match, or prefix match."
- Any change to TCP token authentication, loopback binding, or the WebSocket listener's
  upgrade-handling flow beyond the matching function itself.

## Decisions

**D1 — Trailing-`*` prefix matching, nothing more elaborate.** An allowlist entry ending
in `*` (e.g. `moz-extension://*`) matches any origin that starts with everything before
the `*`. An entry without a trailing `*` matches only that exact string, exactly as
today. This is deliberately the simplest possible extension of the existing contract:
no regex engine, no glob library, no wildcard positions other than a single trailing one.
Alternative considered: full glob/regex matching — rejected as more power than this
problem needs, and a real footgun (a slightly-wrong regex in an env var could silently
allow far more than intended, with no test suite of the user's own to catch it).

**D2 — Recommended values documented per browser, not auto-detected.** Gatoway core has
no way to know which browser a given WebSocket connection is coming from before checking
its Origin — the allowlist itself is what tells it. So this remains a manually-configured
value: document that `chrome-extension://<the real, stable id>` is the right entry for
Chrome, and `moz-extension://*` is the right entry for Firefox, and let whoever configures
`GATOWAY_ALLOWED_ORIGINS` set both if supporting both browsers (comma-separated, matching
the existing multi-value convention).

**D3 — Security posture is unchanged, documented explicitly.** A wildcard is a broader
match than an exact string — `moz-extension://*` accepts any Firefox extension, not just
one specific one. This is an accepted trade-off, not an oversight: AD-4 (loopback-only
binding) is the actual security boundary; Origin-checking was already scoped in AD-5 to
distinguish "a legitimate extension" from "some other local process," not to resist a
determined local attacker who could forge the header regardless of which string is being
matched. Firefox's own platform design (randomizing the UUID specifically to prevent
extension fingerprinting) already makes a tighter check than "any Firefox extension"
impossible without an entirely different mechanism (e.g. a manual token, previously
considered and rejected in AD-5 for the friction it adds) — this is documented explicitly
so the trade-off isn't silently discovered later.

## Risks / Trade-offs

- [Trade-off] `moz-extension://*` means any Firefox extension installed on the same
  machine can connect to Gatoway core's WebSocket listener, not just xDender specifically
  — accepted per D3, given loopback-only binding is the real boundary and Firefox's own
  design forecloses a tighter check.
- [Risk] A malformed wildcard entry (e.g. `*` alone, matching everything) could be
  configured by mistake → [Mitigation] document the expected shape clearly
  (`<scheme>://*`, not a bare `*`); this is a configuration/documentation concern, not
  something to add runtime validation ceremony for on a personal-use, hand-configured
  value.

## Migration Plan

Not applicable — purely additive. Any already-configured exact-match `GATOWAY_ALLOWED_ORIGINS`
value keeps working unchanged.

## Open Questions

None outstanding.
