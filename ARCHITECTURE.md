# Architecture: Gatoway

**Version:** 1.6
**Date:** 2026-07-16
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
listener, authenticate, and report their own focus state. Gatoway core tracks which
plugin currently has focus and drives the Stream Deck's displayed content accordingly,
falling back to an idle profile when nothing is focused.

As of v1.6 (resolving `REQUIREMENTS.md` FR-007/FR-008), Gatoway core has **no semantic
understanding of what any plugin's buttons or dials do**. It knows two things only: what
content to display at a given physical slot, and which slot was just interacted with.
Each application plugin decides what to display, sized to whatever slot capacity Gatoway
tells it is available — there is no persistent, host-side, hand-authored mapping file
telling Gatoway which of a plugin's commands belongs at which position. This supersedes
v1.4's `layout.json`-based model entirely (see AD-6, revised).

---

## Components

- **Gatoway Core** (Node.js/TypeScript) — the hub. Owns connection management (TCP +
  WebSocket listeners, both loopback-bound), authentication, the unified message
  protocol, focus tracking, live slot-capacity tracking, and logging. Runs as a single
  local process per machine. Holds no persisted, app-specific configuration — only the
  auth token and rotating logs are ever written to disk.
- **Stream Deck Plugin** (Node.js/TypeScript, built on the Elgato Stream Deck SDK) —
  spawns and supervises the Gatoway Core child process (restarting it if it crashes),
  connects to Gatoway Core as the display/input client, forwards raw physical input
  (which position was pressed, which dial turned by how much), renders whatever
  position-addressed content Gatoway Core instructs via the Stream Deck SDK, and
  reports the device's live slot capacity (AD-9) — how many generic Key/Dial actions
  are actually placed right now — whenever it changes. Per AD-8, the plugin has no
  app-specific knowledge at all — it is a generic input/output device driver; Gatoway
  Core alone resolves what a given position means, and even Gatoway Core no longer
  knows what it *does*, only what to show and where.
- **Application Plugins** (per-app, outside Gatoway's own codebase, but speaking its
  protocol):
  - **Lightroom Classic Plugin** (Lua) — the existing plugin's proven TCP + JSON-Lines
    networking layer, adapted to the new unified message schema and token handshake.
  - **xDender Browser Extension** (JavaScript) — connects via WebSocket, using the
    browser's own `Origin` header for authentication.
  - Future application plugins follow the same contract: connect over TCP or
    WebSocket, authenticate, receive slot capacity, declare content sized to fit,
    self-report focus, and manage their own paging/grouping internally (FR-008).
- **Shared Message Protocol** — the JSON message schema (registration, focus events,
  slot capacity, commands, content declarations) that is identical across both
  transports, so Gatoway core's message-handling logic does not fork by transport —
  only the connection-accept code does.

---

## Key Decisions

| ID | Decision | Status | Rationale | Rejected Alternatives |
|----|----------|--------|-----------|------------------------|
| AD-1 | Gatoway core runs as a child process spawned/supervised by the Stream Deck plugin, not an independent OS service | Decided | Requirements set no uptime SLA and prioritize simplicity for a personal-use tool (no install/uninstall service tooling needed); the Stream Deck software already manages its own plugin's lifecycle | Independent OS-level service (launchd/systemd/Windows service) — rejected as more engineering (three separate installer mechanisms) than the requirements justify |
| AD-2 | Gatoway core and the Stream Deck plugin are built in Node.js/TypeScript | Decided | Matches the existing Lightroom plugin's Stream Deck-side language and the Elgato Stream Deck SDK's own Node/TS ecosystem; mature cross-platform WebSocket/TCP support satisfies NFR 3.4 (Windows/Mac/Linux) | Python (weaker cross-platform background-process packaging story); Go/Rust (better single-binary distribution for a future public release, but a second toolchain with no reuse of existing work) |
| AD-3 | Dual transport: TCP + newline-delimited JSON for native plugins, WebSocket for browser-based plugins; one unified JSON message schema across both | Decided | Lightroom's Lua sandbox only exposes raw TCP (`LrSocket`) — no WebSocket/HTTP-upgrade client, no SHA-1/bitwise primitives — so requiring WebSocket there would mean vendoring a pure-Lua SHA-1 and hand-rolling RFC 6455 framing/masking for no functional benefit over the proven TCP channel already in place. Browser extensions can only realistically reach a local process via WebSocket. | "WebSocket everywhere" (original recommendation) — rejected once the Lua-environment cost was confirmed via research: moderate, unnecessary lift with no benefit to an already-working channel |
| AD-4 | Both listeners bind to IPv4 loopback only (`127.0.0.1`), never `0.0.0.0`. IPv6 loopback (`::1`) is not bound | Decided (amended v1.1) | Satisfies NFR 3.3 (local-only communication) at the network layer; an OS-level refusal of non-loopback connections holds regardless of firewall state, unlike an application-layer check. IPv6 loopback binding was dropped after QA-002 (gatoway-core-foundation review) found that requiring both addresses fails Gatoway core's entire startup on any host without IPv6 loopback available, for no benefit — IPv4 loopback alone already satisfies "local only" | Originally required both `127.0.0.1` and `::1` — amended because IPv6 adds a startup-fragility risk with no corresponding requirement forcing it |
| AD-5 | Authentication: shared-secret token handshake for TCP (native) connections; `Origin`-header allowlisting for WebSocket (browser) connections, supporting a trailing-wildcard prefix match (e.g. `moz-extension://*`) in addition to exact-match entries | Decided (amended v1.5) | Native plugins can read a local token file with no friction; browser extensions cannot read arbitrary local files, but browsers do send a reliable `Origin` header identifying the extension. Both checks operate *within* the loopback-only boundary (AD-4), distinguishing legitimate plugins from other local processes — they do not, and are not meant to, restrict network origin (that's AD-4's job). Wildcard support was added after confirming (via Mozilla's own documentation) that Firefox generates a random internal UUID per installation that appears in the `Origin` header regardless of any static id set in the manifest — an exact-match allowlist can never be correctly pre-configured for a Firefox extension, only a Chrome one, so a prefix-match escape hatch is required to support Firefox at all. The security posture is unchanged: a wildcard is broader than an exact match, but the actual boundary was always AD-4, not Origin-checking. A separate deployment gap — `GATOWAY_ALLOWED_ORIGINS` never reaching a GUI-launched, Stream-Deck-spawned Gatoway core — was fixed by `plugin-allowed-origins-config` (a local, plugin-side config file forwarded into the spawned child's environment); this is a delivery-mechanism fix, not a change to the auth model itself | Manual one-time token entry into the browser extension (rejected: more setup friction, no real security benefit over Origin-checking within the same threat model); dropping authentication entirely (rejected: NFR 3.3 is a firm requirement raised by the user; see Risk R-1 for what "no auth" would actually expose); full glob/regex matching instead of a single trailing wildcard (rejected as unneeded power and a real footgun for an env-var-configured value) |
| AD-6 | **(Revised v1.6, superseding v1.4.)** Gatoway core persists no button/dial mapping of any kind. Instead, each application plugin declares its own display content — sized to fit the slot capacity Gatoway core tells it is available (AD-9) — as an ordered list per control type (buttons, dials). A plugin may re-send this declaration at any time (on the existing `register` connection, reusing its already-documented "an explicit array always replaces the prior one" semantics) to reflect a live state change, a paging navigation, or entering/leaving a nested group (FR-008) — no separate update message type is needed. Gatoway core stores each connection's current declared content in memory only, never on disk | Decided (amended v1.6) | Resolves `REQUIREMENTS.md` v1.2 Open Question #1, definitively this time: v1.4's answer (Gatoway core owns and persists a `layout.json` binding capability ids to positions) required whoever authored that file to know a plugin's internal capability id strings in advance — realistic only if the plugin's author and Gatoway's operator are the same person. Live verification with a real third-party plugin (xDender) confirmed this in practice. The new model requires no such advance knowledge: a plugin fits its own content to the capacity it's told about, using ordinal position only. Reusing `register`'s existing re-declaration semantics for all updates (rather than adding a distinct update message) was chosen over a two-tier model for protocol simplicity — confirmed with the user as the preferred trade-off over a lower-bandwidth-but-more-complex two-message design | v1.4's persisted `layout.json` capability-id-to-position file — superseded, not merely deprecated (see Risk/blast-radius entry below); a two-tier declare-once/update-lightly message pair — rejected in favor of one unified re-declaration mechanism, accepting slightly larger messages for a simpler protocol surface |
| AD-7 | Plugins self-report focus/blur; Gatoway core tracks the focused connection and switches the Stream Deck to that plugin's content, falling back to an idle profile when nothing is focused | Decided | Matches FR-003/FR-004; keeps focus detection consistent across native (OS-level detection would differ per platform) and browser-based plugins (no OS-level window concept for a browser tab) | Gatoway performing OS-level active-window detection itself — rejected as inconsistent across plugin types and not needed once self-reporting is adopted uniformly |
| AD-8 | **(Revised v1.6.)** The Stream Deck plugin's manifest declares only a small, fixed set of generic, position-based action types (one for keys, one for dials) — never one action per app-specific command. The plugin forwards raw physical events (position pressed, dial delta) to Gatoway core and renders whatever position-addressed content Gatoway core sends back. Gatoway core resolves a raw physical position to **an ordinal slot index within the focused connection's own declared content** (AD-6) — never to any app-specific meaning — and forwards that resolved index, plus the raw gesture info the app needs (`eventType`/`delta`), to the focused connection as a `command` message. Gatoway core translates ordinal index ↔ actual physical position in both directions; no other component ever needs to know both at once | Decided (amended v1.6, previously amended v1.3) | This is the actual mechanism that makes the core app-agnostic at the hardware layer, not just at the data layer: Elgato's SDK requires action UUIDs to be declared statically in `manifest.json` at build time, so a distinct UUID per app-specific command would mean rebuilding/republishing the Stream Deck plugin every time a new app is added — defeating the entire premise of Gatoway. The v1.6 revision goes one step further than v1.3: Gatoway core previously resolved a position to a specific `capabilityId` it understood the *shape* of (id/label/type/icon/state); it now resolves only to *which of the focused connection's own declared items* was interacted with, by ordinal position — Gatoway core no longer needs to understand capability shape at all, only slot content and slot interaction | Distinct action UUIDs per app-specific command (rejected: requires a manifest rebuild per app, defeats agnosticism); Elgato's native per-key settings + a Property Inspector web UI for configuring each key's target (rejected for now: `REQUIREMENTS.md` scopes the MVP mapping story as developer-driven, with a no-code UI explicitly deferred post-MVP) |
| AD-9 | **(New, v1.6.)** The Stream Deck plugin proactively reports live slot capacity (current button-slot count, current dial-slot count — how many generic Key/Dial actions are actually placed on the connected device right now) to Gatoway core: once at its own registration, and again any time that capacity changes (an action added/removed, a device connected/disconnected). Gatoway core holds this as in-memory-only current state and forwards it to each application plugin at that plugin's own connection time, and again every time that plugin reports gaining focus | Decided | Resolves `REQUIREMENTS.md` FR-007. Push-based and event-driven, matching this project's existing self-reported style (AD-7) rather than introducing polling. Refreshing on every focus change (not only once at connection) was a deliberate choice, confirmed with the user, so that a long-lived connection's capacity information can't go stale if the physical arrangement changes mid-session — and so the design does not preclude a future where multiple physical Stream Decks exist, or a device is connected/disconnected while plugins remain connected (`REQUIREMENTS.md` §2.3), without requiring that capability to be built now. The Elgato Stream Deck SDK already exposes exactly the data needed for this (device `size`, `type`, and a live `actions` iterator over what's currently placed) | Polling Gatoway core for capacity on demand — rejected as inconsistent with the project's established event-driven philosophy and adding needless latency/complexity; sending capacity only once at connection — rejected because it would go stale across a long-lived connection with no way to recover short of a full reconnect |

---

## Data Model

- **Connection** — one live plugin session. Has a unique connection ID (generated per
  connection, *not* equal to the plugin's app-type), transport (`tcp` | `websocket`),
  plugin type (e.g. `lightroom`, `xdesign`), authentication state, current focus state
  (focused/unfocused), and its currently-declared slot content (AD-6; in-memory only,
  never persisted).
- **Slot Content** — a single item a plugin currently wants displayed at one ordinal
  position within one control type (button or dial): icon, label, and (for buttons)
  state. Carries no semantic identifier — Gatoway core does not need one, since it only
  ever addresses this by its ordinal position within the connection's own declared list.
- **Slot Capacity** — the live count of button slots and dial slots currently available,
  reported by the Stream Deck plugin (AD-9) and held in memory only. Never persisted;
  always current as of the last report.
- **Idle Profile** — the special default content shown when no connection currently
  reports focus.
- **Auth Token** — a random shared secret generated fresh each time Gatoway core
  starts, written to a local file with user-only read permission; presented by native
  (TCP) plugins as their first message.
- **Extension Origin Allowlist** — the set of known browser-extension origins (e.g. the
  xDender extension ID) Gatoway core accepts WebSocket connections from, sourced either
  directly from `GATOWAY_ALLOWED_ORIGINS` (manual/standalone use) or forwarded by the
  Stream Deck plugin from its own local config file (`plugin-allowed-origins-config`).

Connection IDs are deliberately independent of plugin type so that supporting multiple
simultaneous instances of the same application later (not needed today, but called out
as a non-goal-to-preclude in REQUIREMENTS.md) does not require a data model change —
only new logic for resolving which instance's content is active. The same
non-precluding-without-building principle applies to Slot Capacity: it is modeled as a
single device's counts today, but nothing here presumes only one physical Stream Deck
can ever exist.

---

## Integrations

| System | Direction | Purpose | Failure Handling |
|--------|-----------|---------|-------------------|
| Elgato Stream Deck (hardware/software, via official Stream Deck SDK) | Bidirectional | Button/dial input; icon, label, and dial state rendering; live slot-capacity reporting (AD-9) | Stream Deck plugin follows standard SDK lifecycle; if Gatoway core crashes, the Stream Deck plugin restarts it and reconnects |
| Lightroom Classic (via existing Lua plugin) | Bidirectional | Native application target; commands out, content updates back | Plugin retries/backs off reconnecting to Gatoway core if the TCP connection drops; Gatoway core falls back to the idle profile if Lightroom's connection is lost |
| Solidworks xDesign (via xDender browser extension) | Bidirectional | Browser-based application target; commands out, content updates back | Extension retries/backs off reconnecting over WebSocket if dropped; same idle-profile fallback on disconnect |
| Local filesystem | N/A (local I/O) | Auth token file, the Stream Deck plugin's local allowed-origins config, rotating log files | Standard file I/O; no app-specific layout/profile data is ever written to disk as of v1.6 |

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
  exits unexpectedly; the focus/content logic falls back to the idle profile whenever
  no connection currently reports focus, including on an unexpected disconnect. A
  reconnecting plugin receives fresh slot capacity exactly as a new connection would
  (AD-9) — no stale-state carryover.
- **Logging/observability:** Gatoway core writes connection lifecycle events, commands,
  content declarations, and errors to a local rotating log file, retained short-term for
  active debugging only.
- **Data retention:** as of v1.6, Gatoway core persists nothing app-specific to disk —
  only the auth token file and rotating logs. "Backup" no longer applies to any
  layout/profile data, since none is persisted; Risk R-3 (schema migration for the old
  layout config file) is retired along with the file itself.

---

## Delivery Sequence

1. **Gatoway core foundation** — TCP + WebSocket listeners (loopback-bound), token +
   Origin auth, the unified message schema, connection manager, logging. No profile
   logic yet. *(Complete.)*
2. **Stream Deck plugin skeleton** — spawns/supervises Gatoway core, connects as the
   display client, renders a static idle profile via the Stream Deck SDK. *(Complete.)*
3. **Lightroom integration (native path)** — adapt the existing, proven Lua TCP client
   to the new schema and token handshake; validate single-app profile switching
   (Lightroom profile ↔ idle) end to end. *(In progress, blocked on the separate
   Lightroom Stream Deck Plugin repo's own work settling.)*
4. **Generalize focus/profile state machine** — extend from single-app to genuinely
   tracking multiple simultaneous connections and arbitrating focus between them;
   introduced the generic, position-based action model (AD-8 v1.3). *(Complete.)*
5. **xDesign integration (browser path)** — build the xDender WebSocket client and
   Origin auth; validate full multi-app switching (Lightroom ↔ xDesign ↔ idle).
   *(In progress — live verification with the real xDender extension surfaced QA-017
   and QA-018, the latter driving this v1.6 revision.)*
6. ~~**Persisted layout config**~~ — **superseded by step 7.** `layout.json`,
   `layoutConfig.ts`, `layoutStore.ts`, and the capability-id lookup path in
   `profileRouter.ts` (all built and archived as `persisted-layout-config`) are to be
   removed, not merely supplemented, once step 7 lands.
7. **Extension-provided slot content** *(new, replaces step 6's approach)* — implement
   AD-9 (Stream Deck plugin reports live slot capacity to Gatoway core), the revised
   AD-6 (application plugins declare/re-declare content sized to that capacity, via
   `register`'s existing re-declaration semantics), and the revised AD-8 (ordinal-index
   resolution replacing capability-id resolution). Remove the superseded
   `persisted-layout-config` code and its `layout-persistence` capability spec as part
   of this same delivery step, not as separate cleanup — leaving both live
   simultaneously would let a plugin author follow stale documentation.
8. **(Post-MVP) End User no-code mapping UI** — deferred; design not started (see Risk
   R-2). Its likely shape has narrowed post-v1.6: since no plugin needs an id-to-position
   mapping authored at all anymore, any future UI here is about *overriding* a plugin's
   own default ordering, not creating a mapping from scratch.

---

## Risks and Open Questions

| ID | Severity | Description | Owner |
|----|----------|--------------|-------|
| R-1 | Observation | Without the token/Origin auth (AD-5), any local process could inject commands into real applications or read state; this was raised and accepted as a firm requirement (NFR 3.3), so AD-5 exists specifically to close this gap | Architect (closed by AD-5) |
| R-2 | Question | The End User (non-developer) no-code mapping UI is entirely undesigned; its scope has narrowed following v1.6 (see Delivery Sequence step 9) but remains undesigned | Future requirements/architecture pass, post-MVP |
| ~~R-3~~ | ~~Minor~~ | ~~Layout config file has no schema-migration/versioning strategy yet~~ — **Retired v1.6**: the layout config file itself is being removed (AD-6 revision), so this risk no longer applies | Retired |
| R-4 | Observation | A future application that cannot self-report its own focus (e.g. one that can't be modified to add a signal) isn't addressed by the self-reporting model (AD-7) | Revisit architecture if/when such an application is targeted |
| R-5 | Major (blast radius, historical) | AD-8 v1.3 meant `stream-deck-plugin-skeleton`'s already-merged manifest/action design needed a delta change before routing real commands. Resolved by delivery-sequence step 4. Kept here for the historical record. | Closed |
| R-6 | Major (blast radius, v1.6) | This revision (AD-6/AD-8 amended, AD-9 added) invalidates significant, already-archived work: (a) `persisted-layout-config`'s entire deliverable — `layout.json`, `layoutConfig.ts`, `layoutStore.ts`, the capability-id lookup path in `profileRouter.ts`, and the `layout-persistence` capability spec — must be removed, not kept as a fallback; (b) `validate-capability-payloads`'s validation logic (`capabilityValidation.ts`) validates a `Capability` shape (id/label/type/description/icon/state) that no longer exists at the protocol level and must be redesigned around the new Slot Content shape; (c) the `message-protocol` spec's `register`/`capability_update`/`command` requirements need rewriting for ordinal-index addressing and the new capacity-report message direction; (d) the `profile-routing` spec's capability-id resolution requirements need rewriting for ordinal-index resolution; (e) `docs/PROTOCOL.md` needs a substantial rewrite and `docs/LAYOUT_CONFIG.md` should be removed entirely once nothing references it | Main agent: sequence the OpenSpec change(s) for delivery-sequence step 7 to cover removal and rewrite together, not as a follow-on cleanup pass — QA should specifically verify no stale reference to `layout.json`/`capabilityId`-based routing survives in either code or docs once step 7 is archived |

---

## Handoff Notes

**For the developer:**
- Follow the Delivery Sequence above. Steps 1, 2, and 4 are complete; step 7 is the
  next substantial piece of work and should be scoped as a single OpenSpec change (or
  a tightly-sequenced pair) covering both the new capacity/content mechanism *and* the
  removal of the superseded layout-config code — see Risk R-6.
- The Stream Deck plugin's existing SDK usage already gives access to everything AD-9
  needs (`Device.size`, `Device.type`, `Device.actions`) — this is additive to
  existing device-info handling, not a new SDK capability to research.
- Reuse `register`'s existing "an explicit array always replaces it" re-declaration
  behavior for all content updates (AD-6) — do not add a second update message type.
- Keep connection IDs unique per connection (never equal to plugin type) to preserve
  the future option of multiple simultaneous instances of the same app (Data Model).
- Loopback-only binding (AD-4) and the token/Origin auth (AD-5) remain unaffected by
  this revision — no changes needed there.

**For QA:**
- Verify loopback-only binding actually rejects connections from another machine on
  the same network (with no firewall in place).
- Verify token and Origin checks actually reject unauthenticated/unrecognized
  connections.
- Verify the idle-profile fallback triggers correctly on an unexpected disconnect, not
  just a graceful blur signal.
- Verify the Stream Deck plugin correctly restarts Gatoway core if the core process is
  killed while the Stream Deck software keeps running.
- Once step 7 lands: verify capacity is actually refreshed on focus-gain (not just at
  initial connection); verify overflow (more declared content than slots) and
  underflow (fewer than slots) both behave as the plugin itself intends, since Gatoway
  core no longer arbitrates this; verify no code path still reads or writes
  `layout.json`, and no documentation still references it.

---

*This document was produced by a software architect session with Claude Code, based on
`REQUIREMENTS.md`. v1.6 revises AD-6/AD-8 and adds AD-9 in response to `REQUIREMENTS.md`
v1.2 (FR-007/FR-008), itself raised by QA-018 during live xDender verification. It
should be reviewed before change proposals are drafted against it.*
