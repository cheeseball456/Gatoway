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
- **THEN** Gatoway core sends `render_update` messages to the Stream Deck plugin reflecting the built-in idle appearance, explicitly resetting `icon` to `null` at every position so a previously-focused connection's capability icon does not remain visually stuck

### Requirement: Rendered Content Reflects Live Capability Data
Gatoway core SHALL render a focused connection's bound layout using that connection's
current, live capability data (including any `capability_update` changes applied since
registration), not a static snapshot taken at registration time.

#### Scenario: Render reflects a capability update made before gaining focus
- **WHEN** a connection has already pushed a `capability_update` for a capability, and that connection subsequently gains focus
- **THEN** the `render_update` sent for that capability's bound position reflects the updated icon/label/state, not the value declared at registration

### Requirement: Capability Updates Trigger an Immediate Re-Render
Gatoway core SHALL immediately send an updated `render_update` to the Stream Deck plugin
when a `capability_update` is applied for a capability that is both bound to a position and
belongs to the currently focused connection.

#### Scenario: Live update while focused and bound
- **WHEN** the currently focused connection sends a `capability_update` for a capability bound to a position
- **THEN** Gatoway core immediately sends a `render_update` for that position reflecting the change, without waiting for a subsequent `input_event` or focus change

#### Scenario: Update while not focused produces no render
- **WHEN** a connection that is not currently focused sends a `capability_update`
- **THEN** Gatoway core updates its stored record but sends no `render_update`, since that connection's layout is not currently displayed
