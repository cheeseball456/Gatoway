## Context

This is the first implementation change for Gatoway. There is no existing Gatoway
codebase — this design translates `ARCHITECTURE.md` decisions AD-2 (Node.js/TypeScript),
AD-3 (dual transport, unified schema), AD-4 (loopback-only binding), and AD-5
(token/Origin authentication) into a concrete implementation approach for the four
capabilities in this change: `connection-management`, `plugin-authentication`,
`message-protocol`, and `diagnostics-logging`.

## Goals / Non-Goals

**Goals:**
- Stand up a Gatoway core process that accepts TCP and WebSocket connections on
  loopback only, authenticates them, exchanges a registration handshake using one
  unified JSON message schema, and logs activity to a rotating local file.
- Establish the connection/auth/protocol contract that later changes (the Stream Deck
  plugin, the Lightroom adapter, the xDender extension) build against.

**Non-Goals:**
- Focus tracking, profile switching, and the idle profile — deferred to a later change,
  once a Stream Deck plugin and at least one app plugin exist to exercise that logic.
- Persisted layout/profile configuration — deferred until profile data actually exists
  to persist.
- Process spawning/supervision by the Stream Deck plugin (AD-1) — that lifecycle wiring
  belongs to the Stream Deck plugin's own change. This change only needs Gatoway core to
  be runnable as a standalone process.
- Any application-specific plugin work (Lightroom, xDesign).

## Decisions

**D1 — Runtime and structure.** A Node.js/TypeScript package with a single entry point
(e.g. `src/index.ts`) exposing a `startGatowayCore()` function, so a future Stream Deck
plugin change can invoke it as a child process without this change needing to know how
it will be launched. Matches AD-2.

**D2 — Listener architecture.** Node's built-in `net` module for the TCP listener and
the `ws` package for the WebSocket listener, both bound explicitly to IPv4 loopback
(`127.0.0.1`) only — IPv6 loopback (`::1`) is not bound (amended per AD-4 v1.1: requiring
both addresses failed Gatoway core's entire startup on hosts without IPv6 loopback
available, for no benefit over IPv4-only loopback). Both feed into one internal
`ConnectionManager` that owns connection state regardless of transport. Per AD-3,
message-handling logic does not fork by transport — only the connection-accept code
does. Alternative considered: a single abstraction that fully hides transport
differences behind one interface — rejected as premature abstraction for two
transports with genuinely different accept semantics (TCP accept vs. WebSocket HTTP
upgrade).

**D3 — Connection identity and state.** Every accepted connection is assigned a UUID
connection ID immediately on accept, before authentication. The ID is never derived
from plugin type or transport, preserving the option (per `ARCHITECTURE.md`'s Data
Model) of multiple simultaneous instances of the same application later. Connections
move through `connected → authenticating → authenticated → disconnected`. Any message
other than the registration handshake received before `authenticated` is rejected and
the connection is closed.

**D4 — Message protocol and envelope.** One JSON message shape shared by both
transports:
```
{ "type": string, "connectionId"?: string, "payload": object }
```
- TCP: newline-delimited JSON (one JSON object per line), matching the framing the
  existing Lightroom plugin already uses — reusable when that plugin is adapted in a
  later change.
- WebSocket: one JSON object per text frame; WebSocket's own framing makes a delimiter
  unnecessary.
- Message types defined in this change: `register` (client → core: auth token for TCP
  clients, plus the plugin's declared capability manifest — Origin-header check
  substitutes for a token on the WebSocket side), `register_ack` (core → client:
  confirms or reports a rejection reason), `error` (either direction). Focus, command,
  and state-update message types are defined in later changes once a plugin exists to
  use them.

**D5 — Authentication.**
- TCP: a random token (crypto-random, 32 bytes) is generated fresh each time Gatoway
  core starts and written to a local file restricted to the owning user (`0600` on
  POSIX; equivalent ACL restriction on Windows). The connecting plugin includes this
  token in its `register` message payload; the core rejects and closes the connection
  on mismatch.
- WebSocket: the core inspects the `Origin` header on the HTTP upgrade request against
  a configured allowlist of known extension origins (e.g. `chrome-extension://<id>`).
  A non-matching origin causes the upgrade itself to be refused, rather than accepting
  the connection and closing it afterward.
- Both checks occur before a connection is marked `authenticated`; both successes and
  failures are logged.

**D6 — Logging.** A structured logger (e.g. `pino`) writes newline-delimited JSON log
entries to a rotating local file (rotate on size, e.g. 10MB, keeping a bounded number
of rotated files, e.g. the last 5). Logged events: connection accept, auth
success/failure, registration, and messages sent/received (including payload, since
NFR 3 calls for *detailed* logging for troubleshooting) — rotation keeps this
consistent with "short-term debugging only, not long-term archival."

## Risks / Trade-offs

- [Risk] Newline-delimited JSON over TCP could break if a message payload contains an
  unescaped literal newline → [Mitigation] Standard `JSON.stringify`/`JSON.parse` on
  both ends always escapes embedded newlines within string values; this must be
  called out explicitly when the Lua-side Lightroom adapter is built in a later change,
  since it hand-rolls its own JSON encoding.
- [Risk] The Origin-header allowlist can be spoofed by a non-browser client
  hand-crafting a WebSocket handshake → [Mitigation] Already accepted in
  `ARCHITECTURE.md` (Risk R-1): the loopback-only binding (AD-4) is the primary control;
  Origin-checking only needs to distinguish legitimate plugins from other local
  processes within that boundary, not resist a sophisticated local attacker.
- [Risk] Detailed logging (including payloads) could grow log files quickly under
  heavy dial/slider traffic → [Mitigation] Conservative size-based rotation with a
  bounded number of retained files.
- [Trade-off] `ARCHITECTURE.md` doesn't specify the auth token file's exact location —
  this design places it in a per-OS user config/cache directory, created on first run
  if missing; revisit if a future packaging change needs a different location.

## Migration Plan

Not applicable — this is greenfield code with no existing deployment. On first run,
Gatoway core creates its config/log directories if they don't already exist.

## Open Questions

- Exact library choices (`ws` for WebSocket, `pino` for logging) are implementation
  details left to the developer; no architectural decision forces a specific package.
- Whether the auth token file path should be overridable via an environment variable
  for automated testing — recommended yes, defaulting to the standard per-OS location.
