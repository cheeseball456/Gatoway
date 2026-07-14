## Context

`focus-profile-routing` deliberately proved the routing/resolution interface and logic
with `testFixtureLayoutResolver.ts` — an in-code stand-in, not real persistence — per its
own design.md D3. This change builds the real thing: a local JSON config file describing
which physical Stream Deck position is bound to which application capability, per
application, loaded by Gatoway core at startup. Assessing whether `docs/PROTOCOL.md` was
ready to call stable surfaced this as a genuine prerequisite for any real plugin
integration (Lightroom or xDesign), not just the next item on a list.

## Goals / Non-Goals

**Goals:**
- Replace the in-code test fixture with a real, file-backed `LayoutResolver`
  implementation, keyed by plugin type rather than connection id.
- Provide a `LayoutStore` with both load and save operations — save is unused by anything
  in this change, but built now as the API surface the future no-code mapping UI needs.
- Handle a missing config file (fresh install) and a malformed one safely — zero bindings
  and a clear log message, never a crash.

**Non-Goals:**
- Any UI (no-code or otherwise) for editing the config — it's hand-authored JSON for now,
  per `REQUIREMENTS.md`'s MVP framing.
- Hot-reloading the config file while Gatoway core is running — picking up hand-edits
  requires a restart, matching every other piece of startup configuration.
- Multi-instance-of-the-same-app layouts — plugin type remains the key, consistent with
  `ARCHITECTURE.md`'s "not needed now, but shouldn't be architecturally precluded" framing;
  nothing here forecloses it, but nothing here builds it either.

## Decisions

**D1 — Bindings are keyed by plugin type, not connection id.** `testFixtureLayoutResolver.ts`'s
`resolve()` took a `connectionId` (largely ignored by the fixture itself). Real, persisted
bindings need a stable key across reconnects — a connection id is regenerated every time a
plugin reconnects, so it was never the right key for anything durable. Plugin type (e.g.
`"lightroom"`, `"xdesign"`) is the stable identity `register` already declares. `LayoutResolver`'s
interface changes accordingly: `resolve(pluginType: string, controller, position): string | null`.
`ProfileRouter` already has the connection record (and therefore its `pluginType`) at every
call site that currently passes `connectionId` — this is a mechanical change, not a new
lookup.

**D2 — Config file: one JSON file, profiles keyed by plugin type.**
```jsonc
{
  "profiles": {
    "lightroom": {
      "bindings": [
        { "controller": "keypad", "position": { "row": 0, "column": 0 }, "capabilityId": "next-photo" },
        { "controller": "encoder", "position": { "index": 0 }, "capabilityId": "exposure" }
      ]
    }
  }
}
```
Location follows the existing per-OS config directory convention (`config.ts`'s
`defaultConfigDir()`, already used for the auth token file): `<configDir>/layout.json` by
default, overridable via `GATOWAY_LAYOUT_FILE` (matching `GATOWAY_TOKEN_FILE`'s existing
pattern). Alternative considered: YAML — rejected only because JSON needs no new
dependency and every other piece of config in this codebase is already JSON (log entries,
message envelopes); no functional reason favors one over the other here.

**D3 — `allPositions()` becomes a union across all configured profiles, not one profile's list.**
The idle sweep needs to reset *every* position any profile might have left showing
something — not just one profile's bindings — so `LayoutResolver.allPositions()` now
returns the union of every `(controller, position)` pair bound in *any* profile in the
loaded config, while `resolve(pluginType, controller, position)` remains the
profile-specific lookup used for bound-layout sweeps and input resolution. This preserves
`profile-routing`'s existing "idle sweep resets everything" behavior without changing that
spec's requirements.

**D4 — Missing or malformed config fails safe, never crashes.** No file present: Gatoway
core starts with an empty in-memory layout (`resolve()` always returns `null`, `allPositions()`
returns an empty list) and logs a clear message stating no layout config was found, the
expected path, and a pointer to the schema (`docs/PROTOCOL.md` or a dedicated layout-config
doc section, left to `doc-writer`). A file present but invalid (malformed JSON, wrong
shape) logs a loud error including what failed to parse and falls back to the same empty
layout — it does not abort Gatoway core's startup. This matches the existing precedent in
`index.ts`: a token-file write failure logs loudly and continues rather than crashing,
because a hard crash is a worse outcome for a personal-use background service than a
degraded-but-running one.

**D5 — `LayoutStore` provides load and save, even though nothing calls save yet.** A
`LayoutStore` component owns the config file: `load()` (called once at Gatoway core
startup), `getProfile(pluginType)`/`allPositions()` (read access, backing the
`LayoutResolver` implementation), and `setBinding(pluginType, controller, position,
capabilityId)` / `removeBinding(...)` / `save()` (write access, unused by this change but
built as the API surface the future no-code mapping UI needs). `save()` writes atomically
(write to a temp file in the same directory, then rename over the target) so a crash
mid-write can never leave a corrupted config file — a reasonable, low-cost precaution
given this file's contents matter for every subsequent Gatoway core startup.

## Risks / Trade-offs

- [Risk] Building a save/write API with no caller in this change risks the API shape being
  wrong for whatever the eventual no-code UI actually needs → [Mitigation] kept deliberately
  minimal (per-binding set/remove, not a bulk-replace-everything API) and thoroughly unit
  tested against its own contract; if the future UI needs something different, this is a
  small, isolated component to revise, not something deeply threaded through the rest of
  the codebase.
- [Trade-off] Hand-authored JSON has no schema validation UI or friendly error messages
  beyond a logged parse/shape error → acceptable for a developer-facing MVP config file;
  revisit if this becomes a real friction point once real plugins (Lightroom, xDesign) are
  actually being configured this way.

## Migration Plan

Not applicable — greenfield for this data. `testFixtureLayoutResolver.ts` is deleted
entirely, not migrated; nothing depended on its specific fixture capability ids outside
this codebase's own tests (which move to testing the real config-backed resolver instead).

## Open Questions

None outstanding. Whether/how a future no-code UI surfaces `LayoutStore`'s save API is
explicitly out of scope here and left for whenever that UI is actually designed.
