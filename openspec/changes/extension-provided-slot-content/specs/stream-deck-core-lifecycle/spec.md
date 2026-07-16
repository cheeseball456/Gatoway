## ADDED Requirements

### Requirement: Fixed Physical Device Capacity Reported to Gatoway Core
The Stream Deck plugin SHALL report the connected device's fixed physical layout —
the ordered list of physical button positions and the ordered list of physical dial
positions, derived from the device's actual hardware capacity, not from which
positions currently have a generic action placed on them — to Gatoway core via a
`device_capacity` message, once at its own registration and again only if the
connected device itself changes.

#### Scenario: Initial capacity reported at registration
- **WHEN** the Stream Deck plugin registers with Gatoway core
- **THEN** it sends a `device_capacity` message reflecting the connected device's full physical button and dial layout

#### Scenario: Placement changes do not trigger a new report
- **WHEN** a generic Key or Dial action is added to or removed from the connected device, with the device itself unchanged
- **THEN** the Stream Deck plugin does not send a new `device_capacity` message, since the device's physical capacity is unaffected

#### Scenario: A device change is reported without requiring a restart
- **WHEN** the connected Stream Deck device is disconnected, or a different device is connected in its place, while the Stream Deck plugin is already running
- **THEN** the Stream Deck plugin sends an updated `device_capacity` message reflecting the new physical layout, without needing to reconnect or restart
