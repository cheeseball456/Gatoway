## ADDED Requirements

### Requirement: Capability Update Field Validation
Gatoway core SHALL validate each field present in a `capability_update` message
(`icon` a string or `null`, `label` a string, `state` a number) independently. A field
that fails validation SHALL NOT be applied — the stored capability's existing value for
that field is left unchanged, exactly as if the field had been omitted — while any other,
validly-typed fields in the same message SHALL still be applied. Gatoway core SHALL send
an `error` message identifying which field(s) were rejected and why.

#### Scenario: Invalid field rejected, valid fields still applied
- **WHEN** a `capability_update` message includes a validly-typed `label` alongside an invalidly-typed `state`
- **THEN** Gatoway core applies the `label` change, leaves `state` unchanged, and sends a follow-up `error` message identifying the rejected `state` field and the reason

#### Scenario: All fields invalid, nothing applied
- **WHEN** every field present in a `capability_update` message (other than `capabilityId`) fails validation
- **THEN** Gatoway core applies no changes to the stored capability and sends a follow-up `error` message identifying all rejected fields

#### Scenario: Valid update produces no error
- **WHEN** every field present in a `capability_update` message passes validation
- **THEN** Gatoway core applies the update normally and sends no `error` message
