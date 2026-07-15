## MODIFIED Requirements

### Requirement: Registration Message Type
The protocol SHALL define a `register` message type that a plugin sends to
authenticate and declare its displayed content, and a `register_ack` message type
that Gatoway core sends in response. A new connection — including one reconnecting
after a previous connection from the same plugin disconnected — SHALL send a fresh
`register`; nothing from a prior, now-disconnected connection carries over to it.
Content is declared as two ordered arrays, `content.buttons` and `content.dials`, each
entry addressed only by its position within its array — never by any plugin-chosen
identifier. Each entry SHALL be validated against the `SlotContent` shape (non-empty
`label`, `icon` a string if present, `state` a number if present and only on a
`content.buttons` entry); an entry that fails validation SHALL be dropped from the
connection's declared content rather than causing the whole registration to fail, and
Gatoway core SHALL send an `error` message afterward identifying which entries were
rejected and why. Sending `register` again on an already-authenticated connection
fully replaces its previously-declared content — omitting `content` leaves it
unchanged; an explicit `content` (including empty arrays) always replaces it. This is
the only mechanism for any content change (a live update, paging, entering or leaving
a nested group) — no separate update message type exists.

#### Scenario: Plugin registers successfully
- **WHEN** a plugin sends a `register` message containing valid authentication (token, or for WebSocket an allowlisted Origin) and declared content
- **THEN** Gatoway core responds with a `register_ack` message confirming successful registration

#### Scenario: Plugin registration rejected
- **WHEN** a plugin sends a `register` message that fails authentication
- **THEN** Gatoway core responds with a `register_ack` message reporting the rejection reason and then closes the connection

#### Scenario: Reconnecting plugin must register again
- **WHEN** a plugin that was previously registered disconnects and opens a new connection
- **THEN** the new connection has no declared content until it sends a fresh `register` message — the previous connection's declared content does not carry over

#### Scenario: Malformed content entry dropped, registration still succeeds
- **WHEN** a plugin sends a `register` message whose `content.buttons` or `content.dials` array contains one invalid entry (e.g. missing `label`, or a `state` field on a dial entry) alongside otherwise-valid entries
- **THEN** Gatoway core registers the connection successfully with only the valid entries, and sends a follow-up `error` message identifying the rejected entry (by controller and index) and the reason it was rejected

#### Scenario: All content entries malformed still registers with empty content
- **WHEN** every entry in a `register` message's `content.buttons`/`content.dials` arrays fails validation
- **THEN** Gatoway core still registers the connection successfully with empty content, and sends a follow-up `error` message identifying all rejected entries

#### Scenario: Re-registration replaces content
- **WHEN** an already-registered connection sends `register` again with a new, explicit `content`
- **THEN** Gatoway core replaces its stored content entirely — see `profile-routing`'s "Re-Registration While Focused Triggers Immediate Re-Render" for what happens next if that connection is currently focused

### Requirement: Command Message Type
The protocol SHALL define a `command` message type that Gatoway core sends to an
application plugin once an `input_event` has been resolved against an ordinal index
within that plugin's own declared content, with payload `{ controller: "keypad" |
"encoder", slotIndex: number, eventType: "keyDown" | "keyUp" | "rotate" | "push",
delta? }`. `slotIndex` identifies the entry's position within the focused connection's
own `content.buttons` (for `controller: "keypad"`) or `content.dials` (for
`controller: "encoder"`) array — Gatoway core carries no other meaning for it.
`eventType`/`delta` carry the same raw gesture information the originating
`input_event` reported, rather than an abstracted trigger/adjust vocabulary — the
application plugin itself decides what a given gesture means for its own content.

#### Scenario: Resolved key press sent as a command
- **WHEN** Gatoway core resolves an `input_event` with `eventType: "keyDown"` against an entry in the focused connection's `content.buttons`
- **THEN** Gatoway core sends that connection a `command` message with `controller: "keypad"`, that entry's ordinal `slotIndex`, and `eventType: "keyDown"`

#### Scenario: Resolved dial rotation sent as a command
- **WHEN** Gatoway core resolves an `input_event` with `eventType: "rotate"` and a `delta` against an entry in the focused connection's `content.dials`
- **THEN** Gatoway core sends that connection a `command` message with `controller: "encoder"`, that entry's ordinal `slotIndex`, `eventType: "rotate"`, and the same `delta`

## ADDED Requirements

### Requirement: Device Capacity Reporting Message Type
The protocol SHALL define a `device_capacity` message type, sent only by the
connection declaring `pluginType: "stream-deck"`, reporting the ordered list of
physical positions currently holding a generic Key action (`buttonPositions`) and the
ordered list currently holding a generic Dial action (`dialPositions`). It SHALL be
sent once at that connection's own registration, and again any time the set of placed
generic actions changes.

#### Scenario: Stream Deck plugin reports its initial capacity
- **WHEN** the Stream Deck plugin connection registers
- **THEN** it sends a `device_capacity` message describing every position currently holding a generic Key or Dial action

#### Scenario: Capacity change is reported
- **WHEN** a generic action is added to or removed from the connected device after the Stream Deck plugin has already registered
- **THEN** the Stream Deck plugin sends an updated `device_capacity` message reflecting the change

### Requirement: Slot Capacity Message Type
The protocol SHALL define a `slot_capacity` message type that Gatoway core sends to an
application plugin, reporting how many button slots and dial slots are currently
available (`{ buttonSlots: number, dialSlots: number }`), derived from the most
recent `device_capacity` report. It SHALL be sent once immediately after that
connection's own successful `register_ack`, and again every time Gatoway core records
that connection as newly focused.

#### Scenario: New connection receives initial capacity
- **WHEN** an application plugin registers successfully
- **THEN** Gatoway core sends it a `slot_capacity` message reflecting the current button/dial slot counts

#### Scenario: Capacity is refreshed on focus gain
- **WHEN** an application plugin reports gaining focus
- **THEN** Gatoway core sends it a fresh `slot_capacity` message reflecting the current counts, which may differ from what it received at connection time

#### Scenario: No capacity reported before the Stream Deck plugin connects
- **WHEN** an application plugin registers before any `device_capacity` report has ever been received
- **THEN** Gatoway core sends it a `slot_capacity` message with both counts at zero

## REMOVED Requirements

### Requirement: Capability Update Message Type
**Reason:** Superseded by re-sending `register` (see the modified Registration
Message Type requirement above), which now fully replaces a connection's declared
content and is the single mechanism for any content change.
**Migration:** A plugin that previously sent `capability_update` to change one
capability's icon/label/state now re-sends `register` with its complete, updated
`content` — there is no partial/single-entry update message.
