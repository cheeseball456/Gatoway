## Why

Assessing whether the protocol is completely defined for a real plugin author (xDender)
surfaced that Gatoway core doesn't validate the shape of capability data at two points
where a plugin author's own bug could otherwise go unnoticed: `register`'s `capabilities`
array (checked at `messageHandler.ts` — verified only that it's an array, never that each
element has a valid `id`/`label`/`type`) and `capability_update`'s `icon`/`label`/`state`
fields (`profileRouter.ts`'s `handleCapabilityUpdate` writes them onto the stored
capability with no type checking). Today, a malformed capability or a wrong-typed field is
silently accepted; the only symptom is that it never renders correctly, and the only way
to notice is by reading Gatoway core's own logs — not something a plugin author debugging
their own extension would normally think to check.

## What Changes

- `register`: validate each entry in `capabilities` against the documented `Capability`
  shape (`id`/`label` non-empty strings, `type` exactly `"button"` or `"dial"`,
  `description`/`icon` strings if present, `state` a number if present). A capability that
  fails validation is dropped from the connection's declared manifest (not the whole
  registration); the connection still authenticates and registers normally with whatever
  valid capabilities it declared. Gatoway core sends an `error` message afterward listing
  which capability entries were rejected and why.
- `capability_update`: validate `icon` (string or `null`), `label` (string), `state`
  (number) if present. A field that fails validation is not applied (the stored
  capability's existing value for that field is left unchanged, same as if the field had
  been omitted); Gatoway core sends an `error` message describing which field(s) were
  rejected and why. This applies independently per field — a valid `label` alongside an
  invalid `state` still updates the label.
- No change to messages that are already validated at the envelope level (malformed JSON,
  non-object payload — existing `error` behavior, untouched).
- Out of scope: validating `input_event`/`focus`/`render_update`/`command` payloads more
  strictly — those either originate only from Gatoway's own Stream Deck plugin (not a
  third-party plugin author's code) or are already fully specified and correctly produced
  by Gatoway core itself; this change is scoped to the two places a buggy *application*
  plugin's own authored data flows in.

## Capabilities

### Modified Capabilities
- `message-protocol`: the "Registration Message Type" requirement is amended to describe capability-shape validation and the resulting `error` feedback for rejected entries.
- `profile-routing`: a new requirement is added describing `capability_update` field-level validation and the resulting `error` feedback for rejected fields.

## Impact

- Changes `gatoway-core/src/connection/messageHandler.ts` (capability validation at
  registration) and `gatoway-core/src/routing/profileRouter.ts` (`capability_update` field
  validation).
- A capability that was previously silently accepted despite being malformed will now be
  dropped and reported via `error` instead — existing, correctly-shaped capabilities are
  entirely unaffected.
- Directly improves the development experience for xDender (and any future plugin
  author): a coding mistake now produces a clear, actionable signal over the wire instead
  of a silent no-op only visible in Gatoway core's own logs.
