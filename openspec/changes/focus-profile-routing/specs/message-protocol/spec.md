## ADDED Requirements

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
`input_event`. Fields other than `controller`/`position` are optional — an update only sets
what is changing.

#### Scenario: Render update changes a key's label
- **WHEN** Gatoway core sends a `render_update` with a `controller`, `position`, and a `label` but no `icon` or `state`
- **THEN** the Stream Deck plugin updates only the label at that position, leaving any existing icon/state unchanged

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
