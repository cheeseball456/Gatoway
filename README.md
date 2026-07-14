# Gatoway

Gatoway is an application-agnostic communications hub between an Elgato Stream Deck and
application-specific plugins — a Lightroom Stream Deck plugin, a browser extension for
Solidworks xDesign, and future integrations — so that adding Stream Deck support for a
new application doesn't require rebuilding the communications layer from scratch.

This project is early-stage: the current codebase implements Gatoway core's
connection/authentication/protocol/logging foundation, focus tracking, profile routing,
live capability updates, and a real, file-backed layout config determining which
physical position resolves to which capability per plugin type (`gatoway-core/`), and a
Stream Deck plugin (`stream-deck-plugin/`) that spawns/supervises core and renders
Gatoway's generic, position-based Key/Dial actions on real Stream Deck hardware —
including the built-in idle appearance when no application currently has focus, and a
local default baseline shown immediately after a plugin restart even before that config
loads — described in the package docs below. No real application plugins (Lightroom,
xDesign) exist yet; the mechanism has instead been proven using a manual test-double
application client (`gatoway-core/test/manual/testAppClient.ts`) verified live against
real Stream Deck+ hardware. See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the full
wire message contract a future application plugin author would build against, and
[`docs/LAYOUT_CONFIG.md`](docs/LAYOUT_CONFIG.md) for the local layout config file that
same author needs to bind their capabilities to physical positions.

This is an npm workspaces monorepo: install and build from this root directory, not
from inside an individual package directory (see each package's README for details).

## Project documents

- [`REQUIREMENTS.md`](REQUIREMENTS.md) — what Gatoway is for and its functional/non-functional requirements.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the system's components, key design decisions, and delivery sequence.
- [`openspec/`](openspec/) — per-change specs and design records (spec-driven development via OpenSpec).
- [`QA_REPORT.md`](QA_REPORT.md) — review and verification findings for implemented changes.
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — the full Gatoway wire message protocol reference for anyone writing a new application plugin.
- [`docs/LAYOUT_CONFIG.md`](docs/LAYOUT_CONFIG.md) — the local layout config file's JSON schema, file location, and a worked example, for binding a plugin's capabilities to physical Stream Deck positions.

## Packages

- [`gatoway-core/`](gatoway-core/) — the Node.js/TypeScript communications core. See
  [`gatoway-core/README.md`](gatoway-core/README.md) for how to run it standalone, its
  configuration, and its current scope and limitations.
- [`stream-deck-plugin/`](stream-deck-plugin/) — the Node.js/TypeScript Stream Deck
  plugin that spawns and supervises Gatoway core, connects to it as an authenticated
  client, and renders Gatoway's keys on physical Stream Deck hardware. See
  [`stream-deck-plugin/README.md`](stream-deck-plugin/README.md) for how to build it,
  link it to real Stream Deck hardware (including the required developer-mode step),
  and its current scope and limitations.

No application plugin packages (Lightroom, xDesign) exist yet; they are planned as
later changes per `ARCHITECTURE.md`'s Delivery Sequence.
