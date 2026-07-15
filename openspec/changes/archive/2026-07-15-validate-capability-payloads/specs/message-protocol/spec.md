## MODIFIED Requirements

### Requirement: Registration Message Type
The protocol SHALL define a `register` message type that a plugin sends to authenticate
and declare its capability manifest, and a `register_ack` message type that Gatoway core
sends in response. A new connection — including one reconnecting after a previous
connection from the same plugin disconnected — SHALL send a fresh `register`; nothing
from a prior, now-disconnected connection carries over to it. Each entry in the declared
`capabilities` array SHALL be validated against the `Capability` shape (non-empty `id`,
non-empty `label`, `type` of exactly `"button"` or `"dial"`, `description`/`icon` a
string if present, `state` a number if present); an entry that fails validation SHALL be
dropped from the connection's declared manifest rather than causing the whole
registration to fail, and Gatoway core SHALL send an `error` message afterward
identifying which entries were rejected and why.

#### Scenario: Plugin registers successfully
- **WHEN** a plugin sends a `register` message containing valid authentication (token, or for WebSocket an allowlisted Origin) and a capability manifest
- **THEN** Gatoway core responds with a `register_ack` message confirming successful registration

#### Scenario: Plugin registration rejected
- **WHEN** a plugin sends a `register` message that fails authentication
- **THEN** Gatoway core responds with a `register_ack` message reporting the rejection reason and then closes the connection

#### Scenario: Reconnecting plugin must register again
- **WHEN** a plugin that was previously registered disconnects and opens a new connection
- **THEN** the new connection has no capability manifest until it sends a fresh `register` message — the previous connection's declared capabilities do not carry over

#### Scenario: Malformed capability dropped, registration still succeeds
- **WHEN** a plugin sends a `register` message whose `capabilities` array contains one capability with an invalid shape (e.g. missing `id`, or an unrecognized `type`) alongside otherwise-valid capabilities
- **THEN** Gatoway core registers the connection successfully with only the valid capabilities, and sends a follow-up `error` message identifying the rejected entry and the reason it was rejected

#### Scenario: All capabilities malformed still registers with an empty manifest
- **WHEN** every entry in a `register` message's `capabilities` array fails validation
- **THEN** Gatoway core still registers the connection successfully with an empty capability manifest, and sends a follow-up `error` message identifying all rejected entries
