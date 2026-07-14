## 1. Config Path and Schema

- [x] 1.1 Add `layoutFilePath` to `GatowayCoreConfig`/`loadConfig()`, defaulting to `<configDir>/layout.json`, overridable via `GATOWAY_LAYOUT_FILE`
- [x] 1.2 Define the layout config's JSON schema/types (`profiles: { [pluginType: string]: { bindings: Binding[] } }`, `Binding: { controller, position, capabilityId }`)

## 2. LayoutStore

- [x] 2.1 Implement `LayoutStore.load()`: read and parse the config file at startup
- [x] 2.2 Handle a missing file: empty in-memory layout, clear log message with the expected path
- [x] 2.3 Handle invalid JSON: empty in-memory layout, clear error log describing the parse failure
- [x] 2.4 Handle valid JSON with the wrong shape: empty in-memory layout, clear error log describing the shape mismatch
- [x] 2.5 Implement `LayoutStore.getProfile(pluginType)` / resolution read access
- [x] 2.6 Implement `LayoutStore.allPositions()` as the union of every position bound across all configured profiles
- [x] 2.7 Implement `LayoutStore.setBinding(pluginType, controller, position, capabilityId)` and `removeBinding(...)`
- [x] 2.8 Implement `LayoutStore.save()`, writing atomically (temp file + rename)

## 3. Real LayoutResolver Implementation

- [x] 3.1 Change `LayoutResolver.resolve()`'s signature to take `pluginType` instead of `connectionId`
- [x] 3.2 Implement a `LayoutStore`-backed `LayoutResolver` replacing `testFixtureLayoutResolver.ts` (delete the fixture file)
- [x] 3.3 Update `ProfileRouter` call sites to pass the connection's `pluginType` (already available on its `ConnectionRecord`) instead of `connectionId`
- [x] 3.4 Update `startGatowayCore()`/wiring to construct the real `LayoutStore`/`LayoutResolver` at startup instead of the fixture

## 4. Testing

- [x] 4.1 Unit tests for `LayoutStore`: load valid config, missing file, invalid JSON, wrong shape, setBinding/removeBinding, save-then-reload round-trip, atomic-write behavior
  - [x] QA-013 fix: `save()` now cleans up the orphaned `.tmp` file (and logs a secondary warning without masking the original error, if cleanup itself fails) when `rename()` fails; regression tests added covering both the successful-cleanup and failed-cleanup paths
- [x] 4.2 Unit tests for the config-backed `LayoutResolver`: resolve by plugin type (not connection id), two connections of the same plugin type resolve identically, `allPositions()` unions across profiles
- [x] 4.3 Update/replace `focus-profile-routing`'s existing tests that depended on `testFixtureLayoutResolver.ts` to use a real (test-authored) config file instead
- [~] 4.4 Manually verify: hand-author a layout config file binding a made-up capability id to a real physical position, confirm resolution/rendering works end to end using the existing manual test-app client, and confirm the missing/malformed-file fallback behavior with real Gatoway core startup logs
  - [x] Missing/invalid-JSON/wrong-shape fallback confirmed against a real, standalone-launched Gatoway core process (`tsx src/index.ts`), reading real startup log output for each case
  - [x] End-to-end resolution confirmed against a real, standalone-launched Gatoway core process and a hand-authored `layout.json` (keypad position bound to a made-up capability id for a made-up plugin type) using real TCP protocol traffic (register/focus/input_event/command) - not the Elgato SDK/physical hardware
  - [ ] Deferred: visual confirmation on real Stream Deck+ hardware via the existing `manual:test-app-client` script and the real Stream Deck plugin - requires the physical device, which this subagent has no access to
