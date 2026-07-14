# Stream Deck Plugin

The Stream Deck plugin is the hardware-facing half of Gatoway: it spawns and supervises
Gatoway core as a child process, connects to it as an authenticated TCP client, and
renders Gatoway's key(s) on physical Elgato Stream Deck hardware via the official Elgato
Stream Deck SDK.

As of the `focus-profile-routing` change, this package implements Gatoway's generic,
position-based action model (`ARCHITECTURE.md` AD-8): two generic actions, **Key**
(keypad positions) and **Dial** (encoder/dial positions), whose displayed content and
behavior are fully controlled by Gatoway core. Neither action has any app-specific or
even idle-specific knowledge baked into it — the plugin only forwards raw physical
events (`input_event`) and renders whatever Gatoway core instructs (`render_update`),
including the built-in idle appearance shown when no application currently has focus.
This replaces the earlier `stream-deck-plugin-skeleton` change's single static "Idle"
action, which is no longer part of the plugin (see
[Placing the generic actions](#placing-the-generic-actions-manual-one-time) and
[Migrating from the old Idle action](#migrating-from-the-old-idle-action) below). There
is still no application-specific plugin work in this repository (no Lightroom or
xDesign integration) — see [Scope and limitations](#scope-and-limitations).

For the project's requirements and architecture, see [`../REQUIREMENTS.md`](../REQUIREMENTS.md)
and [`../ARCHITECTURE.md`](../ARCHITECTURE.md). For the full wire message contract
(`register`, `focus`, `input_event`, `render_update`, `command`, `capability_update`),
see [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md) — this is the reference an application
plugin author should build against. For the detailed capability specs this package
implements, see
[`openspec/changes/stream-deck-plugin-skeleton/specs/`](../openspec/changes/stream-deck-plugin-skeleton/specs/)
and
[`openspec/changes/focus-profile-routing/specs/`](../openspec/changes/focus-profile-routing/specs/)
(`stream-deck-idle-display`'s delta spec — despite its name, this is now where the
generic action model is specified; the original static-Idle requirements it once held
were removed in favor of the generic Key/Dial requirements).

## Requirements

- Node.js >= 20.5.1
- npm
- An Elgato Stream Deck application install (macOS 10.15+ or Windows 10+ — see
  [Platform support](#platform-support)) and, ideally, real Stream Deck hardware. The
  plugin cannot be meaningfully exercised without the Stream Deck application, since it
  is the Stream Deck application that launches the plugin process in the first place.
- The Elgato Stream Deck CLI (`@elgato/cli`, providing the `streamdeck` command),
  installed globally per Elgato's own SDK documentation. This project does not vendor
  or depend on it directly — it is a one-time developer-machine tool used only to link
  and manage locally-developed plugins, not something an end user needs.

## Install and build

This package is part of the repo-root npm workspace and is **not installed or built
standalone**. From the repository root (not from inside `stream-deck-plugin/`):

```bash
npm install
npm run build
```

`npm run build` at the root builds `gatoway-core` first and this package second (the
plugin depends on `gatoway-core`'s compiled output — see
[How it spawns Gatoway core](#how-it-spawns-gatoway-core)). Building just this package
(`npm run build --workspace=stream-deck-plugin`) also works, but only once
`gatoway-core` itself has been built at least once.

Building runs two steps in sequence (see `package.json`'s `build` script):
1. `tsc -p tsconfig.json` compiles `src/` to `dist/`.
2. `scripts/packagePlugin.mjs` copies `dist/` into
   `com.gatoway.streamdeck.sdPlugin/bin/` — the exact location the Stream Deck
   application actually loads, per `manifest.json`'s `CodePath: "bin/plugin.js"`. `tsc`
   alone is not enough to produce a loadable plugin; this second step is required.

If a fresh checkout's very first build fails with `@types/node`/module-resolution
errors immediately after `npm install`, retry the same build command once — this has
been observed as a one-off npm-workspace-linking race on a first install, not a
reproducible defect (see `QA_REPORT.md`).

## Running it against real Stream Deck hardware

This plugin is a real Stream Deck plugin, not a standalone program you run directly —
the Stream Deck application itself launches `com.gatoway.streamdeck.sdPlugin/bin/plugin.js`
as a subprocess once the plugin is linked and the application is restarted. To exercise
it end to end:

1. **Build it** (see above), so `com.gatoway.streamdeck.sdPlugin/bin/plugin.js` exists.
2. **Enable developer mode.** This is the step most likely to trip up a first attempt:
   a locally-linked plugin (one not installed from Elgato's Marketplace) **will not
   load at all** unless developer mode is enabled first, and the failure is silent —
   the Stream Deck application's own log records `"Feature only enabled in developer
   mode"`, but nothing surfaces in Gatoway's own logs, because the plugin process never
   launches in the first place. Enable it with:
   ```bash
   streamdeck dev
   ```
   This is standard Elgato Stream Deck SDK behavior, not specific to this plugin — do
   this once per development machine before the first link.
3. **Link the plugin**, pointing the CLI at `com.gatoway.streamdeck.sdPlugin/`:
   ```bash
   streamdeck link com.gatoway.streamdeck.sdPlugin
   ```
4. **Restart the Stream Deck application** so it picks up the newly-linked plugin:
   ```bash
   streamdeck restart
   ```
5. **Place a generic Key or Dial action on a physical key/dial.** See the next section
   — this is a required, one-time manual step in the plugin's current state.

After a code change, rebuild (`npm run build`) and re-run `streamdeck restart` to pick
up the new `bin/plugin.js`.

### Placing the generic actions (manual, one-time)

The plugin does **not** currently auto-provision a profile or place actions for you.
After linking and restarting, open the Stream Deck application, find the **Gatoway**
category in the action list, and drag the **Key** action onto a physical key and/or the
**Dial** action onto a physical dial yourself (a Stream Deck+ has both keys and dials;
plain Stream Deck models have only keys). Once placed, the position renders whatever
Gatoway core's most recent `render_update` instructed — the built-in idle appearance
(icon reset to the manifest default, "Gatoway" title) by default, since nothing is
focused until an application plugin connects and reports focus — and continues to do so
across Gatoway core disconnects/restarts. Nothing appears on the device until this
manual placement happens.

This is a known, deliberate limitation, not an oversight: a true zero-touch auto-install
(a bundled Stream Deck profile that places actions automatically on install) was
attempted and tested live against real hardware for the original static Idle action,
found not to work, and was reverted; this change did not revisit that decision. See
`openspec/changes/stream-deck-plugin-skeleton/design.md`'s Open Questions for the full
investigation and why it's deferred to a future change, rather than solved here.

### Migrating from the old Idle action

If you placed the earlier `stream-deck-plugin-skeleton` change's static **Idle** action
on a key before upgrading, it no longer exists — the plugin's manifest replaces it
outright with the generic **Key**/**Dial** actions described above (an internal, clean
replacement, since Gatoway has no public users yet; see
`openspec/changes/focus-profile-routing/proposal.md`'s Migration Plan). After
rebuilding and restarting with this version, the old Idle key will show as a missing/
unrecognized action on the Stream Deck application's profile — remove it and drag the
new **Key** action onto that position instead.

### Exercising the mechanism without a real application plugin

No real Lightroom or xDesign plugin exists yet — both are future work (`ARCHITECTURE.md`
delivery-sequence steps 3 and 5). To exercise focus tracking, profile routing, and live
capability updates end to end against real hardware in the meantime, `gatoway-core`
ships a manual test-double application-plugin client:
[`gatoway-core/test/manual/testAppClient.ts`](../gatoway-core/test/manual/testAppClient.ts).

With Gatoway core already running (e.g. via this plugin, or standalone with
`npm run dev --workspace=gatoway-core`), run from the repository root:

```bash
npm run manual:test-app-client --workspace=gatoway-core
```

This connects to Gatoway core, registers as `pluginType: "test-app"` declaring a small
fixture set of capabilities (two buttons, one dial — matching
`gatoway-core/src/routing/testFixtureLayoutResolver.ts`'s hardcoded test layout), and
then accepts commands typed at the prompt:

- **`focus`** — reports `focused: true`. Should bind the test fixture's two keys and one
  dial on the real hardware, replacing the idle appearance.
- **`blur`** — reports `focused: false`. Should revert the hardware to the idle
  appearance, with the icon explicitly reset rather than left showing whatever the test
  app last displayed.
- **`update`** — pushes a `capability_update` toggling one button's label between
  `"Fixture A"` and `"Fixture A (pushed)"`. If this client is currently focused, the
  real hardware should update immediately, with no further focus change or key press
  needed — this is the live capability-update mechanism's headline behavior.
- **`quit`** — disconnects. Since a disconnect while focused clears focus exactly like
  an explicit blur, this should also revert the hardware to the idle appearance.

Any `command` message Gatoway core sends back (a bound key press or dial turn on the
real hardware while this test-double is focused) is printed to the console as it
arrives. This script is genuinely useful beyond this change's own verification —
anyone developing or testing Gatoway further, including whoever eventually adapts the
real Lightroom plugin, can use it to exercise the full mechanism without needing a real
application plugin connected. See [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md) for the
full message contract this script (and any real plugin) speaks.

## How it spawns Gatoway core

On startup, the plugin locates `gatoway-core`'s built entry point
(`@gatoway/core`'s `dist/index.js`) via Node's own module resolution against the
workspace dependency (not a hand-built path string), spawns it as a genuine child
process, and supervises it — restarting it with a backoff delay if it exits
unexpectedly. This means `gatoway-core` must already be built (`gatoway-core/dist/`
must exist) before the plugin can start it; the root `npm run build` ordering handles
this for you.

The plugin then connects to the spawned Gatoway core instance as a TCP client, using the
same `register`/`register_ack` handshake and shared-secret token any other native
plugin uses (see [`gatoway-core/README.md`](../gatoway-core/README.md)'s "Message
protocol" and "Auth token file" sections), registering with plugin type `stream-deck`
and an empty capability manifest. This is deliberate and unrelated to the generic action
model added by `focus-profile-routing`: per `ARCHITECTURE.md` AD-8, the Stream Deck
plugin's own connection never declares capabilities — it is the one display client
Gatoway core sends `render_update` to, not an application connection with its own
capabilities to bind positions to. It forwards physical `input_event`s and applies
`render_update`s exactly as described in [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md).

## Configuration

The plugin owns the Gatoway core instance it spawns, so it decides the port and token
file path and passes them to the child via the same `GATOWAY_TCP_PORT` /
`GATOWAY_TOKEN_FILE` environment variables `gatoway-core` itself understands (see
[`gatoway-core/README.md`](../gatoway-core/README.md#configuration-environment-variables)).
Absent an override, it uses `gatoway-core`'s own per-OS defaults (port `47821`; the
per-OS default token file location), so a manually-started standalone `gatoway-core`
and this plugin agree on the token file's location with no explicit configuration in the
common case.

## Development workflow

```bash
npm run dev          # runs src/plugin.ts directly via tsx
npm start             # runs the built dist/plugin.js directly
```

Both of these run the plugin's Node process standalone, **outside** the Stream Deck
application. This is useful for quickly catching startup errors (e.g. a missing
`gatoway-core` build, a config/env problem) — the process will start, spawn Gatoway
core, and attempt to connect — but it does **not** render anything on physical hardware:
the Stream Deck SDK's transport expects to be launched by the real Stream Deck
application with connection arguments on `argv`, which these commands don't supply. To
see it on real hardware, use the `streamdeck link` / `streamdeck restart` workflow
above.

## Running the automated test suite

```bash
npm test          # runs the full unit + integration suite once
npm run test:watch
npm run typecheck  # tsc --noEmit
```

The automated suite covers what's testable without physical hardware: child-process
spawn/supervise/backoff logic, the TCP client's connect/register/retry logic (including
against a real running Gatoway core instance in the integration tests), config
resolution, and backoff calculation. It cannot confirm actual on-device rendering —
that was confirmed live against real Stream Deck+ hardware during `/verify` (see
`../QA_REPORT.md`), not by this suite.

## Scope and limitations

This package implements the plugin skeleton (`stream-deck-plugin-skeleton`) plus the
generic action model, focus/profile routing on the Gatoway core side, and live
capability updates (`focus-profile-routing`) — the fourth change in Gatoway's delivery
sequence (see `../ARCHITECTURE.md`'s Delivery Sequence). As of this change:

- **Command forwarding, profile routing, and focus tracking all work end to end** —
  Gatoway core resolves a physical key press or dial turn against whichever connection
  currently has focus and forwards a `command`, and switches the Stream Deck's display
  between an application's bound layout and the built-in idle appearance as focus
  changes. All of this has been verified live against real Stream Deck+ hardware using
  a test-double application client (see
  [Exercising the mechanism without a real application plugin](#exercising-the-mechanism-without-a-real-application-plugin)
  above), since no real Lightroom/xDesign plugin exists yet.
- **No persisted layout config yet.** Gatoway core currently resolves position →
  capability bindings against an in-code test fixture
  (`gatoway-core/src/routing/testFixtureLayoutResolver.ts`), not a real config file —
  that's delivery-sequence step 6, a later change, not this one.
- **No auto-install of the generic actions.** See
  [Placing the generic actions](#placing-the-generic-actions-manual-one-time) above.
- **No Property Inspector or settings UI** for the plugin.
- **No application-specific plugin work** (no Lightroom or xDesign integration) — that
  is scoped to later changes in the delivery sequence.

### Platform support

Per `manifest.json`'s `"OS"` entries, this plugin supports macOS 10.15+ and Windows 10+
only — it has no Linux entry, because Elgato's own Stream Deck application has no Linux
build at all. `gatoway-core` itself remains fully portable to Linux; this is a
vendor-imposed limitation of the Stream Deck application, not of this plugin's own code
(see `REQUIREMENTS.md`'s NFR 3.4).

## Known open items (see `QA_REPORT.md`)

A few non-blocking observations from QA review and live `/verify` remain open at the
time of writing:

- A rejected registration attempt currently produces three separate, slightly
  overlapping log lines for what is conceptually one event
  (`stream-deck-plugin/src/coreClient/coreClient.ts`).
- `stream-deck-plugin/package.json` pins `"typescript": "^7.0.2"`, an unusually early
  major version (consistent with `gatoway-core`'s own existing pin).
- True zero-touch auto-install of a generic action onto a profile was attempted (for the
  original static Idle action, before this change), found not to work against real
  hardware, and reverted — deferred to a future change (see
  `stream-deck-plugin-skeleton`'s `design.md` Open Questions).
- A capability label longer than roughly 8-10 characters visibly overflows a physical
  key's title area (e.g. the manual test-app client's `"Fixture A (pushed)"` label) —
  see [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md#icon-and-label-content) for practical
  length guidance.

See `../QA_REPORT.md` for full detail and status on these and all other findings from
this change's review and verification.
