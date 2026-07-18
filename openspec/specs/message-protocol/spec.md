# message-protocol Specification

## Requirements

### Requirement: Unified Message Envelope
Every message exchanged between Gatoway core and a connected plugin, regardless of
transport, SHALL use a single JSON envelope containing a `type` field, an optional
`connectionId` field, and a `payload` object.

#### Scenario: Message parsed using the shared envelope
- **WHEN** Gatoway core receives a message over either TCP or WebSocket
- **THEN** it parses the message using the same envelope shape (type, optional connectionId, payload), regardless of which transport delivered it

### Requirement: Transport-Specific Framing
Gatoway core SHALL frame TCP messages as newline-delimited JSON (one JSON object per
line) and SHALL frame WebSocket messages as one JSON object per text frame.

#### Scenario: TCP message framed by newline
- **WHEN** Gatoway core sends a message over a TCP connection
- **THEN** the message is serialized as a single JSON object followed by a newline character, with no embedded unescaped newlines

#### Scenario: WebSocket message framed as a single text frame
- **WHEN** Gatoway core sends a message over a WebSocket connection
- **THEN** the message is serialized as a single JSON object and sent as one WebSocket text frame

### Requirement: Registration Message Type
The protocol SHALL define a `register` message type that a plugin sends to
authenticate and declare its displayed content, and a `register_ack` message type
that Gatoway core sends in response. A new connection — including one reconnecting
after a previous connection from the same plugin disconnected — SHALL send a fresh
`register`; nothing from a prior, now-disconnected connection carries over to it.
Content is declared as a flat map keyed by fixed physical-position label (e.g.
`"B1"`, `"D1"` — a `B`/`D` prefix plus a 1-based ordinal, no leading zeros, and no
other characters; `"B01"` or `"b1"` are not canonical and SHALL be rejected) — never
by any plugin-chosen identifier. Each entry SHALL be validated against the
`SlotContent` shape (non-empty `label`, `icon` a string if present, `state` a number
if present and only under a `B`-prefixed key); an entry that fails validation, has a
non-canonical key, or whose key is out of range for the most recently reported device
capacity SHALL be dropped from the connection's declared content rather than causing
the whole registration to fail, and Gatoway core SHALL send an `error` message
afterward identifying which entries were rejected and why. **While device capacity is
not yet known** (see `slot_capacity`'s `null` state), a canonical key's range SHALL
NOT be checked — only its canonical form and its value shape — since there is no
known bound to check against yet. Sending `register` again on an already-authenticated
connection fully replaces its previously-declared content — omitting `content` leaves
it unchanged; an explicit `content` (including an empty map) always replaces it. This
is the only mechanism for any content change (a live update, paging, entering or
leaving a nested group) — no separate update message type exists.

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
- **WHEN** a plugin sends a `register` message whose `content` map contains one invalid entry (e.g. missing `label`, a `state` field under a dial-prefixed key, or a key that is out of range for the currently-known device capacity) alongside otherwise-valid entries
- **THEN** Gatoway core registers the connection successfully with only the valid entries, and sends a follow-up `error` message identifying the rejected entry (by its label) and the reason it was rejected

#### Scenario: Non-canonical label form rejected
- **WHEN** a plugin sends a `register` message whose `content` map contains a key that is not in canonical form (e.g. `"B01"` with a leading zero, or `"b1"` in lowercase)
- **THEN** Gatoway core drops that entry and reports it via a follow-up `error` message, regardless of whether device capacity is currently known

#### Scenario: Canonical label accepted provisionally while capacity is unknown
- **WHEN** a plugin sends a `register` message whose `content` map contains a canonically-formed key (e.g. `"B5"`), and Gatoway core does not yet know the device's capacity
- **THEN** Gatoway core accepts that entry into the connection's declared content without checking whether `5` is actually in range — it may or may not ever render, depending on what capacity turns out to be once known

#### Scenario: All content entries malformed still registers with empty content
- **WHEN** every entry in a `register` message's `content` map fails validation
- **THEN** Gatoway core still registers the connection successfully with empty content, and sends a follow-up `error` message identifying all rejected entries

#### Scenario: Re-registration replaces content
- **WHEN** an already-registered connection sends `register` again with a new, explicit `content`
- **THEN** Gatoway core replaces its stored content entirely — see `profile-routing`'s "Re-Registration While Focused Triggers Immediate Re-Render" for what happens next if that connection is currently focused

### Requirement: Error Message Type
The protocol SHALL define an `error` message type usable by either Gatoway core or a
connected plugin to report a protocol-level error.

#### Scenario: Core reports a protocol error to a plugin
- **WHEN** Gatoway core receives a malformed message it cannot parse under the shared envelope, from a connection that is already authenticated
- **THEN** Gatoway core sends an `error` message describing the problem back to that connection

### Requirement: Focus Message Type
The protocol SHALL define a `focus` message type that an application plugin sends to
report its own focus state, with payload `{ focused: boolean }`.

#### Scenario: Application reports focus gained
- **WHEN** an application plugin sends a `focus` message with `payload: { focused: true }`
- **THEN** Gatoway core treats this as that connection reporting it has gained focus

#### Scenario: Application reports focus lost
- **WHEN** an application plugin sends a `focus` message with `payload: { focused: false }`
- **THEN** Gatoway core treats this as that connection reporting it has lost focus

### Requirement: Input Event Message Type
The protocol SHALL define an `input_event` message type that the Stream Deck plugin sends
to report raw physical input, with payload `{ controller: "keypad" | "encoder", position,
eventType: "keyDown" | "keyUp" | "rotate" | "push", delta? }`, where `position` is `{ row,
column }` for `controller: "keypad"` and `{ index }` for `controller: "encoder"`, and
`delta` is present only when `eventType` is `"rotate"`.

#### Scenario: Keypad press reported
- **WHEN** the Stream Deck plugin sends an `input_event` with `controller: "keypad"`, a `position` of `{ row, column }`, and `eventType: "keyDown"`
- **THEN** Gatoway core receives a well-formed report of that physical key being pressed

#### Scenario: Dial rotation reported
- **WHEN** the Stream Deck plugin sends an `input_event` with `controller: "encoder"`, a `position` of `{ index }`, `eventType: "rotate"`, and a `delta` value
- **THEN** Gatoway core receives a well-formed report of that dial being rotated by the given amount

### Requirement: Render Update Message Type
The protocol SHALL define a `render_update` message type that Gatoway core sends to the
Stream Deck plugin to specify what to display at a given position, with payload
`{ controller, position, icon?, label?, state? }` using the same `position` addressing as
`input_event`. Fields other than `controller`/`position` are optional and sparse: an
omitted field means "leave unchanged." `icon` additionally accepts `null` to mean
"explicitly reset to the manifest's bundled default image" — distinct from omission, since
these are indistinguishable once a field is dropped from the JSON payload entirely.

#### Scenario: Render update changes a key's label
- **WHEN** Gatoway core sends a `render_update` with a `controller`, `position`, and a `label` but no `icon` or `state`
- **THEN** the Stream Deck plugin updates only the label at that position, leaving any existing icon/state unchanged

#### Scenario: Render update explicitly resets the icon to default
- **WHEN** Gatoway core sends a `render_update` with `icon: null`
- **THEN** the Stream Deck plugin resets that position's displayed image to the manifest's bundled default, distinct from leaving a previously-set icon unchanged

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
device physically has (`{ buttonSlots: number | null, dialSlots: number | null }`),
derived from the most recent `device_capacity` report. A `null` value SHALL mean
capacity is not yet known (no `device_capacity` report has ever been received) —
distinct from a known value of `0`, which means the device is known to genuinely have
none of that control type. An application plugin derives its own valid label set
(`"B1".."B<buttonSlots>"`, `"D1".."D<dialSlots>"`) from these counts, once known,
using the documented labeling convention; the actual label strings are never
enumerated over the wire. It SHALL be sent once immediately after that connection's
own successful `register_ack`, again every time Gatoway core records that connection
as newly focused, and again, unsolicited, to every currently-connected application
plugin the first time real capacity becomes known after having been unknown, and on
any subsequent `device_capacity` change.

#### Scenario: New connection receives initial capacity
- **WHEN** an application plugin registers successfully, and capacity is already known
- **THEN** Gatoway core sends it a `slot_capacity` message reflecting the device's current button/dial slot counts

#### Scenario: Capacity is refreshed on focus gain
- **WHEN** an application plugin reports gaining focus
- **THEN** Gatoway core sends it a fresh `slot_capacity` message reflecting the current counts, which may differ from what it received at connection time if the device itself changed in between

#### Scenario: Unknown capacity reported before the Stream Deck plugin connects
- **WHEN** an application plugin registers before any `device_capacity` report has ever been received
- **THEN** Gatoway core sends it a `slot_capacity` message with both counts `null`, not `0`

#### Scenario: All connected plugins are notified once capacity first becomes known
- **WHEN** the Stream Deck plugin sends its first-ever `device_capacity` report, after one or more application plugins already registered while capacity was still unknown
- **THEN** Gatoway core sends each of those already-connected application plugins a fresh, unsolicited `slot_capacity` message reflecting the now-known counts, without waiting for their next registration or focus change

#### Scenario: All connected plugins are notified when the device itself changes
- **WHEN** the connected Stream Deck device changes (disconnected, or replaced by a different device) while one or more application plugins are already connected
- **THEN** Gatoway core sends each connected application plugin a fresh, unsolicited `slot_capacity` message reflecting the new counts
