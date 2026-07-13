## 1. Project Setup

- [x] 1.1 Initialize the Node.js/TypeScript package for Gatoway core (package.json, tsconfig, build script)
- [x] 1.2 Add dependencies: `ws` (WebSocket), a structured logger with a rotating file transport (e.g. `pino`), and a UUID generator
      (implemented with `ws`, `pino` + `pino-roll`, and Node's built-in `crypto.randomUUID()` in place of an
      external UUID package — see developer summary for rationale)
- [x] 1.3 Create the entry point exposing `startGatowayCore()` (per design D1)
      (standalone-invocation guard originally compared `import.meta.url` against a naively
      concatenated `file://` string, which never matched on paths needing URL-encoding, e.g.
      spaces — silently no-oping `npm run dev`/`node dist/index.js`; fixed per QA-005 to compare
      `fs.realpathSync`-resolved filesystem paths instead, also covering symlinked directories
      such as macOS's `/tmp` → `/private/tmp`; regression-tested by spawning the real CLI entry
      point in `test/integration/cliEntrypoint.test.ts`)

## 2. Message Protocol

- [x] 2.1 Define the shared TypeScript types for the message envelope (`type`, optional `connectionId`, `payload`)
- [x] 2.2 Implement the `register`, `register_ack`, and `error` message payload shapes
- [x] 2.3 Implement newline-delimited JSON encode/decode for TCP framing
- [x] 2.4 Implement single-frame JSON encode/decode for WebSocket framing

## 3. Connection Management

- [x] 3.1 Implement a `ConnectionManager` tracking connection state (connected → authenticating → authenticated → disconnected)
- [x] 3.2 Implement unique connection ID assignment on accept, independent of plugin type or transport
- [x] 3.3 Implement the TCP listener bound to `127.0.0.1` only, wired into `ConnectionManager`
      (originally also bound `::1`; dropped per AD-4 v1.1/QA-002 — binding both addresses via
      `Promise.all` failed startup entirely on hosts without IPv6 loopback available, for no benefit
      over IPv4-only loopback)
- [x] 3.4 Implement the WebSocket listener bound to `127.0.0.1` only, wired into `ConnectionManager`
      (same AD-4 v1.1/QA-002 amendment as 3.3)
- [x] 3.5 Reject and close connections that send any non-registration message while in the authenticating state
- [x] 3.6 Remove disconnected connections from active tracking on both graceful and unexpected disconnects

## 4. Authentication

- [x] 4.1 Implement crypto-random token generation on Gatoway core startup
- [x] 4.2 Write the token to a local file restricted to the owning user (0600 on POSIX, equivalent ACL on Windows), overwriting any previous token
      (POSIX path verified via automated test; Windows ACL path implemented via `icacls` but not executable/verifiable
      from this development machine — see developer summary)
- [x] 4.3 Implement the TCP registration handler that validates the presented token against the current token; reject and close on mismatch
- [x] 4.4 Implement a configurable allowlist of accepted WebSocket `Origin` values
- [x] 4.5 Implement the WebSocket upgrade handler that refuses the upgrade when `Origin` isn't allowlisted
- [x] 4.6 Mark a connection authenticated only after its respective check (token or Origin) passes

## 5. Diagnostics Logging

- [x] 5.1 Configure the structured logger to write newline-delimited JSON to a local log file
- [x] 5.2 Configure size-based log rotation with a bounded number of retained rotated files
- [x] 5.3 Log connection lifecycle events (accepted, authenticated, disconnected) with connection ID, transport, and timestamp
- [x] 5.4 Log authentication successes and failures with connection ID and transport type
- [x] 5.5 Log every message sent and received on authenticated connections, including type and payload

## 6. Integration and Verification

- [x] 6.1 Wire listeners, connection manager, authentication, protocol handling, and logging together in `startGatowayCore()`
- [x] 6.2 Write a manual TCP test client that connects and registers with a valid and an invalid token, confirming accept/reject behavior
      (script provided at `test/manual/tcpTestClient.ts`; accept/reject behavior confirmed via the equivalent
      automated integration test, `test/integration/tcpListener.test.ts`, using the same encode/decode helpers)
- [x] 6.3 Write a manual WebSocket test client that connects with an allowlisted and a non-allowlisted Origin, confirming accept/reject behavior
      (script provided at `test/manual/wsTestClient.ts`; accept/reject behavior confirmed via the equivalent
      automated integration test, `test/integration/wsListener.test.ts`)
- [x] 6.4 Verify listeners are not reachable on any non-loopback interface (e.g. via `netstat`/`lsof`)
      (verified via an automated assertion on the actual bound socket address in
      `test/integration/tcpListener.test.ts` / `wsListener.test.ts` — now asserting a single `127.0.0.1`
      bind per AD-4 v1.1/QA-002, rather than a live `netstat`/`lsof` run — see developer summary for why
      a live background instance wasn't run in this sandbox)
- [x] 6.5 Verify log rotation behavior under a forced size threshold in a test run
      (`test/integration/logger.test.ts`)
