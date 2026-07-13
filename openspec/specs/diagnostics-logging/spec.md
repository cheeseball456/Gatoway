# diagnostics-logging Specification

## Requirements

### Requirement: Connection Lifecycle Logging
Gatoway core SHALL log connection lifecycle events, including connection accepted,
authenticated, and disconnected, for every connection.

#### Scenario: Lifecycle events logged
- **WHEN** a connection is accepted, becomes authenticated, or disconnects
- **THEN** Gatoway core writes a corresponding log entry including the connection ID, transport type, and timestamp

### Requirement: Detailed Message Logging
Gatoway core SHALL log messages sent and received on authenticated connections,
including message type and payload, to support debugging.

#### Scenario: Received message logged
- **WHEN** Gatoway core receives a message from an authenticated connection
- **THEN** it writes a log entry including the connection ID, message type, and payload

#### Scenario: Sent message logged
- **WHEN** Gatoway core sends a message to a connection
- **THEN** it writes a log entry including the connection ID, message type, and payload

### Requirement: Rotating Short-Term Log Retention
Gatoway core SHALL write logs to a local file that rotates based on size, retaining only
a bounded number of rotated files, so that logs serve short-term debugging rather than
long-term archival.

#### Scenario: Log file rotates at size threshold
- **WHEN** the active log file reaches its configured size threshold
- **THEN** Gatoway core rotates it to a new file and enforces the configured limit on the number of retained rotated files

#### Scenario: Oldest rotated log discarded beyond retention limit
- **WHEN** the number of rotated log files exceeds the configured retention limit
- **THEN** Gatoway core deletes the oldest rotated file(s) to stay within the limit
