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
The protocol SHALL define a `register` message type that a plugin sends to authenticate
and declare its capability manifest, and a `register_ack` message type that Gatoway core
sends in response. A new connection — including one reconnecting after a previous
connection from the same plugin disconnected — SHALL send a fresh `register`; nothing
from a prior, now-disconnected connection carries over to it. Each entry in the declared
`capabilities` array SHALL be validated against the `Capability` shape (non-empty `id`,
non-empty `label`, `type` of exactly `"button"` or `"dial"`, `description`/`icon` a
string if present, `state` a number if present); an entry that fails validation SHALL be
dropped from the connection's declared manifest rather than causing the whole
registration to fail, and Gatoway core SHALL send an `error` message afterward
identifying which entries were rejected and why.

#### Scenario: Plugin registers successfully
- **WHEN** a plugin sends a `register` message containing valid authentication (token, or for WebSocket an allowlisted Origin) and a capability manifest
- **THEN** Gatoway core responds with a `register_ack` message confirming successful registration

#### Scenario: Plugin registration rejected
- **WHEN** a plugin sends a `register` message that fails authentication
- **THEN** Gatoway core responds with a `register_ack` message reporting the rejection reason and then closes the connection

#### Scenario: Reconnecting plugin must register again
- **WHEN** a plugin that was previously registered disconnects and opens a new connection
- **THEN** the new connection has no capability manifest until it sends a fresh `register` message — the previous connection's declared capabilities do not carry over

#### Scenario: Malformed capability dropped, registration still succeeds
- **WHEN** a plugin sends a `register` message whose `capabilities` array contains one capability with an invalid shape (e.g. missing `id`, or an unrecognized `type`) alongside otherwise-valid capabilities
- **THEN** Gatoway core registers the connection successfully with only the valid capabilities, and sends a follow-up `error` message identifying the rejected entry and the reason it was rejected

#### Scenario: All capabilities malformed still registers with an empty manifest
- **WHEN** every entry in a `register` message's `capabilities` array fails validation
- **THEN** Gatoway core still registers the connection successfully with an empty capability manifest, and sends a follow-up `error` message identifying all rejected entries

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
application plugin once an `input_event` has been resolved against that plugin's bound
capability, with payload `{ capabilityId: string, eventType: "keyDown" | "keyUp" | "rotate"
| "push", delta? }`. `eventType`/`delta` carry the same raw gesture information the
originating `input_event` reported, rather than an abstracted trigger/adjust vocabulary —
the application plugin itself decides what a given gesture means for its own capability.

#### Scenario: Resolved key press sent as a command
- **WHEN** Gatoway core resolves an `input_event` with `eventType: "keyDown"` against a bound capability on the focused connection
- **THEN** Gatoway core sends that connection a `command` message with the matching `capabilityId` and `eventType: "keyDown"`

#### Scenario: Resolved dial rotation sent as a command
- **WHEN** Gatoway core resolves an `input_event` with `eventType: "rotate"` and a `delta` against a bound capability on the focused connection
- **THEN** Gatoway core sends that connection a `command` message with the matching `capabilityId`, `eventType: "rotate"`, and the same `delta`

### Requirement: Capability Update Message Type
The protocol SHALL define a `capability_update` message type that an application plugin
sends to push a live display change to one of its own already-declared capabilities, with
payload `{ capabilityId: string, icon?, label?, state? }`. Fields other than
`capabilityId` are optional and sparse, using the same unchanged/omitted-versus-`null`-reset
semantics as `render_update`'s `icon`. An application plugin may only update capabilities it
has itself declared.

#### Scenario: Application pushes an icon/label change
- **WHEN** an application plugin sends a `capability_update` with its own previously-declared `capabilityId` and a new `icon` and/or `label`
- **THEN** Gatoway core updates its stored record of that capability to reflect the change

#### Scenario: Update ignored for an undeclared capability id
- **WHEN** an application plugin sends a `capability_update` referencing a `capabilityId` it did not declare at registration
- **THEN** Gatoway core does not apply the update
