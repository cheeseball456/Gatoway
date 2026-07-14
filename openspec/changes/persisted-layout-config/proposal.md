## Why

`ARCHITECTURE.md`'s delivery sequence step 6 replaces `focus-profile-routing`'s in-code
test fixture (`testFixtureLayoutResolver.ts`) with real, file-backed persistence for
which physical Stream Deck position is bound to which application capability. This isn't
just the next scheduled step — it closes a concrete gap identified while assessing
whether `docs/PROTOCOL.md` was ready to treat as stable: the message protocol itself is
complete and verified, but nothing today lets a real application plugin's declared
capabilities actually bind to a physical key, since the only existing "layout" is a
hardcoded fixture recognizing made-up test capability ids. Without this change, starting
Lightroom's adapter (or xDesign's) would produce a plugin that speaks the protocol
correctly but can never be bound to anything real.

## What Changes

- Replace the in-code test-fixture `LayoutResolver` with a real implementation backed by
  a local JSON config file, loaded at Gatoway core startup.
- Key bindings by **plugin type** (e.g. `"lightroom"`, `"xdesign"`), not connection id —
  plugin type is the stable identity across reconnects; connection id is regenerated
  every time a plugin reconnects, so it was never the right key for persisted data.
- Add a `LayoutStore` component that owns the config file: loads it at startup, exposes
  read access for resolution, and exposes a save/write path (`setBinding`/`removeBinding`/
  `save()`) even though nothing in this change calls it yet — this is the API surface the
  future no-code mapping UI (post-MVP) will need, built now rather than redesigned later.
- If no config file exists (a fresh install), Gatoway core runs with zero bindings —
  every position resolves to "unbound," matching the existing safe no-op behavior for an
  unresolvable `input_event` — and logs a clear message pointing at where the file should
  go and its schema, rather than crashing or silently guessing.
- A malformed/invalid config file logs a clear, loud error and falls back to zero
  bindings, rather than crashing Gatoway core outright — consistent with this project's
  existing resilience posture (e.g. a token-file write failure logs loudly but doesn't
  abort startup).
- Out of scope: any UI (no-code or otherwise) for editing the config file — it remains
  hand-authored JSON for this change, matching `REQUIREMENTS.md`'s MVP framing. Hot-reload
  of the config file while Gatoway core is running is also out of scope — picking up
  hand-edits requires restarting Gatoway core, matching how other startup configuration
  already works.

## Capabilities

### New Capabilities
- `layout-persistence`: loading, in-memory representation, and saving of the per-plugin-type position-to-capability layout config as a local JSON file, including safe fallback behavior for a missing or malformed file.

### Modified Capabilities
None. `profile-routing`'s existing requirements describe behavior in terms of "a
connection" having "a capability bound... at the reported position" — that behavior is
unchanged; only the internal mechanism resolving it (a real config file keyed by plugin
type, instead of an in-code fixture) changes, which is an implementation detail this
change's own design covers, not a change to `profile-routing`'s specified behavior.

## Impact

- Replaces `gatoway-core/src/routing/testFixtureLayoutResolver.ts` with a real,
  file-backed implementation behind the same `LayoutResolver` interface (revised to
  resolve by plugin type rather than connection id) — `ProfileRouter` and everything else
  that depends on `LayoutResolver` needs no changes beyond passing plugin type instead of
  connection id.
- No changes to the message protocol (`message-protocol`, `focus-tracking`) or to the
  Stream Deck plugin — this is entirely a Gatoway-core-internal change to how bindings are
  sourced.
- Unblocks a real, meaningful test of delivery-sequence step 3 (Lightroom) or step 5
  (xDesign): a real application plugin can now have its actual declared capabilities bound
  to actual physical keys via a hand-authored config file, not a hardcoded test fixture.
