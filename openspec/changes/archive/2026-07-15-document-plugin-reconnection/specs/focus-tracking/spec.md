## MODIFIED Requirements

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
