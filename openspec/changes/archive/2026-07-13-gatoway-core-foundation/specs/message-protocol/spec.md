## ADDED Requirements

### Requirement: Unified Message Envelope
Every message exchanged between Gatoway core and a connected plugin, regardless of
transport, SHALL use a single JSON envelope containing a `type` field, an optional
`connectionId` field, and a `payload` object.

#### Scenario: Message parsed using the shared envelope
- **WHEN** Gatoway core receives a message over either TCP or WebSocket
- **THEN** it parses the message using the same envelope shape (type, optional connectionId, payload), regardless of which transport delivered it

### Requirement: Transport-Specific Framing
Gatoway core SHALL frame TCP messages as newline-delimited JSON (one JSON object per
line) and SHALL frame WebSocket messages as one JSON object per text frame.

#### Scenario: TCP message framed by newline
- **WHEN** Gatoway core sends a message over a TCP connection
- **THEN** the message is serialized as a single JSON object followed by a newline character, with no embedded unescaped newlines

#### Scenario: WebSocket message framed as a single text frame
- **WHEN** Gatoway core sends a message over a WebSocket connection
- **THEN** the message is serialized as a single JSON object and sent as one WebSocket text frame

### Requirement: Registration Message Type
The protocol SHALL define a `register` message type that a plugin sends to authenticate
and declare its capability manifest, and a `register_ack` message type that Gatoway core
sends in response.

#### Scenario: Plugin registers successfully
- **WHEN** a plugin sends a `register` message containing valid authentication (token, or for WebSocket an allowlisted Origin) and a capability manifest
- **THEN** Gatoway core responds with a `register_ack` message confirming successful registration

#### Scenario: Plugin registration rejected
- **WHEN** a plugin sends a `register` message that fails authentication
- **THEN** Gatoway core responds with a `register_ack` message reporting the rejection reason and then closes the connection

### Requirement: Error Message Type
The protocol SHALL define an `error` message type usable by either Gatoway core or a
connected plugin to report a protocol-level error.

#### Scenario: Core reports a protocol error to a plugin
- **WHEN** Gatoway core receives a malformed message it cannot parse under the shared envelope, from a connection that is already authenticated
- **THEN** Gatoway core sends an `error` message describing the problem back to that connection
