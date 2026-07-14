## ADDED Requirements

### Requirement: Layout Config Loaded at Startup
Gatoway core SHALL load the layout config file once at startup, parsing per-plugin-type
profiles of position-to-capability bindings into memory.

#### Scenario: Valid config loaded successfully
- **WHEN** Gatoway core starts and a valid layout config file exists at the configured path
- **THEN** its profiles and bindings are available for resolution for the lifetime of that Gatoway core process

### Requirement: Missing Config File Is Handled Safely
Gatoway core SHALL start successfully with an empty layout (no bindings for any plugin
type) if no layout config file exists at the configured path, and SHALL log a clear
message identifying the expected path.

#### Scenario: No config file present
- **WHEN** Gatoway core starts and no file exists at the configured layout config path
- **THEN** Gatoway core starts normally with zero bindings, and logs a message stating no layout config was found and where it was expected

### Requirement: Malformed Config File Is Handled Safely
Gatoway core SHALL NOT crash or fail to start if the layout config file exists but cannot
be parsed or does not match the expected shape. It SHALL log a clear error describing the
problem and fall back to an empty layout, identical to the missing-file case.

#### Scenario: Invalid JSON
- **WHEN** the layout config file exists but contains invalid JSON
- **THEN** Gatoway core starts normally with zero bindings and logs an error describing the parse failure

#### Scenario: Valid JSON, wrong shape
- **WHEN** the layout config file contains valid JSON that does not match the expected profiles/bindings structure
- **THEN** Gatoway core starts normally with zero bindings and logs an error describing the shape mismatch

### Requirement: Bindings Resolved By Plugin Type
Resolution of a position to a capability SHALL be keyed by the requesting connection's
plugin type, not its connection id.

#### Scenario: Two connections of the same plugin type resolve identically
- **WHEN** two separate connections both declare the same plugin type and one of them is focused
- **THEN** position resolution for the focused connection uses that plugin type's configured bindings, regardless of which specific connection is currently focused

### Requirement: All Bound Positions Span Every Configured Profile
The set of all positions used for idle-state sweeps SHALL include every position bound in
any configured profile, not only the currently or most-recently focused one.

#### Scenario: Idle sweep resets a position bound only in a different profile
- **WHEN** position P is bound only within profile "xdesign"'s configuration, and focus clears while "lightroom" was previously focused
- **THEN** the idle sweep still includes position P, resetting it to the idle appearance

### Requirement: Layout Store Supports Reading and Writing Bindings
Gatoway core SHALL provide a component that supports both reading the current layout and
modifying it in memory (setting or removing a single binding for a plugin type), and
persisting the current in-memory layout back to the config file.

#### Scenario: Setting a binding is reflected in subsequent resolution
- **WHEN** a binding is set for a plugin type, controller, and position
- **THEN** subsequent resolution for that plugin type/controller/position returns the newly set capability id

#### Scenario: Saving persists the current in-memory layout
- **WHEN** the current in-memory layout is saved
- **THEN** the config file on disk is updated to match, and loading it again reproduces the same in-memory layout

#### Scenario: Save writes atomically
- **WHEN** a save is interrupted or fails partway through
- **THEN** the previously-saved config file on disk is not left in a corrupted or partially-written state
