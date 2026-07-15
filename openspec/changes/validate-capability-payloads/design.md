## Context

Assessing the protocol's completeness for xDender surfaced that Gatoway core accepts
capability data from two places — `register`'s `capabilities` array and
`capability_update`'s `icon`/`label`/`state` fields — without validating its shape at all
beyond "is `capabilities` an array." A malformed entry is silently stored; the only
symptom is that it never renders, discoverable only by reading Gatoway core's own logs.
This change adds validation and `error`-message feedback at both points, following the
existing `validateLayoutConfig` pattern in `gatoway-core/src/routing/layoutConfig.ts`
(never throws; returns a descriptive failure reason for the caller to act on).

## Goals / Non-Goals

**Goals:**
- Validate capability shape at `register` time; drop only the invalid entries, not the
  whole registration.
- Validate `capability_update` field types; drop only the invalid fields, not the whole
  update.
- Give the plugin an explicit `error` message describing what was rejected and why, in
  both cases.

**Non-Goals:**
- Validating any other message type's payload more strictly (`input_event`, `focus`,
  `render_update`, `command`) — these either originate only from Gatoway's own
  Stream Deck plugin or are already fully and correctly specified; this change is scoped
  to the two places a third-party application plugin's own authored data enters the
  system.
- Rejecting an entire `register`/`capability_update` message outright for a partial
  validation failure — see D2 for why partial acceptance is the right behavior here.

## Decisions

**D1 — Validation rules, matching the documented `Capability`/`CapabilityUpdatePayload` shapes exactly:**
- `Capability` (in `register`): `id` non-empty string; `label` non-empty string; `type`
  exactly `"button"` or `"dial"`; `description` a string if present; `icon` a string if
  present (register-time capabilities don't use the `null`-reset semantics —
  that's specific to `render_update`/`capability_update`); `state` a number if present.
- `CapabilityUpdatePayload` fields (`icon`/`label`/`state`), each independently: `icon` a
  string or `null` if present (matching its existing three-way semantics); `label` a
  string if present; `state` a number if present. `capabilityId` itself is unchanged —
  already required and checked against the connection's own declared capabilities.

**D2 — Partial acceptance, not all-or-nothing rejection.** A `register` with 9 valid
capabilities and 1 malformed one registers successfully with the 9 valid ones; the
malformed one is dropped and reported via `error`. A `capability_update` with a valid
`label` and an invalid `state` applies the label and leaves `state` unchanged, reporting
the rejected field via `error`. Alternative considered: reject the entire message (like a
malformed envelope) — rejected as needlessly disruptive during real development, where a
plugin author iterating on one new capability shouldn't lose everything else that already
works; the existing `input_event`-resolution philosophy ("silently continue, don't crash
the whole system over one bad case") already favors graceful degradation over hard
failure, and this is consistent with it.

**D3 — Reuse the existing `error` message type; no new message type.** `error` is already
defined as "a generic protocol-level error report" usable in either direction — extending
its use from purely envelope-level malformation (invalid JSON, non-object payload) to also
cover semantically-invalid-but-well-formed payload contents is a natural extension of its
existing purpose, not a new concept. Sent as a follow-up message on the same connection
(after `register_ack`, in the registration case — the connection did authenticate
successfully; the capability issue is reported separately, not folded into
`register_ack`'s own status field, which only concerns authentication) with `payload:
{ message: string, details: { rejectedCapabilities?: ({ index: number, reason: string
})[], rejectedFields?: ({ field: string, reason: string })[] } }`.

**D4 — Validation logic lives alongside the existing schema-validation pattern.** Add
`validateCapability()`/`validateCapabilityUpdateFields()` functions in
`gatoway-core/src/protocol/` (or a small new file near `messages.ts`), mirroring
`layoutConfig.ts`'s `validateLayoutConfig()` style (never throws, returns a descriptive
reason on failure) rather than inventing a different validation idiom.

## Risks / Trade-offs

- [Risk] A plugin author might not notice the follow-up `error` message if their code
  doesn't handle unsolicited messages on that connection type → [Mitigation] this is a
  documentation/DX matter for `docs/PROTOCOL.md` to call out clearly (not addressed by
  this change's own scope, but worth a `doc-writer` note); the *system* itself still fails
  safe either way (the capability just doesn't render, exactly as it silently didn't
  before — the improvement is purely additive signal, not a new failure mode).
- [Trade-off] Adding validation code paths that didn't exist before is inherently more
  code to maintain → accepted, since the alternative (silent, hard-to-debug failures for
  every future plugin author) is worse for a system explicitly meant to be built against
  by third parties.

## Migration Plan

Not applicable — purely additive validation. Every currently-declared capability in the
codebase (the manual test-app client's three fixture capabilities, and the Stream Deck
plugin's own empty capability array) is already validly shaped and continues to register
exactly as before.

## Open Questions

None outstanding.
