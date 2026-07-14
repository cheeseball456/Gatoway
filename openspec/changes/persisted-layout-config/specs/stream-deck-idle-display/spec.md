## ADDED Requirements

### Requirement: Local Default Baseline Applied Independent of Gatoway Core
The Stream Deck plugin's generic Key and Dial actions SHALL apply a local default
baseline — the manifest's own declared default label and icon — immediately upon first
appearing whenever no remembered render state exists yet for that position, without
waiting for or depending on any message from Gatoway core.

#### Scenario: Baseline applied with no remembered state and no Gatoway core message yet
- **WHEN** a generic action appears with no previously remembered render state for its position (e.g. a fresh placement, or the plugin process itself having just restarted)
- **THEN** the plugin immediately applies its manifest-declared default label and icon, without waiting for a `render_update` from Gatoway core

#### Scenario: A later render_update still overrides the local baseline
- **WHEN** Gatoway core subsequently sends a `render_update` for that position
- **THEN** the plugin's displayed content updates to reflect it, exactly as if no local baseline had been applied first
