## ADDED Requirements

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
