# Architecture: Gatoway

**Version:** 1.3
**Date:** 2026-07-14
**Status:** Draft — ready for change proposals

---

## Overview

Gatoway is an application-agnostic communications core that sits between an Elgato Stream
Deck and any number of application-specific plugins (Lightroom Classic, the xDender
browser extension for Solidworks xDesign, and future apps). It replaces the previous
model — a direct, one-to-one bridge rebuilt per application — with a central hub that
every plugin connects into, using one shared message protocol regardless of which
application or transport is on the other end.

Gatoway core runs as a local child process, spawned and supervised by the Stream Deck
plugin. Application plugins connect to it over a loopback-only TCP or WebSocket
listener, authenticate, declare what actions they support, and report their own focus
state. Gatoway core tracks which plugin currently has focus and drives the Stream
Deck's displayed profile accordingly, falling back to an idle profile when nothing is
focused.

---

## Components

- **Gatoway Core** (Node.js/TypeScript) — the hub. Owns connection management (TCP +
  WebSocket listeners, both loopback-bound), authentication, the unified message
  protocol, focus tracking and profile-switching logic, layout/profile persistence, and
  logging. Runs as a single local process per machine.
- **Stream Deck Plugin** (Node.js/TypeScript, built on the Elgato Stream Deck SDK) —
  spawns and supervises the Gatoway Core child process (restarting it if it crashes),
  connects to Gatoway Core as the display/input client, and forwards raw physical
  input (which position was pressed, which dial turned by how much) and renders
  whatever position-addressed icon/label/state Gatoway Core instructs via the Stream
  Deck SDK. Per AD-8, the plugin has no app-specific knowledge at all — it is a
  generic input/output device driver; Gatoway Core alone resolves what a given
  position means.
- **Application Plugins** (per-app, outside Gatoway's own codebase, but speaking its
  protocol):
  - **Lightroom Classic Plugin** (Lua) — the existing plugin's proven TCP + JSON-Lines
    networking layer, adapted to the new unified message schema and token handshake.
  - **xDender Browser Extension** (JavaScript) — connects via WebSocket, using the
    browser's own `Origin` header for authentication.
  - Future application plugins follow the same contract: connect over TCP or
    WebSocket, authenticate, declare capabilities, self-report focus.
- **Shared Message Protocol** — the JSON message schema (registration, focus events,
  commands, state updates) that is identical across both transports, so Gatoway core's
  message-handling logic does not fork by transport — only the connection-accept code
  does.

---

## Key Decisions

| ID | Decision | Status | Rationale | Rejected Alternatives |
|----|----------|--------|-----------|------------------------|
| AD-1 | Gatoway core runs as a child process spawned/supervised by the Stream Deck plugin, not an independent OS service | Decided | Requirements set no uptime SLA and prioritize simplicity for a personal-use tool (no install/uninstall service tooling needed); the Stream Deck software already manages its own plugin's lifecycle | Independent OS-level service (launchd/systemd/Windows service) — rejected as more engineering (three separate installer mechanisms) than the requirements justify |
| AD-2 | Gatoway core and the Stream Deck plugin are built in Node.js/TypeScript | Decided | Matches the existing Lightroom plugin's Stream Deck-side language and the Elgato Stream Deck SDK's own Node/TS ecosystem; mature cross-platform WebSocket/TCP support satisfies NFR 3.4 (Windows/Mac/Linux) | Python (weaker cross-platform background-process packaging story); Go/Rust (better single-binary distribution for a future public release, but a second toolchain with no reuse of existing work) |
| AD-3 | Dual transport: TCP + newline-delimited JSON for native plugins, WebSocket for browser-based plugins; one unified JSON message schema across both | Decided | Lightroom's Lua sandbox only exposes raw TCP (`LrSocket`) — no WebSocket/HTTP-upgrade client, no SHA-1/bitwise primitives — so requiring WebSocket there would mean vendoring a pure-Lua SHA-1 and hand-rolling RFC 6455 framing/masking for no functional benefit over the proven TCP channel already in place. Browser extensions can only realistically reach a local process via WebSocket. | "WebSocket everywhere" (original recommendation) — rejected once the Lua-environment cost was confirmed via research: moderate, unnecessary lift with no benefit to an already-working channel |
| AD-4 | Both listeners bind to IPv4 loopback only (`127.0.0.1`), never `0.0.0.0`. IPv6 loopback (`::1`) is not bound | Decided (amended v1.1) | Satisfies NFR 3.3 (local-only communication) at the network layer; an OS-level refusal of non-loopback connections holds regardless of firewall state, unlike an application-layer check. IPv6 loopback binding was dropped after QA-002 (gatoway-core-foundation review) found that requiring both addresses fails Gatoway core's entire startup on any host without IPv6 loopback available, for no benefit — IPv4 loopback alone already satisfies "local only" | Originally required both `127.0.0.1` and `::1` — amended because IPv6 adds a startup-fragility risk with no corresponding requirement forcing it |
| AD-5 | Authentication: shared-secret token handshake for TCP (native) connections; `Origin`-header allowlisting for WebSocket (browser) connections | Decided | Native plugins can read a local token file with no friction; browser extensions cannot read arbitrary local files, but browsers do send a reliable `Origin` header identifying the extension. Both checks operate *within* the loopback-only boundary (AD-4), distinguishing legitimate plugins from other local processes — they do not, and are not meant to, restrict network origin (that's AD-4's job) | Manual one-time token entry into the browser extension (rejected: more setup friction, no real security benefit over Origin-checking within the same threat model); dropping authentication entirely (rejected: NFR 3.3 is a firm requirement raised by the user; see Risk R-1 for what "no auth" would actually expose) |
| AD-6 | Plugins declare their own action/capability manifest at connect time (in-memory); Gatoway core owns and persists the button/dial layout mapping (which action is bound to which position, per profile) as a local config file | Decided | Resolves REQUIREMENTS.md Open Question #1. Keeps Gatoway free of any app-specific knowledge (each plugin knows its own actions), while giving the future no-code mapping UI (FR post-MVP) a single, simple place to read/write layout — a plain local file, which also answers Open Question #3 (config backup is just "copy the file") | A database or structured config service — rejected as unwarranted complexity for a personal-use tool with no concurrent multi-user access |
| AD-7 | Plugins self-report focus/blur; Gatoway core tracks the focused connection and switches the Stream Deck to that plugin's profile, falling back to an idle profile when nothing is focused | Decided | Matches FR-003/FR-004; keeps focus detection consistent across native (OS-level detection would differ per platform) and browser-based plugins (no OS-level window concept for a browser tab) | Gatoway performing OS-level active-window detection itself — rejected as inconsistent across plugin types and not needed once self-reporting is adopted uniformly |
| AD-8 | The Stream Deck plugin's manifest declares only a small, fixed set of generic, position-based action types (one for keys, one for dials) — never one action per app-specific command. The plugin forwards raw physical events (position pressed, dial delta) to Gatoway core and renders whatever position-addressed content Gatoway core sends back; Gatoway core alone resolves "this position, in this profile" to a specific app's specific capability, using AD-6's persisted layout config and the currently-focused connection (AD-7), then forwards the resolved capability invocation to that app as a `command` message | Decided (amended v1.3) | This is the actual mechanism that makes the core app-agnostic at the hardware layer, not just at the data layer: Elgato's SDK requires action UUIDs to be declared statically in `manifest.json` at build time, so a distinct UUID per app-specific command (as the original single-app Lightroom plugin did) would mean rebuilding/republishing the Stream Deck plugin every time a new app is added — defeating the entire premise of Gatoway. Keeping the plugin fully generic means it never changes again as apps are added; all app-specific knowledge lives in Gatoway core, consistent with AD-6. Requires three new message types in `message-protocol`: `input_event`/`render_update` (plugin ↔ core, position-addressed only) and `command` (core → app, carrying the resolved `capabilityId` plus the raw gesture info the app needs — `eventType`/`delta` — since the app itself, not Gatoway core, decides what a press/release/rotation means for its own capability). The `command` message was originally omitted from this decision's own text and only surfaced as a gap during `focus-profile-routing`'s implementation — amended here for completeness | Distinct action UUIDs per app-specific command (rejected: requires a manifest rebuild per app, defeats agnosticism); Elgato's native per-key settings + a Property Inspector web UI for configuring each key's target (rejected for now: `REQUIREMENTS.md` scopes the MVP mapping story as developer-driven, editing Gatoway's own config directly, with a no-code UI explicitly deferred post-MVP — building a Property Inspector now would duplicate that future work before it's needed) |

---

## Data Model

- **Connection** — one live plugin session. Has a unique connection ID (generated per
  connection, *not* equal to the plugin's app-type), transport (`tcp` | `websocket`),
  plugin type (e.g. `lightroom`, `xdesign`), authentication state, current focus state
  (focused/unfocused), and the capability manifest it declared at registration
  (in-memory only, not persisted).
- **Action** — a single capability a plugin declares: id, label, type (button or dial),
  optional description/icon hint.
- **Profile** — a named set of button/dial position → Action bindings for one plugin
  type. Persisted in the local config file.
- **Idle Profile** — the special default Profile shown when no connection currently
  reports focus.
- **Auth Token** — a random shared secret generated fresh each time Gatoway core
  starts, written to a local file with user-only read permission; presented by native
  (TCP) plugins as their first message.
- **Extension Origin Allowlist** — the set of known browser-extension origins (e.g. the
  xDender extension ID) Gatoway core accepts WebSocket connections from.

Connection IDs are deliberately independent of plugin type so that supporting multiple
simultaneous instances of the same application later (not needed today, but called out
as a non-goal-to-preclude in REQUIREMENTS.md) does not require a data model change —
only new logic for resolving which instance's profile is active.

---

## Integrations

| System | Direction | Purpose | Failure Handling |
|--------|-----------|---------|-------------------|
| Elgato Stream Deck (hardware/software, via official Stream Deck SDK) | Bidirectional | Button/dial input; icon, label, and dial state rendering | Stream Deck plugin follows standard SDK lifecycle; if Gatoway core crashes, the Stream Deck plugin restarts it and reconnects |
| Lightroom Classic (via existing Lua plugin) | Bidirectional | Native application target; commands out, state updates back | Plugin retries/backs off reconnecting to Gatoway core if the TCP connection drops; Gatoway core falls back to the idle profile if Lightroom's connection is lost |
| Solidworks xDesign (via xDender browser extension) | Bidirectional | Browser-based application target; commands out, state updates back | Extension retries/backs off reconnecting over WebSocket if dropped; same idle-profile fallback on disconnect |
| Local filesystem | N/A (local I/O) | Layout/profile config file, auth token file, rotating log files | Standard file I/O; config file is human-readable (JSON/YAML) for manual recovery if needed |

---

## Non-Functional Approach

- **Performance (near-instant):** all connections are loopback-local (TCP/WebSocket);
  Node.js's event loop handles concurrent low-latency I/O well; JSON parsing overhead
  is negligible at this message scale; no external network hops.
- **Cross-platform (Windows/Mac/Linux):** Node.js and native OS TCP/WebSocket support
  are uniform across all three; the Stream Deck SDK itself is cross-platform.
- **Security:** loopback-only binding (AD-4) is the network-layer control; the
  token/Origin checks (AD-5) are the application-layer control distinguishing
  legitimate plugins from other local processes.
- **Reliability:** plugins implement retry/backoff reconnect logic against Gatoway
  core; the Stream Deck plugin supervises and restarts the Gatoway core process if it
  exits unexpectedly; the focus/profile logic falls back to the idle profile whenever
  no connection currently reports focus, including on an unexpected disconnect.
- **Logging/observability:** Gatoway core writes connection lifecycle events, commands,
  state updates, and errors to a local rotating log file, retained short-term for
  active debugging only.
- **Data retention:** layout/profile config is a plain local file; "backup" is copying
  that file. No schema-migration tooling is built at this stage (see Risk R-3).

---

## Delivery Sequence

1. **Gatoway core foundation** — TCP + WebSocket listeners (loopback-bound), token +
   Origin auth, the unified message schema, connection manager, logging. No profile
   logic yet.
2. **Stream Deck plugin skeleton** — spawns/supervises Gatoway core, connects as the
   display client, renders a static idle profile via the Stream Deck SDK.
3. **Lightroom integration (native path)** — adapt the existing, proven Lua TCP client
   to the new schema and token handshake; validate single-app profile switching
   (Lightroom profile ↔ idle) end to end. Building on already-working networking code
   de-risks the foundation before tackling the harder net-new piece.
4. **Generalize focus/profile state machine** — extend from single-app to genuinely
   tracking multiple simultaneous connections and arbitrating focus between them. This
   step (or a dedicated delta change alongside it) must also introduce the generic,
   position-based action model from AD-8: replace the Stream Deck plugin's current
   single static "Idle" action with the small, fixed set of generic Key/Dial action
   types, and add the `key_event`/`render_update` message types to `message-protocol`.
5. **xDesign integration (browser path)** — build the xDender WebSocket client and
   Origin auth; validate full multi-app switching (Lightroom ↔ xDesign ↔ idle).
6. **Persisted layout config** — move profile/button-mapping definitions from
   hardcoded/in-code into the local config file, with load/save in Gatoway core. This
   is where AD-8's position → capability resolution actually reads its bindings from.
7. **(Post-MVP) End User no-code mapping UI** — deferred; design not started (see Risk
   R-2).

---

## Risks and Open Questions

| ID | Severity | Description | Owner |
|----|----------|--------------|-------|
| R-1 | Observation | Without the token/Origin auth (AD-5), any local process could inject commands into real applications or read state; this was raised and accepted as a firm requirement (NFR 3.3), so AD-5 exists specifically to close this gap | Architect (closed by AD-5) |
| R-2 | Question | The End User (non-developer) no-code mapping UI is entirely undesigned | Future requirements/architecture pass, post-MVP |
| R-3 | Minor | Layout config file has no schema-migration/versioning strategy yet | Developer, revisit before any public release |
| R-4 | Observation | A future application that cannot self-report its own focus (e.g. one that can't be modified to add a signal) isn't addressed by the self-reporting model (AD-7) | Revisit architecture if/when such an application is targeted |
| R-5 | Major (blast radius) | AD-8 (decided after `stream-deck-plugin-skeleton` was already implemented, reviewed, and merged) means that change's manifest/action design — one static, hardcoded "Idle" action — does not yet follow the generic, position-based model. It isn't wrong for what it was scoped to build (there was no app-specific routing to generalize yet), but it will need a delta change to adopt AD-8's generic Key/Dial action types before step 4/6 can route real commands through it | Main agent: open a delta OpenSpec change against `stream-deck-idle-display`/`stream-deck-core-client` when delivery-sequence step 4 begins, to re-flow this work downward |

---

## Handoff Notes

**For the developer:**
- Follow the Delivery Sequence above — build Gatoway core's connection/auth/logging
  foundation and the Stream Deck plugin's supervision logic before any app-specific
  plugin work.
- Reuse the existing Lightroom Lua TCP/JSON-Lines networking code; adapt it to the new
  message schema and token handshake rather than rewriting it.
- Keep connection IDs unique per connection (never equal to plugin type) to preserve
  the future option of multiple simultaneous instances of the same app (AD-6/Data
  Model).
- Loopback-only binding (AD-4) and the token/Origin auth (AD-5) must be present from
  step 1, not bolted on later — this is a firm requirement (NFR 3.3), not a
  nice-to-have.

**For QA:**
- Verify loopback-only binding actually rejects connections from another machine on
  the same network (with no firewall in place).
- Verify token and Origin checks actually reject unauthenticated/unrecognized
  connections.
- Verify the idle-profile fallback triggers correctly on an unexpected disconnect, not
  just a graceful blur signal.
- Verify the Stream Deck plugin correctly restarts Gatoway core if the core process is
  killed while the Stream Deck software keeps running.

---

*This document was produced by a software architect session with Claude Code, based on
`REQUIREMENTS.md` v1.0. It should be reviewed before change proposals are drafted
against it.*
