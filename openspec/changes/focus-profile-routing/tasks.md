## 1. Message Protocol Extension (gatoway-core)

- [x] 1.1 Define the `focus` message payload type (`{ focused: boolean }`)
- [x] 1.2 Define the `input_event` message payload type (`controller`, `position`, `eventType`, optional `delta`)
- [x] 1.3 Define the `render_update` message payload type (`controller`, `position`, optional `icon`/`label`/`state`)
- [x] 1.4 Extend envelope validation/parsing to accept the three new message types without changing existing `register`/`register_ack`/`error` handling (no source change needed — `envelope.ts`'s `decodeMessage` was already generic over `type`; added round-trip tests in `envelope.test.ts` confirming this)

## 2. Focus Tracking (gatoway-core)

- [x] 2.1 Add `focusedConnectionId` state to the connection manager (or an adjacent component), defaulting to none (implemented as an adjacent `FocusTracker` component, `src/focus/focusTracker.ts`)
- [x] 2.2 Handle incoming `focus` messages: `focused: true` sets the sender as focused, superseding any previous focused connection without requiring an explicit blur
- [x] 2.3 Handle `focused: false` from the currently focused connection: clear focus to none
- [x] 2.4 Clear focus to none when the currently focused connection disconnects
- [x] 2.5 Log every focus change (previous focused connection, new focused connection, reason)

## 3. Profile Routing and Resolution (gatoway-core)

- [x] 3.1 Define the `LayoutResolver` interface (`resolve(connectionId, controller, position) -> capability | null`)
- [x] 3.2 Implement an in-code test-fixture `LayoutResolver` for this change's own tests (explicitly not real persistence — step 6 replaces this)
- [x] 3.3 Handle incoming `input_event`: resolve against the focused connection via `LayoutResolver`; if resolved, send the corresponding command to that connection; if not (no focus, or no binding), log and take no further action
- [x] 3.4 On focus change (a connection gains focus), send `render_update` messages to the Stream Deck plugin reflecting that connection's bound layout via `LayoutResolver`
- [x] 3.5 On focus cleared (idle), send `render_update` messages to the Stream Deck plugin reflecting the built-in idle appearance

## 4. Stream Deck Plugin: Generic Action Model

- [x] 4.1 Remove `idleAction.ts`, `idleKeyRenderer.ts`, and the `Idle` action's manifest entry and image assets no longer needed
- [x] 4.2 Add a generic Keypad action (manifest entry + implementation) that sends `input_event` on key down/up
- [x] 4.3 Add a generic Encoder (dial) action (manifest entry + implementation) that sends `input_event` on rotate/push
- [x] 4.4 Implement rendering logic shared by both generic actions: apply whatever the most recent `render_update` for that position specified
- [x] 4.5 Ensure displayed content is never cleared/blanked on Gatoway core disconnect — persists until the next `render_update` after reconnect
- [x] 4.6 Update `manifest.json`'s tooltip/description text to describe the generic actions instead of the removed static Idle action

## 5. Protocol Reference Documentation

- [x] 5.1 Draft a protocol reference document covering the full message contract: envelope, `register`/`register_ack`/`error` (existing), `focus`/`input_event`/`render_update` (new), and the capability manifest shape — in enough detail that a future application plugin author needs no other source (`docs/PROTOCOL.md`)
- [x] 5.2 Cross-check the document against the actual implemented types/behavior before finalizing (hand off final polish/placement to `doc-writer`) — cross-checked against `gatoway-core/src/protocol/messages.ts`, `focusTracker.ts`, and `profileRouter.ts`; final polish/placement still left to `doc-writer`

## 6. Testing and Verification

- [x] 6.1 Write unit tests for focus tracking (single-winner supersession, blur, disconnect-clears-focus)
- [x] 6.2 Write unit tests for the in-code `LayoutResolver` fixture and input-event resolution (resolved case, no-focus case, no-binding case)
- [x] 6.3 Write integration tests using test-double TCP/WS connections that register, report focus, and exchange `input_event`/`render_update` with a real running Gatoway core instance, mirroring `gatoway-core-foundation`'s real-socket testing approach
- [x] 6.4 Write unit/integration tests for the Stream Deck plugin's generic actions (input forwarding, render-update application, no-clear-on-disconnect)
- [ ] 6.5 Manually verify on physical Stream Deck+ hardware, using test-double app connections (no real Lightroom/xDesign yet): placing the generic actions, seeing the idle appearance by default, simulating a test app gaining focus and seeing the display update accordingly, pressing a bound key and confirming the resolved command is sent, and confirming the idle appearance returns when the test app blurs or disconnects (deferred — requires the user's real Stream Deck+ hardware and the Elgato Stream Deck application; see developer report)
