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

**D1 — New message types.** Five additions to the existing envelope (`{ type, connectionId?, payload }`), no changes to framing or existing types (amended twice: this originally listed three types, then gained `command`, and now `capability_update` — both gaps surfaced during implementation and design review, not invented up front):
- `focus` (app plugin → core): `payload: { focused: boolean }`. Sent any time an application plugin's own focus state changes; no acknowledgement message, since focus changes are frequent and the state is self-correcting (an app crashing without sending `focused: false` is resolved by its disconnect, not by a missed message).
- `input_event` (Stream Deck plugin → core): `payload: { controller: "keypad" | "encoder", position: { row: number, column: number } | { index: number }, eventType: "keyDown" | "keyUp" | "rotate" | "push", delta?: number }`. `position` is `{ row, column }` for `controller: "keypad"` and `{ index }` for `controller: "encoder"`, matching the Elgato SDK's own addressing so the plugin does no coordinate translation. `delta` is present only for `eventType: "rotate"`.
- `render_update` (core → Stream Deck plugin): `payload: { controller: "keypad" | "encoder", position: (same shape as above), icon?: string, label?: string, state?: number }`. Fields are optional/sparse — an update only sets what's changing.
- `command` (core → app plugin): `payload: { capabilityId: string, eventType: "keyDown" | "keyUp" | "rotate" | "push", delta?: number }`. Sent once Gatoway core resolves an `input_event` against the focused connection's bound layout (D3). Carries the resolved `capabilityId` plus the same raw gesture info `input_event` reported (`eventType`/`delta`) rather than an abstracted "trigger"/"adjust" vocabulary — the app itself, not Gatoway core, decides what a press versus a release versus a given rotation amount means for its own capability (e.g. Lightroom's existing dial actions already distinguish rotate-to-adjust from push-to-toggle-fine/coarse). No acknowledgement message, consistent with the fire-and-forget style of `focus`/`render_update`.
- `capability_update` (app plugin → core): `payload: { capabilityId: string, icon?: string, label?: string, state?: number }`. Lets an app push a live display change to one of its own already-declared capabilities at any time (D7) — this is the piece that actually satisfies `REQUIREMENTS.md` FR-001's "an application can push a state update that changes a button's icon, label, or toggle state," which nothing built so far had implemented. Sparse update semantics, same as `render_update`: an omitted field leaves that property unchanged. No acknowledgement message.

**D2 — Focus tracking is single-winner, last-report-wins.** Gatoway core holds one piece of state: `focusedConnectionId: string | null`. Receiving `focus: { focused: true }` from a connection sets it as the sole focused connection, implicitly superseding any previous one (no requirement that the previous connection explicitly blur first) — this is deliberately tolerant of a crashed or buggy app that never sends `focused: false`, rather than requiring perfect handshake discipline between apps. Receiving `focused: false` from the *currently* focused connection clears it to `null` (idle). A disconnecting connection that was focused also clears it to `null`. Alternative considered: requiring an explicit blur-then-focus handshake with conflict rejection — rejected as more fragile (one missed blur message leaves the system stuck) for no real benefit at this scale.

**D3 — In-code test-fixture layout for this change only, resolving to a capability *id*, not a snapshot.** Gatoway core resolves `(focusedConnectionId, controller, position)` to a capability **id** (`string | null`) using a small, hardcoded in-memory structure built for this change's own tests — not a config file. This deliberately proves the resolution/routing *interface* and *logic* without pulling in step 6's real persistence work, matching `ARCHITECTURE.md`'s own delivery-sequence separation. The interface (a `LayoutResolver` with a `resolve(connectionId, controller, position)` method returning an id, plus `allPositions()`) is designed so step 6 can swap the in-code fixture for a real config-file-backed implementation without changing anything that depends on it. **Amended:** `resolve()` originally returned a full `Capability` object baked into the fixture itself — but that meant a `capability_update` (D7) could never actually change what gets rendered, since the fixture's embedded copy is static and disconnected from whatever the app actually registered or later updates. Resolution is now two steps: `LayoutResolver` answers *which capability id* occupies a position (the binding — still a config/persistence concern, still step 6's to make real); the *live* `Capability` object (including any `capability_update` changes) is looked up from the connection's own registered capabilities (D7), which is a connection-management concern, not a layout concern. This keeps the two responsibilities cleanly separated and makes `capability_update` actually work.

**D7 — Apps push live capability display updates; Gatoway core stores and re-renders them.** Each connection's declared capabilities (already stored on its `ConnectionRecord` since `gatoway-core-foundation`) are no longer a write-once snapshot: a `capability_update` message from a connection updates the matching capability (by id, sparse-merged — only provided fields change) within *that connection's own* capability list. If the sender is the currently focused connection and `LayoutResolver` has that capability id bound to one or more positions, Gatoway core immediately sends updated `render_update` message(s) reflecting the change to the Stream Deck plugin — an app doesn't have to wait for a fresh `input_event`/focus change to see its own pushed update take effect. An app can only update its own declared capabilities (looked up within its own connection record), never another connection's. Alternative considered: leaving capability data as a write-once registration snapshot, requiring an app to re-register (or disconnect/reconnect) to change its own display — rejected outright, since it directly contradicts `REQUIREMENTS.md` FR-001, an already-established MVP requirement.

**D4 — Idle rendering is Gatoway-core-driven, not plugin-hardcoded.** When `focusedConnectionId` is `null`, Gatoway core sends `render_update` messages describing a built-in idle appearance (matching what the previous static "Idle" action showed — an icon/"Gatoway" label at the position the user has placed a generic Key action) rather than the Stream Deck plugin having any idle-specific code of its own. This is the direct implementation of AD-8: the plugin is now fully generic, and "idle" is simply what gets rendered when nothing is focused. **Amended:** the idle sweep must explicitly reset `icon` back to the manifest's bundled default, not merely omit it — omitting a field means "leave unchanged" (sparse-update semantics), so an idle sweep that never mentions `icon` leaves whatever the previously-focused app's capability icon was still showing. Since `RenderUpdatePayload`'s fields are plain JSON, an explicit `icon: undefined` is indistinguishable on the wire from an omitted field (`JSON.stringify` drops both) — so "explicitly reset to default" needs its own distinct value. `render_update`'s `icon` field therefore accepts `string | null | undefined`: `undefined`/omitted means unchanged (unmodified from before), `null` means explicitly reset to the manifest's bundled default (the Stream Deck SDK's own `setImage()` call with no argument does exactly this). The idle sweep sends `icon: null`.

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
