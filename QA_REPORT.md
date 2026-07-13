# QA Report

**Review date:** 2026-07-13
**Reviewer:** QA Engineer
**Scope:** OpenSpec change `gatoway-core-foundation` (branch `gatoway-core-foundation`, commit `8739eec`) — the Gatoway core Node.js/TypeScript codebase in `gatoway-core/src/`, reviewed against its four capability specs (`connection-management`, `plugin-authentication`, `message-protocol`, `diagnostics-logging`), `design.md`, `proposal.md`, `tasks.md`, and the project-level `REQUIREMENTS.md` / `ARCHITECTURE.md`.
**Prepared for:** Technical Architect

---

## Summary

This is a solid first implementation: loopback-only binding, token/Origin authentication, the unified envelope, and rotating logging are all present, unit/integration tested (46 tests, all passing), and type-checks clean under `strict` TypeScript. No Critical issues were found — the core security controls (loopback binding, timing-safe token comparison, fail-closed Origin allowlist, ordering of ack-before-close on rejection) are implemented correctly and match `design.md`.

The most important thing the architect needs to know: **the initial TCP plugin registration — the capability manifest a native plugin declares when it connects — is never written to the log with any payload detail, while the equivalent WebSocket registration is fully logged.** This is a transport-asymmetry bug caused by an interaction between `ConnectionManager`'s `preAuthenticated` fast path and `messageHandler`'s state-gated logging, and it directly undercuts `design.md` D6's explicit commitment to log "registration" in detail — for exactly the transport (TCP/Lightroom) that the architecture's delivery sequence names as the very next integration target. See QA-001.

---

## Issue Log

| ID | Severity | Location | Description | Status |
|----|----------|----------|-------------|--------|
| QA-001 | Major | `gatoway-core/src/connection/messageHandler.ts:76-221` | Initial TCP registration's capability manifest is never logged with payload; WebSocket registration is. Transport-asymmetric logging. | Open |
| QA-002 | Minor | `gatoway-core/src/connection/tcpListener.ts:83-108`, `wsListener.ts:47-133` | Both listeners bind to `127.0.0.1` and `::1` via `Promise.all`; if IPv6 loopback is unavailable (e.g. some containerized/restricted environments), the entire core fails to start even though IPv4 loopback alone would satisfy the loopback-only requirement. | Open |
| QA-003 | Minor | `gatoway-core/src/connection/messageHandler.ts:83-91` | A plugin's second/re-`register` message silently overwrites previously-declared `capabilities` with `[]` if the new message omits the field, since `Array.isArray(payload.capabilities) ? payload.capabilities : []` treats "absent" the same as "explicitly empty." | Open |
| QA-004 | Question | `openspec/changes/gatoway-core-foundation/specs/connection-management/spec.md:32-34` vs. `connectionManager.ts:58-61` | The spec's "New connection starts unauthenticated" scenario says a new connection's state is set to `connected` then `authenticating`, "not yet treated as authenticated" — but the WebSocket `preAuthenticated` fast path (an intentional, well-justified design choice per `design.md` D5) walks straight through to `authenticated` inside `accept()`, so this scenario's literal wording never holds for WebSocket connections. | Open (needs confirmation whether the spec text should be amended) |

**Status values:**
- `Open` — not yet fixed; needs architect attention

---

## Issue Detail

### QA-001 · Major · `gatoway-core/src/connection/messageHandler.ts`

**What:** The capability manifest a plugin declares in its `register` message is not captured in the logs for the initial TCP registration, but is fully captured for the initial WebSocket registration.

**Scenario:** A native (TCP) plugin — e.g. the Lightroom adapter, the very next item in `ARCHITECTURE.md`'s Delivery Sequence — connects, sends its `register` message with `pluginType` and `capabilities`, and successfully authenticates.

**Evidence:**
- For TCP, the first `register` message arrives while `connection.state === "authenticating"`. `handleRawMessage` (lines 174-190) detects this and calls `handleRegister` directly, then returns — bypassing the generic `message_received` log block at lines 198-207 (which only runs once `connection.state === "authenticated"`, i.e. *after* this branch has already returned).
- Inside `handleRegister`'s success path (lines 126-136), the only log line written is:
  ```ts
  logger.info(
    { event: "authentication_succeeded", connectionId: connection.id, transport: connection.transport },
    "authentication succeeded",
  );
  ```
  This has no `pluginType` or `capabilities` field.
- The only place that *does* log `pluginType` (still not `capabilities`) is the "already authenticated" branch at lines 90-102 (`event: "registered"`), which only fires on a *second* `register` call after the connection is already `authenticated` — not on the first, credential-validating registration.
- Contrast with WebSocket: `ConnectionManager.accept()` is called with `preAuthenticated: true` (`wsListener.ts:51-60`), which walks the connection straight to `authenticated` before its first message even arrives. So when the WS client's first `register` message is dispatched, `connection.state` is already `authenticated`, and it flows through the generic `message_received` log block (full `messageType` + `payload`, i.e. the entire capability manifest) before `handleRegister` even runs.
- This was independently reproducible by tracing the two code paths; no test in the suite asserts on log call arguments for registration, so this gap isn't caught by the existing 46 passing tests.

**Impact:** `design.md` D6 explicitly lists "registration" as one of the categories Gatoway core must log in detail ("since NFR 3 calls for *detailed* logging for troubleshooting"), and `REQUIREMENTS.md` FR-006/NFR 3.6 require detailed logs for debugging. For every native (TCP) plugin, the actual declared capability manifest is invisible in the log file — if a plugin declares unexpected or malformed capabilities, or registration silently no-ops in some edge case, there's no diagnostic trail for the single most informative message of the session. Meanwhile the exact same conceptual event is fully logged for WebSocket plugins, which is an inconsistency likely to confuse whoever debugs this from the log file later.

**Suggested fix direction:** Ensure the initial registration event is logged with `pluginType` and `capabilities` regardless of which branch of `handleRegister` handles it (i.e., regardless of the connection's authentication-timing quirk), so TCP and WebSocket registrations produce equivalent log detail.

---

### QA-002 · Minor · `gatoway-core/src/connection/tcpListener.ts`, `wsListener.ts`

**What:** Both the TCP and WebSocket listeners bind two separate server instances — one for `127.0.0.1`, one for `::1` — via `Promise.all`, which rejects (aborting `startGatowayCore()` entirely) if *either* bind fails.

**Scenario:** Gatoway core starts on a host/container where IPv6 loopback is disabled or unavailable (not uncommon in some restricted or containerized environments, though less likely on the personal desktop machines this project primarily targets).

**Evidence:** `startTcpListener`/`startWsListener` construct one `Promise` per loopback address and `Promise.all` them; a `server.on("error", ...)` handler calls `reject(err)` for that address's promise, which propagates as a rejection of the whole `Promise.all`, so `startGatowayCore()` throws and the process never starts serving TCP/WS at all — even on the address that bound successfully.

**Impact:** A user on a machine/VM without IPv6 loopback enabled would find Gatoway core entirely unable to start, despite IPv4 loopback (which is all AD-4 strictly requires) working fine. `ARCHITECTURE.md`/`design.md` don't address this degradation case.

**Suggested fix direction:** Decide (as an architecture/design question, not a code-only fix) whether a failure to bind `::1` specifically should be tolerated with a logged warning (falling back to IPv4-loopback-only) or should remain a hard failure; document whichever is chosen.

---

### QA-003 · Minor · `gatoway-core/src/connection/messageHandler.ts:83-91`

**What:** `handleRegister` computes `capabilities` as `Array.isArray(payload.capabilities) ? payload.capabilities : []` on every `register` message, including a plugin's second/subsequent `register` call (the "already authenticated" branch).

**Scenario:** A plugin sends an initial `register` with a full capability manifest, then later sends a second `register` (e.g. to update its `pluginType` label, or simply as a benign re-handshake) without repeating the `capabilities` array.

**Evidence:** `manager.setPluginInfo(connection.id, pluginType, capabilities)` is called unconditionally with the freshly-computed (possibly empty) `capabilities`, overwriting whatever was previously recorded — there's no merge or "omitted means unchanged" handling.

**Impact:** If any later logic (e.g. profile-switching in a subsequent change) depends on `ConnectionRecord.capabilities`, a partial re-registration could silently erase a plugin's declared actions. Not currently exercised since no downstream feature reads `capabilities` yet, but worth confirming intended re-registration semantics before that logic is built.

---

### QA-004 · Question · connection-management spec vs. `connectionManager.ts`

**What:** The `connection-management` capability spec's "New connection starts unauthenticated" scenario states a new connection's state is set to `connected` and then `authenticating`, "not yet treated as authenticated." The code's `preAuthenticated` fast path (used for WebSocket, per `design.md` D5's rationale that Origin-checking already happened at HTTP-upgrade time) transitions a WS connection through `connected -> authenticating -> authenticated` as one atomic step inside `ConnectionManager.accept()`, so externally a WS connection is *never* observably in a not-yet-authenticated state.

**Scenario:** A future reader compares this OpenSpec capability spec literally against the code and may flag the WS fast path as a violation, even though `design.md` explicitly designed and justified it.

**Question for the requirements/spec owner:** Should the `connection-management` spec's scenario text be amended to explicitly carve out the WebSocket pre-authenticated case (mirroring `design.md`'s D3/D5 language), so the delta spec and the design intent stay in sync for future readers? The code correctly implements `design.md`'s decision; this is a spec-text completeness gap, not a code defect.

---

## Observations

- `gatoway-core/src/connection/wsListener.ts:62-69` — the WebSocket `authentication_succeeded` log line omits the `origin` value that was actually matched, while the corresponding `authentication_failed` log (`wsListener.ts:91-98`) does include `origin`. Minor asymmetry; harmless but slightly reduces debuggability of which allowlist entry matched.
- `gatoway-core/src/auth/token.ts:38-46` — on Windows, the token file is created via `writeFile` (default ACLs) and only restricted afterward via a separate `icacls` call, leaving a brief window where the file could be more widely readable than intended. The developer has already transparently disclosed (in `tasks.md` 4.2) that this path is implemented but unverifiable on the current (macOS) development machine — flagging here only so the architect is aware this specific claim still awaits a real Windows verification pass.
- `gatoway-core/src/index.ts:59-71` — if `writeTokenFile` fails, Gatoway core logs loudly but continues starting up rather than aborting. This is a deliberate, well-commented trade-off (loopback-only binding still holds), not a defect, but it does mean a broken token file write silently weakens the one authentication control TCP connections rely on. Worth the architect's awareness, not a required fix.
- Test coverage is good for the units reviewed (46 tests: envelope parsing, TCP/WS framing, token generation/permissions/constant-time comparison, Origin allowlist, connection state machine, message handler dispatch, log rotation, and real-socket TCP/WS integration tests asserting actual bound loopback addresses). `tasks.md` 6.4's live `netstat`/cross-machine verification was substituted with an assertion on bound socket addresses — a reasonable substitute for a sandboxed environment, but the architect may still want a one-time manual `netstat`/cross-machine check before this ships, per `ARCHITECTURE.md`'s own "For QA" handoff note ("Verify loopback-only binding actually rejects connections from another machine on the same network").

---

## Testing Coverage Assessment

The test suite (`gatoway-core/test/unit/*`, `gatoway-core/test/integration/*`) covers all four capabilities reasonably well at the unit and component-integration level:
- **connection-management:** connection ID uniqueness, state-machine forward-only transitions, disconnect/removal — unit-tested directly against `ConnectionManager`.
- **plugin-authentication:** token generation/matching (including constant-time comparison and non-string/undefined inputs), file permission restriction, Origin allowlist fail-closed behavior, and end-to-end accept/reject over real TCP sockets and real WebSocket upgrades.
- **message-protocol:** envelope encode/decode validation (malformed JSON, wrong types, missing fields), NDJSON framing edge cases (split chunks, `\r\n`, empty lines, multiple messages per chunk), WS single-frame framing.
- **diagnostics-logging:** rotation-under-forced-size-threshold integration test confirms both rotation and retention-limit enforcement.

Gaps: no test asserts on the *content* of log calls for the registration/capability-manifest path, which is exactly how QA-001 went unnoticed. No test covers the IPv6-bind-unavailable scenario (QA-002) or partial re-registration overwriting capabilities (QA-003). These would be reasonable additions once QA-001/QA-003 are resolved one way or another.

I did not run a live cross-machine connection attempt or a live `netstat`/`lsof` check (matching the developer's own disclosed limitation for a sandboxed environment) — this remains an outstanding manual verification item per `ARCHITECTURE.md`'s "For QA" section, to be picked up in `/verify`.

---

## Review Verdict

**Recommendation:** ⚠️ **Conditional pass** — One Major issue (QA-001) is open, but it is a logging/observability gap, not a functional or security defect: authentication, loopback binding, and the message protocol all behave correctly under test and manual code trace. The architect should decide whether QA-001 blocks this change or can be scheduled as an immediate follow-up fix before the Stream Deck plugin / Lightroom integration changes build on top of it, since native (TCP) registration logging is exactly what the next delivery-sequence step will depend on for debugging.
