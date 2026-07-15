# focus-tracking Specification

## Requirements

### Requirement: Focus Self-Reporting
Gatoway core SHALL accept a `focus` message from any authenticated connection, updating
its focus state to match the reported value. Focus is not automatically restored across
a reconnection: a plugin that reconnects while still active/focused SHALL re-send
`focus: true` on its new connection to be recognized as focused again.

#### Scenario: Connection reports gaining focus
- **WHEN** an authenticated connection sends a `focus` message with `focused: true`
- **THEN** Gatoway core records that connection as the currently focused connection

#### Scenario: Connection reports losing focus
- **WHEN** the currently focused connection sends a `focus` message with `focused: false`
- **THEN** Gatoway core clears the focused connection to none

#### Scenario: Reconnecting plugin must re-assert focus
- **WHEN** a plugin that was focused disconnects and reconnects while still active
- **THEN** the new connection is not automatically treated as focused; it must send a fresh `focus: true` message to be recognized as focused again

### Requirement: At Most One Focused Connection
Gatoway core SHALL track at most one focused connection at a time. A connection reporting
`focused: true` SHALL supersede any previously focused connection, without requiring the
previous connection to explicitly report `focused: false` first.

#### Scenario: New focus report supersedes the previous one
- **WHEN** connection A is currently focused and connection B sends `focus` with `focused: true`
- **THEN** Gatoway core records connection B as the focused connection, and connection A is no longer considered focused, without connection A needing to send a blur message

### Requirement: Focus Cleared on Disconnect
Gatoway core SHALL clear the focused connection to none if the currently focused
connection disconnects, whether gracefully or unexpectedly.

#### Scenario: Focused connection disconnects
- **WHEN** the currently focused connection disconnects
- **THEN** Gatoway core clears the focused connection to none

#### Scenario: Non-focused connection disconnects
- **WHEN** a connection that is not currently focused disconnects
- **THEN** the currently focused connection (if any) is unaffected
