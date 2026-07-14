## Context

`gatoway-core-foundation` built a working connection/auth/protocol/logging core, but
nothing spawns it, connects to it, or shows anything on physical Stream Deck hardware yet.
This design covers the first real consumer: a Stream Deck plugin that brings Gatoway core
up as a child process (AD-1), connects to it as an authenticated client using the existing
protocol, and renders a single static idle profile. No focus/profile-switching logic and no
application plugin exist yet, so this change is deliberately narrow.

## Goals / Non-Goals

**Goals:**
- Spawn Gatoway core as a genuine child process on plugin startup and supervise it,
  restarting it on unexpected exit (AD-1).
- Connect to the running Gatoway core over its existing TCP protocol as an authenticated
  client, using the same `register`/`register_ack` handshake every other plugin will use,
  with retry/backoff on disconnect.
- Render one static idle profile on physical Stream Deck hardware via the Elgato Stream
  Deck SDK, so this change produces a real, hardware-visible milestone.

**Non-Goals:**
- Forwarding physical button presses or dial turns anywhere — no `command` message type
  exists yet, and there is no application connected to route input to.
- Any profile switching, focus tracking, or distinguishing an idle profile from an
  app-specific one — there is exactly one static profile in this change.
- Any application-specific plugin work (Lightroom, xDesign).
- A Property Inspector or any user-facing settings UI for the plugin.

## Decisions

**D1 — Package structure and workspace tooling.** A new `stream-deck-plugin/` package
(Node.js/TypeScript), sibling to `gatoway-core/`. Adds a root-level `package.json` using
npm workspaces (`workspaces: ["gatoway-core", "stream-deck-plugin"]`) so the plugin can
depend on `gatoway-core` as a linked workspace package rather than a fragile relative-path
reference, and both packages install/build together from the repo root. Alternative
considered: a plain `file:../gatoway-core` dependency with no root tooling — rejected as
only marginally simpler while losing the convenience of a single root install/build for
what's now a genuine two-package local project.

**D2 — Process lifecycle (AD-1, applied concretely).** The plugin spawns Gatoway core as a
true OS child process via Node's `child_process.spawn`, invoking `node` against
`gatoway-core`'s built `dist/index.js` (resolved via the workspace dependency, e.g.
`require.resolve('@gatoway/core/dist/index.js')`, not a hand-built path string — directly
avoiding the class of bug QA-005 uncovered in `gatoway-core-foundation`, where a manually
constructed `file://` path comparison broke silently). The plugin listens for the child's
`exit`/`error` events and restarts it with a short backoff, logging every restart.
Alternative considered: importing and calling `startGatowayCore()` in-process instead of
spawning a subprocess — simpler, no subprocess management, but ties Gatoway core's fate to
the plugin's own process, undermining the crash isolation AD-1 calls for; rejected.

**D3 — Connecting as a client.** The plugin connects to Gatoway core's TCP listener using
exactly the existing client-side contract already exercised by `gatoway-core-foundation`'s
own manual TCP test client: read the token file, open a TCP socket to the configured port,
send `register` with `pluginType: "stream-deck"` and an empty capability manifest (nothing
to declare yet, since this change doesn't act on commands), and treat a `register_ack` with
`status: "ok"` as connected. On disconnect, or a `register_ack` with `status: "rejected"`,
retry with backoff. This requires no changes to the `message-protocol`,
`plugin-authentication`, or `connection-management` capabilities — this change is purely a
new consumer of the existing contract.

**D4 — Idle profile rendering is unconditional.** The plugin renders its static idle
profile on the physical Stream Deck immediately at plugin startup, independent of whether
Gatoway core is reachable yet — since there is no profile-switching logic in this change
anyway, "idle" here is simply the plugin's only profile, always shown. This avoids a blank
Stream Deck while the plugin is still starting or reconnecting to Gatoway core. Alternative
considered: only render once connected to Gatoway core — rejected as it produces a worse,
confusing experience (a blank device during normal startup or a transient reconnect) for no
benefit, since the profile's content doesn't depend on the connection in this change.

**D5 — Manifest/action scope.** The plugin's `manifest.json` declares a minimal, fixed set
of static keys (icon/label only, no dynamic behavior) for the idle profile — no Property
Inspector, no per-app profiles. Real per-app profiles and dynamic key/dial content are
introduced once focus/profile-switching (delivery-sequence step 4) and an application
plugin exist.

## Risks / Trade-offs

- [Risk] Spawning depends on `gatoway-core` already being built (`dist/index.js` present)
  → [Mitigation] the root workspace build orders `gatoway-core`'s build before the plugin's
  own build/packaging step; if the spawn still fails (e.g. a missing build in a fresh
  checkout), the plugin logs a clear, visible error rather than failing silently — directly
  informed by the QA-005 lesson that a silent no-op is unacceptable for this exact failure
  mode.
- [Risk] The Elgato Stream Deck SDK requires physical (or emulated) hardware to actually
  confirm rendering — this can't be verified by an automated test suite alone →
  [Mitigation] automated tests cover what's testable in isolation (child-process
  spawn/supervise logic, the TCP client's connect/register/retry logic, using the same
  approach as `gatoway-core-foundation`'s `cliEntrypoint.test.ts`); actual on-device
  rendering is confirmed via `/verify` with the user and real hardware, as before.
- [Trade-off] Using npm workspaces changes the repo's top-level structure for the first
  time (a new root `package.json`) — a deliberate, low-stakes choice for a project that now
  genuinely has two local packages; revisit only if it causes friction in practice.

## Migration Plan

Not applicable — greenfield code, no existing deployment. Adds a root `package.json` for
workspaces; existing `gatoway-core/` package.json/scripts are unaffected.

## Open Questions

- Exact Elgato Stream Deck SDK package/version and manifest conventions are left for the
  developer to confirm against the SDK's current documentation, rather than hardcoded here.
- **Deferred: true zero-touch profile auto-install.** A `Profiles` entry in
  `manifest.json` plus a bundled `Gatoway.streamDeckProfile` (with
  `DontAutoSwitchWhenInstalled: true`) was attempted to make the idle key appear on
  install without the user manually placing the Idle action on a key. Live testing
  against real Stream Deck+ hardware showed this had no effect at all — no profile
  appeared, not even the "installed but not force-switched" behavior the flag implies.
  Investigation against two other real plugins already installed on this machine
  (Volume Controller, Lightroom) found neither is actually a confirmed working example
  of this mechanism either. Getting this right needs authoritative Elgato SDK
  documentation on the real auto-install contract, not accessible in this session, so
  the attempt was reverted and manual placement is accepted as this change's behavior.
  Revisiting true auto-install is deferred to a future change.
