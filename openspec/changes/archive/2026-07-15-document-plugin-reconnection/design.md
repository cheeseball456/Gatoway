## Context

Assessing `docs/PROTOCOL.md`'s completeness for a real plugin author (xDender, starting
with Firefox/Chrome) surfaced that reconnection is never mentioned anywhere in it, even
though the actual behavior is already correct and implemented: `ConnectionRecord` is
per-connection (a fresh TCP/WS connection has no memory of a prior one), and
`focus-tracking`'s existing "Focus Cleared on Disconnect" requirement already clears
focus on any disconnect. Nothing needs to change in code — this closes a documentation and
spec-completeness gap only.

## Goals / Non-Goals

**Goals:**
- Make the reconnect implications of already-existing behavior explicit and testable via
  new scenarios on the two requirements they actually touch.
- Give a plugin author one clear, consolidated place (`docs/PROTOCOL.md`) to read this,
  rather than requiring it to be inferred from individual message semantics.

**Non-Goals:**
- Any code change — the behavior being documented is already correct.
- Any new message type, reconnection backoff algorithm, or keepalive/ping-pong mechanism
  — those are either already each plugin's own implementation choice (backoff timing) or
  a separate, lower-priority concern (WS keepalive, not addressed here; loopback-only
  transport makes it low-risk).

## Decisions

**D1 — Formalize as spec scenarios, not just prose.** Since the reconnect behavior is
already enforced by real code (a disconnected `ConnectionRecord` is discarded;
`focus-tracking`'s disconnect-clears-focus requirement already exists), it's a genuine,
testable requirement — not merely narrative documentation. Adding scenarios to
`message-protocol`'s "Registration Message Type" and `focus-tracking`'s "Focus
Self-Reporting" keeps the spec accurate as the source of truth, and gives `doc-writer`/QA
something concrete to verify the documentation against, rather than a prose addition with
nothing backing it.

**D2 — A dedicated "Reconnection" section in `docs/PROTOCOL.md`, not scattered notes.**
Rather than adding a caveat to each individually-affected message's own subsection (easy
to miss), add one consolidated section a plugin author reads once, covering: reconnects
require a fresh `register`; a still-active plugin must re-send `focus: true`; Gatoway
core's own reconnect tolerance (accepting a plugin disconnecting/reconnecting at any time)
means there's no special handshake or grace period to worry about — just start over
cleanly on each new connection.

## Risks / Trade-offs

None of significance — this is a low-risk, additive documentation change with no runtime
behavior change.

## Migration Plan

Not applicable — no code or data changes.

## Open Questions

None. Reconnect backoff timing/algorithm and WS keepalive were both raised as separate,
lower-priority observations during the investigation that led to this change, but are
explicitly out of scope here (see Non-Goals).
