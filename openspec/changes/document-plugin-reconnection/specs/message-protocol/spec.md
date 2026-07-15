## MODIFIED Requirements

### Requirement: Registration Message Type
The protocol SHALL define a `register` message type that a plugin sends to authenticate
and declare its capability manifest, and a `register_ack` message type that Gatoway core
sends in response. A new connection — including one reconnecting after a previous
connection from the same plugin disconnected — SHALL send a fresh `register`; nothing
from a prior, now-disconnected connection carries over to it.

#### Scenario: Plugin registers successfully
- **WHEN** a plugin sends a `register` message containing valid authentication (token, or for WebSocket an allowlisted Origin) and a capability manifest
- **THEN** Gatoway core responds with a `register_ack` message confirming successful registration

#### Scenario: Plugin registration rejected
- **WHEN** a plugin sends a `register` message that fails authentication
- **THEN** Gatoway core responds with a `register_ack` message reporting the rejection reason and then closes the connection

#### Scenario: Reconnecting plugin must register again
- **WHEN** a plugin that was previously registered disconnects and opens a new connection
- **THEN** the new connection has no capability manifest until it sends a fresh `register` message — the previous connection's declared capabilities do not carry over
