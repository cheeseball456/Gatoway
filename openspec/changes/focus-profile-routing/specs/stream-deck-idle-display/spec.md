## REMOVED Requirements

### Requirement: Static Idle Key Rendered Once Placed, Independent of Gatoway Core
The Stream Deck plugin's Idle action SHALL render correctly on the physical Stream Deck
hardware once the user manually places it on a key — a one-time setup step consistent
with standard Stream Deck plugin UX (the plugin is not bundled with a profile that
auto-installs it). From that point on, the idle key SHALL continue to render correctly
independent of whether Gatoway core is currently reachable, including across Gatoway
core disconnects and restarts.

#### Scenario: Idle key renders once manually placed
- **WHEN** the user drags the plugin's Idle action onto a key on their Stream Deck hardware
- **THEN** the physical Stream Deck hardware displays the idle key's icon and title correctly

#### Scenario: Idle key persists across Gatoway core disconnects and restarts
- **WHEN** the Stream Deck plugin is not currently connected to Gatoway core (e.g. still starting, reconnecting, or Gatoway core has restarted)
- **THEN** the physical Stream Deck hardware continues showing the idle key rather than a blank or error state

**Reason**: Superseded by AD-8 (`ARCHITECTURE.md` v1.2) — a single hardcoded, always-static
"Idle" action is replaced by generic, position-based actions whose content Gatoway core
controls dynamically via `render_update`, including the idle appearance itself.

**Migration**: Developers who already placed the old "Idle" action on a key must manually
re-place the new generic Key/Dial action after upgrading — there is no automatic migration,
since Gatoway has no public users yet. Documented in `stream-deck-plugin/README.md`.

### Requirement: Idle Profile Content Is Static
The idle profile's keys SHALL display fixed icons/labels with no dynamic content or
behavior in this change.

#### Scenario: No dynamic key behavior
- **WHEN** a key on the idle profile is pressed
- **THEN** no command is sent anywhere and no dynamic content update occurs, since no command message type or application connection exists yet

**Reason**: Superseded — a `command`-equivalent path now exists (`input_event`/
`render_update`, this change), so "no dynamic behavior" is no longer true in general;
dynamic behavior is instead scoped per-position by whether the focused connection has a
capability bound there (see `profile-routing`'s "Input Events Are Safely Ignored When
Unresolvable" requirement for the still-safe no-op case).

**Migration**: Not applicable — behavior is superseded, not migrated; no user-facing state
depends on the old static guarantee.

## ADDED Requirements

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
