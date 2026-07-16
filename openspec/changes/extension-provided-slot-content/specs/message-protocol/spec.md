## MODIFIED Requirements

### Requirement: Registration Message Type
The protocol SHALL define a `register` message type that a plugin sends to
authenticate and declare its displayed content, and a `register_ack` message type
that Gatoway core sends in response. A new connection — including one reconnecting
after a previous connection from the same plugin disconnected — SHALL send a fresh
`register`; nothing from a prior, now-disconnected connection carries over to it.
Content is declared as a flat map keyed by fixed physical-position label (e.g.
`"B1"`, `"D1"` — a `B`/`D` prefix plus a 1-based ordinal, self-describing button vs.
dial) — never by any plugin-chosen identifier. Each entry SHALL be validated against
the `SlotContent` shape (non-empty `label`, `icon` a string if present, `state` a
number if present and only under a `B`-prefixed key); an entry that fails validation,
or whose key is not a currently-valid label for the most recently reported device
capacity, SHALL be dropped from the connection's declared content rather than causing
the whole registration to fail, and Gatoway core SHALL send an `error` message
afterward identifying which entries were rejected and why. Sending `register` again
on an already-authenticated connection fully replaces its previously-declared
content — omitting `content` leaves it unchanged; an explicit `content` (including an
empty map) always replaces it. This is the only mechanism for any content change (a
live update, paging, entering or leaving a nested group) — no separate update message
type exists.

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
- **WHEN** a plugin sends a `register` message whose `content` map contains one invalid entry (e.g. missing `label`, a `state` field under a dial-prefixed key, or a key that isn't a currently-valid label) alongside otherwise-valid entries
- **THEN** Gatoway core registers the connection successfully with only the valid entries, and sends a follow-up `error` message identifying the rejected entry (by its label) and the reason it was rejected

#### Scenario: All content entries malformed still registers with empty content
- **WHEN** every entry in a `register` message's `content` map fails validation
- **THEN** Gatoway core still registers the connection successfully with empty content, and sends a follow-up `error` message identifying all rejected entries

#### Scenario: Re-registration replaces content
- **WHEN** an already-registered connection sends `register` again with a new, explicit `content`
- **THEN** Gatoway core replaces its stored content entirely — see `profile-routing`'s "Re-Registration While Focused Triggers Immediate Re-Render" for what happens next if that connection is currently focused

### Requirement: Command Message Type
The protocol SHALL define a `command` message type that Gatoway core sends to an
application plugin once an `input_event` has been resolved against a fixed label
within that plugin's own declared content, with payload `{ label: string, eventType:
"keyDown" | "keyUp" | "rotate" | "push", delta? }`. `label` identifies the entry
within the focused connection's own `content` map (e.g. `"B3"`, `"D1"`) — Gatoway core
carries no other meaning for it. There is no separate `controller` field: the label's
own prefix (`B` for button, `D` for dial) already conveys the controller type.
`eventType`/`delta` carry the same raw gesture information the originating
`input_event` reported, rather than an abstracted trigger/adjust vocabulary — the
application plugin itself decides what a given gesture means for its own content.

#### Scenario: Resolved key press sent as a command
- **WHEN** Gatoway core resolves an `input_event` with `eventType: "keyDown"` against an entry in the focused connection's `content` under a `B`-prefixed label
- **THEN** Gatoway core sends that connection a `command` message with that label and `eventType: "keyDown"`

#### Scenario: Resolved dial rotation sent as a command
- **WHEN** Gatoway core resolves an `input_event` with `eventType: "rotate"` and a `delta` against an entry in the focused connection's `content` under a `D`-prefixed label
- **THEN** Gatoway core sends that connection a `command` message with that label, `eventType: "rotate"`, and the same `delta`

## ADDED Requirements

### Requirement: Device Capacity Reporting Message Type
The protocol SHALL define a `device_capacity` message type, sent only by the
connection declaring `pluginType: "stream-deck"`, reporting the connected device's
fixed physical layout: the ordered list of physical button positions
(`buttonPositions`) and the ordered list of physical dial positions
(`dialPositions`), derived from the device's actual hardware capacity — not from
which positions currently have a generic action placed on them. It SHALL be sent once
at that connection's own registration, and again only if the connected device itself
changes (connected, disconnected, or replaced by a different device).

#### Scenario: Stream Deck plugin reports its initial capacity
- **WHEN** the Stream Deck plugin connection registers
- **THEN** it sends a `device_capacity` message describing the connected device's full physical button and dial layout

#### Scenario: Capacity is stable across placement changes
- **WHEN** a generic Key or Dial action is added to or removed from the connected device, with the device itself unchanged
- **THEN** the Stream Deck plugin does not send a new `device_capacity` message, since the device's physical capacity has not changed

#### Scenario: Capacity change is reported when the device itself changes
- **WHEN** the connected Stream Deck device is disconnected, or replaced by a different device
- **THEN** the Stream Deck plugin sends an updated `device_capacity` message reflecting the new device's physical layout (or an empty layout if none is connected)

### Requirement: Slot Capacity Message Type
The protocol SHALL define a `slot_capacity` message type that Gatoway core sends to an
application plugin, reporting how many button slots and dial slots the connected
device physically has (`{ buttonSlots: number, dialSlots: number }`), derived from
the most recent `device_capacity` report. An application plugin derives its own valid
label set (`"B1".."B<buttonSlots>"`, `"D1".."D<dialSlots>"`) from these counts using
the documented labeling convention; the actual label strings are never enumerated
over the wire. It SHALL be sent once immediately after that connection's own
successful `register_ack`, and again every time Gatoway core records that connection
as newly focused.

#### Scenario: New connection receives initial capacity
- **WHEN** an application plugin registers successfully
- **THEN** Gatoway core sends it a `slot_capacity` message reflecting the device's current button/dial slot counts

#### Scenario: Capacity is refreshed on focus gain
- **WHEN** an application plugin reports gaining focus
- **THEN** Gatoway core sends it a fresh `slot_capacity` message reflecting the current counts, which may differ from what it received at connection time if the device itself changed in between

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
