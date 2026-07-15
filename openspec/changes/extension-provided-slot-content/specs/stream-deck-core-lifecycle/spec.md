## ADDED Requirements

### Requirement: Live Slot Capacity Reported to Gatoway Core
The Stream Deck plugin SHALL report the connected device's live slot capacity — the
ordered list of physical positions currently holding a generic Key action, and the
ordered list currently holding a generic Dial action — to Gatoway core via a
`device_capacity` message, once at its own registration and again any time that
capacity changes.

#### Scenario: Initial capacity reported at registration
- **WHEN** the Stream Deck plugin registers with Gatoway core
- **THEN** it sends a `device_capacity` message reflecting every position currently holding a generic Key or Dial action

#### Scenario: Capacity change is reported without requiring a restart
- **WHEN** a generic Key or Dial action is added to or removed from the connected device while the Stream Deck plugin is already connected
- **THEN** the Stream Deck plugin sends an updated `device_capacity` message reflecting the change, without needing to reconnect or restart
