## MODIFIED Requirements

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
