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
