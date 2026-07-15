## Why

QA-017 (`QA_REPORT.md`, live xDender verification session, 2026-07-15): a real
end-to-end test found that Gatoway core, when spawned as a child of the Stream Deck
*application* (the normal, everyday way it runs — launched via the Dock/Finder, not a
terminal), never has `GATOWAY_ALLOWED_ORIGINS` set. Per `gatoway-core/src/config.ts`, an
unset allowlist defaults to `[]` (fail closed), so every WebSocket-based plugin —
xDender today, any future browser extension — is silently unable to connect at all
through the normal launch path. The only way to set this today is a terminal-exported
shell variable, which a GUI-launched process never inherits. This was only discoverable
by manually inspecting the running process's environment; nothing surfaces the problem
to a user or plugin author.

## What Changes

- The Stream Deck plugin gains a small, local, hand-authored JSON config file (mirroring
  the existing `layout.json` pattern — same config directory, same
  never-throws/safe-fallback loading philosophy) that lets a user declare allowed
  WebSocket Origins.
- On startup, the Stream Deck plugin reads this file and forwards the declared origins
  to its spawned Gatoway core child as `GATOWAY_ALLOWED_ORIGINS`, exactly as it already
  does today for `GATOWAY_TCP_PORT`/`GATOWAY_TOKEN_FILE` (`coreLifecycle/config.ts`'s
  `buildCoreChildEnv`) — the difference is this value now has a real, persistent,
  GUI-launch-compatible source instead of only ever being empty in practice.
- Missing or malformed file: falls back to an empty allowlist (current behavior,
  unchanged) and logs why, matching this project's established
  fail-safe-not-fail-closed-to-a-crash philosophy for local config files.
- Out of scope: any UI for editing this file (no-code configuration remains deferred
  per `REQUIREMENTS.md`); WebSocket port (`GATOWAY_WS_PORT`) configurability, which has
  no reported gap and is not part of QA-017.

## Capabilities

### Modified Capabilities
- `stream-deck-core-lifecycle`: the Stream Deck plugin's core-spawning behavior is
  amended to read and forward a locally-configured Origin allowlist to the child
  Gatoway core process.

## Impact

- New file: a small config-loading module in `stream-deck-plugin/src/coreLifecycle/`
  (mirroring `gatoway-core/src/routing/layoutConfig.ts`'s validation style) plus a
  schema addition to `coreLifecycle/config.ts`.
- Changes `stream-deck-plugin/src/coreLifecycle/coreProcessSupervisor.ts` (or
  wherever the config is read and merged into the spawned child's environment).
- New local file convention: `<config dir>/allowed-origins.json` (or similar), read once
  at plugin startup — no hot-reload, matching `layout.json`'s existing precedent.
- Directly unblocks xDender (and any future browser-based plugin) from connecting
  through the Stream Deck application's normal, everyday launch path.
