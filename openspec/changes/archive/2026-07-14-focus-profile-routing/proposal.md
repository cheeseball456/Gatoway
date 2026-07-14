## Why

`ARCHITECTURE.md`'s delivery sequence step 4 is generalizing Gatoway core's focus/profile
logic from the single-app placeholder built in `stream-deck-plugin-skeleton` to genuinely
tracking multiple simultaneous application connections and routing physical Stream Deck
input to whichever one is focused. This is also where AD-8 (the generic, position-based
Stream Deck action model) gets implemented: without it, every future application plugin
(Lightroom in step 3, xDesign in step 5, and anything beyond) would need bespoke,
per-app Stream Deck manifest entries — exactly what Gatoway exists to avoid. Building this
now, before step 3/5, also produces the thing the user specifically asked for: a stable,
documented message-protocol contract that future application plugin authors can build
against without reading Gatoway core's source.

## What Changes

- Add a `focus` message type: application plugins self-report `focused`/`blurred` state
  (already anticipated by AD-7, never implemented — `gatoway-core-foundation` explicitly
  deferred it).
- Add an `input_event` message type: the Stream Deck plugin forwards raw physical input
  (which position was pressed/released, which dial was rotated/pushed and by how much) —
  no app-specific meaning attached, per AD-8.
- Add a `render_update` message type: Gatoway core instructs the Stream Deck plugin what to
  display at a given position (icon/label/state) — again position-addressed only.
- Gatoway core: track which connection currently has focus (none, or exactly one), and
  resolve `input_event`s against that connection's bound capabilities at the pressed
  position, using an **in-code test-fixture layout** for this change (real file-backed
  persistence is delivery-sequence step 6, not this change — this change proves the
  routing/resolution logic and interface, not the persistence mechanism).
- Gatoway core: send `render_update` instructions to the Stream Deck plugin reflecting
  whichever application currently has focus, or a built-in idle appearance when nothing
  does.
- Stream Deck plugin: replace the single static "Idle" action from `stream-deck-plugin-skeleton`
  with a small, fixed set of generic Key and Dial action types (per AD-8); these forward
  `input_event`s and render whatever `render_update` instructs, including the idle state —
  the plugin has no hardcoded idle-specific behavior anymore, since idle is just what
  Gatoway core renders when nothing is focused.
- **BREAKING** (internal, pre-1.0, no external consumers yet): removes the `stream-deck.idle`
  action and its dedicated always-static rendering behavior from `stream-deck-plugin-skeleton`,
  superseded by the generic action model.
- Produce a protocol reference document describing the full message contract (envelope,
  `register`/`register_ack`/`error`, `focus`, `input_event`, `render_update`, the capability
  manifest shape) so a future application plugin author has a single place to read the
  interface without needing to read Gatoway core's source.
- Out of scope: real application plugins (Lightroom, xDesign — steps 3 and 5), persisted
  layout config (step 6 — this change uses an in-code test fixture instead), and any
  no-code mapping UI (post-MVP).

## Capabilities

### New Capabilities
- `focus-tracking`: application plugins self-report focus/blur; Gatoway core tracks which single connection (if any) currently has focus.
- `profile-routing`: Gatoway core resolves physical input events against the focused connection's bound capabilities and sends corresponding render instructions to the Stream Deck plugin, including an idle appearance when nothing is focused.

### Modified Capabilities
- `message-protocol`: adds the `focus`, `input_event`, and `render_update` message types to the existing envelope/framing (no changes to the envelope, framing, or existing `register`/`register_ack`/`error` types).
- `stream-deck-idle-display`: removes the single static "Idle" action and its always-on rendering behavior (superseded by AD-8's generic action model — see Reason/Migration in the delta spec), replaced by generic, position-addressed rendering driven by Gatoway core's `render_update` messages, including the idle appearance.

## Impact

- Extends `gatoway-core`'s existing message-protocol/connection-management code; no changes to `plugin-authentication`, `diagnostics-logging`, `connection-management`, or `stream-deck-core-lifecycle`/`stream-deck-core-client`.
- Rewrites `stream-deck-plugin`'s action layer (`idleAction.ts`/`idleKeyRenderer.ts` and `manifest.json`'s `Actions` entry) to the generic Key/Dial model; the plugin's core-lifecycle and core-client code (spawn/supervise, connect/register/reconnect) are unaffected.
- No real application plugin exists to validate multi-app focus arbitration against yet — this change's tests use lightweight test-double connections (the same pattern `gatoway-core-foundation`'s own test suite already uses for real-socket testing) to exercise focus tracking and routing in isolation, with live hardware verification of the generic action rendering itself.
- Produces a new protocol reference document that step 3 (Lightroom) and step 5 (xDesign) will build against directly.
