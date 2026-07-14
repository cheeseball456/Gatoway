# Gatoway Core

Gatoway core is the application-agnostic communications hub between an Elgato Stream
Deck and application-specific plugins (e.g. a Lightroom plugin, a browser extension for
Solidworks xDesign). It is a standalone Node.js/TypeScript process: application plugins
connect into it over TCP or WebSocket, authenticate, and exchange a shared JSON message
protocol.

This package implements the connection/authentication/protocol/logging foundation
(`gatoway-core-foundation`) plus, as of `focus-profile-routing`, focus tracking (which
single connection, if any, currently has focus), profile routing (resolving physical
Stream Deck input against the focused connection's bound capability and forwarding a
`command`), and live capability display updates (`capability_update`). See
[Current Scope and Limitations](#current-scope-and-limitations) for what is deliberately
not yet built.

For the project's requirements and architecture, see [`../REQUIREMENTS.md`](../REQUIREMENTS.md)
and [`../ARCHITECTURE.md`](../ARCHITECTURE.md). For the full wire message contract, see
[`../docs/PROTOCOL.md`](../docs/PROTOCOL.md) — the reference an application plugin
author should build against, rather than this package's own source. For the detailed
capability specs this package implements, see
[`openspec/specs/`](../openspec/specs/)
(`connection-management`, `plugin-authentication`, `message-protocol`,
`diagnostics-logging`) — consolidated there after the `gatoway-core-foundation` change
that introduced them was archived; see
[`openspec/changes/archive/2026-07-13-gatoway-core-foundation/`](../openspec/changes/archive/2026-07-13-gatoway-core-foundation/)
for that change's original proposal and design record, and
[`openspec/changes/focus-profile-routing/`](../openspec/changes/focus-profile-routing/)
for the focus-tracking/profile-routing/capability-update change (not yet archived at
the time of writing).

## Requirements

- Node.js >= 20
- npm

## Install

This project is an npm workspaces monorepo (`gatoway-core` and `stream-deck-plugin` are
sibling workspace packages). Install from the **repository root**, not from inside this
directory:

```bash
npm install
```

Running `npm install` from inside `gatoway-core/` directly will not correctly link the
`stream-deck-plugin` package's dependency on this one.

## Running it standalone (development)

Gatoway core can run as a standalone process — useful for development and for manually
exercising the listeners before a Stream Deck plugin exists to spawn it.

```bash
npm run dev
```

This runs `src/index.ts` directly via `tsx`. Alternatively, build and run the compiled
output:

```bash
npm run build
npm start
```

On startup, Gatoway core:
- generates a fresh authentication token and writes it to the token file (see below),
- binds the TCP listener to `127.0.0.1` (default port `47821`),
- binds the WebSocket listener to `127.0.0.1` (default port `47822`),
- opens the rotating log file (see below) and writes a `gatoway_core_started` event.

Both listeners are **loopback-only** — bound to `127.0.0.1` (IPv4) and never
`0.0.0.0` — so Gatoway core is unreachable from any other machine on the network,
regardless of local firewall state.

Stop it with `Ctrl+C`; it closes both listeners and flushes the logger before exiting.

## Configuration (environment variables)

All configuration is optional; every variable below has a per-OS default. Set these
before running `npm run dev` / `npm start`, or export them in the shell that runs the
manual test clients (see [Manual test clients](#manual-test-clients)) so they agree with
the running instance.

| Variable | Default | Purpose |
|---|---|---|
| `GATOWAY_TCP_PORT` | `47821` | Port the TCP listener binds on `127.0.0.1` |
| `GATOWAY_WS_PORT` | `47822` | Port the WebSocket listener binds on `127.0.0.1` |
| `GATOWAY_CONFIG_DIR` | Per-OS user config dir (see below) | Base directory for the auth token file, if `GATOWAY_TOKEN_FILE` isn't set |
| `GATOWAY_TOKEN_FILE` | `<config dir>/auth-token` | Path to the auth token file (native/TCP plugins read this to authenticate) |
| `GATOWAY_ALLOWED_ORIGINS` | *(empty — fail closed)* | Comma-separated list of allowlisted WebSocket `Origin` values (e.g. `chrome-extension://<id>`). No origins are allowed by default, so no WebSocket connection succeeds until this is set |
| `GATOWAY_LOG_DIR` | Per-OS user log dir (see below) | Base directory for the log file, if `GATOWAY_LOG_FILE` isn't set |
| `GATOWAY_LOG_FILE` | `<log dir>/gatoway-core.log` | Path to the active rotating log file |
| `GATOWAY_LOG_MAX_SIZE_BYTES` | `10485760` (10 MB) | Log rotation size threshold |
| `GATOWAY_LOG_MAX_FILES` | `5` | Number of rotated log files retained in addition to the active one |
| `GATOWAY_LOG_LEVEL` | `info` | Minimum log level |

**Per-OS default config directory** (`GATOWAY_CONFIG_DIR`, holds the token file):
- macOS: `~/Library/Application Support/gatoway`
- Windows: `%APPDATA%\gatoway`
- Linux/other: `$XDG_CONFIG_HOME/gatoway` or `~/.config/gatoway`

**Per-OS default log directory** (`GATOWAY_LOG_DIR`):
- macOS: `~/Library/Logs/gatoway`
- Windows: `%APPDATA%\gatoway\logs`
- Linux/other: `$XDG_STATE_HOME/gatoway/logs` or `~/.local/state/gatoway/logs`

Both directories are created automatically on first run if they don't already exist.

### Auth token file

The token file holds a fresh, crypto-random 32-byte token generated every time Gatoway
core starts (it overwrites any previous token). It is written with owner-only
permissions (`0600` on POSIX; an equivalent ACL restriction via `icacls` on Windows). A
native (TCP) plugin reads this file and presents the token in its first message to
authenticate; see [`plugin-authentication`
spec](../openspec/specs/plugin-authentication/spec.md).

WebSocket (browser-extension) connections do not use the token; they are checked
instead against the `GATOWAY_ALLOWED_ORIGINS` allowlist at the HTTP-upgrade stage.

## Manual test clients

Two scripts let you exercise the accept/reject behavior of each listener against a
running Gatoway core instance, without a real plugin (a third, described further below,
exercises the focus/routing/capability-update mechanism instead). Start Gatoway core
first (`npm run dev`), then in another terminal:

```bash
# Exercises the TCP listener: connects once with the current valid token
# (read from the token file), and once with a deliberately invalid token.
npm run manual:tcp-client
```

```bash
# Exercises the WebSocket listener: connects once with an allowlisted Origin
# and once with a non-allowlisted Origin. Requires GATOWAY_ALLOWED_ORIGINS to
# include the origin the script will present:
GATOWAY_ALLOWED_ORIGINS=chrome-extension://test-id npm run manual:ws-client
```

Both scripts print the observed `register_ack` (or upgrade-refusal) result for each
attempt, and honor the same `GATOWAY_*` environment variables as Gatoway core itself, so
they find the running instance's port and token file by default.

A third script, added by `focus-profile-routing`, stands in for a real application
plugin so focus tracking, profile routing, and live capability updates can be exercised
end to end — including against real Stream Deck+ hardware, via the actual Stream Deck
plugin connected as the display client:

```bash
npm run manual:test-app-client
```

It registers a small fixture set of capabilities (matching
`src/routing/testFixtureLayoutResolver.ts`'s hardcoded test layout) and accepts
`focus` / `blur` / `update` / `quit` commands typed at the prompt — see
[`stream-deck-plugin/README.md`](../stream-deck-plugin/README.md#exercising-the-mechanism-without-a-real-application-plugin)
for the full walkthrough of what each command does.

## Message protocol

Every message, on either transport, shares one JSON envelope:

```jsonc
{ "type": "register", "connectionId": "...", "payload": { /* type-specific */ } }
```

- **TCP:** newline-delimited JSON — one JSON object per line.
- **WebSocket:** one JSON object per text frame.

The full message set, as of `focus-profile-routing`:
- `register` (plugin → core): declares `pluginType` and a `capabilities` manifest
  (button/dial actions the plugin supports); TCP clients also include their auth `token`.
- `register_ack` (core → plugin): `status: "ok" | "rejected"`, the assigned
  `connectionId`, and a `reason` on rejection.
- `error` (either direction): a protocol-level error report.
- `focus` (application plugin → core): reports the plugin's own focus/blur state.
  Gatoway core tracks at most one focused connection at a time and switches the Stream
  Deck's displayed profile accordingly.
- `input_event` (Stream Deck plugin → core): a raw physical interaction (key
  down/up, dial rotate/push) at a given position — no app-specific meaning attached.
- `render_update` (core → Stream Deck plugin): what to display at a given position
  (icon/label/state), including the built-in idle appearance when nothing is focused.
- `command` (core → focused application connection): an `input_event` resolved against
  that connection's bound capability.
- `capability_update` (application plugin → core): lets a plugin push a live
  icon/label/state change to one of its own already-declared capabilities at any time
  after registration (satisfies `REQUIREMENTS.md` FR-001).

See [`../docs/PROTOCOL.md`](../docs/PROTOCOL.md) for the full reference — envelope,
every payload shape, the `icon` field's null-vs-omitted reset semantics, and practical
icon/label content guidance — rather than the abbreviated summary above. The
[`message-protocol` spec](../openspec/specs/message-protocol/spec.md) covers only the
original `register`/`register_ack`/`error` set from `gatoway-core-foundation`; the five
message types added by `focus-profile-routing` are specified in that change's own
[`specs/message-protocol/spec.md`](../openspec/changes/focus-profile-routing/specs/message-protocol/spec.md)
until the change is archived and consolidated.

## Logging

Gatoway core writes structured, newline-delimited JSON log entries to the rotating log
file described above. Logged events include connection lifecycle (accepted,
authenticated, disconnected), authentication successes/failures, plugin registration
(including the declared capability manifest), and every message sent/received on an
authenticated connection. Rotation is size-based (`GATOWAY_LOG_MAX_SIZE_BYTES`), keeping
a bounded number of rotated files (`GATOWAY_LOG_MAX_FILES`) — logs are for short-term,
active debugging, not long-term archival.

## Running the automated test suite

```bash
npm test          # runs the full unit + integration suite once
npm run test:watch
npm run typecheck  # tsc --noEmit
```

## Current scope and limitations

This package now implements the core foundation (`gatoway-core-foundation`, the first
change in Gatoway's delivery sequence) plus focus tracking, profile routing, and live
capability updates (`focus-profile-routing`, delivery-sequence step 4; see
`../ARCHITECTURE.md`'s Delivery Sequence). As of the most recent change:

- **A Stream Deck plugin now exists** ([`../stream-deck-plugin/`](../stream-deck-plugin/))
  that spawns, supervises, and connects to Gatoway core as a client, and renders
  Gatoway's generic, position-based Key/Dial actions on physical Stream Deck hardware —
  including the built-in idle appearance when nothing is focused. It registers with an
  empty capability manifest of its own (it is the display client, not an application
  connection) — see that package's own README for its scope.
- **Focus tracking and profile routing now work end to end.** Gatoway core tracks which
  single connection (if any) currently has focus, resolves physical `input_event`s
  against that connection's bound capability, forwards resolved `command`s, and keeps
  the Stream Deck plugin's display in sync with focus changes, falling back to the idle
  appearance when nothing is focused.
- **Live capability updates work.** A connection can push a `capability_update` for one
  of its own already-declared capabilities at any time after registration, and Gatoway
  core immediately re-renders it on the Stream Deck if that connection is currently
  focused (`REQUIREMENTS.md` FR-001).
- **No persisted layout config yet.** Position → capability bindings are resolved
  against an in-code test fixture (`src/routing/testFixtureLayoutResolver.ts`), not a
  real config file — that's delivery-sequence step 6, a later change.
- **No real application plugins exist yet** (no Lightroom adapter, no xDesign/xDender
  browser extension) — `focus-profile-routing` proves the mechanism using a manual
  test-double client (`test/manual/testAppClient.ts`; see
  [Manual test clients](#manual-test-clients)) and live verification against real
  Stream Deck+ hardware, not a real second application.

## Known open items (see `QA_REPORT.md`)

A few non-blocking observations from QA review remain open at the time of writing, for
awareness when working on this package:

- The WebSocket `authentication_succeeded` log line omits the matched `origin` value
  (the corresponding failure log includes it).
- The Windows ACL-restriction path for the auth token file (`icacls`, in `src/auth/token.ts`)
  has not been verified on an actual Windows machine.
- If writing/restricting the auth token file fails at startup, Gatoway core logs the
  failure but continues running rather than aborting (a deliberate trade-off, since
  loopback-only binding still holds regardless).

See `../QA_REPORT.md` for full detail and status on these and all other findings from
this change's review and verification.
