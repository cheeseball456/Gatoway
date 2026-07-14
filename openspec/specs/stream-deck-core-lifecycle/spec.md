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
