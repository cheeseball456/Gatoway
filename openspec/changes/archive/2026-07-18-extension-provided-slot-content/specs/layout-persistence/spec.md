## REMOVED Requirements

### Requirement: Layout Config Loaded at Startup
**Reason:** Gatoway core no longer persists any position-to-content mapping. Physical
slot capacity is reported live by the Stream Deck plugin (`device_capacity`,
`stream-deck-core-lifecycle`), and each application plugin declares its own content
sized to fit (`register`'s `content`, `message-protocol`) — there is nothing left for
a host-side layout file to do.
**Migration:** Delete any existing `layout.json` file — it is no longer read.

### Requirement: Missing Config File Is Handled Safely
**Reason:** No config file exists to be missing; the concept no longer applies.
**Migration:** None needed.

### Requirement: Malformed Config File Is Handled Safely
**Reason:** No config file exists to be malformed; the concept no longer applies.
**Migration:** None needed.

### Requirement: Bindings Resolved By Plugin Type
**Reason:** Resolution is now by fixed position label (derived from the device's
physical capacity, looked up directly in a connection's own declared content), not a
lookup by plugin type against a persisted file — see `profile-routing`'s revised
"Input Event Resolution Against the Focused Connection."
**Migration:** None needed; the replacement behavior is specified in `profile-routing`.

### Requirement: All Bound Positions Span Every Configured Profile
**Reason:** There are no "configured profiles" anymore — the idle sweep now spans
every position present in the most recent `device_capacity` report, regardless of any
connection's focus history.
**Migration:** None needed; the replacement behavior is specified in `profile-routing`.

### Requirement: Layout Store Supports Reading and Writing Bindings
**Reason:** `LayoutStore` (`gatoway-core/src/routing/layoutStore.ts`) and its
`setBinding`/`removeBinding`/`save` API are deleted entirely — nothing in this or any
other capability writes a layout file anymore.
**Migration:** None needed; no code called this API in production (it existed only
for a future no-code UI that was never built).
