## 1. Capability Validation (register)

- [x] 1.1 Add `validateCapability()` (or similar) near `gatoway-core/src/protocol/messages.ts`, mirroring `layoutConfig.ts`'s `validateLayoutConfig()` style (never throws; returns ok/reason)
- [x] 1.2 Validate: `id` non-empty string; `label` non-empty string; `type` exactly `"button"` or `"dial"`; `description`/`icon` a string if present; `state` a number if present
- [x] 1.3 Update `messageHandler.ts`'s registration handling to validate each entry in `capabilities`, keeping only valid entries in the connection's declared manifest
- [x] 1.4 Send a follow-up `error` message (after `register_ack`) identifying rejected entries (index + reason) when one or more capabilities were dropped; send nothing extra when all capabilities are valid
- [x] 1.5 Confirm re-registration (capabilities omitted = unchanged; explicit array = replaces) still works unchanged when the explicit array is fully valid

## 2. Capability Update Field Validation

- [x] 2.1 Add `validateCapabilityUpdateFields()` (or similar), validating `icon` (string or null), `label` (string), `state` (number) independently per field
- [x] 2.2 Update `profileRouter.ts`'s `handleCapabilityUpdate` to apply only validly-typed fields, leaving invalid fields' stored values unchanged
- [x] 2.3 Send a follow-up `error` message identifying rejected field(s) and why, when one or more fields were rejected; send nothing extra when the whole update is valid
- [x] 2.4 Confirm the existing "undeclared capability id" no-op behavior is unaffected (validation happens after confirming the capability exists)

## 3. Testing

- [x] 3.1 Unit tests for `validateCapability()`: valid capability, missing `id`, missing `label`, invalid `type`, non-string `description`/`icon`, non-number `state`
- [x] 3.2 Unit tests for `validateCapabilityUpdateFields()`: all-valid, invalid `icon` (wrong type, not null), invalid `label`, invalid `state`, mixed valid+invalid
- [x] 3.3 Integration tests: a `register` with one malformed capability among valid ones registers successfully with only the valid ones and produces the expected `error` message
- [x] 3.4 Integration tests: a `register` where every capability is malformed still registers with an empty manifest and produces the expected `error` message
- [x] 3.5 Integration tests: a `capability_update` with a mix of valid/invalid fields applies only the valid ones and produces the expected `error` message
- [x] 3.6 Confirm all existing tests (manual test-app client's fixture capabilities, Stream Deck plugin's empty capability array) still pass unchanged

## 4. Documentation

- [x] 4.1 Update `docs/PROTOCOL.md`'s `Capability`/`register` and `capability_update` sections to document validation behavior and the `error` message shape/details it produces
- [x] 4.2 Note in the docs (per design.md's Risk) that a plugin author should handle unsolicited `error` messages on their connection to actually see this feedback
