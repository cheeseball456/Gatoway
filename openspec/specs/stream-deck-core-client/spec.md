# stream-deck-core-client Specification

## Requirements

### Requirement: Plugin Registers With Gatoway Core
The Stream Deck plugin SHALL connect to Gatoway core's TCP listener and register using
the existing `register`/`register_ack` protocol, presenting the current auth token and
declaring plugin type `stream-deck`.

#### Scenario: Successful registration
- **WHEN** the Stream Deck plugin connects to Gatoway core's TCP listener and sends a `register` message with a valid token and plugin type `stream-deck`
- **THEN** Gatoway core responds with a `register_ack` message with `status: "ok"`, and the Stream Deck plugin treats itself as connected

#### Scenario: Rejected registration
- **WHEN** Gatoway core responds to the Stream Deck plugin's `register` message with a `register_ack` reporting rejection
- **THEN** the Stream Deck plugin does not treat itself as connected

### Requirement: Reconnection With Backoff
The Stream Deck plugin SHALL retry connecting to Gatoway core with a backoff delay if the
connection is lost or a registration attempt is rejected.

#### Scenario: Reconnect after disconnect
- **WHEN** the Stream Deck plugin's connection to Gatoway core is lost after having been connected
- **THEN** the Stream Deck plugin attempts to reconnect and re-register after a backoff delay

#### Scenario: Reconnect after rejected registration
- **WHEN** a registration attempt is rejected
- **THEN** the Stream Deck plugin attempts to reconnect and re-register after a backoff delay, rather than giving up permanently
