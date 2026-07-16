## 1. Protocol Types

- [x] 1.1 In `gatoway-core/src/protocol/messages.ts`: replace `Capability`/`CapabilityUpdatePayload` with `SlotContent` (`{ icon?: string; label: string; state?: number }`), a `RegisterContent` shape (`{ buttons: SlotContent[]; dials: SlotContent[] }`), `DeviceCapacityPayload` (`{ buttonPositions: Position[]; dialPositions: Position[] }`), and `SlotCapacityPayload` (`{ buttonSlots: number; dialSlots: number }`)
- [x] 1.2 Update `RegisterPayload` to carry `content?: RegisterContent` in place of `capabilities?: Capability[]`
- [x] 1.3 Update `CommandPayload` to carry `controller` + `slotIndex: number` in place of `capabilityId: string`
- [x] 1.4 Remove the `capability_update` message type and its payload type entirely

## 2. Validation

- [x] 2.1 Replace `gatoway-core/src/protocol/capabilityValidation.ts` with a `SlotContent` validator (never throws; returns ok/reason per entry): `label` non-empty string (required); `icon` a string if present (no `null` at registration); `state` a number if present, and only valid on a `content.buttons` entry (present on a `content.dials` entry is itself a validation failure)
- [x] 2.2 Error reporting: rejected entries reported as `{ controller: "keypad" | "encoder", index: number, reason: string }[]` (renaming `rejectedCapabilities`/`rejectedFields` to a single `rejectedContent` shape)

## 3. Registration Handling

- [x] 3.1 Update `gatoway-core/src/connection/messageHandler.ts`'s registration handling to validate each entry in `content.buttons`/`content.dials` independently, dropping invalid entries (keeping valid ones) rather than failing the whole registration
- [x] 3.2 Send a follow-up `error` message (after `register_ack`) identifying rejected entries when one or more were dropped; send nothing extra when all entries are valid
- [x] 3.3 Confirm re-registration semantics: omitting `content` on a re-registration leaves the previous declaration unchanged; an explicit `content` (including empty arrays) always replaces it — reuse this existing mechanism, do not add a new one
- [x] 3.4 Add handling for the new `device_capacity` message: accept only from the `pluginType: "stream-deck"` connection; store the latest report in memory (never persisted); ignore/log-and-reject if sent by any other connection

## 4. Slot Capacity Delivery

- [x] 4.1 Send a `slot_capacity` message to a connection immediately after its own successful `register_ack`, derived from the current in-memory `device_capacity` report (both counts `0` if none has ever been received)
- [x] 4.2 Send a fresh `slot_capacity` message to a connection every time Gatoway core records it as newly focused (alongside existing `focus_changed` handling) — never on blur

## 5. Resolution Logic (replaces `layout.json`-based lookup)

- [x] 5.1 Rewrite `gatoway-core/src/routing/profileRouter.ts`'s input-event resolution: map the reported physical position to an ordinal index via the latest `device_capacity` report for the matching controller type; if not found, log and drop
- [x] 5.2 Check whether the focused connection's own `content.buttons`/`content.dials` has an entry at that ordinal index; if yes, send `command` with that `slotIndex`; if no (underflow — focused connection declared fewer entries than physical capacity), log and drop
- [x] 5.3 If nothing is focused, log and drop (unchanged from today)
- [x] 5.4 Rewrite `render_update` derivation: for the focused (or content-updated) connection, for each index present in its declared content, look up the corresponding physical position from the latest `device_capacity` report and send a `render_update` for it; sweep any remaining physical positions (up to full device capacity) to the idle appearance
- [x] 5.5 Re-registration while focused triggers an immediate re-render of all affected positions (replaces `capability_update`'s equivalent behavior)
- [x] 5.6 Idle sweep (on focus clear) spans every position in the most recent `device_capacity` report, not "every position bound in any configured profile" (that concept no longer exists)

## 6. Remove `persisted-layout-config`

- [x] 6.1 Delete `gatoway-core/src/routing/layoutConfig.ts` and `layoutStore.ts`, and their test files
- [x] 6.2 Remove the `GATOWAY_LAYOUT_FILE` environment variable and its handling from `gatoway-core/src/config.ts`
- [x] 6.3 Remove any remaining import/reference to the above from `profileRouter.ts` or elsewhere
- [x] 6.4 Confirm no other code path reads or writes a layout config file after this change

## 7. Stream Deck Plugin: Capacity Reporting

- [x] 7.1 Add logic (likely in `stream-deck-plugin/src/coreLifecycle/` or `coreClient/`) that derives the current ordered `buttonPositions`/`dialPositions` lists from the Elgato SDK's device/action info (`Device.size`, `Device.actions`), using a stable, deterministic order (e.g. row then column for keys; ascending index for dials) — document the chosen order in a code comment
- [x] 7.2 Send `device_capacity` once at the plugin's own registration with Gatoway core
- [x] 7.3 Listen for the relevant Elgato SDK events (device connected/disconnected, action `willAppear`/`willDisappear`) and re-send `device_capacity` whenever the derived lists actually change
- [x] 7.4 Confirm this doesn't interfere with existing render-state persistence (`renderStore.ts`) or the local-default-baseline behavior (QA-014's fix) — both should be unaffected
- [x] 7.5 Update `manifest.json`'s `Software.MinimumVersion` from `"6.5"` to `"7.0"` — task 7.3's `onDeviceDidChange` listener requires Stream Deck 7.0+, and the Elgato SDK's own runtime validation throws synchronously on registration if the declared minimum is below that. Caught live during `/verify` (crash-loop on every startup); confirmed installed Stream Deck version is `7.0.3`, so `7.0` is a real, already-satisfied requirement, not a workaround.

## 8. Testing

- [x] 8.1 Unit tests for the `SlotContent` validator: valid entry, missing `label`, invalid `icon` type, invalid `state` type, `state` present on a dial entry (rejected)
- [x] 8.2 Unit tests for registration handling: partial-entry rejection + `error`, full re-registration replacing content, omitted `content` leaving prior declaration unchanged
- [x] 8.3 Unit tests for `device_capacity` handling: accepted from `stream-deck` connection, rejected/ignored from any other `pluginType`
- [x] 8.4 Unit tests for `slot_capacity` delivery: sent after `register_ack`, sent again on focus gain, zero-counts when no `device_capacity` yet received
- [x] 8.5 Unit + integration tests for resolution: ordinal index resolved correctly; underflow (input event's index has no content entry) safely dropped; position not in `device_capacity` safely dropped; overflow (more declared content than capacity) never causes an out-of-range render — QA-019 fix: the overflow and mixed populated/idle sweep cases were previously untested (every fixture used a 1-button/1-dial device capacity, unable to distinguish "no content" from "overflow dropped" or "all idle" from "mixed"). Added `gatoway-core/test/unit/profileRouter.test.ts`'s "overflow / multi-position mixed sweep (QA-019)" describe block, using a new `MULTI_DEVICE_CAPACITY` fixture (3 button slots, 2 dial slots): one test declares 5 button/4 dial content entries against that capacity and asserts exactly 3/2 `render_update`s are sent (never one per overflow entry), that the overflow entries' labels never appear in the sweep, and that an `input_event` at the last in-capacity position still resolves normally; a second test declares content shorter than capacity for both controllers and asserts a single sweep renders the populated positions with their real content and the remaining positions with the idle appearance in the same pass. Both pass against the existing implementation unchanged (no functional defect found).
- [x] 8.6 Update `gatoway-core/test/manual/testAppClient.ts`, `tcpTestClient.ts`, `wsTestClient.ts` to speak the new `register` content shape and exercise `slot_capacity`
- [x] 8.7 Confirm the full existing suite (both workspaces) still passes after removing `persisted-layout-config`'s tests, with no orphaned references

## 9. Documentation

- [x] 9.1 Rewrite `docs/PROTOCOL.md`'s `register`/`Capability` sections for the new `content`/`SlotContent` shape; remove the `capability_update` section entirely; update `command`'s payload documentation for `slotIndex`
- [x] 9.2 Add `device_capacity` and `slot_capacity` sections to `docs/PROTOCOL.md`, documenting when each is sent and by/to whom
- [x] 9.3 Add pixel-dimension guidance to `docs/PROTOCOL.md`'s existing "Icon and label content" section (raised separately during this change's planning — not previously documented at all)
- [x] 9.4 Delete `docs/LAYOUT_CONFIG.md` entirely, and remove every cross-reference to it (`docs/PROTOCOL.md`'s current link, any README references)
- [x] 9.5 Update `gatoway-core/README.md`/`stream-deck-plugin/README.md` if either references the old capability/layout model

## 10. Amend for `ARCHITECTURE.md` v1.7 (QA-020: fixed-label addressing)

Sections 1-9 above implemented and verified `ARCHITECTURE.md` v1.6's ordinal-index/
placement-derived model, and passed QA (QA-016 line reused, actually QA-019) plus a
partial live `/verify` pass. Live verification then surfaced QA-020: ordinal-index
addressing resolved against *currently-placed* actions meant the same physical button
could mean a different slot depending on unrelated placement changes. `design.md` has
been rewritten in place (not appended) for the v1.7 model below — do not treat the v1.6
description as still current; sections 1-9's checkboxes remain checked as an honest
record of what was built and tested against v1.6, not because that model is still
correct.

- [x] 10.1 Update `gatoway-core/src/protocol/messages.ts`: `SlotContent` unchanged in
      shape, but `RegisterContent` becomes `Record<string, SlotContent>` (a flat map
      keyed by label, e.g. `"B1"`, `"D1"`) in place of `{ buttons: SlotContent[];
      dials: SlotContent[] }`. `CommandPayload` drops `controller`, keeping only
      `label: string` plus `eventType`/`delta`.
- [x] 10.2 Update `gatoway-core/src/protocol/slotContentValidation.ts`: validate each
      map entry's *key* is a currently-valid label (`B<n>`/`D<n>` within the most
      recently reported `device_capacity` counts) in addition to the existing
      value-shape validation (non-empty `label`, `icon` string, `state` only under a
      `B`-prefixed key). Update `rejectedContent` to `{ label: string; reason: string
      }[]` (drop the old `{ controller, index }` shape).
- [x] 10.3 Update `gatoway-core/src/connection/messageHandler.ts`'s registration
      handling for the new map-based `content` and label-keyed `rejectedContent`.
- [x] 10.4 Rewrite `gatoway-core/src/routing/profileRouter.ts`'s D6 resolution:
      derive a physical position's label from its index in `device_capacity`'s
      position lists (`buttonPositions[i]` → `"B" + (i+1)`, `dialPositions[i]` →
      `"D" + (i+1)`); look up that label directly in the focused connection's
      `content` map instead of indexing into an array. `render_update`/idle-sweep
      derivation follows the same label-keyed lookup, reversed.
- [x] 10.5 In `stream-deck-plugin/src/coreClient/deviceCapacity.ts`: change
      `computeDeviceCapacity()` to derive `buttonPositions` from `Device.size`
      (every `{row, column}` in the grid, not just currently-placed ones) and
      `dialPositions` from a new `DeviceType` → dial-count mapping. Build and verify
      this mapping against `@elgato/schemas`' own `DeviceType` documentation (dial
      counts are only in prose, e.g. "Stream Deck + ... 4 dials" — do not guess or
      assume completeness from memory; verify every entry actually used).
- [x] 10.6 Remove the `willAppear`/`willDisappear`-based placement-change listening
      added in task 7.3 entirely (not left dormant) — capacity now only depends on
      `Device.size`/`Device.type`, so only device connect/disconnect/change events
      matter. Confirm `deviceCapacityEqual()` (or its equivalent) still makes sense
      given capacity now only changes on a device event, not a placement event.
- [x] 10.7 Update all tests touched by 10.1-10.6: `slotContentValidation.test.ts`,
      `messageHandler.test.ts`, `profileRouter.test.ts` (including the QA-019
      overflow/mixed-sweep tests — re-express them against label-keyed content),
      `deviceCapacity.test.ts` (drop placement-based scenarios, add
      `Device.size`/`DeviceType`-based ones).
- [x] 10.8 Update `testAppClient.ts`/`tcpTestClient.ts`/`wsTestClient.ts` for the
      label-keyed `content` map and the new `command`/`error` shapes.
- [x] 10.9 Update all four spec deltas under `specs/` (already rewritten in this
      session — confirm they match the final implementation once built) and
      `docs/PROTOCOL.md` (rewritten once for v1.6 in task 9.1-9.2 — needs a further
      pass for the label-keyed shapes, dropped `controller` field, and the revised
      `device_capacity`/`slot_capacity` meaning).
- [x] 10.10 Full test suite + typecheck, both workspaces. Live re-verification (crash
      fix already confirmed working; device_capacity/slot_capacity delivery already
      confirmed working under the old meaning — needs re-confirming under the new
      one) resumes in `/verify` once this section is complete.

## 11. Amend for `ARCHITECTURE.md` v1.8 (QA-021: unknown-vs-zero capacity; QA-022: canonical label form)

Section 10 above implemented and QA-passed the v1.7 label-addressing model, except
for two findings from that QA pass: QA-021 (Major, design-level — registering before
capacity is known permanently rejects content, since "unknown" and "zero" were both
represented as `0`) and QA-022 (Minor, code-level — the label-key parser accepted
non-canonical forms like `"B01"` that could never be resolved). `design.md` and the
`message-protocol` spec delta have been rewritten in place for both fixes — read them
in full before starting; do not rely on memory of the v1.7-only model.

- [ ] 11.1 Change `SlotCapacityPayload`'s `buttonSlots`/`dialSlots` from `number` to
      `number | null` in `gatoway-core/src/protocol/messages.ts`. `null` means "not
      yet known" (no `device_capacity` report ever received) — distinct from a known
      `0`.
- [ ] 11.2 Update wherever `slot_capacity` is constructed (`profileRouter.ts`) to emit
      `null` when no `device_capacity` has been received yet, instead of `0`.
- [ ] 11.3 Add broadcast logic: the first time real capacity becomes known (a
      `device_capacity` report arrives after previously having none), and on every
      subsequent `device_capacity` report (device change), send a fresh
      `slot_capacity` to **every currently-connected application-type connection**
      (not just whichever connection's own register/focus-gain would normally trigger
      it) — iterate all connections excluding the `stream-deck`-typed one itself.
- [ ] 11.4 Update `slotContentValidation.ts`'s label-key parser to reject non-canonical
      forms (QA-022): exactly `B` or `D` followed by a positive integer with no
      leading zeros and no other characters. Confirm this is enforced regardless of
      whether capacity is currently known.
- [ ] 11.5 Update range-checking in the same validator: when capacity for the relevant
      dimension (`buttonSlots`/`dialSlots`) is `null` (unknown), skip the upper-bound
      range check entirely for a canonically-formed key — accept it provisionally.
      When capacity is known (a real number), check the range as before.
- [ ] 11.6 Confirm no retroactive re-validation/rejection occurs when capacity
      transitions from unknown to known for already-registered connections (D9) — a
      previously-accepted, now-out-of-range label simply never renders, exactly like
      any other out-of-range label; it is not actively dropped or re-reported via a
      new `error`.
- [ ] 11.7 Update tests: `slotContentValidation.test.ts` (unknown-capacity acceptance,
      known-capacity range rejection, non-canonical form rejection regardless of
      capacity state), `profileRouter.test.ts`/`messageHandler.test.ts` (the
      broadcast-to-all-connections behavior on first-known and on-device-change,
      `null` vs `0` in constructed `slot_capacity` payloads), and the manual test
      clients if they assume `slot_capacity`'s fields are always numbers.
- [ ] 11.8 Update `docs/PROTOCOL.md`'s `slot_capacity`/`register` sections for the
      `null`/unknown state, the canonical-label-form requirement, and the broadcast
      behavior.
- [ ] 11.9 Full test suite + typecheck, both workspaces.
