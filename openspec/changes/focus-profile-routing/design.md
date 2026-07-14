## Context

`ARCHITECTURE.md` AD-7 (self-reported focus) and AD-8 (generic, position-based action
model) are both decided but unimplemented. `gatoway-core-foundation` deliberately deferred
focus/profile logic; `stream-deck-plugin-skeleton` deliberately shipped a single hardcoded
static "Idle" action as a placeholder. This change implements both decisions together,
since they're two halves of one mechanism: AD-8's position-based events are meaningless
without AD-7's focus tracking to resolve them against, and AD-7's focus tracking has
nothing to route to without AD-8's generic input/render messages.

No real second application plugin exists yet (Lightroom adaptation is step 3, xDesign is
step 5) — this change proves the mechanism using lightweight test-double connections in
Gatoway core's own test suite, plus live verification of the generic action rendering on
real Stream Deck+ hardware.

## Goals / Non-Goals

**Goals:**
- Add `focus`, `input_event`, and `render_update` message types to `message-protocol`, and
  publish them as a stable reference document future application plugin authors can build
  against.
- Gatoway core tracks which single connection (if any) currently has focus, and resolves
  incoming `input_event`s against that connection's declared capabilities at the pressed
  position, using an in-code test fixture for the layout (not real persistence — that's
  step 6).
- Stream Deck plugin adopts AD-8's generic Key/Dial action model, replacing the static Idle
  action; it forwards raw input and renders whatever Gatoway core instructs, including the
  idle appearance when nothing is focused.

**Non-Goals:**
- Real application plugins (Lightroom, xDesign) — steps 3 and 5.
- Persisted, file-backed layout config — step 6. This change proves the routing/resolution
  logic and the interface, using a hardcoded in-code layout fixture.
- A no-code mapping UI — post-MVP, unrelated to this change.
- Solving zero-touch profile/action auto-installation on the Stream Deck — already
  investigated and deferred in `stream-deck-plugin-skeleton` (QA-009); this change keeps
  the same one-time manual placement step for the (now generic, not idle-specific) actions.

## Decisions

**D1 — New message types.** Three additions to the existing envelope (`{ type, connectionId?, payload }`), no changes to framing or existing types:
- `focus` (app plugin → core): `payload: { focused: boolean }`. Sent any time an application plugin's own focus state changes; no acknowledgement message, since focus changes are frequent and the state is self-correcting (an app crashing without sending `focused: false` is resolved by its disconnect, not by a missed message).
- `input_event` (Stream Deck plugin → core): `payload: { controller: "keypad" | "encoder", position: { row: number, column: number } | { index: number }, eventType: "keyDown" | "keyUp" | "rotate" | "push", delta?: number }`. `position` is `{ row, column }` for `controller: "keypad"` and `{ index }` for `controller: "encoder"`, matching the Elgato SDK's own addressing so the plugin does no coordinate translation. `delta` is present only for `eventType: "rotate"`.
- `render_update` (core → Stream Deck plugin): `payload: { controller: "keypad" | "encoder", position: (same shape as above), icon?: string, label?: string, state?: number }`. Fields are optional/sparse — an update only sets what's changing.

**D2 — Focus tracking is single-winner, last-report-wins.** Gatoway core holds one piece of state: `focusedConnectionId: string | null`. Receiving `focus: { focused: true }` from a connection sets it as the sole focused connection, implicitly superseding any previous one (no requirement that the previous connection explicitly blur first) — this is deliberately tolerant of a crashed or buggy app that never sends `focused: false`, rather than requiring perfect handshake discipline between apps. Receiving `focused: false` from the *currently* focused connection clears it to `null` (idle). A disconnecting connection that was focused also clears it to `null`. Alternative considered: requiring an explicit blur-then-focus handshake with conflict rejection — rejected as more fragile (one missed blur message leaves the system stuck) for no real benefit at this scale.

**D3 — In-code test-fixture layout for this change only.** Gatoway core resolves `(focusedConnectionId, controller, position)` to a specific capability using a small, hardcoded in-memory structure built for this change's own tests — not a config file. This deliberately proves the resolution/routing *interface* and *logic* without pulling in step 6's real persistence work, matching `ARCHITECTURE.md`'s own delivery-sequence separation. The interface (a `LayoutResolver` with a `resolve(connectionId, controller, position)` method) is designed so step 6 can swap the in-code fixture for a real config-file-backed implementation without changing anything that depends on it.

**D4 — Idle rendering is Gatoway-core-driven, not plugin-hardcoded.** When `focusedConnectionId` is `null`, Gatoway core sends `render_update` messages describing a built-in idle appearance (matching what the previous static "Idle" action showed — an icon/"Gatoway" label at the position the user has placed a generic Key action) rather than the Stream Deck plugin having any idle-specific code of its own. This is the direct implementation of AD-8: the plugin is now fully generic, and "idle" is simply what gets rendered when nothing is focused.

**D5 — Stream Deck plugin action model.** Replace `idleAction.ts`/`idleKeyRenderer.ts` and the manifest's single `Idle` action with two generic actions — one `Controllers: ["Keypad"]` action and one `Controllers: ["Encoder"]` action — whose `onKeyDown`/`onKeyUp`/`onDialRotate`/`onDialPress` handlers send the corresponding `input_event` and whose `onWillAppear`/state-update handling applies whatever `render_update` last instructed for that position. The manual one-time placement step (dragging the generic action onto a key) is unchanged from `stream-deck-plugin-skeleton` — this change does not revisit the deferred auto-install question.

**D6 — Protocol reference document.** Produce a single reference document (likely `docs/PROTOCOL.md` or similar — final location decided by `doc-writer` per its own conventions) covering the full message contract: envelope, `register`/`register_ack`/`error` (existing), and `focus`/`input_event`/`render_update` (new), plus the capability manifest shape apps declare at registration. This is the artifact step 3 and step 5 build against directly, rather than reading Gatoway core's source.

## Risks / Trade-offs

- [Risk] No real second application exists to validate multi-app focus arbitration against → [Mitigation] test-double TCP/WS connections in Gatoway core's own test suite (the same real-socket testing pattern `gatoway-core-foundation` already established) exercise focus tracking and routing directly; the generic action rendering itself is verified live against real Stream Deck+ hardware, same as `stream-deck-plugin-skeleton`.
- [Risk] The in-code test-fixture layout (D3) could be mistaken for the real persistence design if not clearly labeled → [Mitigation] documented explicitly here and in the fixture's own code comments as a stand-in for step 6, with a stable resolver interface so swapping it later doesn't ripple into this change's other logic.
- [Trade-off] D2's "last-report-wins, no explicit handshake" focus model is simpler and more crash-tolerant but means a misbehaving app that repeatedly claims focus without ever blurring could "steal" focus indefinitely — acceptable for a personal-use tool with a small, trusted set of app plugins; revisit if this becomes a real problem with more plugins in play.

## Migration Plan

Removes `stream-deck-plugin-skeleton`'s static `Idle` action and its manifest entry
entirely, replaced by the generic Key/Dial actions (see the `stream-deck-idle-display`
delta spec's Reason/Migration for the formal record). Since Gatoway has no public users
yet, this is a clean replacement rather than a versioned migration — any developer with
the old Idle action already placed on a key will need to re-place the new generic action
after upgrading (documented in `stream-deck-plugin/README.md` by `doc-writer`).

## Open Questions

None outstanding — the remaining implementation-level decisions above (message shapes,
focus tie-breaking, idle rendering ownership) are settled by this document. Step 6 will
need to decide the real config file's format/location, but that's explicitly out of scope
here.
