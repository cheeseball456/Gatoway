# Architecture: Gatoway

**Version:** 1.8
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
| AD-6 | **(Revised v1.7, superseding v1.6/v1.4; label-validity check amended v1.8.)** Gatoway core persists no button/dial mapping of any kind. Instead, each application plugin declares its own display content, addressed by **fixed, stable position labels** (e.g. `"B1"`, `"B2"`, `"D1"` — a `B`/`D` prefix plus a 1-based ordinal, self-describing button vs. dial) derived from the connected device's slot capacity Gatoway core tells it is available (AD-9). Content is a flat map keyed by label, not an array — a plugin need not declare every label; a label absent from its map simply isn't rendered. A plugin may re-send this declaration at any time (on the existing `register` connection, reusing its already-documented "an explicit array/map always replaces the prior one" semantics) to reflect a live state change, a paging navigation, or entering/leaving a nested group (FR-008) — no separate update message type is needed. Gatoway core stores each connection's current declared content in memory only, never on disk. **(v1.8)** A registration's label keys are checked against the current known capacity (AD-9) only once that capacity is actually known — while capacity is still unknown, only syntactic well-formedness and value-shape are validated, never an upper-bound range, since there is no bound to check yet | Decided (amended v1.8, previously amended v1.7) | Resolves `REQUIREMENTS.md` v1.2 Open Question #1. v1.6's answer (ordinal array-index addressing, resolved against whichever positions currently held a *placed* generic action) was found during live `/verify` (QA-020) to conflate two different things: a device's actual physical capacity, and how many generic actions the user happened to have manually placed so far — the same button could shift which "ordinal index" it meant if placement changed. v1.7 fixes this by deriving stable labels directly from the device's fixed physical layout (button grid dimensions, dial count per model) rather than from live placement — a label always means the same physical position for a given device, full stop. v1.8 further fixes QA-021: validating a label's range against a capacity that reads as zero only because it's not yet known (rather than genuinely zero) wrongly and permanently rejected early-registering plugins' content — see AD-9 for the full fix (distinguishing unknown from zero, broadcasting once known). The expected setup is that a user places a generic Key/Dial action on every physical position (documented as a setup requirement, not enforced); a label with no action actually placed there yet simply doesn't render, exactly as an undeclared label doesn't — fails safe either way, matching this project's existing graceful-degradation philosophy. Reusing `register`'s existing re-declaration semantics for all updates remains unchanged from v1.6 | v1.6's ordinal-array-index-against-current-placement model — superseded for conflating physical capacity with placement state (see QA-020); enumerating the actual label strings over the wire in `slot_capacity` — rejected as redundant, since both sides derive `B1..BN`/`D1..DM` from the same documented convention once they know the counts |
| AD-7 | Plugins self-report focus/blur; Gatoway core tracks the focused connection and switches the Stream Deck to that plugin's content, falling back to an idle profile when nothing is focused | Decided | Matches FR-003/FR-004; keeps focus detection consistent across native (OS-level detection would differ per platform) and browser-based plugins (no OS-level window concept for a browser tab) | Gatoway performing OS-level active-window detection itself — rejected as inconsistent across plugin types and not needed once self-reporting is adopted uniformly |
| AD-8 | **(Revised v1.7.)** The Stream Deck plugin's manifest declares only a small, fixed set of generic, position-based action types (one for keys, one for dials) — never one action per app-specific command. The plugin forwards raw physical events (position pressed, dial delta) to Gatoway core and renders whatever position-addressed content Gatoway core sends back. Gatoway core resolves a raw physical position to **its fixed label** (`"B1"`, `"D1"`, etc. — AD-6/AD-9), checks whether the focused connection's own declared content has an entry for that label, and if so forwards the label plus the raw gesture info the app needs (`eventType`/`delta`) to the focused connection as a `command` message — the `controller` field is dropped as redundant, since a label's own `B`/`D` prefix already says which. Gatoway core translates label ↔ actual physical position in both directions; no other component ever needs to know both at once | Decided (amended v1.7, previously amended v1.6/v1.3) | This is the actual mechanism that makes the core app-agnostic at the hardware layer, not just at the data layer: Elgato's SDK requires action UUIDs to be declared statically in `manifest.json` at build time, so a distinct UUID per app-specific command would mean rebuilding/republishing the Stream Deck plugin every time a new app is added — defeating the entire premise of Gatoway. v1.7 changes only the *shape* of what's resolved to (a fixed label instead of an ordinal index into a live, potentially-shifting list) — the core principle (Gatoway resolves position, never app-specific meaning) is unchanged from v1.6/v1.3 | Distinct action UUIDs per app-specific command (rejected: requires a manifest rebuild per app, defeats agnosticism); Elgato's native per-key settings + a Property Inspector web UI for configuring each key's target (rejected for now: `REQUIREMENTS.md` scopes the MVP mapping story as developer-driven, with a no-code UI explicitly deferred post-MVP); keeping `controller` as a separate `command` field alongside the label — rejected as redundant once the label's own prefix conveys it, confirmed acceptable with the user as long as documented consistently |
| AD-9 | **(Revised v1.8, further amended from v1.7.)** The Stream Deck plugin reports the connected device's **fixed physical layout** — its button grid dimensions and dial count, derived once from the Elgato SDK's `Device.size`/`Device.type` (a static per-model fact, not a function of what's currently placed) — to Gatoway core, at its own registration and again whenever the connected device itself changes (connected/disconnected/swapped). This directly yields the ordered position lists AD-6/AD-8's labels are derived from. Gatoway core holds this as in-memory-only current state. `slot_capacity` (forwarded to each application plugin) now distinguishes **unknown** capacity (the Stream Deck plugin has never yet reported — e.g. it hasn't connected/registered yet) from a **known** capacity of zero — represented as `buttonSlots`/`dialSlots` being `null` versus a real number. Gatoway core sends `slot_capacity` to an application plugin at that plugin's own connection time, again every time it reports gaining focus (unchanged from v1.7), **and additionally, proactively, to every currently-connected application plugin the first time real capacity becomes known after having been unknown, and again on any subsequent device change** — a genuine broadcast, not limited to whichever connection triggered the underlying `device_capacity` report | Decided (amended v1.8, previously amended v1.7) | Resolves QA-021 (Major, found during QA review of the v1.7 rework): because Gatoway core is spawned *by* the Stream Deck plugin (AD-1), which must then itself connect back to Gatoway core, there is a real bootstrap window — observed directly in this project's own `/verify` sessions as a connect-retry race — during which an application plugin could register before the Stream Deck plugin has ever reported capacity. Treating "not yet known" the same as "known to be zero" (v1.7's behavior) meant such a plugin's content was wrongly and permanently rejected as out-of-range, with no path to recovery short of an arbitrary blind retry. Distinguishing "unknown" from "zero" fixes the ambiguity at its root; broadcasting to all connections rather than polling matches this project's consistently push-based, event-driven philosophy (AD-7, AD-9's own prior rejection of polling) and puts no new retry-loop burden on plugin authors — they already have to tolerate `slot_capacity` arriving unsolicited (today, on every focus-gain), so an unsolicited arrival following a capacity-became-known event is the same kind of event, not a new category of message they must specially handle | Requiring plugins to poll/retry registration until capacity is known — rejected as inconsistent with the project's established event-driven philosophy and as unnecessary retry-loop complexity pushed onto every plugin author; leaving `slot_capacity`'s zero-vs-unknown ambiguity unresolved and instead relaxing registration-time validation whenever capacity reads as zero — rejected because it cannot distinguish a device that genuinely has zero dials (a real, valid state) from one Gatoway simply hasn't heard from yet |

---

## Data Model

- **Connection** — one live plugin session. Has a unique connection ID (generated per
  connection, *not* equal to the plugin's app-type), transport (`tcp` | `websocket`),
  plugin type (e.g. `lightroom`, `xdesign`), authentication state, current focus state
  (focused/unfocused), and its currently-declared slot content (AD-6; in-memory only,
  never persisted).
- **Slot Content** — a single item a plugin currently wants displayed at one fixed
  physical-position label (`"B1"`, `"D1"`, etc. — AD-6): icon, label, and (for
  buttons) state. Carries no semantic identifier beyond that label — Gatoway core
  does not need one, since the label itself is purely a stable stand-in for a
  physical position, never an app-specific meaning.
- **Slot Capacity** — the device's fixed physical button/dial counts, reported by the
  Stream Deck plugin (AD-9) and held in memory only. Never persisted; reflects the
  connected device's actual hardware, not what a user has gotten around to placing.
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
   AD-9 (Stream Deck plugin reports the device's fixed physical layout to Gatoway
   core), the revised AD-6 (application plugins declare/re-declare content addressed
   by fixed position labels, via `register`'s existing re-declaration semantics), and
   the revised AD-8 (label-based resolution replacing capability-id resolution).
   Remove the superseded `persisted-layout-config` code and its `layout-persistence`
   capability spec as part of this same delivery step, not as separate cleanup —
   leaving both live simultaneously would let a plugin author follow stale
   documentation. *(In progress — implemented and QA-passed against v1.6's
   ordinal-index model; live `/verify` surfaced QA-020, driving the v1.7 amendment to
   AD-6/AD-8/AD-9 above. The already-open `extension-provided-slot-content` change is
   being amended in place, not superseded by a new change, since it hasn't been
   archived yet — see Risk R-7.)*
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
| R-7 | Major (blast radius, v1.7) | This revision (AD-6/AD-8/AD-9 further amended) was raised as QA-020 during live `/verify` of the still-open, not-yet-archived `extension-provided-slot-content` change — the change built and QA-passed against v1.6's ordinal-index/placement-derived model. It needs amending in place, not superseding with a new change: (a) `device_capacity`'s computation (`stream-deck-plugin/src/coreClient/deviceCapacity.ts`) changes from `Device.actions`-based placement detection to `Device.size`/`Device.type`-based fixed-layout derivation — the `willAppear`/`willDisappear` event wiring added for placement-change detection is no longer needed and should be removed, not kept dormant; (b) `SlotContent`'s addressing changes from an ordinal array to a label-keyed map across `messages.ts`, `messageHandler.ts`, `profileRouter.ts`'s D6 resolution algorithm, and `slotContentValidation.ts`; (c) `command`'s payload drops `controller` in favor of the label's own prefix; (d) a `DeviceType` → dial-count mapping needs building and verifying against the SDK's own documentation (not guessed) since the SDK exposes dial count only in prose, never as a runtime field; (e) all of `message-protocol`/`profile-routing`/`stream-deck-core-lifecycle`'s delta specs under `openspec/changes/extension-provided-slot-content/specs/` need updating to match; (f) `docs/PROTOCOL.md`'s not-yet-merged rewrite needs updating for the new shapes before this change is archived | Main agent: amend the open `extension-provided-slot-content` change's `design.md`/specs/`tasks.md` directly rather than opening a new change; re-run QA and resume the paused `/verify` session once implemented |
| R-8 | Major (blast radius, v1.8) | This further amendment (AD-6/AD-9) was raised as QA-021 during QA review of the v1.7 rework, itself part of the still-open `extension-provided-slot-content` change — amend in place again, not a new change: (a) `SlotCapacityPayload`'s `buttonSlots`/`dialSlots` fields change from `number` to `number | null` (`null` = not yet known), and every place that constructs or consumes this payload (`profileRouter.ts`, `messageHandler.ts`, the manual test clients) needs updating for the three-state distinction; (b) registration-time label-range validation (`slotContentValidation.ts`) must skip the upper-bound check entirely while capacity is unknown, checking only syntactic form and value shape; (c) Gatoway core needs new logic to broadcast a fresh `slot_capacity` to every currently-connected application plugin the first time real capacity becomes known, and again on any subsequent device change — not just to whichever connection's own register/focus-gain triggered a `device_capacity` update, a genuinely new fan-out behavior distinct from today's per-connection delivery; (d) QA-022 (Minor, `slotContentValidation.ts`'s label parser accepting non-canonical forms like `"B01"`) should be fixed alongside this, since it touches the same validation code path | Main agent: amend the still-open `extension-provided-slot-content` change's `design.md`/specs/`tasks.md` for both QA-021 and QA-022 together; re-run QA and resume the paused `/verify` session once implemented |

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
v1.2 (FR-007/FR-008), itself raised by QA-018 during live xDender verification. v1.7
further revises AD-6/AD-8/AD-9 in response to QA-020, raised during live `/verify` of
the change v1.6 motivated — physical-layout labels replace ordinal-index/placement-
derived addressing. v1.8 further amends AD-6/AD-9 in response to QA-021, raised during
QA review of the v1.7 rework — `slot_capacity` distinguishes unknown capacity from a
known zero, and Gatoway core broadcasts fresh capacity to all connections once known.
It should be reviewed before change proposals are drafted against it.*
