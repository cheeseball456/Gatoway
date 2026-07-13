## 1. Project Setup

- [ ] 1.1 Initialize the Node.js/TypeScript package for Gatoway core (package.json, tsconfig, build script)
- [ ] 1.2 Add dependencies: `ws` (WebSocket), a structured logger with a rotating file transport (e.g. `pino`), and a UUID generator
- [ ] 1.3 Create the entry point exposing `startGatowayCore()` (per design D1)

## 2. Message Protocol

- [ ] 2.1 Define the shared TypeScript types for the message envelope (`type`, optional `connectionId`, `payload`)
- [ ] 2.2 Implement the `register`, `register_ack`, and `error` message payload shapes
- [ ] 2.3 Implement newline-delimited JSON encode/decode for TCP framing
- [ ] 2.4 Implement single-frame JSON encode/decode for WebSocket framing

## 3. Connection Management

- [ ] 3.1 Implement a `ConnectionManager` tracking connection state (connected → authenticating → authenticated → disconnected)
- [ ] 3.2 Implement unique connection ID assignment on accept, independent of plugin type or transport
- [ ] 3.3 Implement the TCP listener bound to `127.0.0.1`/`::1` only, wired into `ConnectionManager`
- [ ] 3.4 Implement the WebSocket listener bound to `127.0.0.1`/`::1` only, wired into `ConnectionManager`
- [ ] 3.5 Reject and close connections that send any non-registration message while in the authenticating state
- [ ] 3.6 Remove disconnected connections from active tracking on both graceful and unexpected disconnects

## 4. Authentication

- [ ] 4.1 Implement crypto-random token generation on Gatoway core startup
- [ ] 4.2 Write the token to a local file restricted to the owning user (0600 on POSIX, equivalent ACL on Windows), overwriting any previous token
- [ ] 4.3 Implement the TCP registration handler that validates the presented token against the current token; reject and close on mismatch
- [ ] 4.4 Implement a configurable allowlist of accepted WebSocket `Origin` values
- [ ] 4.5 Implement the WebSocket upgrade handler that refuses the upgrade when `Origin` isn't allowlisted
- [ ] 4.6 Mark a connection authenticated only after its respective check (token or Origin) passes

## 5. Diagnostics Logging

- [ ] 5.1 Configure the structured logger to write newline-delimited JSON to a local log file
- [ ] 5.2 Configure size-based log rotation with a bounded number of retained rotated files
- [ ] 5.3 Log connection lifecycle events (accepted, authenticated, disconnected) with connection ID, transport, and timestamp
- [ ] 5.4 Log authentication successes and failures with connection ID and transport type
- [ ] 5.5 Log every message sent and received on authenticated connections, including type and payload

## 6. Integration and Verification

- [ ] 6.1 Wire listeners, connection manager, authentication, protocol handling, and logging together in `startGatowayCore()`
- [ ] 6.2 Write a manual TCP test client that connects and registers with a valid and an invalid token, confirming accept/reject behavior
- [ ] 6.3 Write a manual WebSocket test client that connects with an allowlisted and a non-allowlisted Origin, confirming accept/reject behavior
- [ ] 6.4 Verify listeners are not reachable on any non-loopback interface (e.g. via `netstat`/`lsof`)
- [ ] 6.5 Verify log rotation behavior under a forced size threshold in a test run
