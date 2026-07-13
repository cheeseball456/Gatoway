## Why

Gatoway currently has no shared core to connect into — every prior Stream Deck integration
(the Lightroom plugin) was a direct, one-to-one bridge. Per `ARCHITECTURE.md`'s phased
delivery sequence, step 1 is building the Gatoway core's connection, authentication,
protocol, and logging foundation, since every later piece (the Stream Deck plugin, the
Lightroom and xDesign integrations, focus/profile switching) depends on it existing first.

## What Changes

- Introduce a new Gatoway core process (Node.js/TypeScript) with a TCP listener and a
  WebSocket listener, both bound to IPv4 loopback (`127.0.0.1`) only — never all
  interfaces — so the core is unreachable from any other machine regardless of firewall
  state. (Amended per AD-4 v1.1/QA-002: IPv6 loopback `::1` is not required and is not
  bound.)
- Add connection lifecycle management: every accepted connection gets a unique
  connection ID, independent of plugin type, tracked from accept through authentication
  through disconnect. IDs are deliberately not keyed by plugin type so that supporting
  multiple simultaneous instances of the same application later doesn't require a data
  model change.
- Add authentication: TCP connections must present a shared-secret token (read from a
  local file with user-only read permission, regenerated fresh each time Gatoway core
  starts) as their first message. WebSocket connections are checked against an
  `Origin`-header allowlist of known browser-extension IDs. Unauthenticated or
  unrecognized connections are rejected before any other message is processed.
- Define the unified JSON message protocol: one shared message envelope/schema used
  identically over both transports, starting with the registration/handshake message
  (through which a plugin authenticates and declares its capability manifest).
- Add rotating local file logging of connection lifecycle events, protocol messages, and
  errors, retained short-term for active debugging — not long-term archival.
- Out of scope for this change: focus tracking, profile switching, and the idle profile
  (deferred to a later change once a Stream Deck plugin and at least one app plugin exist
  to exercise that logic), and persisted profile/layout configuration (deferred until the
  layout data itself exists to persist).

## Capabilities

### New Capabilities
- `connection-management`: loopback-only TCP and WebSocket listeners, unique per-connection IDs, and connection lifecycle tracking (connected → authenticated → disconnected).
- `plugin-authentication`: token handshake for TCP connections and Origin-header allowlisting for WebSocket connections, rejecting any connection that fails its check.
- `message-protocol`: the shared JSON message envelope/schema used identically across both transports, including the registration/capability-declaration message.
- `diagnostics-logging`: rotating local log files capturing connection lifecycle events, protocol messages, and errors, for short-term debugging.

### Modified Capabilities
None — this is the first change proposed for Gatoway; `openspec/specs/` is currently empty.

## Impact

- New Node.js/TypeScript codebase for Gatoway core; no existing code is modified.
- Local filesystem: a new auth token file (user-only read permission) and new rotating
  log files are introduced. No profile/layout config file yet — that's deferred to a
  later change.
- No impact on the existing Lightroom Lua plugin; it isn't touched until a later change
  adapts it to speak this protocol.
- Establishes the connection/auth/protocol contract that the Stream Deck plugin and every
  future application plugin (Lightroom, xDesign, and beyond) must follow.
