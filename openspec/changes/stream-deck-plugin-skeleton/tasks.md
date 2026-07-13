## 1. Repo and Package Setup

- [ ] 1.1 Add a root-level `package.json` configuring npm workspaces (`gatoway-core`, `stream-deck-plugin`)
- [ ] 1.2 Initialize the `stream-deck-plugin/` package (package.json, tsconfig, build script), depending on `gatoway-core` as a workspace package
- [ ] 1.3 Add the Elgato Stream Deck SDK dependency and confirm its manifest/plugin conventions against current SDK documentation
- [ ] 1.4 Confirm root install/build orders `gatoway-core`'s build before `stream-deck-plugin`'s

## 2. Gatoway Core Lifecycle

- [ ] 2.1 Implement locating Gatoway core's built entry point via the workspace dependency (e.g. `require.resolve`), not a hand-built path string
- [ ] 2.2 Implement spawning Gatoway core as a child process on plugin startup
- [ ] 2.3 Implement supervision: detect unexpected child exit and restart with a backoff delay
- [ ] 2.4 Log every restart, including the exit reason if available
- [ ] 2.5 Detect and clearly report spawn failure (e.g. missing build) rather than failing silently

## 3. Gatoway Core Client Connection

- [ ] 3.1 Implement reading the current auth token from Gatoway core's token file
- [ ] 3.2 Implement opening a TCP connection to Gatoway core and sending a `register` message (`pluginType: "stream-deck"`, empty capabilities)
- [ ] 3.3 Handle `register_ack` with `status: "ok"` as connected
- [ ] 3.4 Handle `register_ack` rejection and connection loss by retrying with a backoff delay
- [ ] 3.5 Log connection lifecycle events (connecting, connected, disconnected, retrying)

## 4. Idle Profile Display

- [ ] 4.1 Define the plugin's manifest with a minimal, fixed set of static keys for the idle profile
- [ ] 4.2 Render the idle profile on physical Stream Deck hardware immediately at plugin startup, independent of Gatoway core connection state
- [ ] 4.3 Confirm key presses on the idle profile produce no dynamic behavior (no command sent, no content change)

## 5. Testing and Verification

- [ ] 5.1 Write automated tests for the child-process spawn/supervise logic (spawn, unexpected-exit restart, backoff), following the same approach as `gatoway-core-foundation`'s `cliEntrypoint.test.ts`
- [ ] 5.2 Write automated tests for the TCP client's connect/register/retry logic against a real (or test-harness) Gatoway core instance
- [ ] 5.3 Manually verify on physical (or emulated) Stream Deck hardware that the idle profile renders correctly at plugin startup and stays visible through a Gatoway core restart
