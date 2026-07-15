## Context

QA-017 found that a Gatoway core instance spawned by the Stream Deck plugin (the
normal, everyday way it runs — launched via the Dock/Finder, not a terminal) never has
`GATOWAY_ALLOWED_ORIGINS` set, because a GUI-launched process doesn't inherit a shell's
exported environment variables. `gatoway-core`'s own `config.ts` already supports this
override correctly; the gap is entirely on the Stream Deck plugin's side, in how (or
whether) it passes a value through when spawning its child.

`coreLifecycle/config.ts`'s existing `buildCoreChildEnv()` already solves exactly this
class of problem for `GATOWAY_TCP_PORT`/`GATOWAY_TOKEN_FILE`: it doesn't rely on the
plugin's own inherited environment at all — it resolves a value from a source the
plugin fully controls, then explicitly sets it on the child's environment. Origins need
the same treatment, but a hardcoded default won't work here (unlike a port number,
there's no safe universal default Origin — every plugin's extension id/UUID is
different), so the value must come from somewhere the user can actually configure.

## Goals / Non-Goals

**Goals:**
- Give the Stream Deck plugin a real, persistent source for `GATOWAY_ALLOWED_ORIGINS`
  that works identically whether the Stream Deck app is GUI-launched or
  terminal-launched.
- Keep the loading philosophy consistent with this project's existing local-config
  precedent (`layoutConfig.ts`/`layoutStore.ts`): never throws, missing/malformed file
  falls back to a safe default (empty allowlist, fail-closed as today), always logs
  what happened.

**Non-Goals:**
- Any UI for editing this file — `REQUIREMENTS.md` already defers no-code configuration
  post-MVP; this change only fixes the delivery mechanism, not the authoring experience.
- Making `GATOWAY_WS_PORT` or any other `GATOWAY_*` variable configurable this way —
  QA-017 is specifically about the Origin allowlist; no other gap was reported. Adding
  unrequested configurability here would be scope creep.
- Hot-reload — matches `layout.json`'s existing precedent of read-once-at-plugin-startup.

## Decisions

**D1 — A dedicated new local JSON file, not an addition to `layout.json`.**
`layout.json` is documented as being specifically about position-to-capability
bindings (`docs/LAYOUT_CONFIG.md`); mixing in unrelated Origin-allowlist config would
blur that file's single responsibility and its schema/validation. This change adds a
separate file, `<config dir>/allowed-origins.json`, in the same per-OS config directory
`layoutConfig.ts`/`gatoway-core`'s own token file already use — no new directory
convention introduced, just a new file within the existing one. Alternative considered:
extend `layout.json`'s schema with a top-level `allowedOrigins` key — rejected for
mixing two unrelated concerns (position bindings vs. connection authentication) in one
file and one schema.

**D2 — Read by the Stream Deck plugin, not by `gatoway-core` itself.** `gatoway-core`
already supports `GATOWAY_ALLOWED_ORIGINS` correctly today (this is exactly how a
manually-started standalone instance is already configured, as used in this project's
own `/verify` sessions) — nothing needs to change there. The gap is entirely that the
*spawning* plugin never sets it. So this new file is read by the Stream Deck plugin at
its own startup (alongside its existing `resolvePluginCoreConfig()`), and its resolved
value is forwarded into the child's environment via `buildCoreChildEnv()`, exactly
alongside `GATOWAY_TCP_PORT`/`GATOWAY_TOKEN_FILE` today. `gatoway-core`'s own config
loading is entirely unchanged by this proposal.

**D3 — Schema: a simple array of strings, matching `GATOWAY_ALLOWED_ORIGINS`'s existing
wire format exactly.** `gatoway-core/src/config.ts`'s `parseAllowlist()` already accepts
a comma-separated string and already supports each entry being either an exact-match
Origin or a trailing-`*` wildcard (`wildcard-origin-allowlist`). Rather than invent a new
representation, the file's schema is simply:

```jsonc
{
  "allowedOrigins": ["moz-extension://*", "chrome-extension://<published-id>"]
}
```

— a JSON array of strings, each validated with the exact same rule
`isOriginAllowed`/`parseAllowlist` already use (must be non-empty; wildcard rule is
enforced downstream in `gatoway-core`, not re-validated here). This array is joined with
commas when building the child's environment (matching `GATOWAY_ALLOWED_ORIGINS`'s
existing comma-separated wire format), so `gatoway-core`'s own parsing is completely
unaware anything changed upstream.

**D4 — Missing/malformed file: empty allowlist, not a spawn failure.** Matches
`layoutConfig.ts`'s and `gatoway-core`'s own established philosophy for every local
config file in this project: a missing or invalid file never blocks startup. If this
file is absent or unparseable, the plugin spawns Gatoway core with no
`GATOWAY_ALLOWED_ORIGINS` set (today's current, fail-closed-on-WS-Origin behavior),
and logs clearly why (mirroring `layout_config_missing`/`layout_config_invalid_json`/
`layout_config_invalid_shape`'s existing three-case pattern). A user who wants
browser-plugin support simply won't get it until the file exists and is valid — exactly
like an unbound layout position today, a safe, inert default rather than a startup
failure.

## Risks / Trade-offs

- [Risk] A user still has to know this file exists and hand-author it — this doesn't
  fix the underlying UX gap (QA-017 unblocks the *mechanism*, not discoverability) →
  [Mitigation] out of scope for this fix; `docs/PROTOCOL.md`'s existing Origin-allowlist
  section and a new doc addition for this file are the mitigation available today,
  matching how `layout.json` itself is documented without a UI.
- [Trade-off] Yet another local JSON file for a user to manage → accepted, since it's
  the smallest change consistent with existing project conventions; a real
  configuration UI is explicitly out of scope until the no-code UI work happens.

## Migration Plan

Not applicable — purely additive. No existing behavior changes for anyone who already
runs a manually-configured standalone `gatoway-core` (their `GATOWAY_ALLOWED_ORIGINS`
env var, if set directly on that process, continues to work exactly as today); this
only adds a new path for the Stream Deck-spawned case, which previously had no working
path at all.

## Open Questions

None outstanding.
