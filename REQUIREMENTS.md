# Requirements: Gatoway

**Version:** 1.0
**Date:** 2026-07-13
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

**Out of scope (for now):**
- A no-code configuration/mapping UI for non-developer End Users (deferred to a future release)
- Multi-instance support for a single application running more than once at a time (not precluded architecturally, but not a near-term requirement)
- Remote/networked operation beyond a single local machine

---

## 2. Functional Requirements

### 2.1 User Roles
| Role | Description | Permissions Summary |
|------|-------------|---------------------|
| Developer | Writes application plugins/extensions that speak Gatoway's protocol | Full access to write plugin code, configure mappings directly, and manage Gatoway configuration |
| End User (future) | Installs Gatoway and existing app plugins | Configures button-to-command mappings via a UI; does not write plugin code |

### 2.2 Core Features (MVP)

#### FR-001 Bidirectional Communication
**Description:** Gatoway's core supports two-way messaging: the Stream Deck can send commands to trigger actions in a connected application, and the application can push state updates back to update button icons, labels, toggle states, and dial values.
**User story:** As a developer, I want commands and state updates to flow in both directions so that the Stream Deck accurately reflects the current state of the application it's controlling.
**Acceptance criteria:**
- [ ] A button press on the Stream Deck can trigger a command in a connected application
- [ ] An application can push a state update that changes a button's icon, label, or toggle state
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
**Description:** When an application plugin reports that it has gained focus, Gatoway switches the Stream Deck to display that application's configured profile. When no supported application currently has focus, the Stream Deck falls back to a default idle profile.
**User story:** As a user, I want the Stream Deck to automatically show the right set of controls for whichever application I'm currently using, so I don't have to switch profiles manually.
**Acceptance criteria:**
- [ ] Focus signal from an application plugin triggers a switch to that application's profile on the Stream Deck
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

### 2.3 Future Features (Post-MVP)
- **No-code mapping/configuration UI:** A UI allowing a non-developer End User to install app plugins and configure Stream Deck button-to-command mappings without writing code. Deferred because the immediate need is developer-driven (project owner writes plugin code directly); this becomes necessary if Gatoway is shared publicly.
- **Multi-instance support:** Support for multiple simultaneous instances of the same application (e.g. two Lightroom windows). Not needed for the currently targeted applications (Lightroom, xDesign), but the architecture should not preclude it for future applications.

### 2.4 User Journeys

#### Journey 1: Switching focus between applications
1. User is working in Lightroom; the Stream Deck shows the Lightroom profile (buttons/dials mapped to Lightroom actions).
2. User switches focus to a browser tab running xDesign.
3. The xDesign browser extension (xDender) detects the focus change and signals Gatoway.
4. Gatoway switches the Stream Deck to the xDesign profile.
5. If the user switches focus away from both Lightroom and xDesign (e.g. to Finder), the Stream Deck falls back to the default idle profile.

### 2.5 Data Requirements
Gatoway's core concern is real-time message passing (commands and state updates) between the Stream Deck and connected application plugins, plus activity logs for debugging. Whether persistent configuration (e.g. profile-to-application mappings) is owned by Gatoway's core or supplied by each application plugin is an open design question — see Section 4.2.

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

### 4.2 Open Questions
| # | Question | Owner | Due |
|---|----------|-------|-----|
| 1 | Should persistent configuration (e.g. profile-to-application mappings) be owned by Gatoway's core, or supplied by each application plugin when it connects? | Architect | Before/during architecture design |
| 2 | What is the specific authentication/access-control mechanism for the local WebSocket channel? | Architect | Before/during architecture design |
| 3 | What does the configuration backup/recovery approach look like? | Architect / Developer | Before/during architecture design |
| 4 | What does the End User (non-developer) mapping/configuration UI look like? | To be defined | Post-MVP |

---

## 5. Glossary

| Term | Definition |
|------|------------|
| Gatoway | The application-agnostic communications core connecting the Stream Deck to application plugins |
| Plugin | Application-specific code that connects to Gatoway and speaks its protocol (e.g. the Lightroom plugin, the xDender browser extension) |
| Profile | The set of button/dial mappings shown on the Stream Deck for a specific application |
| Idle profile | The default Stream Deck profile shown when no connected application currently has focus |
| Focus (application) | The state of being the currently active/foregrounded application, as self-reported by that application's plugin |
| Stream Deck+ | The Elgato Stream Deck hardware model used for development and testing, which includes touch dials in addition to buttons |

---

*This document was produced by a requirements analyst session with Claude Code. It should be reviewed and approved by the project sponsor before being passed to the architect.*
