# Stream Deck Plugin

The Stream Deck plugin is the hardware-facing half of Gatoway: it spawns and supervises
Gatoway core as a child process, connects to it as an authenticated TCP client, and
renders Gatoway's key(s) on physical Elgato Stream Deck hardware via the official Elgato
Stream Deck SDK.

This package currently implements only the **skeleton** described below — a single
static "Idle" key, no per-application profiles, no command forwarding yet. See
[Scope and Limitations](#scope-and-limitations) for what is deliberately not yet built.

For the project's requirements and architecture, see [`../REQUIREMENTS.md`](../REQUIREMENTS.md)
and [`../ARCHITECTURE.md`](../ARCHITECTURE.md). For the detailed capability specs this
package implements, see
[`openspec/changes/stream-deck-plugin-skeleton/specs/`](../openspec/changes/stream-deck-plugin-skeleton/specs/)
(`stream-deck-core-lifecycle`, `stream-deck-core-client`, `stream-deck-idle-display`).

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
5. **Place the Idle key on a physical key.** See the next section — this is a required,
   one-time manual step in the plugin's current state.

After a code change, rebuild (`npm run build`) and re-run `streamdeck restart` to pick
up the new `bin/plugin.js`.

### Placing the Idle key (manual, one-time)

The plugin does **not** currently auto-provision a profile or place its key for you.
After linking and restarting, open the Stream Deck application, find the **Gatoway**
category in the action list, and drag the **Idle** action onto a physical key yourself.
Once placed, the key renders its icon and "Gatoway" title immediately, and continues to
do so across Gatoway core disconnects/restarts — but nothing appears on the device until
this manual placement happens.

This is a known, deliberate limitation, not an oversight: a true zero-touch auto-install
(a bundled Stream Deck profile that places the key automatically on install) was
attempted and tested live against real hardware, found not to work, and was reverted.
See `openspec/changes/stream-deck-plugin-skeleton/design.md`'s Open Questions for the
full investigation and why it's deferred to a future change, rather than solved here.

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
and an empty capability manifest — this change forwards no button presses or dial turns
anywhere yet.

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

This package currently implements only the **skeleton** — the second change in
Gatoway's delivery sequence (see `../ARCHITECTURE.md`'s Delivery Sequence). As of this
change:

- **No command forwarding.** Physical button presses and dial turns are not sent
  anywhere — there is no `command` message type yet in Gatoway core's protocol, and no
  application plugin connected to route them to.
- **No profile switching or focus tracking.** There is exactly one static profile (the
  Idle key described above) — no per-application profiles, no idle-vs-app-profile
  distinction, no dynamic key content.
- **No auto-install of the Idle key.** See
  [Placing the Idle key](#placing-the-idle-key-manual-one-time) above.
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
- True zero-touch auto-install of the Idle key onto a profile was attempted, found not
  to work against real hardware, and reverted — deferred to a future change (see
  `design.md`'s Open Questions).

See `../QA_REPORT.md` for full detail and status on these and all other findings from
this change's review and verification.
