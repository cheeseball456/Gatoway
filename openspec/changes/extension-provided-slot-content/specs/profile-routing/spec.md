## MODIFIED Requirements

### Requirement: Input Event Resolution Against the Focused Connection
Gatoway core SHALL resolve an incoming `input_event`'s physical position to its fixed
label within the most recent `device_capacity` report for the matching controller
type, then check whether the currently focused connection's own declared content has
an entry for that label. If so, Gatoway core SHALL forward a `command` naming that
label to the focused connection. Gatoway core SHALL NOT consult any persisted,
host-side mapping — resolution depends only on live `device_capacity` and the
focused connection's own, currently-declared content.

#### Scenario: Input event resolved to a declared content entry
- **WHEN** a connection is focused and its own declared content has an entry for the label corresponding to the position reported in an `input_event`
- **THEN** Gatoway core sends a `command` naming that label to the focused connection

### Requirement: Input Events Are Safely Ignored When Unresolvable
Gatoway core SHALL NOT error or crash when an `input_event` cannot be resolved —
whether because no connection is currently focused, because the reported position
isn't present in the most recent `device_capacity` report, or because the focused
connection's own declared content has no entry for the corresponding label (e.g. it
did not declare content for every physically available label).

#### Scenario: No connection is focused
- **WHEN** an `input_event` is received while no connection is focused
- **THEN** Gatoway core takes no action beyond logging the event; nothing is sent to any connection

#### Scenario: Focused connection's content omits the corresponding label
- **WHEN** an `input_event` is received for a physical position whose label has no corresponding entry in the focused connection's declared content
- **THEN** Gatoway core takes no action beyond logging the event; nothing is sent to any connection

#### Scenario: Reported position is not part of the current device capacity
- **WHEN** an `input_event` reports a position not present in the most recently received `device_capacity` report for that controller type
- **THEN** Gatoway core takes no action beyond logging the event; nothing is sent to any connection

### Requirement: Render Updates Reflect Focus Changes
Gatoway core SHALL send `render_update` messages to the Stream Deck plugin reflecting
the currently focused connection's declared content whenever focus changes, mapping
each declared entry's label to its corresponding physical position via the most
recent `device_capacity` report, and SHALL send `render_update` messages reflecting a
built-in idle appearance whenever no connection is focused.

#### Scenario: Render updates sent when a connection gains focus
- **WHEN** a connection becomes the focused connection
- **THEN** Gatoway core sends `render_update` messages to the Stream Deck plugin reflecting that connection's declared content, and also sends it a fresh `slot_capacity` message (see `message-protocol`)

#### Scenario: Render updates sent when focus is cleared
- **WHEN** the focused connection is cleared to none (via blur or disconnect)
- **THEN** Gatoway core sends `render_update` messages to the Stream Deck plugin reflecting the built-in idle appearance, explicitly resetting `icon` to `null` at every position so a previously-focused connection's content does not remain visually stuck

### Requirement: Rendered Content Reflects Live Capability Data
Gatoway core SHALL render a focused connection's content using that connection's most
recently declared `content` (via `register`), not a stale or cached snapshot from
whenever it first connected.

#### Scenario: Render reflects content declared before gaining focus
- **WHEN** a connection has already re-declared its content (a fresh `register`) for a change made before gaining focus, and that connection subsequently gains focus
- **THEN** the `render_update`s sent reflect that most recently declared content, not whatever was declared at the connection's original registration

### Requirement: Re-Registration While Focused Triggers Immediate Re-Render
Gatoway core SHALL immediately send updated `render_update`s to the Stream Deck plugin
when a connection that currently has focus sends `register` again with new content.

#### Scenario: Live update while focused
- **WHEN** the currently focused connection sends `register` again with different content
- **THEN** Gatoway core immediately sends `render_update`s reflecting the change, without waiting for a subsequent `input_event` or focus change

#### Scenario: Update while not focused produces no render
- **WHEN** a connection that is not currently focused sends `register` again with different content
- **THEN** Gatoway core stores the new content but sends no `render_update`, since that connection's content is not currently displayed

## REMOVED Requirements

### Requirement: Capability Updates Trigger an Immediate Re-Render
**Reason:** Superseded by the modified "Re-Registration While Focused Triggers
Immediate Re-Render" requirement above — `capability_update` no longer exists
(message-protocol), so this requirement's own trigger no longer exists either.
**Migration:** Any content change, live or otherwise, now happens via re-`register`;
the re-render behavior itself is unchanged in spirit, only its trigger message
changed.
