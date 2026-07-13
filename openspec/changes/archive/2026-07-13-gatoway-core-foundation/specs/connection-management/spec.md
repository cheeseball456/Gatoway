## ADDED Requirements

### Requirement: Loopback-Only Network Binding
Gatoway core SHALL bind its TCP listener and WebSocket listener exclusively to the
IPv4 loopback interface (`127.0.0.1`), and SHALL NOT bind to any non-loopback interface
(e.g. `0.0.0.0`). IPv6 loopback (`::1`) is not required and is not bound.

#### Scenario: Listeners bound only to loopback
- **WHEN** Gatoway core starts its TCP and WebSocket listeners
- **THEN** both listeners are bound only to the IPv4 loopback address (`127.0.0.1`), and no listening socket is created on any non-loopback network interface

#### Scenario: Connection attempt from another machine cannot reach the listener
- **WHEN** a connection attempt originates from a network interface other than loopback (e.g. another machine on the same LAN, assuming no firewall)
- **THEN** the operating system refuses the connection because no listening socket exists on that interface

### Requirement: Unique Connection Identity
Each connection accepted by Gatoway core SHALL be assigned a unique connection ID at
accept time, independent of the connecting plugin's declared type or transport.

#### Scenario: Connection ID assigned on accept
- **WHEN** a new TCP or WebSocket connection is accepted
- **THEN** Gatoway core assigns it a unique connection ID before any message is processed

#### Scenario: Two connections of the same plugin type receive distinct IDs
- **WHEN** two separate connections both declare the same plugin type during registration
- **THEN** each connection retains its own distinct connection ID and is tracked independently

### Requirement: Connection Lifecycle State Tracking
Gatoway core SHALL track each connection's state as one of: connected, authenticating,
authenticated, or disconnected, and SHALL transition state only in that order.

#### Scenario: New connection starts unauthenticated
- **WHEN** a new TCP connection is accepted
- **THEN** its state is set to connected and then authenticating, and it is not yet treated as authenticated until its `register` message's token is validated

#### Scenario: WebSocket connection takes a pre-authenticated fast path
- **WHEN** a new WebSocket connection completes its HTTP upgrade with an allowlisted `Origin` header (design.md D5) — the only credential check a browser-based plugin can present
- **THEN** Gatoway core transitions the connection through connected, authenticating, and authenticated as one atomic step at accept time, before the connection's first message is even received, so a WebSocket connection is never externally observable in a not-yet-authenticated state; its subsequent `register` message only declares its plugin type and capability manifest and does not re-run any credential check

#### Scenario: Non-handshake message before authentication is rejected
- **WHEN** a connection in the authenticating state sends any message other than the registration handshake
- **THEN** Gatoway core rejects the message and closes the connection

#### Scenario: Connection removed from tracking on disconnect
- **WHEN** an authenticated connection disconnects (gracefully or unexpectedly)
- **THEN** Gatoway core transitions its state to disconnected and removes it from the set of active connections
