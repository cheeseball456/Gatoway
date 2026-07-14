## 1. Config Path and Schema

- [ ] 1.1 Add `layoutFilePath` to `GatowayCoreConfig`/`loadConfig()`, defaulting to `<configDir>/layout.json`, overridable via `GATOWAY_LAYOUT_FILE`
- [ ] 1.2 Define the layout config's JSON schema/types (`profiles: { [pluginType: string]: { bindings: Binding[] } }`, `Binding: { controller, position, capabilityId }`)

## 2. LayoutStore

- [ ] 2.1 Implement `LayoutStore.load()`: read and parse the config file at startup
- [ ] 2.2 Handle a missing file: empty in-memory layout, clear log message with the expected path
- [ ] 2.3 Handle invalid JSON: empty in-memory layout, clear error log describing the parse failure
- [ ] 2.4 Handle valid JSON with the wrong shape: empty in-memory layout, clear error log describing the shape mismatch
- [ ] 2.5 Implement `LayoutStore.getProfile(pluginType)` / resolution read access
- [ ] 2.6 Implement `LayoutStore.allPositions()` as the union of every position bound across all configured profiles
- [ ] 2.7 Implement `LayoutStore.setBinding(pluginType, controller, position, capabilityId)` and `removeBinding(...)`
- [ ] 2.8 Implement `LayoutStore.save()`, writing atomically (temp file + rename)

## 3. Real LayoutResolver Implementation

- [ ] 3.1 Change `LayoutResolver.resolve()`'s signature to take `pluginType` instead of `connectionId`
- [ ] 3.2 Implement a `LayoutStore`-backed `LayoutResolver` replacing `testFixtureLayoutResolver.ts` (delete the fixture file)
- [ ] 3.3 Update `ProfileRouter` call sites to pass the connection's `pluginType` (already available on its `ConnectionRecord`) instead of `connectionId`
- [ ] 3.4 Update `startGatowayCore()`/wiring to construct the real `LayoutStore`/`LayoutResolver` at startup instead of the fixture

## 4. Testing

- [ ] 4.1 Unit tests for `LayoutStore`: load valid config, missing file, invalid JSON, wrong shape, setBinding/removeBinding, save-then-reload round-trip, atomic-write behavior
- [ ] 4.2 Unit tests for the config-backed `LayoutResolver`: resolve by plugin type (not connection id), two connections of the same plugin type resolve identically, `allPositions()` unions across profiles
- [ ] 4.3 Update/replace `focus-profile-routing`'s existing tests that depended on `testFixtureLayoutResolver.ts` to use a real (test-authored) config file instead
- [ ] 4.4 Manually verify: hand-author a layout config file binding a made-up capability id to a real physical position, confirm resolution/rendering works end to end using the existing manual test-app client, and confirm the missing/malformed-file fallback behavior with real Gatoway core startup logs
