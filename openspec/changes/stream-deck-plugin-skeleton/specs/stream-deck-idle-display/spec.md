## ADDED Requirements

### Requirement: Static Idle Profile Rendered Unconditionally
The Stream Deck plugin SHALL render its single static idle profile on the physical Stream
Deck hardware at plugin startup, independent of whether Gatoway core is currently
reachable.

#### Scenario: Idle profile shown at startup
- **WHEN** the Stream Deck plugin starts
- **THEN** the physical Stream Deck hardware displays the plugin's static idle profile

#### Scenario: Idle profile remains shown while disconnected
- **WHEN** the Stream Deck plugin is not currently connected to Gatoway core (e.g. still starting, or reconnecting)
- **THEN** the physical Stream Deck hardware continues showing the static idle profile rather than a blank or error state

### Requirement: Idle Profile Content Is Static
The idle profile's keys SHALL display fixed icons/labels with no dynamic content or
behavior in this change.

#### Scenario: No dynamic key behavior
- **WHEN** a key on the idle profile is pressed
- **THEN** no command is sent anywhere and no dynamic content update occurs, since no command message type or application connection exists yet
