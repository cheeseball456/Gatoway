## Why

Assessing whether `docs/PROTOCOL.md` is complete enough for a real plugin author (starting
with xDender) surfaced a real gap: the document never mentions reconnection at all. The
underlying behavior is already correct and implemented — a fresh connection always
requires a fresh `register` (capabilities are not preserved across a disconnected
connection), and focus is cleared on disconnect (`focus-tracking`'s existing "Focus
Cleared on Disconnect" requirement) — but neither fact is spelled out as an actionable
"what to do when you reconnect" instruction for a plugin author. This matters especially
for a browser extension: Manifest V3 background service workers are ephemeral and
reconnect often, so this is exactly the audience most likely to hit it.

## What Changes

- Add explicit scenarios to two existing requirements, formalizing the reconnect
  implications as testable requirements rather than leaving them merely inferable from
  reading individual message semantics:
  - `message-protocol`'s "Registration Message Type" — a reconnecting connection (even
    from a plugin that was previously registered) must send a fresh `register`; nothing
    from a prior, now-disconnected connection carries over.
  - `focus-tracking`'s "Focus Self-Reporting" — a plugin that reconnects while still
    active/focused must re-send `focus: true`; focus is not automatically restored on
    reconnection.
- Add a "Reconnection" section to `docs/PROTOCOL.md` consolidating this guidance clearly
  for a plugin author, in one place, rather than requiring it to be inferred.
- No code changes — the runtime behavior is already correct today; this closes a
  documentation and spec-completeness gap only.

## Capabilities

### Modified Capabilities
- `message-protocol`: adds a scenario to "Registration Message Type" clarifying that a reconnecting connection must send a fresh `register`.
- `focus-tracking`: adds a scenario to "Focus Self-Reporting" clarifying that a reconnecting, still-active plugin must re-send `focus: true`.

## Impact

- Documentation-only change to `docs/PROTOCOL.md`, plus formalizing already-true behavior
  as explicit spec scenarios.
- No changes to `gatoway-core`'s or `stream-deck-plugin`'s source code.
- Directly unblocks xDender's author from needing to infer this behavior by reading
  individual message semantics carefully.
