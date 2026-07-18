# stream-deck-core-lifecycle Specification

## Requirements

### Requirement: Gatoway Core Spawned On Plugin Startup
The Stream Deck plugin SHALL spawn Gatoway core as a child process when the plugin
itself starts.

#### Scenario: Gatoway core started alongside the plugin
- **WHEN** the Stream Deck plugin starts
- **THEN** it spawns Gatoway core as a child process

### Requirement: Gatoway Core Supervision and Restart
The Stream Deck plugin SHALL supervise the Gatoway core child process and restart it,
with a backoff delay, if it exits unexpectedly.

#### Scenario: Unexpected exit triggers a restart
- **WHEN** the Gatoway core child process exits unexpectedly while the Stream Deck plugin is still running
- **THEN** the Stream Deck plugin spawns a new Gatoway core child process after a backoff delay

#### Scenario: Restart is logged
- **WHEN** the Stream Deck plugin restarts the Gatoway core child process
- **THEN** it logs the restart, including the reason the previous process ended if available

### Requirement: Spawn Failure Is Reported Clearly
If the Stream Deck plugin fails to spawn the Gatoway core child process at all (e.g. its
built entry point cannot be located), the plugin SHALL report this failure visibly rather
than failing silently.

#### Scenario: Spawn failure produces a visible error
- **WHEN** the Stream Deck plugin cannot spawn the Gatoway core child process
- **THEN** it logs or otherwise visibly reports a clear error describing the failure, rather than continuing silently as if nothing were wrong

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

### Requirement: Configured Origin Allowlist Forwarded to Spawned Gatoway Core
The Stream Deck plugin SHALL read a locally-configured list of allowed WebSocket
Origins at its own startup, from a dedicated local JSON config file, and SHALL forward
that list to the Gatoway core child process it spawns as `GATOWAY_ALLOWED_ORIGINS`. This
SHALL work identically regardless of how the Stream Deck application itself was
launched (GUI or terminal), since it does not depend on the plugin process's own
inherited environment.

#### Scenario: Configured origins are forwarded to the spawned child
- **WHEN** the Stream Deck plugin starts and its local allowed-origins config file contains one or more valid Origin entries
- **THEN** the Gatoway core child process it spawns receives those entries via `GATOWAY_ALLOWED_ORIGINS`, exactly as if they had been set directly in that child's own environment

#### Scenario: Missing or malformed config file falls back to an empty allowlist
- **WHEN** the Stream Deck plugin's local allowed-origins config file is missing, is not valid JSON, or does not match the expected schema
- **THEN** the Stream Deck plugin still spawns Gatoway core successfully, without setting `GATOWAY_ALLOWED_ORIGINS` (an empty, fail-closed allowlist, matching Gatoway core's own default), and logs which of these cases occurred
