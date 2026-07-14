# stream-deck-idle-display Specification

## Requirements

### Requirement: Generic Actions Forward Input Events
The Stream Deck plugin's generic Key and Dial actions SHALL send a corresponding
`input_event` message to Gatoway core whenever physically interacted with.

#### Scenario: Key press forwarded
- **WHEN** a user presses a physical key with the generic Key action placed on it
- **THEN** the plugin sends an `input_event` with `controller: "keypad"`, that key's position, and `eventType: "keyDown"`

#### Scenario: Dial rotation forwarded
- **WHEN** a user rotates a physical dial with the generic Dial action placed on it
- **THEN** the plugin sends an `input_event` with `controller: "encoder"`, that dial's position, `eventType: "rotate"`, and the rotation delta

### Requirement: Generic Actions Render Per Gatoway Core Instructions
The Stream Deck plugin's generic Key and Dial actions SHALL display whatever a
`render_update` message most recently specified for their position, and SHALL NOT display
any hardcoded app-specific or idle-specific content of their own.

#### Scenario: Render update changes displayed content
- **WHEN** Gatoway core sends a `render_update` for a position with a generic action placed on it
- **THEN** the plugin updates that position's displayed icon/label/state to match

### Requirement: Displayed Content Persists Across Gatoway Core Disconnects
The Stream Deck plugin SHALL NOT clear or blank a generic action's displayed content when
Gatoway core disconnects or is unreachable — whatever was most recently rendered (via
`render_update`, including the idle appearance) SHALL remain visible until Gatoway core
reconnects and sends a new instruction.

#### Scenario: Content persists through disconnect
- **WHEN** Gatoway core disconnects or becomes unreachable
- **THEN** the physical Stream Deck hardware continues showing whatever was last rendered, rather than a blank or error state

#### Scenario: Content persists through Gatoway core restart
- **WHEN** Gatoway core restarts and reconnects
- **THEN** the previously displayed content remains visible until Gatoway core sends a new `render_update`, at which point it updates accordingly

### Requirement: Local Default Baseline Applied Independent of Gatoway Core
The Stream Deck plugin's generic Key and Dial actions SHALL apply a local default
baseline — the manifest's own declared default label and icon — immediately upon first
appearing whenever no remembered render state exists yet for that position, without
waiting for or depending on any message from Gatoway core.

#### Scenario: Baseline applied with no remembered state and no Gatoway core message yet
- **WHEN** a generic action appears with no previously remembered render state for its position (e.g. a fresh placement, or the plugin process itself having just restarted)
- **THEN** the plugin immediately applies its manifest-declared default label and icon, without waiting for a `render_update` from Gatoway core

#### Scenario: A later render_update still overrides the local baseline
- **WHEN** Gatoway core subsequently sends a `render_update` for that position
- **THEN** the plugin's displayed content updates to reflect it, exactly as if no local baseline had been applied first
