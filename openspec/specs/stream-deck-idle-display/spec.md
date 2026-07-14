# stream-deck-idle-display Specification

## Requirements

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

### Requirement: Idle Profile Content Is Static
The idle profile's keys SHALL display fixed icons/labels with no dynamic content or
behavior in this change.

#### Scenario: No dynamic key behavior
- **WHEN** a key on the idle profile is pressed
- **THEN** no command is sent anywhere and no dynamic content update occurs, since no command message type or application connection exists yet
