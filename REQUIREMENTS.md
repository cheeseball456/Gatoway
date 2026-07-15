# Requirements: Gatoway

**Version:** 1.2
**Date:** 2026-07-16
**Status:** Draft — pending architect review

---

## 1. Project Overview

### 1.1 Purpose
Gatoway is a communications core that brokers bidirectional interaction between an Elgato Stream Deck and a range of application plugins/extensions, so that adding support for a new application does not require rebuilding the communications layer from scratch.

### 1.2 Problem Statement
Today, each Stream Deck integration is built as a one-off: the existing Lightroom Stream Deck Plugin implements a direct, one-to-one bridge between the Stream Deck and Lightroom, with the communications layer tightly coupled to Lightroom-specific concepts. Extending Stream Deck control to a new application currently means rewriting this communications layer for that application. Gatoway generalizes this into a shared, application-agnostic core.

### 1.3 Stakeholders
| Role | Interest |
|------|----------|
| Developer (project owner) | Wants a faster workflow across multiple creative/technical applications without rebuilding integration code for each one |
| End User (future) | Wants to install Gatoway and app plugins and configure Stream Deck button mappings without writing code |

### 1.4 Constraints
No hard deadline or budget constraint. Development and testing will use an Elgato Stream Deck+.

### 1.5 Scope
**In scope:**
- Application-agnostic communications core between Stream Deck and app plugins
- Bidirectional messaging (commands out, state updates back)
- Simultaneous connections to multiple applications
- Automatic profile switching driven by which application currently has focus
- Support for Stream Deck+ dials/touch sliders (continuous input), not just button presses
- Cross-platform Gatoway core (Windows, Mac, Linux)
- Detailed logging for debugging/troubleshooting
- Extension-managed on-device layout: each application plugin decides what to display on its available button/dial slots, using capacity information Gatoway provides — not a host-side, hand-authored mapping file (see FR-007/FR-008; resolves what was Open Question #1 in v1.1)

**Out of scope (for now):**
- A no-code configuration/mapping UI for non-developer End Users (deferred to a future release; its likely scope has shrunk now that plugins no longer need a hand-authored id-to-position mapping to begin with — see Section 2.3)
- Multi-instance support for a single application running more than once at a time (not precluded architecturally, but not a near-term requirement)
- Remote/networked operation beyond a single local machine
- A Linux-native Stream Deck hardware experience (deferred — Elgato's own Stream Deck software has no Linux build at all; supporting Linux here would require either an alternative integration path or custom-written software, neither of which is designed or scoped yet)
- Multiple simultaneous physical Stream Deck devices, or a Stream Deck device being connected/disconnected while plugins remain connected (not a near-term requirement; not precluded architecturally — this is part of why capacity information is refreshed on every focus change rather than only once at connection, see FR-007)

---

## 2. Functional Requirements

### 2.1 User Roles
| Role | Description | Permissions Summary |
|------|-------------|---------------------|
| Developer | Writes application plugins/extensions that speak Gatoway's protocol | Full access to write plugin code, configure mappings directly, and manage Gatoway configuration |
| End User (future) | Installs Gatoway and existing app plugins | Configures button-to-command mappings via a UI; does not write plugin code |

### 2.2 Core Features (MVP)

#### FR-001 Bidirectional Communication
**Description:** Gatoway's core supports two-way messaging: the Stream Deck can send commands to trigger actions in a connected application, and the application can push content updates back to update a slot's icon, label, or state.
**User story:** As a developer, I want commands and state updates to flow in both directions so that the Stream Deck accurately reflects the current state of the application it's controlling.
**Acceptance criteria:**
- [ ] A button press on the Stream Deck can trigger a command in a connected application
- [ ] An application can push a content update that changes a slot's icon, label, or state
- [ ] A dial/slider turn on the Stream Deck+ can send a continuous/parameterized value to a connected application

#### FR-002 Simultaneous Multi-Application Connections
**Description:** Gatoway can maintain live connections to multiple applications at the same time (e.g. Lightroom and xDesign both connected simultaneously).
**User story:** As a developer, I want to keep multiple applications connected at once so that I can switch between them without reconnecting each time.
**Acceptance criteria:**
- [ ] Gatoway maintains active connections to at least two applications simultaneously
- [ ] Switching focus between connected applications does not require re-establishing connections

#### FR-003 Self-Reported Focus Detection
**Description:** Each application plugin is responsible for detecting and reporting its own focus state (focused/unfocused) to Gatoway, rather than Gatoway performing OS-level window detection. This applies consistently to native desktop application plugins and browser-based extension plugins.
**User story:** As a developer, I want each plugin to report its own focus state so that focus detection works consistently regardless of whether the application is a native desktop app or a browser-based extension.
**Acceptance criteria:**
- [ ] A native application plugin (e.g. Lightroom) can signal to Gatoway when it gains or loses focus
- [ ] A browser-based extension plugin (e.g. xDender for xDesign) can signal to Gatoway when it gains or loses focus

#### FR-004 Automatic Profile Switching
**Description:** When an application plugin reports that it has gained focus, Gatoway switches the Stream Deck to display that application's current content. When no supported application currently has focus, the Stream Deck falls back to a default idle profile.
**User story:** As a user, I want the Stream Deck to automatically show the right set of controls for whichever application I'm currently using, so I don't have to switch profiles manually.
**Acceptance criteria:**
- [ ] Focus signal from an application plugin triggers a switch to that application's current content on the Stream Deck
- [ ] When no connected application reports focus, the Stream Deck shows a default idle profile

#### FR-005 Dial/Slider Support
**Description:** Gatoway supports the Stream Deck+'s touch dials/sliders as an input type, sending continuous or parameterized values to applications, in addition to discrete button presses.
**User story:** As a user, I want to use the Stream Deck+ dials to adjust continuous values (like an exposure slider in Lightroom), matching functionality already present in the existing Lightroom plugin.
**Acceptance criteria:**
- [ ] Turning a Stream Deck+ dial sends a parameterized value to the focused application
- [ ] An application can update a dial's displayed value/indicator based on its own state

#### FR-006 Detailed Logging
**Description:** Gatoway produces detailed logs of connection activity, commands sent/received, and errors, to support debugging and troubleshooting.
**User story:** As a developer, I want detailed logs so that I can diagnose problems like dropped connections or missed commands.
**Acceptance criteria:**
- [ ] Gatoway logs connection lifecycle events (connect, disconnect, reconnect)
- [ ] Gatoway logs commands and state updates passing through the core
- [ ] Logs are retained on a short-term/rotating basis for troubleshooting, not long-term archival

#### FR-007 Extension-Provided Capacity and Slot-Based Content
**Description:** Gatoway tells each connecting application plugin how many physical button slots and dial slots are currently available on the connected Stream Deck (based on what the user has actually placed on the device), both when the plugin first connects and again every time it gains focus. The plugin uses this information to decide exactly what to display, sized to fit — Gatoway itself does not need to understand what a plugin's commands mean; it only needs to know what to display at each slot, and which slot was just interacted with. This replaces any host-side, hand-authored file mapping a plugin's commands to physical positions, which required knowing a plugin's internal command identifiers in advance — impractical for anyone other than that plugin's own author.
**User story:** As a developer, I want Gatoway to tell my plugin how many buttons and dials it actually has to work with, so my plugin can decide what to show without anyone needing to hand-configure a mapping between my plugin's commands and specific physical positions.
**Acceptance criteria:**
- [ ] A newly-connected application plugin receives the number of available button slots and dial slots
- [ ] A plugin receives refreshed slot counts again each time it reports gaining focus
- [ ] Gatoway displays whatever ordered content a plugin currently provides by filling available slots directly, without needing to know what that content represents
- [ ] No separate, hand-authored file is required to map a plugin's commands to physical positions

#### FR-008 Extension-Managed Paging and Grouping
**Description:** An application plugin with more commands than fit on the slots available to it, or with commands that are logically grouped (e.g. several variants of one tool), manages that paging or grouping entirely itself, deciding what to currently display given the slot counts Gatoway provided. Gatoway does not need to understand any such structure — it only ever sees the plugin's current, right-sized list of what to show. This mirrors how the existing Lightroom Stream Deck Plugin already manages its own internal panel/page state today.
**User story:** As a developer, I want my plugin to handle its own paging and grouping of commands, so that Gatoway can remain a simple, application-agnostic relay no matter how many commands my plugin has.
**Acceptance criteria:**
- [ ] A plugin with more commands than available slots can show a subset at a time and let the user navigate to see more, without Gatoway being aware this is happening
- [ ] A plugin can group related commands together and reveal them progressively, without Gatoway needing to know about the grouping

### 2.3 Future Features (Post-MVP)
- **No-code mapping/configuration UI:** A UI allowing a non-developer End User to install app plugins and configure Stream Deck button-to-command mappings without writing code. Deferred because the immediate need is developer-driven (project owner writes plugin code directly); this becomes necessary if Gatoway is shared publicly. Its likely shape has changed following FR-007/FR-008: since plugins no longer need a hand-authored id-to-position mapping to work at all, any future UI here would most likely be about letting a user *override* a plugin's own default ordering, rather than creating a mapping from scratch.
- **Multi-instance support:** Support for multiple simultaneous instances of the same application (e.g. two Lightroom windows). Not needed for the currently targeted applications (Lightroom, xDesign), but the architecture should not preclude it for future applications.
- **Multiple physical Stream Deck devices:** Support for more than one physical Stream Deck connected at once, and devices being connected/disconnected while plugins remain connected. Not needed near-term, but the decision to refresh slot-capacity information on every focus change (FR-007) was deliberately made so this isn't precluded later.

### 2.4 User Journeys

#### Journey 1: Switching focus between applications
1. User is working in Lightroom; the Stream Deck shows Lightroom's current content (buttons/dials showing Lightroom actions).
2. User switches focus to a browser tab running xDesign.
3. The xDesign browser extension (xDender) detects the focus change and signals Gatoway.
4. Gatoway sends xDender its currently-available slot counts, and xDender responds with its content sized to fit; Gatoway switches the Stream Deck to display it.
5. If the user switches focus away from both Lightroom and xDesign (e.g. to Finder), the Stream Deck falls back to the default idle profile.

### 2.5 Data Requirements
Gatoway's core concern is real-time message passing (commands and content updates) between the Stream Deck and connected application plugins, plus activity logs for debugging. Persistent, host-side configuration of button-to-command mappings is no longer needed: each application plugin decides what to display on its available slots, live, based on the slot-capacity information Gatoway provides at connection time and on every focus change (see FR-007/FR-008; this resolves what was Open Question #1 in v1.1 — the answer is that this is supplied by each plugin, not owned by Gatoway's core).

### 2.6 Integrations
| System | Direction | Purpose |
|--------|-----------|---------|
| Elgato Stream Deck (hardware, tested on Stream Deck+) | Inbound/Outbound | Receives button/dial input; displays icons, labels, and dial state |
| Lightroom Classic (via existing native plugin) | Inbound/Outbound | Native application target for validating the generalized core |
| Solidworks xDesign (via xDender browser extension) | Inbound/Outbound | Browser-based application target for validating the generalized core |

### 2.7 Reporting and Exports
No reporting dashboards or data exports are required. Logging (FR-006) covers debugging/troubleshooting needs only.

---

## 3. Non-Functional Requirements

### 3.1 Performance
| Metric | Target |
|--------|--------|
| Command/response latency | Near-instant (imperceptible delay), to support real-time creative/CAD workflows |

### 3.2 Availability and Reliability
- **Reconnection:** Gatoway must automatically and immediately reconnect after a dropped connection or crash, matching and extending the reconnect behavior already present in the existing Lightroom plugin.

### 3.3 Security and Compliance
- **Scope:** All communication is local to a single machine for now.
- **Local channel security:** Because the browser-extension communication channel may use a WebSocket (a mechanism reachable by other local processes), Gatoway must implement authentication/access control on its local communication channels to prevent a malicious local application from connecting and issuing unauthorized commands or reading state. The specific mechanism is left to the architect.
- **Sensitive data:** None identified; no PII or payment data is handled.

### 3.4 Platforms and Browsers
Gatoway core must run on Windows, macOS, and Linux. Individual application plugins may be constrained by the platform support of their host application (e.g. Lightroom Classic is Windows/Mac only; a Linux-only setup would only support applications with Linux-compatible plugins).

This cross-platform requirement covers Gatoway core specifically. The Stream Deck plugin — the hardware-facing UI that talks to the physical Stream Deck — is constrained to Windows and macOS only, because Elgato's own Stream Deck software has no Linux build at all. This is a vendor limitation, not a gap in Gatoway's own design: Gatoway core remains fully portable to Linux, but there is currently no way to drive physical Stream Deck hardware from a Linux machine at all, through Gatoway or otherwise.

### 3.5 Internationalisation
English only; no other languages or locales required at this time.

### 3.6 Data Retention
- **Logs:** Retained short-term on a rotating basis, for active debugging/troubleshooting only — not long-term archival.
- **Configuration backup:** Not yet decided — see Section 4.2.

---

## 4. Assumptions and Open Questions

### 4.1 Assumptions
- Lightroom Classic and Solidworks xDesign (via xDender) are the two applications used to validate that the core is genuinely application-agnostic.
- Multiple simultaneous instances of the same application are not required for Lightroom or xDesign, but the architecture should not architecturally preclude this for future applications.
- The Stream Deck+ is the hardware baseline for development and testing.
- A single physical Stream Deck device is assumed for now; the design should not preclude multiple devices later (see Section 2.3).

### 4.2 Open Questions
| # | Question | Owner | Due |
|---|----------|-------|-----|
| 1 | ~~Should persistent configuration (e.g. profile-to-application mappings) be owned by Gatoway's core, or supplied by each application plugin when it connects?~~ **Resolved 2026-07-16:** supplied live by each application plugin, using slot-capacity information Gatoway provides — see FR-007/FR-008. | Architect | Resolved |
| 2 | What is the specific authentication/access-control mechanism for the local WebSocket channel? | Architect | Before/during architecture design |
| 3 | What does the configuration backup/recovery approach look like? | Architect / Developer | Before/during architecture design |
| 4 | What does the End User (non-developer) mapping/configuration UI look like? | To be defined | Post-MVP |
| 5 | If Linux support for the physical Stream Deck experience becomes a priority, what alternative integration path or custom software would provide it, given Elgato's own Stream Deck software has no Linux build? | To be defined | Deferred — no current priority |

---

## 5. Glossary

| Term | Definition |
|------|------------|
| Gatoway | The application-agnostic communications core connecting the Stream Deck to application plugins |
| Plugin | Application-specific code that connects to Gatoway and speaks its protocol (e.g. the Lightroom plugin, the xDender browser extension) |
| Slot | A single physical button or dial position on the Stream Deck. Gatoway addresses slots by position only — it has no knowledge of what a plugin's content at a given slot actually does |
| Profile | The set of button/dial content shown on the Stream Deck for a specific application |
| Idle profile | The default Stream Deck profile shown when no connected application currently has focus |
| Focus (application) | The state of being the currently active/foregrounded application, as self-reported by that application's plugin |
| Stream Deck+ | The Elgato Stream Deck hardware model used for development and testing, which includes touch dials in addition to buttons |

---

*This document was produced by a requirements analyst session with Claude Code. It should be reviewed and approved by the project sponsor before being passed to the architect.*
