# Gatoway

Gatoway is an application-agnostic communications hub between an Elgato Stream Deck and
application-specific plugins — a Lightroom Stream Deck plugin, a browser extension for
Solidworks xDesign, and future integrations — so that adding Stream Deck support for a
new application doesn't require rebuilding the communications layer from scratch.

This project is early-stage: the current codebase implements Gatoway core's
foundational connection/authentication/protocol/logging layer (`gatoway-core/`) and a
Stream Deck plugin skeleton (`stream-deck-plugin/`) that spawns/supervises core and
renders a static idle key on real Stream Deck hardware, described in the package docs
below. No application plugins (Lightroom, xDesign) exist yet.

This is an npm workspaces monorepo: install and build from this root directory, not
from inside an individual package directory (see each package's README for details).

## Project documents

- [`REQUIREMENTS.md`](REQUIREMENTS.md) — what Gatoway is for and its functional/non-functional requirements.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the system's components, key design decisions, and delivery sequence.
- [`openspec/`](openspec/) — per-change specs and design records (spec-driven development via OpenSpec).
- [`QA_REPORT.md`](QA_REPORT.md) — review and verification findings for implemented changes.

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
