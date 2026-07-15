## 1. Config File Loading

- [ ] 1.1 Add an `allowedOriginsConfig.ts` (or similar) in `stream-deck-plugin/src/coreLifecycle/`, mirroring `gatoway-core/src/routing/layoutConfig.ts`'s validation style (never throws; returns ok/reason)
- [ ] 1.2 Schema: `{ "allowedOrigins": string[] }` — validate `allowedOrigins` is present and is an array of non-empty strings; anything else (missing file, invalid JSON, wrong shape) is treated as "no config" (empty array), not a hard failure
- [ ] 1.3 Default file path: `<config dir>/allowed-origins.json`, using the same per-OS config directory resolution `coreLifecycle/config.ts`'s `defaultConfigDir()` already implements; support a `GATOWAY_ALLOWED_ORIGINS_FILE` environment variable override, matching `GATOWAY_TOKEN_FILE`'s existing override pattern
- [ ] 1.4 Log exactly which case occurred at startup (missing file / invalid JSON / invalid shape / loaded successfully with count), mirroring `layout_config_missing`/`layout_config_invalid_json`/`layout_config_invalid_shape`/`layout_config_loaded`'s existing four-case log pattern

## 2. Forwarding to the Spawned Child

- [ ] 2.1 Extend `PluginCoreConfig` (`coreLifecycle/config.ts`) with an `allowedOrigins: string[]` field, resolved via the new loader from 1.1-1.3
- [ ] 2.2 Update `buildCoreChildEnv()` to set `GATOWAY_ALLOWED_ORIGINS` to the resolved origins joined with commas (matching `gatoway-core/src/config.ts`'s `parseAllowlist()` comma-separated format) — omit the variable entirely (not set to an empty string) when the list is empty, matching how an unset env var behaves today
- [ ] 2.3 Confirm the existing `GATOWAY_TCP_PORT`/`GATOWAY_TOKEN_FILE` forwarding is unchanged by this addition

## 3. Testing

- [ ] 3.1 Unit tests for the config loader: valid file with one/multiple origins, missing file, invalid JSON, wrong shape (`allowedOrigins` not an array, non-string entries) — each asserting the correct fallback/logged case
- [ ] 3.2 Unit tests for `buildCoreChildEnv()`: origins present → `GATOWAY_ALLOWED_ORIGINS` set correctly (comma-joined); origins empty → variable omitted entirely
- [ ] 3.3 Confirm existing `coreProcessSupervisor`/`coreClient` tests are unaffected

## 4. Documentation

- [ ] 4.1 Add a short section to `stream-deck-plugin/README.md` (or `docs/PROTOCOL.md`'s existing Origin-allowlist discussion, whichever fits better) documenting the new `allowed-origins.json` file: location, schema, and that it's the mechanism to use when Gatoway core is spawned by the Stream Deck app (as opposed to `GATOWAY_ALLOWED_ORIGINS` directly, which remains the right mechanism for a manually-started standalone instance)
- [ ] 4.2 Manually verify: with a real `allowed-origins.json` in place declaring `moz-extension://*`, confirm a Firefox-based plugin can connect through the normal Stream Deck-spawned path (not a manually-started standalone instance) — this is the actual scenario QA-017 found broken
