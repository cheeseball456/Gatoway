## ADDED Requirements

### Requirement: Input Event Resolution Against the Focused Connection
Gatoway core SHALL resolve an incoming `input_event` against the currently focused
connection's bound capability at the reported position, and forward a corresponding
command to that connection.

#### Scenario: Input event resolved to a bound capability
- **WHEN** a connection is focused and has a capability bound to the position reported in an `input_event`
- **THEN** Gatoway core sends a command for that capability to the focused connection

### Requirement: Input Events Are Safely Ignored When Unresolvable
Gatoway core SHALL NOT error or crash when an `input_event` cannot be resolved — either
because no connection is currently focused, or because the focused connection has no
capability bound at the reported position.

#### Scenario: No connection is focused
- **WHEN** an `input_event` is received while no connection is focused
- **THEN** Gatoway core takes no action beyond logging the event; nothing is sent to any connection

#### Scenario: Focused connection has no binding at that position
- **WHEN** an `input_event` is received for a position the focused connection has no capability bound to
- **THEN** Gatoway core takes no action beyond logging the event; nothing is sent to any connection

### Requirement: Render Updates Reflect Focus Changes
Gatoway core SHALL send `render_update` messages to the Stream Deck plugin reflecting the
currently focused connection's bound layout whenever focus changes, and SHALL send
`render_update` messages reflecting a built-in idle appearance whenever no connection is
focused.

#### Scenario: Render updates sent when a connection gains focus
- **WHEN** a connection becomes the focused connection
- **THEN** Gatoway core sends `render_update` messages to the Stream Deck plugin reflecting that connection's bound layout

#### Scenario: Render updates sent when focus is cleared
- **WHEN** the focused connection is cleared to none (via blur or disconnect)
- **THEN** Gatoway core sends `render_update` messages to the Stream Deck plugin reflecting the built-in idle appearance
