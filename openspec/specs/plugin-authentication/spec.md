# plugin-authentication Specification

## Requirements

### Requirement: TCP Token Authentication
Gatoway core SHALL require every TCP connection to present a valid shared-secret token
in its registration message. The token SHALL be generated fresh each time Gatoway core
starts and stored in a local file restricted to the owning user's read access.

#### Scenario: Valid token accepted
- **WHEN** a TCP connection sends a registration message containing the current valid token
- **THEN** Gatoway core marks the connection as authenticated

#### Scenario: Invalid or missing token rejected
- **WHEN** a TCP connection sends a registration message with a missing or incorrect token
- **THEN** Gatoway core rejects the registration, closes the connection, and does not mark it authenticated

#### Scenario: Token regenerated on each core startup
- **WHEN** Gatoway core starts
- **THEN** it generates a new random token and writes it to the local token file, replacing any previous token

### Requirement: WebSocket Origin Allowlisting
Gatoway core SHALL accept a WebSocket connection's upgrade request only if its `Origin`
header matches an entry in a configured allowlist of known browser-extension origins.
An allowlist entry ending in `*` SHALL match any origin sharing the prefix preceding the
`*`; an entry without a trailing `*` SHALL match only that exact origin.

#### Scenario: Allowlisted exact origin accepted
- **WHEN** a WebSocket upgrade request's `Origin` header matches an allowlisted exact-match extension origin
- **THEN** Gatoway core completes the upgrade and marks the connection as authenticated

#### Scenario: Allowlisted wildcard prefix accepted
- **WHEN** a WebSocket upgrade request's `Origin` header starts with the prefix of an allowlisted wildcard entry (e.g. `moz-extension://*` and an origin of `moz-extension://<any-uuid>`)
- **THEN** Gatoway core completes the upgrade and marks the connection as authenticated

#### Scenario: Non-allowlisted origin refused
- **WHEN** a WebSocket upgrade request's `Origin` header does not match any allowlisted origin (exact or wildcard)
- **THEN** Gatoway core refuses the upgrade request and no connection is established

### Requirement: Authentication Attempts Are Logged
Gatoway core SHALL log every authentication success and failure, including the
connection ID and transport type.

#### Scenario: Successful authentication logged
- **WHEN** a connection successfully authenticates via token or Origin check
- **THEN** Gatoway core writes a log entry recording the success, the connection ID, and the transport type

#### Scenario: Failed authentication logged
- **WHEN** a connection fails its token or Origin check
- **THEN** Gatoway core writes a log entry recording the failure, the connection ID (if assigned), and the transport type
