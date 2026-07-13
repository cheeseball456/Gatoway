# Gatoway

Gatoway is an application-agnostic communications hub between an Elgato Stream Deck and
application-specific plugins — a Lightroom Stream Deck plugin, a browser extension for
Solidworks xDesign, and future integrations — so that adding Stream Deck support for a
new application doesn't require rebuilding the communications layer from scratch.

This project is early-stage: the current codebase (`gatoway-core/`) implements only the
foundational connection/authentication/protocol/logging core described below. There is
no Stream Deck plugin yet, and no application plugins yet.

## Project documents

- [`REQUIREMENTS.md`](REQUIREMENTS.md) — what Gatoway is for and its functional/non-functional requirements.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the system's components, key design decisions, and delivery sequence.
- [`openspec/`](openspec/) — per-change specs and design records (spec-driven development via OpenSpec).
- [`QA_REPORT.md`](QA_REPORT.md) — review and verification findings for implemented changes.

## Packages

- [`gatoway-core/`](gatoway-core/) — the Node.js/TypeScript communications core. See
  [`gatoway-core/README.md`](gatoway-core/README.md) for how to run it standalone, its
  configuration, and its current scope and limitations.

No Stream Deck plugin or application plugin packages exist yet; they are planned as
later changes per `ARCHITECTURE.md`'s Delivery Sequence.
