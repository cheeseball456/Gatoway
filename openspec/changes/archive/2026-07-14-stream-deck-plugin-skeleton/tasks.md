## 1. Repo and Package Setup

- [x] 1.1 Add a root-level `package.json` configuring npm workspaces (`gatoway-core`, `stream-deck-plugin`)
- [x] 1.2 Initialize the `stream-deck-plugin/` package (package.json, tsconfig, build script), depending on `gatoway-core` as a workspace package
- [x] 1.3 Add the Elgato Stream Deck SDK dependency and confirm its manifest/plugin conventions against current SDK documentation
- [x] 1.4 Confirm root install/build orders `gatoway-core`'s build before `stream-deck-plugin`'s

## 2. Gatoway Core Lifecycle

- [x] 2.1 Implement locating Gatoway core's built entry point via the workspace dependency (e.g. `require.resolve`), not a hand-built path string
- [x] 2.2 Implement spawning Gatoway core as a child process on plugin startup
- [x] 2.3 Implement supervision: detect unexpected child exit and restart with a backoff delay
- [x] 2.4 Log every restart, including the exit reason if available
- [x] 2.5 Detect and clearly report spawn failure (e.g. missing build) rather than failing silently

## 3. Gatoway Core Client Connection

- [x] 3.1 Implement reading the current auth token from Gatoway core's token file
- [x] 3.2 Implement opening a TCP connection to Gatoway core and sending a `register` message (`pluginType: "stream-deck"`, empty capabilities)
- [x] 3.3 Handle `register_ack` with `status: "ok"` as connected
- [x] 3.4 Handle `register_ack` rejection and connection loss by retrying with a backoff delay
- [x] 3.5 Log connection lifecycle events (connecting, connected, disconnected, retrying)

## 4. Idle Profile Display

- [x] 4.1 Define the plugin's manifest with a minimal, fixed set of static keys for the idle profile
- [x] 4.2 Render the idle key on physical Stream Deck hardware once manually placed by the user, independent of Gatoway core connection state
- [x] 4.3 Confirm key presses on the idle profile produce no dynamic behavior (no command sent, no content change)

## 5. Testing and Verification

- [x] 5.1 Write automated tests for the child-process spawn/supervise logic (spawn, unexpected-exit restart, backoff), following the same approach as `gatoway-core-foundation`'s `cliEntrypoint.test.ts`
- [x] 5.2 Write automated tests for the TCP client's connect/register/retry logic against a real (or test-harness) Gatoway core instance
- [x] 5.3 Manually verify on physical Stream Deck hardware that the idle key renders correctly once placed on a key and stays visible through a Gatoway core restart — **completed via `/verify` with the user and real Stream Deck+ hardware** (see `QA_REPORT.md`). Confirmed live: the icon and title render correctly once the Idle action is manually dragged onto a key; the key's display is unaffected by killing and auto-restarting the Gatoway core child process; key presses produce no dynamic behavior. A separate attempt to make the idle key appear without manual placement (a bundled `.streamDeckProfile` with a `Profiles` manifest entry) was tested live and found not to work, and was reverted; true zero-touch auto-install is deferred to a future change (see `design.md`'s Open Questions). Code-level equivalents were also checked: 4.3 is covered by `test/unit/idleAction.test.ts`, a structural regression test asserting `idleAction.ts`'s source defines no `onKeyDown` handler (it can't `import`/instantiate `IdleAction` directly and assert on the live object, since Vitest's SSR module runner can't execute this file's native class-decorator syntax — see the comment atop `idleKeyRenderer.ts`); 2.2/2.3/3.2/3.3 are covered by integration tests spawning a genuine child process and connecting over a real TCP socket to a running Gatoway core instance.
