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
| QA-001 | Major | `gatoway-core/src/connection/messageHandler.ts:76-221` | Initial TCP registration's capability manifest is never logged with payload; WebSocket registration is. Transport-asymmetric logging. | **Resolved (commit `a8acacc`)** |
| QA-002 | Minor | `gatoway-core/src/connection/tcpListener.ts:83-108`, `wsListener.ts:47-133` | Both listeners bind to `127.0.0.1` and `::1` via `Promise.all`; if IPv6 loopback is unavailable (e.g. some containerized/restricted environments), the entire core fails to start even though IPv4 loopback alone would satisfy the loopback-only requirement. | **Resolved (commit `a8acacc`)** |
| QA-003 | Minor | `gatoway-core/src/connection/messageHandler.ts:83-91` | A plugin's second/re-`register` message silently overwrites previously-declared `capabilities` with `[]` if the new message omits the field, since `Array.isArray(payload.capabilities) ? payload.capabilities : []` treats "absent" the same as "explicitly empty." | **Resolved (commit `a8acacc`)** |
| QA-004 | Question | `openspec/changes/gatoway-core-foundation/specs/connection-management/spec.md:32-34` vs. `connectionManager.ts:58-61` | The spec's "New connection starts unauthenticated" scenario says a new connection's state is set to `connected` then `authenticating`, "not yet treated as authenticated" — but the WebSocket `preAuthenticated` fast path (an intentional, well-justified design choice per `design.md` D5) walks straight through to `authenticated` inside `accept()`, so this scenario's literal wording never holds for WebSocket connections. | **Resolved (commit `a8acacc`)** |

**Status values:**
- `Open` — not yet fixed; needs architect attention
- `Resolved in review` — fixed or clarified during the review conversation
- `Deferred` — acknowledged, decision made to address in a later cycle
- `Resolved (commit ...)` — fixed in a later commit, confirmed in a follow-up re-verification session (see below)

---

## Issue Detail (original findings, 2026-07-13 initial session)

### QA-001 · Major (originally) · `gatoway-core/src/connection/messageHandler.ts`

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

**Resolution (verified 2026-07-13, commit `a8acacc`):** See Re-verification section below.

---

### QA-002 · Minor (originally) · `gatoway-core/src/connection/tcpListener.ts`, `wsListener.ts`

**What:** Both the TCP and WebSocket listeners bind two separate server instances — one for `127.0.0.1`, one for `::1` — via `Promise.all`, which rejects (aborting `startGatowayCore()` entirely) if *either* bind fails.

**Scenario:** Gatoway core starts on a host/container where IPv6 loopback is disabled or unavailable (not uncommon in some restricted or containerized environments, though less likely on the personal desktop machines this project primarily targets).

**Evidence:** `startTcpListener`/`startWsListener` construct one `Promise` per loopback address and `Promise.all` them; a `server.on("error", ...)` handler calls `reject(err)` for that address's promise, which propagates as a rejection of the whole `Promise.all`, so `startGatowayCore()` throws and the process never starts serving TCP/WS at all — even on the address that bound successfully.

**Impact:** A user on a machine/VM without IPv6 loopback enabled would find Gatoway core entirely unable to start, despite IPv4 loopback (which is all AD-4 strictly requires) working fine. `ARCHITECTURE.md`/`design.md` don't address this degradation case.

**Suggested fix direction:** Decide (as an architecture/design question, not a code-only fix) whether a failure to bind `::1` specifically should be tolerated with a logged warning (falling back to IPv4-loopback-only) or should remain a hard failure; document whichever is chosen.

**Resolution (verified 2026-07-13, commit `a8acacc`):** See Re-verification section below.

---

### QA-003 · Minor (originally) · `gatoway-core/src/connection/messageHandler.ts:83-91`

**What:** `handleRegister` computes `capabilities` as `Array.isArray(payload.capabilities) ? payload.capabilities : []` on every `register` message, including a plugin's second/subsequent `register` call (the "already authenticated" branch).

**Scenario:** A plugin sends an initial `register` with a full capability manifest, then later sends a second `register` (e.g. to update its `pluginType` label, or simply as a benign re-handshake) without repeating the `capabilities` array.

**Evidence:** `manager.setPluginInfo(connection.id, pluginType, capabilities)` is called unconditionally with the freshly-computed (possibly empty) `capabilities`, overwriting whatever was previously recorded — there's no merge or "omitted means unchanged" handling.

**Impact:** If any later logic (e.g. profile-switching in a subsequent change) depends on `ConnectionRecord.capabilities`, a partial re-registration could silently erase a plugin's declared actions. Not currently exercised since no downstream feature reads `capabilities` yet, but worth confirming intended re-registration semantics before that logic is built.

**Resolution (verified 2026-07-13, commit `a8acacc`):** See Re-verification section below.

---

### QA-004 · Question (originally) · connection-management spec vs. `connectionManager.ts`

**What:** The `connection-management` capability spec's "New connection starts unauthenticated" scenario states a new connection's state is set to `connected` and then `authenticating`, "not yet treated as authenticated." The code's `preAuthenticated` fast path (used for WebSocket, per `design.md` D5's rationale that Origin-checking already happened at HTTP-upgrade time) transitions a WS connection through `connected -> authenticating -> authenticated` as one atomic step inside `ConnectionManager.accept()`, so externally a WS connection is *never* observably in a not-yet-authenticated state.

**Scenario:** A future reader compares this OpenSpec capability spec literally against the code and may flag the WS fast path as a violation, even though `design.md` explicitly designed and justified it.

**Question for the requirements/spec owner:** Should the `connection-management` spec's scenario text be amended to explicitly carve out the WebSocket pre-authenticated case (mirroring `design.md`'s D3/D5 language), so the delta spec and the design intent stay in sync for future readers? The code correctly implements `design.md`'s decision; this is a spec-text completeness gap, not a code defect.

**Resolution (verified 2026-07-13, commit `a8acacc`):** See Re-verification section below.

---

## Observations

- `gatoway-core/src/connection/wsListener.ts:62-69` — the WebSocket `authentication_succeeded` log line omits the `origin` value that was actually matched, while the corresponding `authentication_failed` log (`wsListener.ts:91-98`) does include `origin`. Minor asymmetry; harmless but slightly reduces debuggability of which allowlist entry matched. **Still stands** — unchanged by commit `a8acacc` (confirmed in re-verification below; not in scope of QA-001/002/003/004).
- `gatoway-core/src/auth/token.ts:38-46` — on Windows, the token file is created via `writeFile` (default ACLs) and only restricted afterward via a separate `icacls` call, leaving a brief window where the file could be more widely readable than intended. The developer has already transparently disclosed (in `tasks.md` 4.2) that this path is implemented but unverifiable on the current (macOS) development machine — flagging here only so the architect is aware this specific claim still awaits a real Windows verification pass. **Still stands** — `token.ts` untouched by commit `a8acacc`.
- `gatoway-core/src/index.ts:59-71` — if `writeTokenFile` fails, Gatoway core logs loudly but continues starting up rather than aborting. This is a deliberate, well-commented trade-off (loopback-only binding still holds), not a defect, but it does mean a broken token file write silently weakens the one authentication control TCP connections rely on. Worth the architect's awareness, not a required fix. **Still stands** — `index.ts` untouched by commit `a8acacc`.
- Test coverage is good for the units reviewed (46 tests: envelope parsing, TCP/WS framing, token generation/permissions/constant-time comparison, Origin allowlist, connection state machine, message handler dispatch, log rotation, and real-socket TCP/WS integration tests asserting actual bound loopback addresses). `tasks.md` 6.4's live `netstat`/cross-machine verification was substituted with an assertion on bound socket addresses — a reasonable substitute for a sandboxed environment, but the architect may still want a one-time manual `netstat`/cross-machine check before this ships, per `ARCHITECTURE.md`'s own "For QA" handoff note ("Verify loopback-only binding actually rejects connections from another machine on the same network"). **Still relevant** — now simplified to a single-address bind, but the live manual cross-machine check has still not been performed; carries forward to `/verify`.

---

## Testing Coverage Assessment (original session)

The test suite (`gatoway-core/test/unit/*`, `gatoway-core/test/integration/*`) covers all four capabilities reasonably well at the unit and component-integration level:
- **connection-management:** connection ID uniqueness, state-machine forward-only transitions, disconnect/removal — unit-tested directly against `ConnectionManager`.
- **plugin-authentication:** token generation/matching (including constant-time comparison and non-string/undefined inputs), file permission restriction, Origin allowlist fail-closed behavior, and end-to-end accept/reject over real TCP sockets and real WebSocket upgrades.
- **message-protocol:** envelope encode/decode validation (malformed JSON, wrong types, missing fields), NDJSON framing edge cases (split chunks, `\r\n`, empty lines, multiple messages per chunk), WS single-frame framing.
- **diagnostics-logging:** rotation-under-forced-size-threshold integration test confirms both rotation and retention-limit enforcement.

Gaps identified at the time: no test asserted on the *content* of log calls for the registration/capability-manifest path (how QA-001 went unnoticed); no test covered the IPv6-bind-unavailable scenario (QA-002) or partial re-registration overwriting capabilities (QA-003). All three gaps are now closed — see re-verification session below.

I did not run a live cross-machine connection attempt or a live `netstat`/`lsof` check (matching the developer's own disclosed limitation for a sandboxed environment) — this remains an outstanding manual verification item per `ARCHITECTURE.md`'s "For QA" section, to be picked up in `/verify`.

---

## Review Verdict (original session, superseded below)

**Recommendation:** ⚠️ **Conditional pass** — One Major issue (QA-001) is open, but it is a logging/observability gap, not a functional or security defect: authentication, loopback binding, and the message protocol all behave correctly under test and manual code trace. The architect should decide whether QA-001 blocks this change or can be scheduled as an immediate follow-up fix before the Stream Deck plugin / Lightroom integration changes build on top of it, since native (TCP) registration logging is exactly what the next delivery-sequence step will depend on for debugging.

---
---

# Re-verification Session — 2026-07-13

**Reviewer:** QA Engineer
**Scope:** Re-review of commit `a8acacc` ("gatoway-core-foundation: fix QA-001/002/003, document QA-004 fast path") against the original findings above, the amended `ARCHITECTURE.md` (v1.1), amended `design.md`/`proposal.md`/`tasks.md`, and the amended `connection-management` spec. Diff reviewed: `git diff 8739eec a8acacc`. Full test suite and typecheck re-run on the current working tree (branch `gatoway-core-foundation`, HEAD `a8acacc`).
**Prepared for:** Technical Architect

## Summary

All four previously-open findings are resolved as claimed by the developer, and nothing else appears to have regressed. The fixes are precise, the amended `ARCHITECTURE.md`/`design.md`/spec text is internally consistent with the code, and each fix carries its own targeted new unit/integration test. The full suite (50 tests, up from 46) passes, and `tsc --noEmit` is clean. This change is ready to move forward; the three carry-forward Observations are non-blocking and unchanged from the original review.

## Per-finding re-verification

**QA-001 (Major) — Resolved.** `handleRegister`'s success path in `messageHandler.ts` now includes `pluginType` and `capabilities` on the `authentication_succeeded` log event (the first-registration/TCP-credential-validating path, lines ~143-152), and the pre-existing "already authenticated" `registered` event (lines ~96-105) now also includes `capabilities` alongside the `pluginType` it already logged. I traced both code paths directly: for TCP, `authentication_succeeded` now carries the full manifest; for WebSocket (`preAuthenticated`), the generic `message_received` block still logs the full payload as before, and the subsequent `registered` event now also carries `capabilities`. Both transports now produce equivalent registration detail, closing the asymmetry. Two new unit tests (`messageHandler.test.ts`) assert directly on the logged `pluginType`/`capabilities` fields for both the TCP and WebSocket paths — closing the exact test gap the original finding identified (no test previously asserted on log call content).

**QA-002 (Minor, design-level) — Resolved.** `ARCHITECTURE.md` AD-4 is amended to v1.1, explicitly documenting the IPv4-only decision and its rationale (referencing this QA finding by ID). `design.md` D2 and the `connection-management` spec's "Loopback-Only Network Binding" requirement are updated to match. `tcpListener.ts` and `wsListener.ts` no longer construct two servers via `Promise.all` over `["127.0.0.1", "::1"]`; each now binds a single `net`/`http` server to a single `LOOPBACK_ADDRESS = "127.0.0.1"` constant, and `close()` is simplified accordingly (WebSocket's `close()` still correctly closes both the HTTP server and the `WebSocketServer`). I grepped the full `src/` tree for stale `::1`/dual-address references and found none — `config.ts`'s comments were also updated. The failure mode described in the original finding (entire startup aborting if IPv6 loopback bind fails) is eliminated by construction, since there is now only one bind to fail. The integration tests for both listeners were updated to assert a single `127.0.0.1` bind instead of two addresses, and still assert `0.0.0.0`/`::` are never bound. This is correctly flagged by the developer as a design-level fix (root cause: the original design required both addresses; the amendment revises AD-4 itself, not just the code) and was properly routed through an `ARCHITECTURE.md` amendment rather than a silent code-only patch.

**QA-003 (Minor) — Resolved.** `handleRegister` now computes `capabilities` as `Array.isArray(payload.capabilities) ? payload.capabilities : (connection.capabilities ?? [])` — an omitted field now falls back to the connection's previously-recorded manifest (`undefined` on first registration, correctly defaulting to `[]` via `??`), while an explicit array (including an explicitly empty one) still replaces it, matching the intended "omission means unchanged, not cleared" semantics described in the fix. `ConnectionRecord.capabilities` is a plain optional field with no other mutation path, so this reads correctly. Two new unit tests confirm: (a) a re-registration omitting `capabilities` preserves the prior manifest, and (b) a re-registration with an explicit `[]` still clears it — both edge cases the original finding raised are now directly tested.

**QA-004 (Question) — Resolved.** The `connection-management` spec's "Connection Lifecycle State Tracking" section now has two scenarios instead of one: "New connection starts unauthenticated" is narrowed to explicitly say "a new **TCP** connection," and a new "WebSocket connection takes a pre-authenticated fast path" scenario documents the atomic `connected -> authenticating -> authenticated` transition at accept time, explicitly cross-referencing `design.md` D5 and stating a WS connection is never externally observable in a not-yet-authenticated state. This text now accurately reflects `connectionManager.ts`'s actual behavior (`accept()`'s `preAuthenticated` branch) for both transports, closing the spec/code divergence the original finding raised. No code change was needed or made for this item, consistent with the original finding being a spec-completeness gap rather than a code defect.

## Regression check

- Ran `npm test` in `gatoway-core/`: **50/50 tests passing** across 11 test files (up from 46 in the original review; the 4 new tests are the QA-001/QA-003-targeted assertions described above). No failures, no skipped tests.
- Ran `npx tsc --noEmit -p tsconfig.json`: **clean, zero errors.**
- Reviewed the full diff (`git diff 8739eec a8acacc`) line by line rather than just the four touched areas; changes are confined to `ARCHITECTURE.md`, `config.ts` (comment-only), `messageHandler.ts`, `tcpListener.ts`, `wsListener.ts`, their integration/unit tests, and the OpenSpec `design.md`/`proposal.md`/`tasks.md`/spec files. No unrelated files (`token.ts`, `index.ts`, `originAllowlist.ts`, envelope/framing code, logger) were touched, and a grep confirmed no stale references to the old dual-address binding remain anywhere in `src/`.
- No new Critical/Major/Minor issues were found during this re-review. The fixes are narrowly scoped to their target issues and do not introduce new logic paths beyond what's covered by the new tests.

## Observations carried forward

All three Observations from the original review still stand, unchanged, since none were in scope for this fix cycle:
- `wsListener.ts` `authentication_succeeded` log still omits the matched `origin` (asymmetric with `authentication_failed`, which includes it).
- `token.ts`'s Windows ACL-restriction-after-write window remains unverified on a real Windows machine (developer-disclosed limitation, unchanged).
- `index.ts` still logs-and-continues rather than aborting if `writeTokenFile` fails at startup (deliberate trade-off, unchanged).
- The live cross-machine/`netstat` manual verification of loopback-only binding (per `ARCHITECTURE.md`'s "For QA" note) has still not been performed in this sandboxed environment; it remains an open item for `/verify`, and now applies to a simpler single-address bind than before.

None of these block a Pass; the architect may choose to schedule any of them for a future cycle.

## Final Review Verdict

**Recommendation:** ✅ **Pass** — All four previously-open findings (1 Major, 2 Minor, 1 Question) are confirmed resolved by direct code/spec inspection and by 4 new targeted tests. The full suite (50 tests) passes and the typecheck is clean. No new issues were found during this re-review. The three carried-forward Observations are non-blocking and were already known. This change is ready for `/verify` (interactive testing, including the still-outstanding manual cross-machine loopback check) and, following that, `doc-writer` and archival.

---
---

# Interactive Verification Session (`/verify`) — 2026-07-13

**Reviewer:** QA Engineer (interactive, with user)
**Scope:** Hands-on execution of Gatoway core (branch `gatoway-core-foundation`, HEAD `a8acacc`) — starting it as a standalone process the way a real operator would, then exercising loopback binding, authentication, and logging live.
**Prepared for:** Technical Architect

## Summary

Interactive testing surfaced one new **Critical**, code-level finding that neither the automated test suite nor either static review pass caught: Gatoway core silently fails to start at all when launched via its own documented standalone entry point (`npm run dev`, and by extension `node dist/index.js`), in this project's actual real-world path. It exits cleanly with no error, no listeners, and no log output whatsoever. This blocks further live verification of the running system (loopback binding, TCP/WS auth, logging) via the intended launch path, so the remaining planned checks are deferred until it's fixed.

## Issue Log

| ID | Severity | Location | Description | Status |
|----|----------|----------|-------------|--------|
| QA-005 | Critical | `gatoway-core/src/index.ts:119-127` | The standalone-invocation guard's string-equality check between `import.meta.url` and `file://${process.argv[1]}` fails whenever the path needs URL-encoding (e.g. contains spaces), so Gatoway core silently no-ops instead of starting | Open |

## Issue Detail

### QA-005 · Critical · `gatoway-core/src/index.ts:119-127`

**What:** The direct-invocation guard:
```ts
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  startGatowayCore().catch((err) => { ... });
}
```
compares `import.meta.url` (a properly percent-encoded `file://` URL) against a naively concatenated string that is never encoded.

**Scenario:** Any path containing characters that require URL-encoding in a `file://` URL — most commonly spaces — causes the two sides of the comparison to never match, so `invokedDirectly` evaluates `false` and `startGatowayCore()` is never invoked when the module is executed directly (e.g. via `npm run dev`, `tsx src/index.ts`, or `node dist/index.js`).

**Evidence:** Reproduced live in this project's actual directory (`/path with spaces/Gatoway/gatoway-core`, whose ancestor path contains spaces):
```
argv1= /path with spaces/Gatoway/gatoway-core/debugcheck.ts
metaurl= file:///path%20with%20spaces/Gatoway/gatoway-core/debugcheck.ts
constructed= file:///path with spaces/Gatoway/gatoway-core/debugcheck.ts
match= false
```
Running `npm run dev` for real in this project produced no listening sockets (confirmed via `lsof -nP -iTCP -sTCP:LISTEN`), no log file in the configured log directory (confirmed with the user directly — the directory remained empty), and no output of any kind on stdout/stderr. The process simply exited.

**Impact:** `design.md`'s own Non-Goal states "this change only needs Gatoway core to be runnable as a standalone process" — that does not hold in this project's real environment. Anyone launching Gatoway core from a path containing a space (not an exotic condition — it's this project's actual location) gets a completely silent no-op instead of a running service, with no signal anywhere explaining why. This also puts the next delivery-sequence step at risk (the Stream Deck plugin spawning Gatoway core as a child process per `ARCHITECTURE.md` AD-1), if that plugin's install path has similar characters, and would be very difficult to diagnose from outside since nothing is logged or printed.

**Suggested fix direction:** The outcome needed is a direct-invocation check robust to path-encoding differences (and ideally other normalization mismatches, e.g. symlinked temp directories) — not necessarily this exact comparison approach. The developer should pick the mechanism; the requirement is only that Gatoway core reliably starts — or, failing that, reliably reports a clear, visible error — when launched the way its own `package.json` scripts document.

**Root-cause level:** Code. `design.md`'s Non-Goal about standalone runnability is correct as written; the implementation simply doesn't deliver it in the actual environment.

## Verification Checks Not Yet Completed

Blocked by QA-005 until Gatoway core can actually be started via its documented entry point:
- Live confirmation (via `lsof`/`netstat`, observed together with the user) that the TCP and WebSocket listeners are bound only to `127.0.0.1` and unreachable from any other interface.
- Live exercise of the manual TCP test client (`npm run manual:tcp-client`) — valid-token accept and invalid-token reject, observed together with the user.
- Live exercise of the manual WebSocket test client (`npm run manual:ws-client`) — allowlisted-origin accept and non-allowlisted-origin reject, observed together with the user.
- Live inspection of the rotating log file's actual content for a real session (connection lifecycle, auth outcomes, message detail).

## Observations

No new Observations from this session beyond those already carried forward from the prior two sessions (see above) — this session did not get far enough to reach them.

## Review Verdict (this session)

**Recommendation:** ❌ **Requires fixes** — QA-005 is Critical and blocks all further live verification via the standalone entry point. The main agent should route QA-005 to the `developer` subagent as a code-level fix; once fixed, resume `/verify` to complete the checks listed above.

---
---

# Interactive Verification Session (`/verify`, resumed) — 2026-07-13

**Reviewer:** QA Engineer (interactive, with user)
**Scope:** Resuming the prior session after the developer's fix for QA-005 (commit `490eeb7`). Completing the four checks left blocked above.
**Prepared for:** Technical Architect

## Summary

QA-005 is confirmed fixed: Gatoway core now starts correctly via `npm run dev` from this project's real (space-containing) path. With that unblocked, all four previously-deferred live checks were completed together with the user and all passed. No new issues found.

## Checks Completed

- **Loopback-only binding:** started Gatoway core live; `lsof -nP -iTCP -sTCP:LISTEN` and `netstat -an -p tcp` both showed only `127.0.0.1:47821` and `127.0.0.1:47822` — no `0.0.0.0`/wildcard binding on either listener. User confirmed the same output.
- **TCP token auth, live:** ran `npm run manual:tcp-client` against the running instance. Valid token → `register_ack` with `status:"ok"`. Invalid token → `register_ack` with `status:"rejected", reason:"invalid_token"`, connection closed. Matches `plugin-authentication` spec scenarios exactly.
- **WebSocket Origin auth, live:** ran `npm run manual:ws-client`. Allowlisted origin → upgrade accepted, `register_ack` `status:"ok"`. Non-allowlisted origin → upgrade refused outright with HTTP 403 (no connection ever established, matching the spec's "refuses the upgrade request" wording precisely, not merely accept-then-close).
- **Log content, live:** inspected the actual rotating log file after both exercises. Every event was present and correctly detailed: `gatoway_core_started`, `connection_accepted`/`connection_authenticated`/`authentication_succeeded` (TCP, with `pluginType`/`capabilities` — confirming QA-001's fix holds under a real run, not just tests), `message_sent` (register_ack), `connection_disconnected`, and for WebSocket the equivalent sequence plus `message_received`/`registered` with capabilities, and `authentication_failed` for the rejected origin (including the offending `origin` value).
- Stopped the live instance afterward; confirmed via `lsof` that both ports were released.

## Observations

No new Observations. The three Observations carried forward from the static review sessions still stand (unchanged, non-blocking): WS `authentication_succeeded` omits `origin` (asymmetric with `authentication_failed`); Windows ACL path for the token file remains unverified on real Windows; `index.ts` logs-and-continues rather than aborting if the token file write fails.

## Final Review Verdict

**Recommendation:** ✅ **Pass** — QA-005 is fixed and verified live. All planned `/verify` checks (loopback-only binding, TCP token auth accept/reject, WebSocket Origin auth accept/reject, live log content) passed under direct, hands-on observation with the user, using the real standalone entry point rather than only the automated test suite. No open Critical/Major/Minor issues remain. This change is ready for `doc-writer` and `/opsx:archive`.

---
---

# Static Review Session — 2026-07-13 — `stream-deck-plugin-skeleton`

**Reviewer:** QA Engineer
**Scope:** Static review of the OpenSpec change `stream-deck-plugin-skeleton` (branch `stream-deck-plugin-skeleton`, HEAD `299542f`) — the new `stream-deck-plugin/` package (child-process supervision of Gatoway core, a from-scratch NDJSON TCP client, and static idle-key rendering via the Elgato Stream Deck SDK), the small regression fix to `gatoway-core/test/integration/cliEntrypoint.test.ts`, and the new root-level npm-workspaces layout. Reviewed against `proposal.md`, `design.md`, the three new capability specs (`stream-deck-core-lifecycle`, `stream-deck-core-client`, `stream-deck-idle-display`), `tasks.md`, `REQUIREMENTS.md` v1.1, and `ARCHITECTURE.md` v1.1.
**Prepared for:** Technical Architect

## Summary

The three areas this review was specifically asked to scrutinise are all sound. `design.md` D2's requirement that Gatoway core is spawned as a genuine OS child process, located via `require.resolve` rather than a hand-built path, is implemented correctly (`locateCoreEntryPoint.ts` + `coreProcessSupervisor.ts`'s real `child_process.spawn`), and directly avoids `gatoway-core-foundation`'s QA-005-class bug. The plugin's independent NDJSON encoder/decoder (`coreClient/protocol.ts`) is a byte-for-byte faithful reimplementation of `gatoway-core`'s actual wire format (`tcpFraming.ts`/`envelope.ts`) — same line-termination, same `\r\n`/empty-line handling, same envelope shape — and it correctly imports `gatoway-core`'s exported `GatowayMessage`/`RegisterPayload`/`RegisterAckPayload` types rather than guessing the shape. The restart/backoff logic (`backoff.ts`, `coreProcessSupervisor.ts`) is exponential with a sensible cap and a stability-reset window, so a genuinely crash-looping core cannot produce a restart storm, and no failure path (spawn-locate failure, spawn-throw failure, child `error`, child `exit`) is left unlogged. Task 5.3's deferral (manual hardware verification) is exactly what it claims to be — expected, not a defect — and is appropriately handed to `/verify`. The full test suite (52 + 27 = 79 tests) passes and both packages type-check clean.

However, this review surfaced one new **Major**, code-level issue the manual-hardware deferral masked: **the plugin's build never produces the file its own `manifest.json` says it will run.** `manifest.json` declares `"CodePath": "bin/plugin.js"` (resolved by the real Stream Deck application relative to the `com.gatoway.streamdeck.sdPlugin/` folder), and the package's own `.gitignore` explicitly expects `com.gatoway.streamdeck.sdPlugin/bin/` to be a generated build-output directory — but no script anywhere in this change (`stream-deck-plugin/package.json`, the root `package.json`, or any bundler config) ever copies or bundles the TypeScript build's actual output (`stream-deck-plugin/dist/plugin.js`) into that location. I confirmed this by actually running the build: `com.gatoway.streamdeck.sdPlugin/bin/` does not exist anywhere in the tree, before or after `npm run build`. This is not the same gap as task 5.3's deferred hardware check — it isn't merely "no device to test on," it's that the artifact the Stream Deck application would look for is never produced at all, so the single physical-hardware-visible milestone this entire change exists to deliver (per `proposal.md`'s own "Impact" section) is currently unreachable even with real hardware in hand. See QA-006.

Two further Minor findings and a couple of non-blocking Observations round out the review; none of these, nor QA-006, touch the three specifically-flagged design/protocol/backoff areas, all of which check out cleanly.

---

## Issue Log

| ID | Severity | Location | Description | Status |
|----|----------|----------|-------------|--------|
| QA-006 | Major | `stream-deck-plugin/package.json`, `com.gatoway.streamdeck.sdPlugin/manifest.json` | No build step produces `com.gatoway.streamdeck.sdPlugin/bin/plugin.js`, the exact file `manifest.json`'s `CodePath` points to — the plugin cannot be loaded by the real Stream Deck application as currently built. | Open |
| QA-007 | Minor | `stream-deck-plugin/src/coreClient/coreClient.ts:112-123`, `src/plugin.ts:15-30` | The plugin starts `CoreClient` immediately after `CoreProcessSupervisor.start()` returns, before the just-spawned Gatoway core has had time to write its token file or open its listener; the client's very first attempt therefore logs at `error` level for what is, in normal operation, an expected and harmless startup race — indistinguishable in the log from a genuine failure. | Open |
| QA-008 | Minor | `openspec/changes/stream-deck-plugin-skeleton/tasks.md:34` | Task 5.3's note claims "4.3 is covered by a unit test asserting no `onKeyDown` handler exists," but no test file in the suite references `IdleAction`, `IDLE_ACTION_UUID`, or `onKeyDown` at all — the claimed test does not exist. | Open |

**Status values:**
- `Open` — not yet fixed; needs architect attention
- `Resolved in review` — fixed or clarified during the review conversation
- `Deferred` — acknowledged, decision made to address in a later cycle

---

## Issue Detail

### QA-006 · Major · `stream-deck-plugin/package.json`, `com.gatoway.streamdeck.sdPlugin/manifest.json`

**What:** `com.gatoway.streamdeck.sdPlugin/manifest.json` declares:
```json
"CodePath": "bin/plugin.js",
```
The Stream Deck application resolves `CodePath` relative to the `.sdPlugin` bundle folder itself (confirmed against `@elgato/schemas`' own manifest schema, whose description for `CodePath` is "Path to the plugin's main entry point... String must reference file in the plugin directory"). `stream-deck-plugin/.gitignore` (added in this change) explicitly ignores `com.gatoway.streamdeck.sdPlugin/bin/`, showing the developer's own intent that this be a generated build-output directory. But `stream-deck-plugin/package.json`'s only build script is `"build": "tsc -p tsconfig.json"`, and `tsconfig.json` sets `"outDir": "dist"` — so the TypeScript build's actual output lands at `stream-deck-plugin/dist/plugin.js`, never at `com.gatoway.streamdeck.sdPlugin/bin/plugin.js`. No other script, in this package or the root `package.json`, copies or bundles anything into the `.sdPlugin/bin/` directory.

**Scenario:** A developer follows this project's own documented workflow — `npm install` at the root, then `npm run build` — and then tries to add the Gatoway plugin to a Stream Deck profile (the exact next step `proposal.md`'s "Impact" section describes: "a developer can plug in a Stream Deck, launch this plugin, and see Gatoway core come up and an idle profile appear").

**Evidence:** Reproduced directly in this project's checkout:
```
$ ls stream-deck-plugin/com.gatoway.streamdeck.sdPlugin/
imgs  manifest.json          # no bin/ directory
$ npm run build --workspace=stream-deck-plugin
> tsc -p tsconfig.json        # succeeds, no errors
$ ls stream-deck-plugin/dist/
plugin.js  plugin.d.ts  ...   # build output lands here, not in .sdPlugin/bin
$ ls stream-deck-plugin/com.gatoway.streamdeck.sdPlugin/
imgs  manifest.json          # still no bin/ directory after a successful build
```
The official Elgato Stream Deck SDK scaffold (`streamdeck create`, documented in `@elgato/streamdeck`'s own README, which ships in `node_modules`) produces a `rollup.config.mjs` specifically to bundle `src/plugin.ts` directly into `<uuid>.sdPlugin/bin/plugin.js`; this project has no equivalent config or script anywhere.

**Impact:** As built, the plugin cannot actually be installed/loaded by the real Stream Deck application at all — `CodePath` points at a file that is never produced. This isn't the same limitation task 5.3 already (correctly) deferred to `/verify` ("no physical/emulated Stream Deck hardware in this sandboxed environment"); even once real hardware is available, `/verify` will hit this same wall immediately, because there is no build artifact to load in the first place. This directly undercuts the change's own stated purpose (`proposal.md`: "the first end-to-end proof the foundation actually works outside of tests") and blocks `ARCHITECTURE.md`'s Delivery Sequence step 3 (Lightroom integration), which per its own text depends on "a running Stream Deck plugin to validate against."

**Suggested fix direction:** The outcome needed is that after a normal `npm run build`, `com.gatoway.streamdeck.sdPlugin/bin/plugin.js` (or whatever file `CodePath` ultimately names) exists and is runnable by the Stream Deck application — via a bundler step (e.g. adopting the SDK's own rollup-based convention) or a simpler copy step, whichever the developer judges more maintainable given this project's existing `tsc`-only build. Not prescribing the mechanism; the requirement is only that the manifest's `CodePath` resolves to a real, current file after the documented build.

**Root-cause level:** Code. `design.md` D5 explicitly left "exact... manifest conventions" for the developer to confirm against the SDK's current documentation — the manifest's shape is fine, but the packaging/build wiring the SDK's own conventions require to make that manifest usable was never completed.

---

### QA-007 · Minor · `stream-deck-plugin/src/coreClient/coreClient.ts`, `src/plugin.ts`

**What:** `plugin.ts` calls `supervisor.start()` (which spawns the Gatoway core child process and returns immediately — the child itself is still just beginning to boot) and then, on the very next line, `coreClient.start()`, which immediately tries to read the core's token file and open a TCP connection. `CoreClient.connectOnce()`'s token-read failure path logs at `logger.error` (`"failed to read Gatoway core's auth token file; will retry"`, `event: "core_client_token_read_failed"`), and its connect-failure path also logs at `logger.error` (`event: "core_client_connect_failed"`).

**Scenario:** Every normal plugin startup — not an edge case. The freshly-spawned Gatoway core process needs measurable time to start Node, generate and write its token file, and bind its TCP listener; the client's first attempt races this and will typically lose, at least on a cold start.

**Evidence:** No test in this change exercises the real end-to-end startup sequence (`plugin.ts`'s actual `supervisor.start()` immediately followed by `coreClient.start()`) against a genuinely freshly-spawned core process; `coreClient.integration.test.ts` always starts a fully-running `startGatowayCore()` instance *before* constructing/starting the `CoreClient` under test, so it never exercises this specific race. Tracing the code directly: on a cold start, `readToken` will almost always hit `ENOENT` (or the connect will hit `ECONNREFUSED`) on the very first attempt, before the core process has had time to write the token file / bind the port, and this is logged at `error` level every time, indistinguishable from a genuine problem (e.g. a permissions failure or a corrupted token file).

**Impact:** Every normal startup produces at least one `error`-level log line for a condition that isn't actually an error — it's an expected, harmless race the retry/backoff logic already handles correctly. This works against `REQUIREMENTS.md` FR-006's intent (detailed logging *for troubleshooting*): a log file where "everything looks like an error, always" trains whoever reads it to ignore `error`-level entries, which is exactly the failure mode `gatoway-core-foundation`'s QA-001 (transport-asymmetric logging) was concerned with from the other direction.

**Suggested fix direction:** The outcome needed is that a log reader can tell "still waiting for Gatoway core to finish starting" apart from "something is actually wrong" — e.g. logging the first attempt(s) at a lower level and only escalating to `warn`/`error` after some number of consecutive failures, or after Gatoway core's own `gatoway_core_started` signal was expected but never arrived. Not prescribing the exact mechanism.

**Root-cause level:** Code (log-level choice); no spec currently mandates a specific level for this path, so this is a quality/observability gap rather than a spec violation.

---

### QA-008 · Minor · `openspec/changes/stream-deck-plugin-skeleton/tasks.md:34`

**What:** Task 5.3's note reads, in part: "Code-level equivalents were checked: 4.3 is covered by a unit test asserting no `onKeyDown` handler exists." I searched the entire `stream-deck-plugin/test/` tree for any reference to `IdleAction`, `IDLE_ACTION_UUID`, or `onKeyDown`; there are none. The only test touching the idle key's behaviour (`test/unit/idleKeyRenderer.test.ts`) exercises the extracted `renderIdleKey` function against a fake `IdleKeyLike`, asserting `setTitle` is/isn't called — it says nothing about the absence of a key-down handler, and never imports `idleAction.ts` at all.

**Scenario:** A future reader (architect, QA, or another developer) relies on `tasks.md`'s own claim to conclude automated coverage exists for "no dynamic key behavior" (the `stream-deck-idle-display` spec's explicit requirement) and doesn't re-check it.

**Evidence:** `grep -rn "onKeyDown\|IdleAction\|IDLE_ACTION_UUID" stream-deck-plugin/test` returns no matches. The actual guarantee that pressing the idle key sends no command rests entirely on `idleAction.ts` simply never defining an `onKeyDown` method (true by inspection today), with no regression test to catch a future change accidentally adding one.

**Impact:** Low on its own — the underlying behavior (no `onKeyDown` handler) is correct today, confirmed by direct code reading. But the tracked-task claim overstates the actual verification that was done, and there is a real (if narrow) regression gap: nothing would fail if a future edit to `idleAction.ts` added an `onKeyDown` handler that violated the `stream-deck-idle-display` spec's "No dynamic key behavior" scenario.

**Suggested fix direction:** Either add the test `tasks.md` already claims exists (e.g. asserting `"onKeyDown" in new IdleAction()` is `false`, or an equivalent structural check that doesn't require the decorator-under-vitest workaround), or correct the task note to accurately describe what was actually verified.

**Root-cause level:** Code/process — an inaccurate self-reported coverage claim in `tasks.md`, not a functional defect in the shipped behavior.

---

## Areas Specifically Verified (per review scope)

- **D2 — genuine child process via `require.resolve`:** Confirmed. `locateCoreEntryPoint.ts` resolves `@gatoway/core/dist/index.js` via `createRequire(...).resolve(...)`, with no hand-built path/URL string anywhere in the lookup. `coreProcessSupervisor.ts`'s `defaultSpawnChild` calls Node's real `spawn(process.execPath, [entryPointPath], ...)` — a genuine OS child process, not an in-process call to `startGatowayCore()`. `coreProcessSupervisor.integration.test.ts` proves this with an actual spawned Node process (a temp `.mjs` script) that is observed to run and restart for real, not through a mock.
- **NDJSON protocol correctness:** Confirmed against `gatoway-core`'s actual source. `stream-deck-plugin/src/coreClient/protocol.ts`'s `encodeNdjsonLine`/`NdjsonLineDecoder` implement the identical algorithm to `gatoway-core/src/protocol/tcpFraming.ts`'s `encodeNdjsonLine`/`NdjsonDecoder` (same `\n` terminator, same `\r`-stripping, same empty-line skipping, same incremental-buffer approach), and the plugin correctly imports (rather than redeclares) `GatowayMessage`, `RegisterPayload`, and `RegisterAckPayload` from `@gatoway/core`'s public exports (`gatoway-core/src/index.ts`), so there's no risk of the plugin's local type shapes silently drifting from the real payload contracts. `coreClient.integration.test.ts` proves the whole handshake end-to-end against a real, running `startGatowayCore()` instance (real TCP socket, real token file), including a token-rejection-then-retry-then-success path.
- **Restart/backoff soundness:** Confirmed. `backoff.ts`'s `nextBackoffDelayMs` is a pure exponential-backoff function (1s initial, doubling, capped at 30s), shared by both the process supervisor and the TCP client. `coreProcessSupervisor.ts` resets the attempt counter only after `stableAfterMs` (60s) of uptime, so a genuinely crash-looping core process asymptotically settles at retrying every 30 seconds rather than spinning tightly — no restart storm under any traced failure path. Every failure path is logged: entry-point-not-found, spawn-threw, child `error`, child `exit` (both planned-shutdown and unexpected-exit branches). The one theoretical gap I could construct — Node emitting a child `error` event without a subsequent `exit` event, which would leave the supervisor permanently stalled with no restart scheduled — has no realistic path to occurring here, since the child command is always `process.execPath` (the currently-running Node binary), which cannot itself be missing; noting this only for completeness, not as a finding.
- **Task 5.3 deferral:** Confirmed appropriate, not a defect. The note in `tasks.md` is honest about the limitation (no physical/emulated Stream Deck device in this sandboxed environment) and correctly identifies what code-level equivalents were and weren't covered — modulo the QA-008 inaccuracy above regarding the specific `onKeyDown` claim. This deferral is exactly the kind of check `/verify` exists for.
- **`REQUIREMENTS.md` v1.1 platform clarification:** Confirmed consistent. `manifest.json`'s `"OS"` array lists only `mac` and `windows` (no Linux entry), matching NFR 3.4's clarification that the Stream Deck plugin is Windows/Mac-only due to the vendor's own lack of a Linux build, while `gatoway-core` itself remains untouched by this change and so remains portable to Linux as before.
- **Regression fix (`cliEntrypoint.test.ts`):** Confirmed correct and consistent with the rest of this change's approach. The prior hardcoded `node_modules/.bin/tsx` path broke once npm workspace hoisting (introduced by this same change) moved `tsx` to the repo root; the fix resolves `tsx/cli` via `require.resolve` and invokes it via `process.execPath`, mirroring the same "resolve via module resolution, not a hand-built path" principle `locateCoreEntryPoint.ts` uses, and is portable to Windows (no reliance on the `.bin` shebang shim). The full `gatoway-core` suite (52/52, including this test) still passes.

---

## Observations

- `stream-deck-plugin/src/coreClient/coreClient.ts:210-217` — a rejected registration produces three separate, slightly overlapping log lines for what is conceptually one event: `core_client_registration_rejected` (with the actual rejection `reason`) from `handleMessage`, then `core_client_disconnected` ("connection to Gatoway core closed before registering" — technically accurate but reads oddly given registration was in fact attempted and explicitly rejected, not merely interrupted) from the `close` handler, then `core_client_retry_scheduled` from `scheduleRetry()`. Not incorrect, just verbose/slightly confusing to a log reader piecing together what happened; the architect may or may not consider this worth consolidating.
- `stream-deck-plugin/package.json` pins `"typescript": "^7.0.2"` — consistent with `gatoway-core/package.json`'s own pin (pre-existing from `gatoway-core-foundation`, already installed and used successfully here), not a new issue introduced by this change; noting only for the architect's awareness since it's an unusually early major version.

---

## Testing Coverage Assessment

`stream-deck-plugin`'s test suite (27 tests across 8 files) covers what's testable without physical hardware, and does so well:
- **`stream-deck-core-lifecycle`:** unit tests (mocked `spawn`/`scheduleRestart`/`backoffMs`) cover spawn-on-start, restart-after-unexpected-exit with backoff, exit-reason logging, no-restart-after-intentional-stop, and both spawn-failure modes (entry point not located, spawn itself throws) reporting visibly rather than silently. A separate integration test spawns a genuine temporary Node script as a real child process and confirms real restart-with-backoff and real stop-suppresses-restart behavior — exactly matching `design.md`'s stated approach of following `gatoway-core-foundation`'s `cliEntrypoint.test.ts` precedent.
- **`stream-deck-core-client`:** unit tests (mocked socket/backoff) cover the register/token-presenting handshake, `status:"ok"` handling, rejection-then-retry, and disconnect-then-retry. A separate integration test exercises the same logic against a real, running `startGatowayCore()` instance over a real TCP socket, including a realistic stale-token-then-real-token retry sequence.
- **`stream-deck-idle-display`:** `renderIdleKey`'s title-setting behavior is unit tested for both key and non-key (dial) instances. As QA-008 notes, the "no dynamic key behavior" scenario is verified only by code inspection (absence of an `onKeyDown` method), not by an automated test, despite `tasks.md`'s claim to the contrary.
- **Config resolution (`config.ts`) and backoff calculation (`backoff.ts`):** both fully unit tested, including edge cases (non-numeric env override, sub-1 attempt numbers, delay capping).

Gaps: no test exercises the real end-to-end startup race between `supervisor.start()` and `coreClient.start()` as `plugin.ts` actually sequences them (see QA-007); no test guards the "no `onKeyDown` handler" requirement (QA-008); and — as `design.md`'s own Risks section already anticipates and defers to `/verify` — nothing in this suite can confirm actual on-device rendering, which requires physical or emulated Stream Deck hardware and is out of scope for static review.

---

## Review Verdict

**Recommendation:** ❌ **Requires fixes** — QA-006 is a Major, code-level issue that blocks this change's core deliverable (an installable, hardware-loadable Stream Deck plugin) even independent of the hardware-availability limitation `tasks.md` already and correctly deferred to `/verify`. The three specifically-flagged review areas (D2 child-process spawning, the independent NDJSON protocol implementation, and restart/backoff soundness) are all sound and need no changes. QA-007 and QA-008 are Minor and do not block progress on their own; the architect may bundle their fixes with QA-006's or schedule them separately. Once QA-006 is fixed, this change should return to static review only for that fix (a narrow, easily re-verified change) before proceeding to `/verify` with real or emulated hardware.

---
---

# Re-verification Session — 2026-07-14 — `stream-deck-plugin-skeleton` (QA-006/007/008)

**Reviewer:** QA Engineer
**Scope:** Re-review of commit `1af83c5` ("stream-deck-plugin-skeleton: fix QA-006/007/008") against the three findings from the prior static review session, `design.md`, and the three capability specs. Diff reviewed: `git show 1af83c5`. Full test suite and typecheck re-run on the current working tree (branch `stream-deck-plugin-skeleton`, HEAD `1af83c5`), plus a genuinely clean-room rebuild for QA-006.
**Prepared for:** Technical Architect

## Summary

All three previously-open findings (QA-006 Major, QA-007 Minor, QA-008 Minor) are confirmed resolved by direct inspection, a from-scratch build, and — for QA-008 — a mutation test proving the new regression test actually catches the regression it claims to guard against. The full suite (52 + 30 = 82 tests, up from 79) passes and both packages type-check clean. No new issues were found. This change is ready to proceed to `/verify` with real or emulated Stream Deck hardware.

## Per-finding re-verification

**QA-006 (Major) — Resolved.** I did not trust the commit message or the pre-existing `com.gatoway.streamdeck.sdPlugin/bin/` directory in the working tree (it predated my review and could have been a stale artifact from an earlier, pre-fix build attempt). I deleted `stream-deck-plugin/com.gatoway.streamdeck.sdPlugin/bin/`, `stream-deck-plugin/dist/`, and `gatoway-core/dist/` entirely, then ran `npm install` and `npm run build` from the repo root in a genuinely clean state. `com.gatoway.streamdeck.sdPlugin/bin/plugin.js` was regenerated by `scripts/packagePlugin.mjs` (invoked as the second step of `stream-deck-plugin`'s `build` script, after `tsc`). I read the generated file directly — it is real, current, compiled ESM JavaScript (not a stub), with import statements matching the actual source (`@elgato/streamdeck`, `./actions/idleAction.js`, `./coreLifecycle/config.js`, etc.). I then confirmed the file is actually loadable from its new location, not just present: a dynamic `import()` of the copied file resolved every one of its imports (bare specifiers `@elgato/streamdeck`/`@gatoway/core` via npm-workspace hoisting up through `com.gatoway.streamdeck.sdPlugin/bin/` → `stream-deck-plugin/` → the repo root's `node_modules`, plus all relative imports) — it only threw once it reached the Stream Deck SDK's own manifest-lookup logic, which is unrelated to this fix (an artifact of invoking via dynamic `import()` rather than as `argv[1]`). I also ran it directly as `node .../bin/plugin.js` (its real invocation form): it started without any module-resolution error and blocked waiting for a Stream Deck host connection, as expected for a plugin run outside the actual application. `manifest.json`'s `CodePath: "bin/plugin.js"` now resolves to a genuine, freshly-built, loadable file after every clean build. One transient false alarm during this verification: my very first `npm run build --workspace=stream-deck-plugin` invocation (run immediately after a fresh `npm install` following the `rm -rf`) failed with a wall of `@types/node`/module-resolution TypeScript errors; re-running the identical command immediately afterward (and a full from-scratch `rm -rf` + `npm install` + `npm run build` repeat) succeeded cleanly both times, and running `tsc` directly from inside `stream-deck-plugin/` also succeeded — this looks like a one-off npm-workspace-linking race on the very first postinstall build rather than a defect in `1af83c5`'s change, but the architect should be aware a first build in a truly fresh checkout may need a retry. Noted as an Observation below rather than a finding against this fix, since it self-resolved and is not attributable to any code this commit touched.

**QA-007 (Minor) — Resolved.** `CoreClient` now records `startedAt = this.now()` in `start()` and routes both failure paths that previously logged unconditionally at `error` (`core_client_token_read_failed`, `core_client_connect_failed`) through a new `logConnectFailure` helper: within `initialGracePeriodMs` (default 5000ms) of `start()`, the failure logs at `info` with an explicit "may still be starting up" qualifier; once elapsed, it escalates to `error` exactly as before. I traced the call sites: both of the original QA-007 evidence's failure points now go through this helper, and no other log statement in the file was touched (the socket-error, disconnect, and rejected-registration paths still log at `warn` as before — unaffected and out of scope for this finding). The grace window is measured from each `start()` call, not from the constructor or from each individual retry attempt, which is the correct semantics — a client that's still failing after 5 real seconds of retries is no longer in the benign "just starting up" state, regardless of how many attempts it's made in that window. Two new unit tests exercise both branches: one asserts `info` (not `error`) is logged for a failure at `now() = 0` with `startedAt = 0`; the other, using a controllable clock and capturing the scheduled-retry callback, advances the clock past the grace period and confirms the *same* failure type now logs at `error`. I ran both tests directly and confirmed they pass, and confirmed (by reading the assertions) that they'd fail under the pre-fix behavior. No spec or `design.md` text mandates a specific log level for this path, so this is a quality/observability improvement, consistent with the original finding's framing — no conflict with any capability spec.

**QA-008 (Minor) — Resolved, and independently verified via mutation testing.** `stream-deck-plugin/test/unit/idleAction.test.ts` now exists, reads `idleAction.ts`'s source directly, strips comments (so the file's own doc-comment mention of "onKeyDown" doesn't produce a false pass), sanity-checks the extraction found `class IdleAction` at all, and asserts no `onKeyDown(` method signature is present. I did not just confirm the test exists and passes — I temporarily added a real `onKeyDown` method to `idleAction.ts` and re-ran this test in isolation: it failed exactly as expected (`expect(withoutComments).not.toMatch(/\bonKeyDown\s*\(/)`), then I restored the original file (verified via `git status` showing a clean tree) and reran it to confirm it passes again. This directly proves the regression test is effective, not merely present. `tasks.md` 5.3's annotation was also corrected to reference this real test by file name and to explain, accurately, why it's a source-structural check rather than a live-instantiation test (Vitest's SSR module runner cannot execute `idleAction.ts`'s native class-decorator syntax — consistent with the pre-existing explanation already documented atop `idleKeyRenderer.ts`).

## Regression check

- Full clean-room rebuild: `rm -rf` on both packages' `dist/` and the `.sdPlugin/bin/` directory, `npm install`, `npm run build` from the repo root — succeeded, produced `com.gatoway.streamdeck.sdPlugin/bin/plugin.js` as described above.
- `npm run typecheck` (both workspaces): clean, zero errors, for both `gatoway-core` and `stream-deck-plugin`.
- `npm test` (both workspaces): **52/52 (`gatoway-core`) + 30/30 (`stream-deck-plugin`) = 82/82 passing**, up from 79 in the prior session (4 new tests added: 2 for QA-007, 1 for QA-008, plus the mutation-tested QA-008 test counted once). No failures, no skipped tests.
- Reviewed the full diff (`git show 1af83c5`) line by line: changes are confined to `tasks.md` (text-only), `stream-deck-plugin/package.json` (one script line), the new `scripts/packagePlugin.mjs`, `coreClient.ts`, and the two new/extended test files. Nothing outside the three targeted areas was touched — the three review areas the prior session specifically verified (D2 child-process spawning, the NDJSON protocol reimplementation, restart/backoff soundness) are untouched by this commit and remain sound.
- No new Critical/Major/Minor issues were found during this re-review.

## Observations

- A first `npm run build` immediately after a fresh `npm install` (following a full `rm -rf` of both packages' build outputs) once produced a wall of spurious TypeScript `@types/node`-not-found errors for `stream-deck-plugin` alone; an immediate retry of the identical command, and a repeat of the entire clean-room sequence, both succeeded without incident, and running `tsc` directly from inside `stream-deck-plugin/` also succeeded on the first try. This looks like a one-off npm-workspace-linking race rather than a defect introduced by `1af83c5` (no file this commit touches affects module resolution or workspace linking), but it's worth the architect's awareness in case a fresh contributor checkout hits it — a documented "if the first build fails, run `npm install` again and retry" note, or root-caused fix, could save future confusion. Not blocking.
- All Observations carried forward from the prior static review session (log-line verbosity on rejected registration; the pinned `typescript@^7.0.2` pre-release) still stand, unchanged and non-blocking — neither was in scope for this fix cycle.

## Final Review Verdict

**Recommendation:** ✅ **Pass** — All three previously-open findings (1 Major, 2 Minor) are confirmed resolved by direct code inspection, a genuine clean-room rebuild (for QA-006), and a mutation test proving the new regression test is effective (for QA-008). The full suite (82 tests) passes and both packages type-check clean. No new issues were found. This change is ready for `/verify` with real or emulated Stream Deck hardware and, following that, `doc-writer` and `/opsx:archive`.

---
---

# Interactive Verification Session (`/verify`) — 2026-07-14

**Reviewer:** QA Engineer (interactive, with user)
**Scope:** Hands-on execution of `stream-deck-plugin-skeleton` (branch `stream-deck-plugin-skeleton`, commit `d792109`) against real Elgato Stream Deck+ hardware and the real Stream Deck desktop application (not emulated).
**Prepared for:** Technical Architect

## Summary

All core behaviors were confirmed live, on real hardware, with the user directly observing the physical device: the plugin loads under the real Stream Deck application, spawns Gatoway core as a genuine child process, connects and registers over TCP, renders its idle key correctly, survives a hard kill of the Gatoway core process with the key display unaffected, automatically restarts Gatoway core and reconnects, and produces no dynamic behavior on key press beyond the hardware's own built-in press animation. One environment/setup gotcha was discovered and resolved during the session (not a code defect). One real gap was found and, after discussion with the user, is being fixed: the plugin's manifest doesn't auto-provision a default profile, so nothing appears on the device until a user manually places the Idle action on a key — the user decided to fix this by adding a default profile.

## Issue Log

| ID | Severity | Location | Description | Status |
|----|----------|----------|-------------|--------|
| QA-009 | Minor | `stream-deck-plugin/com.gatoway.streamdeck.sdPlugin/manifest.json` | Manifest has no `Profiles` entry, so the idle key never appears on the device until manually placed by the user — the `stream-deck-idle-display` spec's "renders... at plugin startup" wording assumes it appears with no manual step | Open |

## Issue Detail

### QA-009 · Minor · `stream-deck-plugin/com.gatoway.streamdeck.sdPlugin/manifest.json`

**What:** Unlike the existing Lightroom plugin's manifest (which declares a `Profiles` array with `"DontAutoSwitchWhenInstalled": false`), Gatoway's manifest declares only an `Actions` entry with no `Profiles` section at all.

**Scenario:** A user links and starts the plugin exactly as documented, expecting the idle profile described in the spec to be visible on their Stream Deck. Nothing appears until they separately discover they need to open the Stream Deck software, find the "Gatoway" category, and manually drag the "Idle" action onto a key themselves.

**Evidence:** Live-verified with the user: after linking, enabling developer mode (see Observations below), and restarting the plugin, the physical device showed nothing until the Idle action was manually dragged onto a key — at which point the icon and title rendered correctly (confirmed by the user).

**Impact:** The `stream-deck-idle-display` spec's requirement ("SHALL render its single static idle profile on the physical Stream Deck hardware at plugin startup") is not literally met without a manual, undocumented setup step. This is a real but low-severity gap — everything works correctly once the action is placed, and this is a one-time setup action, not a recurring problem — but it doesn't match the spec's stated behavior or the existing Lightroom plugin's more polished zero-touch precedent.

**Suggested fix direction:** Discussed directly with the user, who decided: add a `Profiles` entry to `manifest.json` (matching the existing Lightroom plugin's approach for the `DeviceType`/general shape) but with `"DontAutoSwitchWhenInstalled": true` — unlike Lightroom's `false` — so installing/restarting the plugin does not forcibly switch the user's device away from whatever profile they're currently viewing. This is confirmed by the user as the desired resolution, not merely a suggestion.

**Root-cause level:** Code (manifest configuration). `design.md` D5 didn't explicitly decide whether the idle profile should auto-install; this is a straightforward manifest addition consistent with the existing design intent, not a design decision that needs revisiting via `/design-architecture`.

## Checks Completed

- **Real plugin load under real Stream Deck software:** confirmed via `ps aux` showing a genuine Stream-Deck-spawned Node process running `com.gatoway.streamdeck.sdPlugin/bin/plugin.js`, after `streamdeck link` + `streamdeck restart`.
- **Real child-process spawn of Gatoway core:** confirmed via `ps aux` showing `gatoway-core/dist/index.js` running as a distinct process, and via Gatoway core's own log recording `gatoway_core_started`.
- **Real TCP registration:** Gatoway core's log shows `connection_accepted` → `connection_authenticated` → `authentication_succeeded` (`pluginType: "stream-deck"`) → `register_ack` (`status: "ok"`) for a real socket connection from the real plugin process, not a test harness.
- **Idle key rendering:** user confirmed, looking at the physical device, that the icon and "Gatoway" title rendered correctly once the Idle action was placed on a key.
- **Crash resilience, live:** killed the real Gatoway core child process (`kill -9`) while the user watched the physical key. User confirmed the key's display was unaffected — no flash, no blank state — consistent with `stream-deck-idle-display`'s "Idle profile remains shown while disconnected" scenario.
- **Automatic restart and reconnect, live:** confirmed via `ps aux` (new PID) and the plugin's own log file (`com.gatoway.streamdeck.sdPlugin/logs/com.gatoway.streamdeck.0.log`), which recorded the full sequence: `gatoway_core_restarting` (reason: `signal: "SIGKILL"`) → `gatoway_core_spawned` (new PID) → `core_client_connecting` → transient `ECONNREFUSED` while the new process was still starting → retry with backoff → `core_client_connected`.
- **No dynamic key behavior:** user pressed the physical key and, after clarifying the distinction, confirmed the only visible change was the Stream Deck hardware's own standard press-animation — no icon/title change, consistent with `stream-deck-idle-display`'s "No dynamic key behavior" scenario.

## Observations

- **Developer mode is required for locally-linked plugins to load at all**, and this isn't obvious from a code or manifest inspection alone — the Stream Deck application's own log recorded `"Feature only enabled in developer mode"` when a `streamdeck restart` was issued before developer mode was enabled, and the plugin process silently never started (no error surfaced anywhere in Gatoway's own logs, since the plugin process never even launched). This is standard Elgato SDK behavior (`streamdeck dev` enables it), not a Gatoway defect, but it's worth documenting in the eventual README/setup instructions so a future developer (or the user, on a fresh machine) doesn't lose time on it the way this session initially did.
- The three carried-forward Observations from the prior static-review sessions (log-line verbosity nuance, the pinned `typescript@^7.0.2` pre-release, and the one-off clean-room build flake) still stand, unchanged and non-blocking.

## Review Verdict (this session)

**Recommendation:** ⚠️ **Conditional pass** — All core lifecycle, connection, resilience, and rendering behavior is confirmed working correctly on real hardware. One Minor finding (QA-009) is open, with a fix direction already agreed with the user (add a `Profiles` entry with `DontAutoSwitchWhenInstalled: true`). The main agent should route QA-009 to the `developer` subagent, then do a final confirmation pass (re-link and re-check the device) before moving to `doc-writer` and `/opsx:archive`. The developer-mode requirement should be captured in documentation, not fixed in code.

---
---

# QA-009 Fix Attempt and Final Disposition — 2026-07-14

**Reviewer:** QA Engineer (interactive, with user)
**Scope:** Re-checking the developer's QA-009 fix (commit `01dfe90`: added a `Profiles` entry to `manifest.json` and a bundled `Gatoway.streamDeckProfile` with the Idle action pre-placed) live against real hardware.

## Outcome: fix did not achieve auto-install; root cause investigated; user accepted current behavior

After the developer's fix, restarting the plugin against real hardware produced **no visible change** — the user confirmed no new "Gatoway" profile appeared anywhere, including in the profile switcher (not just "didn't force-switch," which would have been the expected effect of `DontAutoSwitchWhenInstalled: true` — nothing registered at all).

Investigated directly against two real reference points already present on this machine:
- **Volume Controller** (a currently-installed, working third-party plugin): its manifest's `Profiles` entries include an `"AutoInstall": false` field neither our manifest nor Lightroom's includes. Inspecting its bundled `.streamDeckProfile` files showed its "(Auto)" profiles are templates the plugin switches to *programmatically* (via an in-profile "Auto Software Detection" action), not profiles that appear automatically on install — so this is not actually a working example of the behavior we wanted.
- **Lightroom's own bundled template** (`profiles/Lightroom.streamDeckProfile`): has the same empty `Device.Model`/`Device.UUID` fields as our fix. The real, currently-active "Lrc" profile the user actually uses day-to-day was found under Stream Deck's own profile storage with a populated `Device.Model` — consistent with it having been created manually by the user within the Stream Deck software, not auto-installed from that bundled template.

**Conclusion:** neither existing plugin in this codebase is a confirmed working example of zero-touch profile auto-installation. Determining the actual mechanism (there may be an `AutoInstall: true` field or a different convention entirely) would require authoritative Elgato SDK documentation not accessible in this session, rather than further guess-and-check against undocumented behavior.

**Discussed directly with the user, who decided:** accept manual placement (already confirmed working correctly in the original `/verify` session — icon and title render properly once the Idle action is dragged onto a key) as the current behavior, and explicitly **defer** true auto-install to a future change rather than continue investigating now.

## Follow-up Actions (routed to developer)

Since the `Profiles`/bundled-`.streamDeckProfile` addition doesn't deliver its intended effect and isn't confirmed to work, it should be **reverted** rather than left in the tree as non-functional scaffolding that could mislead a future reader into thinking auto-install is implemented:
- Revert `manifest.json`'s `Profiles` entry and remove the bundled `Gatoway.streamDeckProfile` file added in commit `01dfe90`, restoring the plain `Actions`-only manifest that was confirmed working for manual placement.
- Correct the `stream-deck-idle-display` spec's wording (currently "SHALL render its single static idle profile... at plugin startup") to accurately describe that the idle key is shown once manually placed on a key by the user, and persists across Gatoway core disconnects/restarts thereafter — matching what was actually verified live, rather than implying zero-touch appearance.
- Note the deferred auto-install investigation as an open item in this change's `design.md` (Risks/Open Questions) for whoever picks it up in a future change.

## Final Review Verdict

**Recommendation:** ✅ **Pass** — All core behavior (lifecycle, connection, resilience, manual-placement rendering, no dynamic key behavior) is confirmed working correctly on real hardware. QA-009 is resolved by explicit user decision: manual placement is accepted as current behavior, and auto-install is formally deferred rather than left as a half-working attempt. This is contingent on the developer completing the revert/spec-correction follow-up above before archiving.

---
---

# Static Review Session — 2026-07-14 — `focus-profile-routing`

**Reviewer:** QA Engineer
**Scope:** Static review of the OpenSpec change `focus-profile-routing` (branch `focus-profile-routing`, HEAD `ddcd3ca`) — Gatoway core's new `focus-tracking`/`profile-routing` capabilities (`focusTracker.ts`, `profileRouter.ts`, `layoutResolver.ts`/`testFixtureLayoutResolver.ts`, `capabilityLookup.ts`), the five new/amended `message-protocol` message types (`focus`, `input_event`, `render_update`, `command`, `capability_update`), and the Stream Deck plugin's replacement of the static Idle action with the generic Key/Dial action model (AD-8). Reviewed against `proposal.md`, `design.md` (including its D1/D3/D4 amendments), the four capability delta specs (`focus-tracking`, `profile-routing`, `message-protocol`, `stream-deck-idle-display`), `tasks.md`, `REQUIREMENTS.md`, and `ARCHITECTURE.md` v1.4 (AD-6/AD-7/AD-8). Full test suite (100 gatoway-core + 61 stream-deck-plugin = 161 tests) and both packages' typecheck were re-run and pass. I also wrote and ran a temporary, throwaway verification test (not committed, removed before finishing this session) directly against `ProfileRouter` to confirm two suspected defects with a real, JSON-round-tripped wire payload rather than relying on static reasoning alone.
**Prepared for:** Technical Architect

## Summary

D2's focus supersession (single-winner, last-report-wins) is implemented cleanly with no lingering state, `LayoutResolver`'s revised id-based contract is threaded correctly through both the bound-layout sweep and — going beyond what task 7.5 literally asked for — `input_event` resolution, and `capability_update` correctly restricts an app to updating only its own declared capabilities and correctly gates re-rendering on focus. However, the specific area this review was asked to scrutinize most carefully — the null-vs-omitted `icon` semantics that D4/D7 were amended specifically to fix — has a real, confirmed gap on the Gatoway-core side: **`Capability.icon` (the live, stored representation of a capability's display data) has no way to represent "explicitly no icon,"** so every `render_update` that Gatoway core derives from a live `Capability` (both the bound-layout sweep sent on focus gain and the immediate re-render triggered by `capability_update`) silently drops the `icon` field whenever the capability's icon is unset — which is indistinguishable, once JSON-serialized, from "field omitted," meaning "leave unchanged" rather than the intended "reset to default." I confirmed this with a real, running `ProfileRouter` in two concrete scenarios: (1) focus superseding directly from an app with an icon to an app without one leaves the first app's icon visually stuck under the second app's capability, and (2) an app explicitly sending `capability_update` with `icon: null` — the exact feature this change's task-group-7 addendum exists to deliver — silently fails to reset the display at all. Only the hardcoded idle sweep (which never goes through a `Capability` object) actually achieves the reset the design intended. See QA-010 (Major).

A second, lower-severity finding: `docs/PROTOCOL.md` — the protocol reference document this change is specifically meant to produce as a durable artifact for Lightroom (step 3) and xDesign (step 5) to build against — was drafted before the `capability_update` addendum and never updated afterward, despite `tasks.md` 5.2 claiming the document was "cross-checked against the actual implemented types/behavior." It's missing the `capability_update` message type entirely and shows an outdated `RenderUpdatePayload`/`Capability` shape (no `null` on `icon`, no `state` on `Capability`). See QA-011 (Minor) — this is a real drift, not an acceptable "expected/out of scope" gap, given the document's own stated purpose and `design.md` D6's explicit reliance on it for the next two delivery-sequence steps.

Everything else reviewed — D2's focus tracking, the `LayoutResolver` id/`findCapability` split, `capability_update`'s own-connection-only enforcement, the five message payload shapes against `message-protocol`'s spec, and the Stream Deck plugin's generic action rendering (which correctly implements the three-state `icon` semantics on its own side, for what it's told) — is sound and well-tested.

---

## Issue Log

| ID | Severity | Location | Description | Status |
|----|----------|----------|-------------|--------|
| QA-010 | Major | `gatoway-core/src/routing/profileRouter.ts:173-230,253-289`, `gatoway-core/src/protocol/messages.ts:17-25` | `Capability.icon`'s stored type (`string \| undefined`) cannot represent "explicitly no icon," so `render_update`s derived from a live `Capability` (bound-layout sweep, and the immediate re-render after `capability_update`) silently drop `icon` instead of sending `null`, collapsing "explicit reset" into "leave unchanged" on the wire. | Open |
| QA-011 | Minor | `docs/PROTOCOL.md`, `openspec/changes/focus-profile-routing/tasks.md:36` | Protocol reference doc is stale relative to the `capability_update` addendum (missing the message type entirely; `RenderUpdatePayload.icon`/`Capability` shapes shown are out of date), despite `tasks.md` 5.2 claiming it was cross-checked against the implemented behavior. | Open |

**Status values:**
- `Open` — not yet fixed; needs architect attention
- `Resolved in review` — fixed or clarified during the review conversation
- `Deferred` — acknowledged, decision made to address in a later cycle

---

## Issue Detail

### QA-010 · Major · `gatoway-core/src/routing/profileRouter.ts`, `gatoway-core/src/protocol/messages.ts`

**What:** `Capability.icon` (`gatoway-core/src/protocol/messages.ts:17-25`) is typed `string | undefined` — it has no way to hold `null`. But both places that build a `RenderUpdatePayload` from a live `Capability` derive `icon` directly from this field:

```ts
// sendBoundLayoutSweep (profileRouter.ts:280-286)
const payload: RenderUpdatePayload = {
  controller, position,
  icon: capability.icon,   // undefined when the capability has no icon
  label: capability.label,
  state: capability.state,
};
```
```ts
// handleCapabilityUpdate's immediate re-render (profileRouter.ts:222-228)
this.sendRenderUpdate(streamDeckConnection, {
  controller, position,
  icon: capability.icon,   // also undefined after an icon:null reset (see below)
  label: capability.label,
  state: capability.state,
});
```

`handleCapabilityUpdate`'s own icon-merge logic (`profileRouter.ts:189-193`) explicitly converts an incoming `capability_update`'s `icon: null` into `capability.icon = undefined` for storage — a deliberate, well-reasoned choice given `Capability.icon`'s type — but this means the "this was an explicit reset" signal is lost the moment it's stored, and the very next line of code that re-renders it has no way to recover that signal. Since `sendMessage`'s outgoing envelope is serialized with `JSON.stringify` (`gatoway-core/src/protocol/envelope.ts:26-28`), a `RenderUpdatePayload` with `icon: undefined` has its `icon` key dropped from the JSON entirely — which, per the `message-protocol` spec and `RenderUpdatePayload`'s own doc comment, means "leave unchanged," not "reset to default." Only the hardcoded idle sweep (`sendIdleSweep`, `profileRouter.ts:291-306`) — which never touches a `Capability` object at all, just writes the literal `icon: null` — actually achieves the reset the D4/D7 amendments were written to deliver.

**Scenario:** Two realistic, in-scope situations, both directly exercising the multi-app focus arbitration this change exists to prove (FR-002, `ARCHITECTURE.md` Journey 1):
1. Application A (whose bound capability has an icon) is focused; the user switches directly to Application B (whose capability bound to the same position has no icon of its own, e.g. it relies on the manifest's default rendering). Per D2, this is a direct supersession with no intervening idle sweep — that's the whole point of "last-report-wins, no explicit handshake required." B's bound-layout sweep is the *only* opportunity to correct the display for B.
2. A focused application explicitly pushes `capability_update: { capabilityId: "...", icon: null }`, intending to reset its own capability's icon back to the manifest default — the very feature `tasks.md` 7.1-7.10 (task-group-7 addendum) was written to add, and the profile-routing spec's own "Capability Updates Trigger an Immediate Re-Render" requirement says this should "reflect the change."

**Evidence:** I wrote a temporary test file (`gatoway-core/test/unit/tmpQaVerify.test.ts`, not committed, deleted after this session) exercising `ProfileRouter` directly with a real `ConnectionManager` and inspecting the actual JSON-round-tripped wire form of the outgoing message (`JSON.parse(JSON.stringify(sentMessage))`):

- Scenario 1 (App A with icon "one.png" focused, then App B — no icon — supersedes it, same bound position): the wire form of B's `render_update` was
  `{"type":"render_update","connectionId":"...","payload":{"controller":"keypad","position":{"row":0,"column":0},"label":"Two"}}`
  — no `icon` key at all. Per the protocol's own sparse-update semantics, this instructs the Stream Deck plugin to leave the previously-displayed icon (App A's "one.png") exactly as it is. The Stream Deck plugin's own `RenderStore.apply()` (`stream-deck-plugin/src/actions/renderStore.ts:52-58`) confirms this reading: `icon: payload.icon === undefined ? existing?.state.icon : payload.icon` — an omitted `icon` key deserializes to `undefined`, so the store explicitly carries the old icon forward.
- Scenario 2 (an app focused with capability icon "one.png", then sends `capability_update: { capabilityId: ..., icon: null }`): the wire form of the resulting re-render was
  `{"type":"render_update","connectionId":"...","payload":{"controller":"keypad","position":{"row":0,"column":0},"label":"One"}}`
  — again, no `icon` key. The app's explicit reset request is silently dropped; the Stream Deck continues showing "one.png".
- No existing test in either package's suite exercises either scenario: `gatoway-core/test/unit/profileRouter.test.ts` and the `focusProfileRouting.integration.test.ts` integration suite's `capability_update` tests only ever change a capability's icon from one non-null string to another (`"one.png"` → `"two.png"`), and every focus-transition test in both suites only ever exercises a single app's focus/blur cycle (never a direct app-to-app supersession) — so this gap was invisible to the automated suite despite 161 passing tests.

**Impact:** This directly undercuts the headline deliverable of this change's own task-group-7 addendum (`REQUIREMENTS.md` FR-001's live capability display updates) for the specific "reset to default" case, and produces a real, user-visible cross-application rendering bug in the change's primary intended use case (switching focus directly between two real application plugins, per `ARCHITECTURE.md`'s Journey 1) whenever the newly-focused capability doesn't carry its own icon. Given the in-code test fixture itself declares one capability with no icon (`test-fixture.dial.one`), this is not a contrived edge case — it would very plausibly surface during the deferred manual hardware verification (tasks.md 6.5) the moment two different test-double or real app connections are focused back-to-back at the same fixture position, or the moment a real Lightroom/xDesign capability author chooses not to set an icon on some button.

**Suggested fix direction:** The outcome needed is that any `render_update` Gatoway core derives from a live `Capability` (both the bound-layout sweep and the `capability_update`-triggered re-render) faithfully carries the three-state icon signal all the way through — not just the hardcoded idle sweep. That likely means extending `Capability`'s own internal representation of "icon" to distinguish "explicitly no icon" from "not yet touched" (mirroring what `RenderUpdatePayload`/`CapabilityUpdatePayload` already do at the wire level), and having both `sendBoundLayoutSweep` and `handleCapabilityUpdate`'s re-render map an unset icon to the wire's explicit `null` rather than `undefined`, since both of these code paths are always full, authoritative statements of "what does this position look like right now" rather than true incremental deltas. Not prescribing the exact representation — the architect/developer may find a cleaner internal type than adding `null` to `Capability.icon` itself.

**Root-cause level:** Code. `design.md` D3/D4/D7's stated intent — that `null` and omitted must never be collapsed, and that live capability data (including resets) must actually reach rendering — is correct and was clearly reasoned through for the idle-sweep case; the two other rendering paths this same amendment touched simply don't preserve that distinction when the data flows through `Capability` rather than a hardcoded literal. No spec or architecture change is needed to fix this.

---

### QA-011 · Minor · `docs/PROTOCOL.md`, `openspec/changes/focus-profile-routing/tasks.md:36`

**What:** `docs/PROTOCOL.md` was drafted in commit `2807099` (tasks 5.1/5.2, before the task-group-7 addendum existed) and was never touched again — I confirmed this with `git log --follow -- docs/PROTOCOL.md`, which shows only that one commit, and `git show --stat ddcd3ca` (the task-group-7 addendum commit), which touches no files under `docs/`. As a result the document:
- Has no `capability_update` section at all — an entire message type this change adds is undocumented.
- Shows `RenderUpdatePayload.icon` as `icon?: string;` (`docs/PROTOCOL.md:234`), omitting the `| null` variant and the "explicit reset to manifest default" semantics that are exactly this document's job to explain to a future plugin author.
- Shows the `Capability` interface (`docs/PROTOCOL.md:86-93`) without the `state?: number` field that exists in `gatoway-core/src/protocol/messages.ts`.

`tasks.md` 5.2 states: "Cross-checked against the actual implemented types/behavior before finalizing... cross-checked against `gatoway-core/src/protocol/messages.ts`, `focusTracker.ts`, and `profileRouter.ts`" — this claim was accurate at the time it was written, but the addendum (task-group-7) landed afterward and no corresponding re-check task was added, so the claim no longer holds against the code as it stands at `ddcd3ca`.

**Scenario:** A future reader — most immediately, whoever implements step 3 (Lightroom) or step 5 (xDesign) per `design.md` D6's explicit intent that this document is "the artifact step 3 and step 5 build against directly" — reads `docs/PROTOCOL.md` expecting it to be complete and current (its own header says "this document should be the only thing you need to read"), and either doesn't know `capability_update` exists at all, or implements icon handling against the documented (incomplete) `string`-only type.

**Evidence:** `git log --follow --oneline -- docs/PROTOCOL.md` returns only `2807099`; `git show --stat ddcd3ca` (the commit that added `capability_update` and the `icon: string | null | undefined` change) touches only `gatoway-core/src/...`, `stream-deck-plugin/src/...`, and test files — no `docs/` path. Direct reading of `docs/PROTOCOL.md` lines 83-93 and 230-238 confirms the stale shapes described above.

**Impact:** Low severity on its own (this is documentation, not shipped behavior), but it is a real, concrete drift in an artifact this change's own `proposal.md`/`design.md` treat as a first-class deliverable specifically to de-risk the next two delivery-sequence steps — the exact opposite of "expected/out of scope." This is the same category of gap as `stream-deck-plugin-skeleton`'s QA-008 (an inaccurate self-reported task-completion claim masking a real, if narrow, gap).

**Suggested fix direction:** Per this project's own workflow, this is a documentation completeness gap to route to the `doc-writer` role (not a code fix) — bring `docs/PROTOCOL.md` current with `capability_update` and the corrected `icon`/`Capability` shapes before this change is archived, alongside `doc-writer`'s other planned handoff work for this change (e.g. the Migration Plan's note about `stream-deck-plugin/README.md`).

**Root-cause level:** Code/process — an outdated task-tracking claim in `tasks.md` and a documentation artifact that fell out of sync with a later addendum to the same change, not a functional defect in shipped behavior.

---

## Areas Specifically Verified (per review scope)

- **D2 focus supersession, no lingering state:** Confirmed clean. `FocusTracker.setFocused()` (`focusTracker.ts:69-85`) unconditionally overwrites `this.focusedConnectionId` with no leftover reference to the previous holder anywhere else in the class or its callers; `ProfileRouter` always re-fetches the focused connection fresh via `manager.get()` rather than caching a reference. `focusTracker.test.ts` directly exercises supersession-without-blur, no-op re-focus, blur-only-from-the-holder, and disconnect-clears-focus. No bug found.
- **`LayoutResolver`'s id-based contract, threaded through both sweep and input resolution:** Confirmed correct, and confirmed that extending unresolved-id handling to `input_event` resolution (beyond task 7.5's literal scope, which only mentions the sweep) is itself correct and tested: `ProfileRouter.handleInputEvent` (`profileRouter.ts:117-150`) calls `layoutResolver.resolve()` for the id, then `findCapability()` against the focused connection's own declared capabilities, and safely no-ops (logged, not thrown) if either step fails — exactly mirroring `sendBoundLayoutSweep`'s equivalent handling. Both the unit test ("ignores an input_event when the focused connection has not declared the bound capability id") and the integration test ("silently ignores an input_event whose bound capability id the focused application never declared") cover this directly.
- **`capability_update` restricted to the sender's own capabilities, and focused-vs-not-focused re-render distinction:** Confirmed correct. `handleCapabilityUpdate` (`profileRouter.ts:173-230`) looks the target capability up exclusively within `connection`'s own record via `findCapability(connection, ...)` — there is no code path that allows a `capabilityId` to be resolved against any other connection's capabilities — and correctly gates the immediate re-render on `this.focusTracker.current === connection.id`. Both unit and integration tests confirm: a background (non-focused) connection's update is stored but produces no render, and an undeclared capability id is rejected/no-op'd with a distinct log event (`capability_update_ignored`/`undeclared_capability`). No bug found here, independent of QA-010's separate icon-value issue.
- **`message-protocol` payload shapes vs. the delta spec:** `FocusPayload`, `InputEventPayload`, `RenderUpdatePayload`, `CommandPayload`, and `CapabilityUpdatePayload` (`gatoway-core/src/protocol/messages.ts`) match the `message-protocol` spec's described shapes exactly, including the `KeypadPosition`/`EncoderPosition` discriminated addressing and `delta`'s rotate-only presence. `envelope.test.ts` round-trips `focus`/`input_event`/`render_update` through the real `encodeMessage`/`decodeMessage` pair (no round-trip test explicitly targets `command`/`capability_update`, but `decodeMessage` is fully generic over `payload` shape, as already proven by the other three — noted as an Observation, not a defect).
- **Stream Deck plugin's own icon null/undefined handling:** Confirmed correct and thoughtfully documented on its own side. `RenderStore.apply()` and both `renderGenericKey`/`renderGenericDial` correctly distinguish `undefined` ("never touch the image") from `null` ("reset to manifest default via `setImage()` with no argument") from a `string` (set that icon) — the plugin-side implementation is exactly what QA-010's fix needs to finally be able to rely on correctly. This side of the null/undefined distinction is not implicated in QA-010; the gap is entirely upstream, in what Gatoway core actually sends.
- **`command` message correctness:** `ProfileRouter.handleInputEvent` builds `CommandPayload` with the resolved `capabilityId` and the raw `eventType`/`delta` carried through unchanged from the originating `input_event`, matching `message-protocol`'s "Command Message Type" requirement and design.md D1's rationale (the app, not Gatoway core, decides what a gesture means). Confirmed via unit and integration tests, including the `delta: undefined` case for non-rotate events.
- **`docs/PROTOCOL.md` staleness — judged as a real finding, not out of scope:** See QA-011 above. I did not treat this as "expected"/acceptable to defer silently, because the document's own stated purpose and `design.md` D6's explicit reliance on it for steps 3/5 make the gap consequential, and because `tasks.md` 5.2's claim of having cross-checked it is no longer accurate.

---

## Observations

- `gatoway-core/test/unit/envelope.test.ts` round-trips `focus`/`input_event`/`render_update` explicitly but has no equivalent round-trip test for `command` or `capability_update` (both added later, in the D1/D7 amendments). `decodeMessage`/`encodeMessage` are fully generic over `payload`, so this is very unlikely to hide a real bug, but a symmetrical round-trip test for the two later-added types would close the coverage gap and match the pattern already established for the first three.
- `ARCHITECTURE.md`'s Delivery Sequence step 4 (line 146) still says "add the `key_event`/`render_update` message types," using an older name (`key_event`) that AD-8 itself (line 67) and every other artifact in this change consistently call `input_event`. Purely cosmetic — no code or spec anywhere uses `key_event` — but worth tidying up the next time `ARCHITECTURE.md` is revised, since it's a small internal inconsistency within the same document.
- `gatoway-core/src/routing/profileRouter.ts`'s `findStreamDeckConnection()` (`profileRouter.ts:319-323`) picks the first `authenticated` connection with `pluginType === "stream-deck"` via `.find()`; nothing in this change prevents two Stream Deck plugin connections from existing simultaneously (e.g. during a reconnect race), in which case only one would ever receive render updates. Not a realistic concern for the single-physical-device MVP this change targets, and out of scope for this review, but worth a note if multi-device support is ever considered.

---

## Testing Coverage Assessment

Both packages' test suites are substantial and well-targeted for what they cover: `gatoway-core` adds `focusTracker.test.ts`, `profileRouter.test.ts`, `capabilityLookup.test.ts`, `testFixtureLayoutResolver.test.ts`, and a real-socket `focusProfileRouting.integration.test.ts` (test-double TCP connections against a genuinely running Gatoway core, per tasks.md 6.3); `stream-deck-plugin` adds unit tests for both generic action renderers, `renderStore.ts`, and `protocolPositions.ts`. Focus supersession, no-focus/no-binding/undeclared-capability safe-ignore paths, own-connection-only `capability_update` enforcement, and the idle-sweep icon reset are all directly and convincingly tested.

The gap this review surfaced (QA-010) is precisely a testing-coverage gap as much as a code gap: no test in either suite exercises (a) a direct focus supersession between two different application connections (every focus test uses exactly one app, cycling it through focus/blur/disconnect), or (b) a `capability_update` that sets `icon: null` (every `capability_update` test changes icon between two non-null strings). Both are realistic, in-scope scenarios for this change's own stated purpose (multi-app focus arbitration and live capability display updates), and both should be added as regression tests alongside whatever fix QA-010 receives.

Manual verification (tasks.md 6.5) remains correctly deferred to `/verify` per the developer's own disclosure — no physical/emulated Stream Deck hardware in this sandboxed environment. Given QA-010's evidence, I'd flag for `/verify` that testing with two distinct test-double or real app connections focused back-to-back (not just one app cycling focus/blur) is the specific scenario likely to surface this bug visually on real hardware.

---

## Review Verdict

**Recommendation:** ❌ **Requires fixes** — QA-010 is a Major, code-level issue that undercuts this change's own headline addition (live capability display updates, including the icon-reset case the task-group-7 addendum was written specifically to deliver) in a realistic, in-scope multi-app scenario, with no test in either suite currently guarding against it. QA-011 is Minor and should be routed to `doc-writer` rather than blocking progress on its own. Every other area this review was asked to specifically scrutinize — D2's focus-supersession cleanliness, `LayoutResolver`'s id-based contract (including its correct extension to `input_event` resolution), and `capability_update`'s own-connection-only enforcement and focused/not-focused re-render gating — is sound. Once QA-010 is fixed (with regression tests for both scenarios described above), this change should return to static review only for that fix before proceeding to `/verify` with real or test-double hardware.

---

# Re-verification Session — 2026-07-14 — `focus-profile-routing` (QA-010 fix)

**Reviewer:** QA Engineer
**Scope:** Re-review of the QA-010 (Major) fix on branch `focus-profile-routing`, HEAD `0a151cc` — `sendBoundLayoutSweep` and `handleCapabilityUpdate`'s immediate re-render in `gatoway-core/src/routing/profileRouter.ts`, the accompanying `Capability.icon` doc-comment in `gatoway-core/src/protocol/messages.ts`, and the new regression tests in `gatoway-core/test/unit/profileRouter.test.ts` and `gatoway-core/test/integration/focusProfileRouting.integration.test.ts`. Reviewed against the QA-010 finding above, `design.md` D3/D4/D7, `tasks.md`'s new post-review addendum, and re-run of the full test suite and typecheck for both packages.
**Prepared for:** Technical Architect

## Summary

QA-010 is resolved. Both previously-affected call sites — `sendBoundLayoutSweep` (the bound-layout sweep on focus gain) and `handleCapabilityUpdate`'s immediate re-render — now assert `capability.icon ?? null` rather than passing `capability.icon` straight through, so an unset icon always serializes as an explicit `null` on the wire instead of being dropped. I checked all three places `RenderUpdatePayload.icon` is constructed in `profileRouter.ts` (the idle sweep, already correct at the time of the original review; the two just fixed) and confirmed no other code path builds a `render_update` from a live `Capability` without going through one of these three. The developer's decision not to change `Capability.icon`'s stored type (`string | undefined`) is sound: I traced every read of `.icon` on a live `Capability` object in both packages (`grep -rn "\.icon\b"` across `gatoway-core/src` and `stream-deck-plugin/src`) and confirmed the only places the "never set" vs. "explicitly reset" distinction is observable are exactly these three wire-construction sites, all of which are full, authoritative statements of a position's current display rather than partial deltas — so collapsing both cases to `null` at the wire boundary is correct and loses no information any other code path depends on.

The developer added a regression test for each of QA's two original reproduction scenarios at both the unit level (`profileRouter.test.ts`, driving `ProfileRouter` directly) and the real-socket integration level (`focusProfileRouting.integration.test.ts`, a genuine TCP listener with test-double clients). I specifically checked that these tests assert on the wire form rather than a merely-falsy check that an omitted field would also satisfy: the integration tests decode incoming bytes via `JSON.parse(line)` on data read directly off the real socket (`TestDoubleClient`'s `data` handler, `focusProfileRouting.integration.test.ts:64-69`), and both the unit and integration versions of both tests assert `Object.prototype.hasOwnProperty.call(payload, "icon")` is `true` in addition to `payload.icon === null` — this is exactly the assertion shape needed to distinguish "explicit `null`" from "key absent," and I confirmed by inspection that an omitted-field regression (i.e. reverting to the pre-fix `icon: capability.icon`) would fail the `hasOwnProperty` assertion specifically, not just the value assertion. Ran the full suite: all four new regression tests pass, both packages' typecheck is clean, and nothing else regressed (104/104 gatoway-core tests, 61/61 stream-deck-plugin tests).

QA-011 (`docs/PROTOCOL.md` staleness, Minor) is untouched by this commit, as expected — it was already correctly scoped in the original review as a documentation-only finding to route to `doc-writer` rather than block on. I re-confirmed it is still open: `docs/PROTOCOL.md` still shows `RenderUpdatePayload.icon` and `Capability.icon` as `icon?: string;` (lines 91, 234) with no `capability_update` section, unchanged from the original finding. This is not a regression introduced by the QA-010 fix — it was never in scope for it — but it remains an open item that should be routed to `doc-writer` before this change is archived.

---

## Per-finding re-verification

| ID | Severity | Original location | Status now | Notes |
|----|----------|--------------------|------------|-------|
| QA-010 | Major | `gatoway-core/src/routing/profileRouter.ts:222-233,285-297` | **Resolved** | Both call sites now assert `capability.icon ?? null`; verified via code inspection, new unit + real-socket integration regression tests (which correctly assert wire-level key presence, not just falsiness), and full suite re-run. |
| QA-011 | Minor | `docs/PROTOCOL.md`, `openspec/changes/focus-profile-routing/tasks.md:36` | **Open, unchanged** | Out of scope for this commit as expected. Confirmed still stale (no `capability_update` section; `icon?: string` shown without the `| null` reset semantics). Routing note stands: hand to `doc-writer` before archive, not a blocker on its own. |

---

## Regression check

- **Typecheck:** `npm run typecheck` (root, runs both workspaces) — clean, no errors, both `gatoway-core` and `stream-deck-plugin`.
- **Full test suite:** `npm test` (root) — `gatoway-core`: 17 test files, 104/104 passed. `stream-deck-plugin`: 13 test files, 61/61 passed. No failures, no skips other than the normal per-file test isolation.
- **Targeted run of the four new QA-010 regression tests** (`npx vitest run -t "QA-010"`, from `gatoway-core/`): all four pass —
  - `profileRouter.test.ts` › "QA-010 regression: sends icon:null (not omitted) when focus supersedes directly to a connection whose bound capability has no icon"
  - `profileRouter.test.ts` › capability_update › "QA-010 regression: immediately re-renders icon:null (not omitted) when a capability_update explicitly resets icon to null"
  - `focusProfileRouting.integration.test.ts` › "QA-010 regression: sends icon:null (not omitted) on the wire when focus supersedes directly to an app whose bound capability has no icon"
  - `focusProfileRouting.integration.test.ts` › capability_update › "QA-010 regression: immediately re-renders icon:null on the wire when capability_update explicitly resets icon to null"
- **Wire-form assertion check (the specific ask for this session):** confirmed all four new tests include `Object.prototype.hasOwnProperty.call(payload, "icon")` (or an equivalent full-object `toEqual` that would fail if the key were absent, in the unit tests) alongside `expect(payload.icon).toBeNull()`. The integration tests' `payload` comes from `JSON.parse(line)` on bytes read off a real, running TCP socket (`focusProfileRouting.integration.test.ts:64-69`, `startTcpListener`), not an in-memory object — so these assertions genuinely exercise the JSON-serialization boundary QA-010 was about, not just the pre-serialization JS value.
- **No other regressions found.** Re-read the full `profileRouter.ts` (all 335 lines) to confirm the fix didn't touch or affect `handleInputEvent`, `handleFocus`, `handleDisconnect`, `sendIdleSweep`, or the `capability_update` sparse-merge logic (`profileRouter.ts:189-199`) — all unchanged from the previously-reviewed version. Diff for this commit (`git show --stat 0a151cc`) touches only `messages.ts` (doc comment only, no type change), `profileRouter.ts` (the two `?? null` additions plus explanatory comments), the two test files, and `tasks.md`.

---

## Observations carried forward

- The two prior sessions' Observations (round-trip test coverage for `command`/`capability_update` envelopes; `ARCHITECTURE.md`'s stale `key_event` naming; `findStreamDeckConnection()`'s unhandled dual-Stream-Deck-connection race) remain unaddressed and are unaffected by this fix — none is a blocker, all previously logged as non-blocking.

---

## Final Review Verdict

**Recommendation:** ✅ **Pass** — QA-010 is confirmed resolved: the fix is correct, matches `design.md` D3/D4/D7's intent, is narrowly scoped to the two affected call sites, is backed by regression tests for both of QA's original reproduction scenarios at both the unit and real-socket-integration level, and those tests correctly assert wire-level key presence (not a check an omitted field would also satisfy). No new issues found; nothing else regressed. QA-011 (Minor, `docs/PROTOCOL.md` staleness) remains open but was never in scope for this fix and should not block progress on its own — route it to `doc-writer` before `/opsx:archive`, per the original review's recommendation. This change is ready to proceed to `/verify` for hands-on hardware confirmation.

---
---

# Interactive Verification Session (`/verify`) — 2026-07-14

**Reviewer:** QA Engineer (interactive, with user)
**Scope:** Hands-on execution of `focus-profile-routing` (branch `focus-profile-routing`, commit `0988a1f`) against real Elgato Stream Deck+ hardware, using a test-double application-plugin client (`gatoway-core/test/manual/testAppClient.ts`) since no real Lightroom/xDesign plugin exists yet.
**Prepared for:** Technical Architect

## Summary

Every core mechanism this change introduces was confirmed live, on real hardware, with the user directly observing the physical device: generic Key/Dial actions replaced the old static Idle action correctly; the idle appearance renders by default once manually placed; a test-double app registering and reporting focus correctly drives real-time `render_update`s to the device; physical key presses and dial rotation correctly resolve to `command` messages delivered to the focused app; a live `capability_update` pushed with no physical input updates the display immediately (the change's headline feature); and both an explicit blur and a disconnect-while-focused correctly revert the device to the idle appearance with the icon properly reset (QA-010's fix, confirmed live via the actual JSON payloads in Gatoway core's log — `"icon":null` explicit on every idle-sweep entry). One new Minor, non-blocking finding surfaced: an overly long capability label overflows the physical key's title area.

## Issue Log

| ID | Severity | Location | Description | Status |
|----|----------|----------|-------------|--------|
| QA-012 | Minor | `docs/PROTOCOL.md` (documentation gap) | No guidance exists on practical capability-label length; a label like "Fixture A (pushed)" (19 characters) visibly overflows the physical key's title display | Open |

## Issue Detail

### QA-012 · Minor · Documentation gap

**What:** Capability `label`/`render_update` `label` fields are plain strings with no length guidance anywhere in `design.md`, the specs, or `docs/PROTOCOL.md`.

**Scenario:** An application plugin author (Lightroom, xDesign, or beyond) declares or pushes a capability label without knowing there's a practical display limit, and it overflows/clips on the physical key.

**Evidence:** Live-confirmed with the user: pushing a `capability_update` with `label: "Fixture A (pushed)"` (19 characters) via the manual test-app client correctly updated the display (functionally correct — this is not a functional defect), but the user observed the text rendered wider than the physical key and ran off-screen. Reverting to a shorter label ("Gatoway", 7 characters) via the idle sweep displayed correctly at normal width.

**Impact:** Cosmetic only — the underlying mechanism (live label updates) works correctly. But without documented guidance, a future plugin author has no way to know what length is safe, and will likely discover this the same way this session did: by accident, on real hardware.

**Suggested fix direction:** Not a code fix — Gatoway should not silently truncate or wrap app-supplied labels (that would hide meaningful content without the app's knowledge). The right fix is documentation: add practical label-length guidance to `docs/PROTOCOL.md`'s capability/`render_update` section (e.g. "keep labels short — the Stream Deck's physical key title area comfortably fits roughly 8-10 characters at default font size before clipping").

**Root-cause level:** Documentation (interface-contract completeness), not code or design. Groups naturally with QA-011 (the other open `docs/PROTOCOL.md` gap) for `doc-writer` to address in one pass.

## Checks Completed

- **Generic action migration:** confirmed the Stream Deck software's action list now shows "Key" and "Dial" under the "Gatoway" category; the old "Idle" action and any previous placement of it were gone, consistent with `stream-deck-idle-display`'s REMOVED/ADDED delta.
- **Idle appearance at baseline:** after manually placing the generic Key action at `{row:0,column:0}` and `{row:0,column:1}` and the generic Dial action at `{index:0}` (matching the test-fixture layout), both keys and the dial showed "Gatoway" with the default icon before any app connected — confirmed by the user.
- **Live focus-driven rendering:** a test-double app client registered (`pluginType: "test-app"`, declaring the fixture's three capabilities) and reported `focus: true`; the user confirmed the two keys and dial updated to "Fixture A"/"Fixture B"/"Fixture Dial" in real time.
- **Input forwarding, keypad:** pressing the physical "Fixture A" key produced `input_event` (`keyDown` then `keyUp`) in Gatoway core's log and a matching `command` (`capabilityId: "test-fixture.button.one"`) delivered to the test-app client, confirmed in its console output.
- **Input forwarding, dial:** rotating the physical dial produced `input_event` (`rotate`, `delta: 1`) and a matching `command` delivered to the test-app client. (An initial attempt appeared to produce no event; traced to a test-harness artifact — a stray duplicate test-app-client process from an earlier setup attempt competing for the same input pipe, not a defect in the system under test. Cleaned up and re-verified cleanly with a single instance; result above is from the clean run.)
- **Live capability_update while focused and bound:** pushing a `capability_update` for `test-fixture.button.one` with no physical input immediately updated the key's displayed label on real hardware, confirmed by the user watching the device — this is the change's headline new capability (`REQUIREMENTS.md` FR-001), and it works.
- **Idle reset via explicit blur:** reporting `focus: false` reverted all three positions to "Gatoway" with the icon explicitly reset (`"icon":null` in the actual `render_update` payloads, confirmed in Gatoway core's log), and the user confirmed the display visually matched, at normal width.
- **Idle reset via disconnect:** disconnecting the test-app client while it was the focused connection correctly cleared focus and reverted all three positions to idle, confirmed both in the log (`focus_changed` with `reason: "disconnect"`) and visually by the user.

## Review Verdict (this session)

**Recommendation:** ✅ **Pass** — Every mechanism this change introduces is confirmed working correctly on real hardware, including the two QA fix cycles that preceded this session (QA-006/007/008 areas untouched and still sound; QA-010's icon-reset fix specifically re-verified live via real log payloads, not just automated tests). One new Minor, non-blocking, documentation-only finding (QA-012) — groups with the already-open QA-011 for a single `doc-writer` pass covering both `docs/PROTOCOL.md` gaps (missing `capability_update` section, and now label-length guidance) before `/opsx:archive`.

---
---

# Static Review Session — 2026-07-14 — `persisted-layout-config`

**Reviewer:** QA Engineer
**Scope:** Static review of the OpenSpec change `persisted-layout-config` (branch `persisted-layout-config`, HEAD `1e45399`) — the new `layout-persistence` capability replacing `focus-profile-routing`'s in-code `testFixtureLayoutResolver.ts` with a real, file-backed `LayoutStore`/`LayoutResolver` (`gatoway-core/src/routing/layoutConfig.ts`, `layoutStore.ts`, `layoutResolver.ts`, `configLayoutResolver.ts`, `position.ts`), the mechanical `ProfileRouter`/`config.ts`/`index.ts` wiring changes this required, and the deletion of the fixture and its test. Reviewed against `proposal.md`, `design.md` (D1-D5), the new `layout-persistence` capability spec, `tasks.md`, `REQUIREMENTS.md`, and `ARCHITECTURE.md` (delivery-sequence step 6, R-3). Full test suite (120 gatoway-core + 61 stream-deck-plugin = 181 tests) and both packages' typecheck were re-run and pass. I additionally wrote three throwaway, uncommitted verification tests (deleted before finishing this session, none left in the tree) to independently confirm behavior rather than relying on the implementation's or `tasks.md`'s own claims: (1) a fault-injected `LayoutStore.save()` test simulating a failed `writeFile` and a failed `rename` via `vi.mock("node:fs/promises", ...)`, (2) an end-to-end `ProfileRouter` + real `LayoutStore`/`createLayoutResolver` test using two genuinely disjoint, non-overlapping profiles (one of which never even connects) to directly exercise design.md D3's idle-reset requirement, and (3) manual tracing of the `pluginType ?? ""` fallback at all three `ProfileRouter` call sites against `configLayoutResolver.ts`'s actual guard.

## Summary

This is a clean, well-scoped implementation with no Critical or Major issues. Every area this review was specifically asked to scrutinize checks out under direct testing, not just code reading. The `connection.pluginType ?? ""` fallback used at all three `ProfileRouter` call sites (`handleInputEvent`, `handleCapabilityUpdate`, `sendBoundLayoutSweep`) cannot accidentally resolve to a real bound profile: `configLayoutResolver.ts`'s `resolve()` short-circuits with an explicit `if (!pluginType) return null` before ever consulting the store, so even a config file with a (currently unvalidated, but harmless) profile literally keyed `""` could never be reached this way — confirmed both by code trace and by the existing "returns null for a falsy plugin type" unit test. `LayoutStore.allPositions()` genuinely unions across every configured profile, not just one: I independently verified this with a fault-injected, from-scratch test using two completely disjoint profiles (no shared positions at all) where one profile's connection never even connects, and confirmed the idle sweep still resets both profiles' positions after the other one blurs — design.md D3's specific concern is not just claimed correct, it's proven correct end-to-end through the real `ProfileRouter`. Missing-file, invalid-JSON, and wrong-shape config handling all fail safe with distinct log events (`layout_config_missing`/`layout_config_invalid_json`/`layout_config_invalid_shape`) and an empty in-memory layout, traced directly through `LayoutStore.load()`'s three separate catch/validation branches — no crash path exists. `save()`'s atomic write genuinely protects the on-disk file: I forced both a `writeFile` failure and a `rename` failure via mocking, and in both cases the previously-saved `layout.json` was left byte-for-byte intact and valid — the core atomicity guarantee design.md D5 and the spec's "Save writes atomically" scenario require holds under actual fault injection, not just the happy-path round-trip the existing test suite exercises. The unused `save()`/`setBinding()`/`removeBinding()` API surface built for the future no-code UI is small and sound: no bugs found in its position-equality-aware set/replace/remove logic.

One real, if narrow, gap surfaced from the fault-injection testing: a failed `rename()` during `save()` leaves an orphaned `.tmp` file behind in the config directory forever, since nothing cleans it up on the error path — the main config file itself is never corrupted (the requirement that actually matters), but this is a real, untested resource-leak gap in code nothing calls yet, worth closing before a future caller (the no-code UI) relies on `save()` under real-world failure conditions. See QA-013 (Minor).

A second, non-blocking Observation: the `focus-profile-routing` integration test suite's replacement fixture (`FIXTURE_BINDINGS`) applies byte-for-byte identical bindings to all three plugin-type profiles it configures (`test-app`/`test-app-a`/`test-app-b`), so it never exercises design.md D3's specific "a position bound only in a different, non-focused profile is still reset by the idle sweep" scenario at the full `ProfileRouter`-plus-real-TCP-socket level — only the dedicated `LayoutStore`/`configLayoutResolver` unit tests exercise genuinely distinct multi-profile bindings. I confirmed (via my own throwaway test, see Scope above) that the actual behavior is correct end-to-end, so this is a coverage gap, not a functional bug — but it's exactly the scenario design.md D3 calls out as consequential to get wrong, so it's worth a dedicated regression test at the integration level too, not just at the unit level.

Everything else reviewed — the config schema/validation (`layoutConfig.ts`), `position.ts`'s keypad-vs-encoder discrimination (correctly prevents `{row:0,column:0}` and `{index:0}` from colliding), `config.ts`'s `GATOWAY_LAYOUT_FILE` wiring, `index.ts`'s startup sequencing (`layoutStore.load()` awaited before `createLayoutResolver`/`ProfileRouter` construction, matching the existing non-aborting resilience posture for the token file), and the mechanical `ProfileRouter` call-site updates (`pluginType` instead of `connectionId`, threaded through all three resolution call sites) — is sound and consistent with `design.md`'s D1-D5 decisions.

---

## Issue Log

| ID | Severity | Location | Description | Status |
|----|----------|----------|-------------|--------|
| QA-013 | Minor | `gatoway-core/src/routing/layoutStore.ts:160-171` (`LayoutStore.save()`) | A failed `rename()` during `save()` leaves an orphaned `<file>.<uuid>.tmp` file behind in the config directory with no cleanup; the target config file itself is never corrupted (confirmed by fault injection), but repeated failures accumulate stray temp files indefinitely. Untested by the existing suite (which only exercises the happy path). | Resolved (commit `84d293c`) |

**Status values:**
- `Open` — not yet fixed; needs architect attention
- `Resolved in review` — fixed or clarified during the review conversation
- `Deferred` — acknowledged, decision made to address in a later cycle

---

## Issue Detail

### QA-013 · Minor · `gatoway-core/src/routing/layoutStore.ts:160-171`

**What:** `LayoutStore.save()` writes the serialized config to a temp file (`${this.filePath}.${randomUUID()}.tmp`), then `rename()`s it over the target path:
```ts
async save(): Promise<void> {
  const config: LayoutConfigFile = { profiles: {} };
  for (const [pluginType, bindings] of this.profiles.entries()) {
    config.profiles[pluginType] = { bindings: [...bindings] };
  }

  const dir = dirname(this.filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(config, null, 2), "utf8");
  await rename(tempPath, this.filePath);
}
```
There is no `try`/`catch`/`finally` around either the `writeFile` or the `rename` call, so if `rename()` throws (e.g. a cross-device rename on some filesystem layouts, a permissions error, or a concurrent process holding a lock on the target), the freshly-written temp file is never removed — it simply stays on disk, and the exception propagates to the caller with no cleanup having occurred.

**Scenario:** A future caller (the no-code mapping UI design.md D5 builds this API surface for) calls `setBinding()`/`removeBinding()` then `save()`, and the `rename()` step fails for any of the reasons above. The user-visible edit attempt fails (correctly — the exception does propagate, so the caller can report the failure), but every such failure leaves one more `layout.json.<uuid>.tmp` file behind in the config directory, forever, since nothing else in this codebase ever cleans up files matching that pattern.

**Evidence:** I wrote a temporary, uncommitted test (`gatoway-core/test/unit/tmpAtomicWrite.test.ts`, removed before finishing this session) that mocked `node:fs/promises` via `vi.mock(..., async (importOriginal) => ...)` to force a real `rename()` rejection on an otherwise-real `LayoutStore.save()` call, seeded with a pre-existing valid `layout.json`. Result: the pre-existing `layout.json` remained byte-for-byte intact (confirming the core atomicity guarantee holds — this is the good news), but `readdir(dir)` after the failed save showed both `layout.json` and a leftover `layout.json.e9edec90-ced6-4639-9085-4d6751d4f9d5.tmp` file. The equivalent fault injection on `writeFile()` itself (rather than `rename()`) left no stray file, since the temp file is never created if `writeFile` itself throws before completing.

**Impact:** Low on its own — the requirement that actually matters (the previously-saved config is never corrupted or left partially written) is genuinely met, confirmed under fault injection, not just the happy-path round-trip the existing test suite covers. But this is a real, unbounded resource leak on a real (if currently rare) failure path, and it's completely untested — nothing in `layoutStore.test.ts` exercises a `rename()` failure at all. Since nothing calls `save()` yet in this change (design.md D5's own framing), this has zero user-visible impact today, but the future no-code UI this API is explicitly built for will be the first real caller, and repeated failed save attempts (e.g. a user's disk genuinely full, or a permissions issue on the config directory) would otherwise accumulate garbage files silently.

**Suggested fix direction:** The outcome needed is that a failed `save()` leaves the config directory exactly as it found it — no stray temp files — in addition to (already true) never corrupting the target file. A `try`/`finally` (or equivalent) around the write-then-rename sequence that attempts to remove the temp file on any failure (itself best-effort — a cleanup failure shouldn't mask the original error) would close this without changing the atomicity guarantee that's already correctly implemented.

**Root-cause level:** Code. `design.md` D5's intent ("a crash mid-write can never leave a corrupted config file") is correctly implemented for the file that matters; this is a narrower, adjacent gap (temp-file cleanup on the failure path) that the design didn't explicitly call out either way.

---

## Areas Specifically Verified (per review scope)

- **`pluginType ?? ""` fallback cannot accidentally match a real bound profile:** Confirmed by direct code trace and independent reasoning about the config schema. All three `ProfileRouter` call sites (`profileRouter.ts:119-123`, `:224`, `:270-274`) pass `connection.pluginType ?? ""` (or `focusedConnection?.pluginType ?? ""`) to `layoutResolver.resolve()`. `configLayoutResolver.ts:14-17`'s `resolve()` begins with `if (!pluginType) { return null; }`, which is checked *before* any lookup into the store — so an empty string can never reach `store.getProfile(pluginType)` at all, regardless of whether a hand-authored (or malicious) config file happens to contain a profile keyed `""` (which `validateLayoutConfig` does not explicitly reject, but is rendered moot by this guard). I confirmed `pluginType` really can be `""` in practice, not just `undefined`: `messageHandler.ts:89`'s `register` handling only substitutes the literal string `"unknown"` when `payload.pluginType` is not a `string` at all (e.g. missing or wrong type) — an explicitly-sent `pluginType: ""` is stored verbatim on the connection record — but this makes no difference to the outcome, since the guard in `configLayoutResolver.ts` treats both cases (`undefined` defaulted to `""`, and a genuine stored `""`) identically and safely. No security or correctness issue found here.
- **`allPositions()` unions across ALL configured profiles, not just one:** Confirmed both by the existing unit tests (`layoutStore.test.ts`'s "unions distinct positions across every configured profile", `configLayoutResolver.test.ts`'s equivalent) and by my own independent, from-scratch verification test using two entirely disjoint profiles (`app-a` bound only at `keypad(0,0)`, `app-b` bound only at `encoder(9)`, `app-b` never even connecting) driven through the real `ProfileRouter` + real `LayoutStore`/`createLayoutResolver`. After `app-a` gains and then loses focus, the idle sweep correctly reset both `keypad(0,0)` (app-a's position) and `encoder(9)` (app-b's position, never focused, never connected) — exactly the design.md D3 concern this review was asked to specifically confirm rather than trust. No bug found.
- **Missing-file, invalid-JSON, and wrong-shape config handling fail safe:** Confirmed by tracing `LayoutStore.load()`'s three separate `catch`/validation branches directly (`layoutStore.ts:44-95`): an `ENOENT` on `readFile` logs `layout_config_missing` at `info` level with the expected path and a pointer to the schema location; any other `readFile` error logs `layout_config_read_failed` at `error`; a `JSON.parse` throw logs `layout_config_invalid_json` at `error` with the parse error message; a shape validation failure (`validateLayoutConfig`) logs `layout_config_invalid_shape` at `error` with a specific, localized reason string (e.g. `profiles.lightroom.bindings[0].capabilityId must be a non-empty string`). All four paths set `this.profiles = new Map()` and return normally — no path re-throws or rejects past `load()`, so `startGatowayCore()`'s `await layoutStore.load()` (`index.ts:114`) can never fail startup because of a layout config problem. Confirmed via the existing test suite (all four scenarios directly tested) and by reading every line of `load()`, not just its tested branches.
- **`LayoutStore.save()`'s atomic write behavior under simulated failure:** Confirmed the core guarantee holds — see QA-013 above for the one gap found (temp-file cleanup on failure) and the fault-injection method used to confirm the target file is never corrupted even when the write-then-rename sequence fails partway.
- **`save()`/`setBinding()`/`removeBinding()` API soundness for a future caller:** Confirmed sound. `setBinding()` and `removeBinding()` both use `samePosition()` (`position.ts`) for controller/position equality, which correctly distinguishes a keypad `{row:0,column:0}` from an encoder `{index:0}` even when numeric fields coincide — the exact class of bug that would otherwise silently corrupt bindings for the wrong controller type. `setBinding()` replaces an existing binding at the same controller/position rather than duplicating it (confirmed by existing test and by reading the `findIndex`/splice-equivalent logic); `removeBinding()` on a plugin type with no profile is a safe no-op, not a throw (confirmed by existing test). No bug found beyond QA-013's narrower cleanup gap in `save()` itself.

---

## Observations

- `focus-profile-routing`'s integration test suite (`focusProfileRouting.integration.test.ts`) applies identical `FIXTURE_BINDINGS` to all three plugin-type profiles it configures (`test-app`/`test-app-a`/`test-app-b`), so it never exercises design.md D3's "position bound only in a different profile" idle-reset scenario at the full `ProfileRouter`-plus-real-socket integration level — only the dedicated unit-level tests (`layoutStore.test.ts`, `configLayoutResolver.test.ts`) use genuinely distinct, non-overlapping multi-profile bindings. I independently confirmed the actual behavior is correct end-to-end (see "Areas Specifically Verified" above), so this is a coverage gap rather than a functional bug, but given this is the exact scenario design.md D3 flags as consequential to get wrong, a dedicated regression test at the integration level (two distinct plugin types with disjoint bindings, one of which never focuses) would close the gap and guard against a future regression that the current fixture's overlapping bindings would not catch.
- `validateLayoutConfig` (`layoutConfig.ts`) does not reject a profile keyed by the empty string (`""`) in the config file's JSON — this is currently harmless (see "Areas Specifically Verified" above: `configLayoutResolver.ts`'s `resolve()` guard makes such a profile permanently unreachable regardless), but a stricter validator could reject it outright as a clearer signal to whoever hand-authors the file that an empty plugin-type key can never be bound to anything. Not a defect; a minor validation-completeness note only.
- No schema/versioning strategy exists yet for the layout config file — this is already tracked as `ARCHITECTURE.md`'s R-3 ("Layout config file has no schema-migration/versioning strategy yet... revisit before any public release") and is correctly out of scope for this change; noting only that this review's findings don't change that assessment.
- No dedicated documentation section exists yet describing the layout config file's JSON schema for a hand-authoring developer (design.md D4 anticipates this living in `docs/PROTOCOL.md` "or a dedicated layout-config doc section, left to doc-writer"). Not a code defect — correctly deferred to `doc-writer` per this change's own design — but worth ensuring it's actually picked up before `/opsx:archive`, alongside the already-open `docs/PROTOCOL.md` gaps from the `focus-profile-routing` review (QA-011/QA-012).

---

## Testing Coverage Assessment

`gatoway-core`'s new tests (`layoutStore.test.ts`, `configLayoutResolver.test.ts`, plus the updated `focusProfileRouting.integration.test.ts` and `profileRouter.test.ts`) are thorough and well-targeted: valid-load, missing-file, invalid-JSON, wrong-shape (including a field-level validation failure), `allPositions()` union/dedup across genuinely distinct profiles, `setBinding`/`removeBinding` (including no-op-on-unknown-plugin-type and replace-not-duplicate semantics), save-then-reload round-trip, and a "no temp file left behind, valid JSON always" happy-path atomic-write test are all directly covered. `configLayoutResolver.test.ts` explicitly tests the falsy-`pluginType`-returns-null guard and cross-profile-no-contamination. `tasks.md` 4.3's claim (existing `focus-profile-routing` tests updated to use a real, test-authored config file) is accurate — I confirmed the old fixture file and its test were both deleted (`git diff --stat main..persisted-layout-config` shows `testFixtureLayoutResolver.ts`/`testFixtureLayoutResolver.test.ts` both removed, `git log` shows this is a single clean commit) and no stale references to either remain anywhere in `src/` or `test/`.

Two gaps, both already covered above: QA-013 (no test exercises a `rename()`/`writeFile()` failure during `save()` — the existing suite only covers the happy path) and the Observation regarding the integration suite's identical-bindings-across-profiles fixture masking the full-stack D3 scenario (correct behavior confirmed independently, but not by any test that ships with this change).

Task 4.4's manual verification is honestly and accurately disclosed in `tasks.md`: the missing/invalid-JSON/wrong-shape fallback and end-to-end TCP resolution were confirmed against a real, standalone-launched Gatoway core process (not just the test suite), while visual confirmation on real Stream Deck+ hardware is correctly marked as deferred (unchecked) pending physical device access, consistent with this project's established pattern for hardware-dependent checks (e.g. `stream-deck-plugin-skeleton`'s task 5.3).

---

## Review Verdict

**Recommendation:** ✅ **Pass** — No Critical or Major issues found. Every area this review was specifically asked to scrutinize checks out under direct, independent fault-injection/end-to-end testing rather than static trust in the implementation's own claims: the `pluginType ?? ""` fallback cannot accidentally resolve a real bound profile (confirmed by trace and by the fact that config-side empty-string profile keys are also unreachable), `allPositions()` genuinely unions across all configured profiles (confirmed with a from-scratch, disjoint two-profile test through the real `ProfileRouter`), missing/invalid/malformed config handling all fail safe with distinct log events and no crash path, and `save()`'s atomic write genuinely protects the target file from corruption under simulated `writeFile`/`rename` failures. One Minor, code-level finding (QA-013: a failed `rename()` during `save()` leaks a temp file, though the target file itself is never corrupted) and one non-blocking testing-coverage Observation (the `focus-profile-routing` integration fixture's identical cross-profile bindings mask the full-stack D3 scenario, independently confirmed correct by this review) are open but do not block progress — the architect may schedule QA-013 whenever `save()` gets its first real caller (the no-code UI), since nothing in this change invokes it yet. This change is ready for `/verify` (including the still-deferred real-hardware visual confirmation from task 4.4) and, following that, `doc-writer` (to add the layout config schema documentation design.md D4 anticipates, alongside the already-open `docs/PROTOCOL.md` gaps from the prior review) and `/opsx:archive`.

---
---

# Interactive Verification Session (`/verify`) — 2026-07-14

**Reviewer:** QA Engineer (interactive, with user)
**Scope:** Hands-on execution of `persisted-layout-config` (branch `persisted-layout-config`, commit `84d293c`) against real Elgato Stream Deck+ hardware, using a hand-authored `layout.json` at the real default config path and the existing `testAppClient.ts` test double.

## Summary

The core mechanism this change introduces — real, config-file-driven position-to-capability binding, keyed by plugin type — is confirmed working correctly end to end on real hardware: a hand-authored two-profile config loaded correctly, resolved correctly through the real Stream Deck plugin for a live test-app connection, and correctly left an unrelated profile's position untouched. Critically, task 4.4's deferred real-hardware verification of D3 (the position union across all configured profiles) was confirmed live and unusually convincingly: a fourth key, bound only under a plugin type that never once connected, correctly showed the idle appearance from the moment Gatoway core started — direct proof `allPositions()` genuinely spans every configured profile, not just ones with active connections.

However, testing the missing-config fallback path surfaced a new, real gap: a **Major, design-level** finding (QA-014) where a full Stream Deck plugin process restart combined with a missing/empty layout config leaves an already-placed dial action stuck showing an uninitialized-looking title indefinitely, with nothing to correct it.

## Issue Log

| ID | Severity | Location | Description | Status |
|----|----------|----------|-------------|--------|
| QA-014 | Major | Interaction between `persisted-layout-config` D4 and `focus-profile-routing` D5 | A full Stream Deck plugin restart with a missing/empty layout config leaves already-placed actions in an inconsistent, uncorrected visual state indefinitely — confirmed live: the dial showed "Dial" (its manifest `Name`, not its declared default `Title` of "Gatoway") and stayed that way | Open |

## Issue Detail

### QA-014 · Major · Design-level gap (D4 × D5 interaction)

**What:** `persisted-layout-config`'s D4 decision — "missing config file: Gatoway core runs with zero bindings, `allPositions()` returns an empty list" — combined with `focus-profile-routing`'s D5 persistence mechanism (the Stream Deck plugin remembers "last known render state" per position, purely in-memory, applied on `onWillAppear`) has a gap neither decision's scope covered: what happens to an *already-placed* action's display when the **plugin process itself** restarts (wiping its in-memory render-state memory entirely, not just Gatoway core restarting while the plugin keeps running) **and** no layout config exists to re-derive positions from.

**Scenario:** A user places the generic Key/Dial actions on their device (a one-time setup step, per `stream-deck-idle-display`'s existing model). At some point the Stream Deck plugin process restarts (e.g. the Stream Deck software itself restarts, the user manually restarts the plugin, or — as tested here — `streamdeck restart` during development) while no layout config file exists yet (a very plausible fresh-install scenario, not an exotic edge case). Because the plugin's in-memory render-state memory is wiped by the restart, and Gatoway core's idle sweep has zero positions to send anything for (per D4, correctly, since it has no config to derive positions from), nothing tells the freshly-restarted plugin what any position should show. Whatever appears is undefined behavior specific to the SDK/hardware, not anything Gatoway's design actually guarantees.

**Evidence:** Live-confirmed with the user. After restoring a working config, focusing, blurring, and confirming normal idle appearance on all 4 positions (3 keys + 1 dial, one key deliberately bound only under a never-connecting second plugin type to test D3), the config file was moved aside and the plugin restarted (`streamdeck restart`). Gatoway core's log correctly showed `layout_config_missing` and started normally (no crash — D4's stated behavior holds). But: the 3 keypad positions continued showing "Gatoway" (confirmed by the user to be coincidental — physical Stream Deck keys retain their last-pushed image at the hardware level, independent of the plugin process's own state), while the dial showed **"Dial"** — its manifest `Name` field, not the `Title: "Gatoway"` its manifest actually declares as the default state — and remained stuck showing "Dial" even several seconds later, confirmed unchanged by the user on a direct follow-up check. Restoring the config file and restarting again immediately corrected all 4 positions back to "Gatoway" (confirmed by the user), proving the underlying mechanism is sound once Gatoway core has positions to sweep — the gap is specifically the no-config-plus-restart combination.

**Impact:** A real user setting up Gatoway for the first time (no config file created yet) who restarts the Stream Deck plugin at any point (including simply relaunching the Stream Deck software, a completely ordinary occurrence) can end up with a permanently confusing, uninitialized-looking dial display, with no built-in way for the system to correct it short of creating a config file (even an empty/placeholder one) and restarting again. This is a first-run experience gap, not a rare edge case.

**Suggested fix direction:** Not a simple code patch — the underlying question is architectural: should the Stream Deck plugin guarantee a sane default appearance for any placed action **independent of** whatever Gatoway core's config currently knows, rather than relying entirely on a server-driven idle sweep whose position knowledge comes solely from the loaded layout config? A plausible direction: have the plugin's own `onWillAppear` handler apply a hardcoded local baseline (matching the manifest's own declared default — label "Gatoway", default icon) immediately whenever no remembered render state exists for a position, *before* and independent of anything Gatoway core sends — restoring the original static-Idle-action's reliable "always shows something sane immediately" guarantee, while still letting a later `render_update` override it once Gatoway core has something real to say. This needs a real design decision (does `LayoutResolver`/`allPositions()` need to change, or is this purely a Stream Deck plugin-side fix?), not a guess implemented ad hoc.

**Root-cause level:** Design. This is a genuine gap in how two already-made decisions (`persisted-layout-config` D4, `focus-profile-routing` D5) interact under a combination neither one's scope considered — not an implementation mistake within either decision as written.

## Checks Completed

- **Real config load:** hand-authored a two-profile `layout.json` at the real default config path (`~/Library/Application Support/gatoway/layout.json`, no env override — matching how the Stream-Deck-spawned Gatoway core actually resolves its config path); confirmed `layout_config_loaded` with `profileCount: 2` in the real log.
- **D3 (union across profiles), live, without a second connection:** a key bound only under a plugin type that never connects (`test-app-other`) correctly showed the idle appearance from Gatoway core's very first startup sweep — confirmed both in the log (4 positions swept, not 3) and visually by the user after placing that fourth action.
- **Real end-to-end resolution through the actual Stream Deck plugin:** the existing `test-app` test-double client registering and focusing correctly rendered "Fixture A"/"Fixture B"/"Fixture Dial" at their configured positions, while the unrelated fourth position remained idle throughout — confirmed by the user.
- **Idle reversion:** blur and disconnect both correctly reverted all three "test-app"-bound positions to idle, confirmed by the user.
- **Missing-config fallback:** confirmed safe (no crash, correct log event) but surfaced QA-014 above.
- **Config restoration:** confirmed a subsequent restart with the config back in place immediately corrects all 4 positions, including the previously-stuck dial.

## Review Verdict (this session)

**Recommendation:** ⚠️ **Conditional pass** — The core file-backed binding mechanism (loading, resolution by plugin type, the D3 union behavior) is fully confirmed correct on real hardware, including the specific scenario task 4.4 deferred. One Major, design-level finding (QA-014) is open: the interaction between a missing config and a full plugin restart can leave placed actions in an inconsistent, uncorrected state indefinitely — a real first-run risk, not a rare edge case. The main agent should route this to `/design-architecture` (or handle as a design revision within this change, given it directly touches this change's own D4) before archiving, since it affects the actual first-run experience this change is meant to unblock.

---
---

# QA-014 Fix Re-Verification — 2026-07-14

**Reviewer:** QA Engineer (interactive, with user)
**Scope:** Re-checking the developer's QA-014 fix (commit `6dd1e8a`: `genericKeyRenderer.ts`/`genericDialRenderer.ts` now apply a local default baseline — the manifest's declared label/icon — whenever no remembered render state exists, independent of Gatoway core) by reproducing the exact original failure scenario live.

## Outcome: Resolved, confirmed by direct reproduction

Reproduced the identical sequence that originally surfaced QA-014: the layout config file was removed and the Stream Deck plugin was restarted (`streamdeck restart`), reproducing a full plugin-process restart with no config file present — the exact combination that previously left the dial stuck showing "Dial" indefinitely.

**Result:** the dial now correctly shows "Gatoway" immediately, confirmed directly by the user, with no stuck or uninitialized appearance. The config file was then restored and the plugin restarted again; all four positions (three keypad, one dial) were confirmed correct afterward.

187 tests pass across both packages (up from 165 before this fix cycle), typecheck clean for both.

## Final Review Verdict

**Recommendation:** ✅ **Pass** — QA-014 is confirmed resolved by direct reproduction of the original failure scenario, not just by trusting the fix's own unit tests. Both the core file-backed binding mechanism (this change's primary purpose) and the local-default-baseline fix are now fully verified on real hardware. This change is ready for `doc-writer` (the layout config schema documentation design.md anticipates, plus the already-open `docs/PROTOCOL.md` gaps if any remain) and `/opsx:archive`.

---
---

# Static Review Session — 2026-07-14 — `wildcard-origin-allowlist`

**Reviewer:** QA Engineer
**Scope:** Static review of the OpenSpec change `wildcard-origin-allowlist` (branch `wildcard-origin-allowlist`, HEAD `e82ed94`) — `isOriginAllowed()`'s new trailing-wildcard prefix-match support in `gatoway-core/src/auth/originAllowlist.ts`, its new unit and integration tests, `docs/PROTOCOL.md`/`gatoway-core/README.md`'s documentation updates, and `ARCHITECTURE.md` AD-5 (amended v1.5). Reviewed against `proposal.md`, `design.md` (D1-D3), the `plugin-authentication` capability delta spec, and `tasks.md`. Full `gatoway-core` test suite (127 tests) and typecheck were re-run and pass.

## Summary

This is a small, correctly-scoped change with no Critical or Major issues. The core logic — `entry.endsWith("*")` selecting a prefix match via `origin.startsWith(entry.slice(0, -1))`, falling through to the pre-existing exact `entry === origin` check otherwise — correctly handles every edge case this review was specifically asked to check: a bare `*` entry matches everything (by construction, not special-cased, exactly as `design.md` 1.2 and `tasks.md` 1.2 intend and as a dedicated test confirms); an entry with `*` anywhere other than the final character is never treated as a wildcard at all (confirmed by code trace — `endsWith("*")` only inspects the last character, so a mid-string `*` falls straight to the unchanged exact-match branch), correctly keeping the change scoped to a single trailing wildcard per `design.md` D1; an empty-string entry can never match a real origin (and is filtered out of the allowlist entirely upstream by `config.ts`'s pre-existing `parseAllowlist`, so it's doubly unreachable in production); and no case normalization is applied anywhere in the matching path, which is unchanged from the pre-existing exact-match behavior (not a regression) and is a low real-world risk since both Chrome extension ids and Firefox's RFC 4122 UUIDs are always lowercase and browsers canonicalize scheme/host to lowercase in the `Origin` header regardless. The full diff is genuinely minimal and additive: only `originAllowlist.ts`'s matching logic changed (15 lines), the pre-existing `entry === origin`/`allowlist.includes(origin)` comparison is preserved byte-for-byte in the non-wildcard branch, and nothing else in the WebSocket upgrade path, `config.ts`'s parsing, or any other capability was touched — existing exact-match behavior is genuinely unchanged, not just claimed unchanged.

The new integration test (`wsListener.test.ts`, beyond what `tasks.md` explicitly required) is a real, meaningful addition: it starts a genuine `startWsListener()` instance and drives a real `ws` client through an actual HTTP-upgrade handshake with `origin: "moz-extension://some-per-install-uuid"`, asserting the resulting connection reaches `authenticated` state via a real `ConnectionManager` — this exercises the real WebSocket upgrade path (header extraction, `isOriginAllowed()` call site, state transition), not just the unit-level function, and correctly mirrors the pre-existing exact-match sibling test's structure.

Two Minor findings and a few non-blocking Observations are noted below; none of them touch the core matching logic, which is sound.

---

## Issue Log

| ID | Severity | Location | Description | Status |
|----|----------|----------|-------------|--------|
| QA-015 | Minor | `gatoway-core/test/unit/originAllowlist.test.ts` | No test asserts that an entry with `*` in a non-trailing position (e.g. `moz-extension://*.example`) is treated as an exact-match literal, not a wildcard — the one specific out-of-scope-boundary case this change's own `design.md` D1 exists to guard, confirmed correct today only by code trace | Open |
| QA-016 | Minor | `openspec/changes/wildcard-origin-allowlist/tasks.md:12` | Task 2.5 ("Manually verify: run the existing manual WebSocket test client with `GATOWAY_ALLOWED_ORIGINS=moz-extension://*`...") is marked `[x]` complete with no evidence trail (no note in `tasks.md`, the commit message, or elsewhere) describing what was actually run or observed | Open |

**Status values:**
- `Open` — not yet fixed; needs architect attention
- `Resolved in review` — fixed or clarified during the review conversation
- `Deferred` — acknowledged, decision made to address in a later cycle

---

## Issue Detail

### QA-015 · Minor · `gatoway-core/test/unit/originAllowlist.test.ts`

**What:** `design.md` D1 is explicit that only a *single trailing* wildcard is supported — "no wildcard positions other than a single trailing one." The implementation correctly enforces this (`entry.endsWith("*")` only ever inspects the final character of an entry; anything with a `*` elsewhere in the string falls straight through to the unchanged `entry === origin` exact-match branch, which will essentially never match a real origin unless the origin itself literally contains a `*` character). I confirmed this is correct by direct code trace and manual reasoning (e.g. `moz-extension://*.example` does not end in `*`, so `isOriginAllowed("moz-extension://foo.example", ["moz-extension://*.example"])` returns `false`, and `isOriginAllowed("moz-extension://*.example", ["moz-extension://*.example"])` — an origin that happens to literally contain `*` — would return `true`, both consistent with "exact match, no wildcard interpretation"). No test in `originAllowlist.test.ts` exercises this case, however — the four new wildcard tests cover a trailing wildcard, mixed exact+wildcard lists, and a bare `*`, but none cover a non-trailing `*`.

**Scenario:** A future refactor of `isOriginAllowed()` (e.g. switching from `entry.endsWith("*")` to a naive `entry.includes("*")` check, or introducing a small regex-based implementation for readability) could silently widen the matching rule beyond the documented single-trailing-wildcard scope, and nothing in the test suite would catch it.

**Evidence:** `grep -n "\*" gatoway-core/test/unit/originAllowlist.test.ts` shows only trailing-`*` and bare-`*` entries; no entry like `"moz-extension://*.example"` or `"foo*bar"` appears anywhere in the test file.

**Impact:** Low today — the current implementation is correct, confirmed by direct trace, not merely assumed. But this is exactly the boundary `design.md` D1 was written to hold the line on ("no wildcard positions other than a single trailing one"), and it's the one review area explicitly called out as needing verification that a `*` anywhere else is *not* silently treated as a wildcard; a regression here would silently expand the security-relevant matching rule with no test failure to flag it.

**Suggested fix direction:** Add a unit test asserting an entry with a non-trailing `*` (e.g. `"moz-extension://*.example"` or `"foo*bar"`) is treated as a literal exact-match string and does not match any origin sharing only a partial prefix/suffix around the `*`.

**Root-cause level:** Code (test coverage gap only — the implementation itself is correct as traced).

---

### QA-016 · Minor · `openspec/changes/wildcard-origin-allowlist/tasks.md:12`

**What:** Task 2.5 reads: "Manually verify: run the existing manual WebSocket test client with `GATOWAY_ALLOWED_ORIGINS=moz-extension://*` and confirm both a `moz-extension://<uuid-A>` and `moz-extension://<uuid-B>` origin are both accepted, while a non-matching origin is still refused" and is checked off (`[x]`) in the commit that implements this change. Unlike other manual-verification task notes elsewhere in this project's history (e.g. `persisted-layout-config` task 4.4's tasks.md annotation explicitly describing what was confirmed against a real, standalone-launched process), there is no annotation on this line, no note elsewhere in `tasks.md`, and no mention in the commit message (`e82ed94`) of what was actually run or observed.

**Scenario:** A reader (architect, future QA session, or `/verify`) takes this checkbox at face value and assumes the live manual-client check already happened, when — based on the available evidence — it's equally possible this box was checked as a matter of course alongside the (genuinely completed) automated-test tasks in the same group.

**Evidence:** `git log e82ea94 --format=%B` shows no reference to a manual client run; `tasks.md`'s diff shows only the checkbox flipping from `[ ]` to `[x]` with no added prose, in contrast to this project's own established pattern (seen repeatedly elsewhere in this report) of disclosing exactly what a manual check did or didn't confirm.

**Impact:** Low — this is the same category of gap this project's own QA history has flagged before (`stream-deck-plugin-skeleton`'s QA-008: an inaccurate/unverifiable self-reported task-completion claim), and the underlying automated coverage (unit tests 2.1-2.4, plus the new real-upgrade integration test) already gives good confidence the behavior is correct even without this specific manual run. But the claim itself is unverifiable from the artifacts alone.

**Suggested fix direction:** Either confirm and briefly document what was actually observed when task 2.5 was run (a one-line note, matching this project's own established convention), or treat it as not yet done and pick it up during `/verify` alongside whatever other manual/hardware checks that session covers.

**Root-cause level:** Process (task-tracking accuracy), not a functional defect — the underlying feature is already well-covered by the automated real-upgrade integration test regardless of whether this specific manual step was performed.

---

## Areas Specifically Verified (per review scope)

- **Bare `*` entry:** Confirmed correct and genuinely not special-cased. `"*".endsWith("*")` is `true`; `"*".slice(0, -1)` is `""`; `origin.startsWith("")` is `true` for any string — so a bare `*` matches everything purely as a fallout of the general rule, exactly as `design.md` 1.2 and `tasks.md` 1.2 require, and a dedicated test (`"treats a bare '*' entry as matching any origin"`) confirms this against two different origins.
- **Non-trailing `*` is NOT treated as a wildcard:** Confirmed correct by code trace (see QA-015) — `entry.endsWith("*")` is the only branch condition, so any entry with `*` elsewhere always falls to the unchanged exact-match comparison. This is the one area of this review's specific scope where the behavior is correct but under-tested; see QA-015.
- **Empty-string entry:** Confirmed harmless. At the `isOriginAllowed()` level, `"".endsWith("*")` is `false`, so it falls to `"" === origin`; since `origin` is guaranteed non-falsy by the earlier `if (!origin) return false` guard (unchanged from before this diff), an empty-string entry can never match a real request. It's also unreachable in production regardless, since `config.ts`'s pre-existing `parseAllowlist()` (untouched by this diff) already filters out zero-length entries after trimming (`gatoway-core/src/config.ts:67-75`).
- **Case sensitivity:** Confirmed no normalization occurs anywhere in this path — `wsListener.ts:103`'s `request.headers.origin` is passed through verbatim (Node lowercases header *names*, not values), and both the exact-match and prefix-match comparisons in `isOriginAllowed()` are case-sensitive string operations. This is unchanged from the pre-existing exact-match-only implementation (not a regression introduced here), and is a low real-world risk in practice: browsers canonicalize a URL's scheme and host to lowercase before setting `Origin`, so a real Chrome extension id or Firefox UUID will never arrive in unexpected casing. Noted as an Observation, not a defect.
- **Existing exact-match behavior is genuinely unchanged:** Confirmed by reading the full diff, not just the new wildcard branch — the non-wildcard branch (`entry === origin`) is character-for-character the same comparison the old `allowlist.includes(origin)` performed (`Array.prototype.includes` uses `===`/SameValueZero semantics), just relocated inside `.some()`'s callback. No other file in the diff touches the WebSocket upgrade flow, `ConnectionManager`, or `config.ts`'s allowlist parsing.
- **New integration test exercises the real upgrade path, not just the unit function:** Confirmed. `wsListener.test.ts`'s new wildcard test starts a genuine `startWsListener()` instance and a real `ws` client with the `origin` option (which sets the actual `Origin` request header on the HTTP upgrade), and asserts the resulting `ConnectionManager` record reaches `authenticated` state — the same structure as the pre-existing exact-match sibling test, and a materially different (and more convincing) check than merely calling `isOriginAllowed()` directly.
- **Documentation accuracy, including the "single trailing wildcard only" scope limitation:** `docs/PROTOCOL.md` explicitly states "Only a single trailing `*` is supported — this is a prefix match, not a general glob/regex," directly and clearly documenting the scope boundary. `gatoway-core/README.md`'s `GATOWAY_ALLOWED_ORIGINS` table entry and its "Auth token file" section (where the fuller Chrome-vs-Firefox guidance now lives) both accurately describe trailing-wildcard-vs-exact-match behavior and give a concrete combined example (`GATOWAY_ALLOWED_ORIGINS=chrome-extension://<id>,moz-extension://*`); README's version doesn't repeat PROTOCOL.md's explicit "not a general glob/regex" wording verbatim but isn't inaccurate — it consistently describes the behavior as "trailing-wildcard prefix match" throughout. `ARCHITECTURE.md` AD-5's v1.5 amendment accurately summarizes the change, its rationale (Firefox's per-install UUID), and correctly lists full glob/regex matching as a rejected alternative, matching `design.md` D1.

---

## Observations

- `gatoway-core/README.md`'s new Chrome-vs-Firefox guidance (lines 123-137) was added under the existing `### Auth token file` heading, which now documents two conceptually distinct authentication mechanisms (the TCP token file, and the unrelated WebSocket Origin allowlist) under a heading name that no longer fully describes its own contents. The cross-reference from the `GATOWAY_ALLOWED_ORIGINS` table row (`see [Auth token file](#auth-token-file) below`) is technically correct — the anchor does exist and does contain the relevant content — but a reader following it to learn about Origin allowlisting lands under a heading titled after a different mechanism entirely. Not a defect; a minor structural/naming clarity nit the architect or `doc-writer` may want to tidy up (e.g. a dedicated `### WebSocket Origin allowlist` subsection) whenever this section is next touched.
- `design.md`'s own Risk entry ("a malformed wildcard entry could be configured by mistake... mitigation: document the expected shape clearly") is honored by the documentation but, consistent with the explicit decision not to add runtime validation, means a typo like `moz-extension://**` (double trailing asterisk) silently degenerates to a literal-`*`-containing exact-match prefix that will essentially never match any real origin — a safe (fail-closed) direction for a typo, not a security risk, but worth the architect's awareness that no diagnostic (log warning, startup validation) exists to catch this class of misconfiguration; purely cosmetic/UX, matching `design.md`'s explicit "not adding validation ceremony" trade-off.

---

## Testing Coverage Assessment

The five new unit tests (`originAllowlist.test.ts`) directly cover every scenario `tasks.md` 2.1-2.4 asked for, plus the bare-`*` case from task 1.2, and the existing pre-wildcard tests (exact match, non-match, undefined origin, empty allowlist) are untouched and still pass — confirming no regression in the existing contract. The new integration test (`wsListener.test.ts`) goes beyond `tasks.md`'s literal requirements by exercising the real WebSocket upgrade path end-to-end for a wildcard entry, mirroring the existing exact-match integration test's structure closely (though it does not additionally round-trip a `register`/`register_ack` message the way the exact-match sibling test does — a minor asymmetry, not a gap, since confirming `authenticated` state is sufficient to prove the Origin-matching path itself works, and the register/ack round-trip is already proven generically by the sibling test).

The one confirmed gap is QA-015: no test guards the "a `*` anywhere other than the final character is not treated as a wildcard" boundary, despite this being the specific out-of-scope case `design.md` D1 exists to hold the line on. The behavior is correct today (confirmed by trace), but unguarded against regression.

Full suite: 127/127 `gatoway-core` tests pass (`npm test`), `tsc --noEmit` clean. No stream-deck-plugin changes in this diff, so that package's suite is unaffected and was not re-run as part of this review.

---

## Review Verdict

**Recommendation:** ⚠️ **Conditional pass** — No Critical or Major issues. The core wildcard-matching logic is correct for every edge case this review specifically scrutinized (bare `*`, non-trailing `*`, empty-string entries, case sensitivity), existing exact-match behavior is genuinely unchanged (confirmed via full-diff review, not just the touched function), and the new integration test meaningfully exercises the real WebSocket upgrade path rather than just the unit-level function. Documentation accurately describes the implemented behavior, including the "single trailing wildcard only, not full glob" scope limitation. Two Minor, non-blocking findings are open: QA-015 (missing regression test for the non-trailing-`*`-is-not-a-wildcard boundary — code is correct, coverage is not) and QA-016 (an unverifiable manual-verification task-completion claim in `tasks.md`, a process/tracking-accuracy gap rather than a functional one). Neither blocks progress; the architect may schedule either now or defer QA-015 to a follow-up test-hardening pass, and may route QA-016 to `/verify` for a live confirmation of the manual WebSocket client check. This change is ready to proceed to `/verify` and, following that, `doc-writer` (for the minor README section-naming tidy-up, at the architect's discretion) and `/opsx:archive`.

---
---

# Static Review Session — 2026-07-15 — `document-plugin-reconnection`

**Reviewer:** QA Engineer
**Scope:** Static review of the OpenSpec change `document-plugin-reconnection` (branch `document-plugin-reconnection`, working tree clean at HEAD) — a documentation-only change formalizing already-implemented reconnection behavior. Reviewed: `proposal.md`, `design.md`, `tasks.md`, the two modified capability specs (`specs/message-protocol/spec.md`, `specs/focus-tracking/spec.md`), the new "Reconnection" section and cross-links in `docs/PROTOCOL.md`, and the new integration test in `gatoway-core/test/integration/focusProfileRouting.integration.test.ts`. The specs' claims were checked directly against the real implementation (`gatoway-core/src/connection/connectionManager.ts`, `messageHandler.ts`, `gatoway-core/src/focus/focusTracker.ts`, `gatoway-core/src/routing/profileRouter.ts`), not merely trusted. Verified against `REQUIREMENTS.md` and `ARCHITECTURE.md`. Full diff against `main` was reviewed (`git diff main...document-plugin-reconnection --stat`) to confirm scope.

---

## Summary

This change is exactly what it claims to be: a documentation- and spec-completeness-only change with no runtime behavior modification. The full diff against `main` touches only `docs/PROTOCOL.md`, one integration test file, and the `openspec/changes/document-plugin-reconnection/` artifacts (including checking off `tasks.md`) — no file under `gatoway-core/src/` or `stream-deck-plugin/src/` is touched. I traced the two claimed behaviors directly against the real code rather than accepting the developer's "already correct" assertion: `ConnectionManager.accept()` assigns every new connection a fresh `randomUUID()` record with `pluginType`/`capabilities` left `undefined` until `setPluginInfo` is called, and `disconnect()` deletes the record from the map outright with no fallback path that could resurrect a prior connection's state — so a reconnecting connection genuinely has no capability manifest until it sends a fresh `register`, exactly as the new message-protocol scenario states. Similarly, `FocusTracker.clearIfFocused()` is wired via `ConnectionManager.onDisconnect` → `ProfileRouter.handleDisconnect` to run on every disconnect, and `FocusTracker` holds only a single `focusedConnectionId | null` with no per-plugin memory — so focus is genuinely not restorable across a reconnection without an explicit fresh `focus: true`, exactly as the new focus-tracking scenario states. Both new spec scenarios are accurate.

The new integration test is a genuine disconnect-then-reconnect test, not two independent connections dressed up to look related: it registers and focuses an `original` client, calls `original.close()` (a real client-side socket close that triggers the server-side `connection_disconnected` → `handleDisconnect` → focus-clear path, confirmed by the idle-revert `render_update` count assertion immediately after), and only then opens brand-new sockets (`connectOnly`/`connectAndRegister`) against the same running server and port to simulate the reconnecting plugin — confirming in sequence that (a) a message sent before a fresh `register` gets the connection closed exactly like any never-registered connection, (b) a freshly-registered-but-not-yet-focused reconnection produces no bound-profile sweep, and (c) only an explicit fresh `focus: true` triggers the bound sweep. `docs/PROTOCOL.md`'s new "Reconnection" section is accurate against the code, and every cross-link (`#authentication-and-registration`, `#focus-tracking`, `#reconnection`) resolves correctly to a real heading — I verified this by grepping the actual `##`/`###` headings in the file rather than assuming GitHub's slug convention. The unrelated stale-anchor fix (`#authentication` → `#authentication-and-registration`) is a trivial, correct one-line correction consistent with the existing heading. Full `gatoway-core` suite (129/129) passes and `tsc --noEmit` is clean.

No Critical, Major, or Minor issues were found. One Observation is worth the architect's awareness, unrelated to a defect in this change.

---

## Issue Log

No Open issues. This session raised no findings requiring the `Issue Log` table.

---

## Areas Specifically Verified (per review scope)

- **Message-protocol spec scenario accuracy:** Confirmed against `connectionManager.ts`'s `accept()` (new `randomUUID()` per connection, no state inherited) and `setPluginInfo()`/`ConnectionRecord.capabilities` (optional field, `undefined` until a `register` is processed on *that* connection's own ID). A prior connection's disconnect deletes its record from the `Map` outright (`disconnect()`), so there is no code path by which a new connection could read a prior one's `capabilities`/`pluginType`. The scenario's wording ("the new connection has no capability manifest until it sends a fresh `register` message") matches exactly.
- **Focus-tracking spec scenario accuracy:** Confirmed `FocusTracker` holds a single `focusedConnectionId: string | null` with no per-plugin/per-`pluginType` history, and `clearIfFocused` is invoked unconditionally on every disconnect via `index.ts`'s `manager.onDisconnect((record) => profileRouter.handleDisconnect(record.id))` → `profileRouter.ts:78`. Since the new connection also gets a brand-new connection ID (see above), there is no mechanism by which the new connection could ever be recognized as focused without its own explicit `focus: true`. Matches the scenario exactly.
- **Genuineness of the new integration test:** Confirmed `TestDoubleClient.close()` (pre-existing, `focusProfileRouting.integration.test.ts:154`) performs a real socket close, and the new `connectOnly`/`connectAndRegister` calls after it open genuinely new `net.Socket` connections via `connectTo(port)` against the same live `TcpListenerHandle` — not a shared/reused socket or a mocked reconnection. The test's own assertions (idle-revert sweep count after `original.close()`, rejection of a pre-register `focus` message, no bound sweep until fresh `register`+`focus`) directly exercise the causal chain this change documents, not merely a coincidental similarity between two connections. Test run in isolation: 12/12 pass.
- **Cross-link/anchor accuracy in `docs/PROTOCOL.md`:** Grepped the file's actual `##`/`###` headings and every `#...` link target referencing them; `#authentication-and-registration` (heading at line 55), `#focus-tracking` (heading at line 162), and `#reconnection` (heading at line 193, the new section itself) all resolve correctly. No dangling links introduced.
- **Scope of the diff — confirming no runtime code was touched:** `git diff main...document-plugin-reconnection --stat` (excluding the `openspec/` directory) shows exactly two files changed: `docs/PROTOCOL.md` and `gatoway-core/test/integration/focusProfileRouting.integration.test.ts`. No file under `gatoway-core/src/` or `stream-deck-plugin/` appears in the diff at all — the "documentation-only, no behavior change" claim in `proposal.md`/`design.md` is accurate, not merely asserted.
- **Regression check:** `npm test` in `gatoway-core/` — 129/129 tests pass across 18 files (up from 128 prior to this test addition, consistent with exactly one new test being added). `npx tsc --noEmit -p tsconfig.json` — clean, zero errors.

---

## Observations

- `REQUIREMENTS.md` FR-006's acceptance criterion reads "Gatoway logs connection lifecycle events (connect, disconnect, **reconnect**)," but there is no distinct `reconnect` log event anywhere in `gatoway-core/src` — a reconnection is only observable in the log as an unrelated pair of `connection_accepted`/`connection_disconnected` events with two different, uncorrelated connection IDs, with nothing tying them together as "the same logical plugin reconnecting." This is a pre-existing characteristic of the logging design, not something introduced or claimed to be addressed by this change (this change's scope is the `register`/`focus` protocol semantics on reconnection, not logging), so it is not a defect in this change. Flagging only because a literal reading of FR-006's acceptance criterion could be interpreted as expecting a first-class "reconnect" log event, which does not exist; the architect/requirements owner may want to clarify whether FR-006 is satisfied by the current connect+disconnect pair alone or whether a correlated reconnect signal was intended. **Root-cause level: requirements** (ambiguity in FR-006's literal wording vs. what's implemented) — not a code defect, and out of scope for this change to fix.

---

## Testing Coverage Assessment

`tasks.md` 2.1 asked the developer to first confirm whether existing coverage already exercised the reconnect scenarios and only add a test if a genuine gap existed; the developer's judgment that a gap existed is correct — I searched `focusTracker.test.ts` and the pre-existing `focusProfileRouting.integration.test.ts` tests and found no prior test that opened a second, independent connection after closing a first one on the same running server to confirm state does not carry over; all prior multi-connection tests in that file exercise two *simultaneously live* connections (e.g. focus superseding between `test-app-a`/`test-app-b`), not a disconnect-then-reconnect sequence. The new test closes this specific gap directly, at the integration level (real TCP sockets, real running `ConnectionManager`/`FocusTracker`/`ProfileRouter`), which is the appropriate level for a cross-component behavior like this — a unit test on `FocusTracker` alone would not have exercised the `ConnectionManager` disconnect-cleanup and the fresh-ID-on-reconnect aspects together. `tasks.md` 2.2's manual real-instance verification is marked complete by the developer; I did not independently re-run that manual check in this static session (it is a `/verify`-style live check), but the automated coverage added is sufficient to support the spec scenarios' claims on its own.

Full suite: 129/129 `gatoway-core` tests pass (`npm test`), `tsc --noEmit` clean. No `stream-deck-plugin` changes in this diff, so that package's suite is unaffected and was not re-run.

---

## Review Verdict

**Recommendation:** ✅ **Pass** — No Critical, Major, or Minor issues found. This is a genuine documentation- and spec-completeness-only change: the full diff touches only `docs/PROTOCOL.md` and one integration test file (plus the OpenSpec change artifacts), with zero changes under `gatoway-core/src/` or `stream-deck-plugin/`. Both new spec scenarios (message-protocol's "Reconnecting plugin must register again," focus-tracking's "Reconnecting plugin must re-assert focus") were verified directly against the real implementation, not merely trusted, and both are accurate. The new integration test is a genuine disconnect-then-reconnect exercise against real sockets on a real running server, not two independent connections coincidentally resembling one. `docs/PROTOCOL.md`'s new "Reconnection" section and all three of its cross-links resolve to real, correct headings. The full test suite (129/129) passes and the typecheck is clean. One non-blocking Observation (a requirements-level ambiguity in FR-006's "reconnect" logging wording, pre-existing and out of scope here) is noted for the architect's awareness only. This change is ready for `/verify` and, following that, `doc-writer` and `/opsx:archive`.

---
---

# Static Review Session — 2026-07-15 — `validate-capability-payloads`

**Reviewer:** QA Engineer
**Scope:** Static review of the OpenSpec change `validate-capability-payloads` (branch `validate-capability-payloads`, HEAD `c242782`) — capability-shape validation added at two points: `register`'s `capabilities` array (`gatoway-core/src/protocol/capabilityValidation.ts` new, `messageHandler.ts`'s `resolveCapabilities`/`handleRegister`) and `capability_update`'s `icon`/`label`/`state` fields (`profileRouter.ts`'s `handleCapabilityUpdate`). Reviewed against `proposal.md`, `design.md` (D1–D4), the two delta specs (`message-protocol`, `profile-routing`), `tasks.md`, `docs/PROTOCOL.md`'s diff, `REQUIREMENTS.md`, and `ARCHITECTURE.md`. I did not rely on the developer's claims alone: I ran the full test suite for both packages, read every touched line of source and test code, and — per this session's specific ask to verify partial-acceptance and message-ordering behavior with actual execution rather than static reasoning alone — wrote and ran a temporary, throwaway script (`gatoway-core/test/manual/qaOrderCheck.ts`, not committed, deleted before finishing this session) against a real, running `ConnectionManager`/`ProfileRouter`/TCP listener to inspect the literal byte-level order of messages received over a real socket, mirroring the same temporary-verification-script practice used in the `focus-profile-routing` review (QA-010) earlier in this project's history.

---

## Summary

This is a clean, well-scoped, and correctly-implemented change. Every specific area this session was asked to scrutinize checks out:

- **Partial acceptance is genuinely implemented, not just claimed.** For `register`, `resolveCapabilities` (`messageHandler.ts:91-110`) validates each array entry independently via `forEach((raw, index) => ...)` with no early return and no shared mutable state between iterations — one malformed entry cannot affect whether a different, unrelated entry is accepted. I confirmed this both by reading the code and via the existing unit/integration tests, which exercise two malformed entries with *different* rejection reasons in the same array and confirm both are reported independently while the registration as a whole still succeeds. Same for `capability_update`: `validateCapabilityUpdateFields` (`capabilityValidation.ts:76-104`) checks `icon`/`label`/`state` in three independent `if` blocks with no shared state, and `handleCapabilityUpdate` applies each field's validated value directly to the stored `Capability` object regardless of whether a sibling field was rejected. A committed unit test (`profileRouter.test.ts` "applies only the valid fields...") proves a valid `label` is applied to the live, stored record while an invalid `state` in the *same message* is rejected and left unchanged — genuine partial acceptance at the field level, not merely a mocked assertion.
- **The `register_ack`-before-`error` ordering is real, not just asserted in prose.** `messageHandler.test.ts`'s existing unit test asserts `sent` (the literal, ordered sequence of `connection.send()` calls) via `toEqual` with `register_ack` listed before `error` — a genuine ordered-array assertion, not just "both messages eventually arrive." I went further and confirmed this at the actual wire level: my temporary script registered a connection with one malformed capability against a real, running TCP listener and captured the literal byte order the client received: `["register_ack", "error"]`, with the `error` payload's `rejectedCapabilities` correctly identifying the bad entry. Both `handleRegister` code paths (the TCP credential-validating branch, `messageHandler.ts:206-230`, and the already-authenticated/WebSocket branch, `messageHandler.ts:167-182`) call `sendRegisterAck` immediately before `sendRejectedCapabilitiesError`, synchronously with no `await` between them, so the ordering holds for both transports by construction, not by accident.
- **The register-vs-capability_update `icon`/`null` asymmetry is implemented exactly backwards from how it would be easy to get wrong — i.e., correctly.** `validateCapability` (register-time) accepts only `typeof value.icon === "string"` and explicitly rejects `icon: null` (there's a dedicated, clearly-commented unit test for this: "rejects icon: null at register time (unlike capability_update's three-way semantics)"). `validateCapabilityUpdateFields` accepts `payload.icon === null || typeof payload.icon === "string"`. This is exactly the distinction `design.md` D1 calls for, and it is the one place in this change most likely to be silently swapped by mistake — it isn't.
- **Validation is fully independent per-entry/per-field**, confirmed by both code inspection (no shared state, no short-circuiting between entries/fields) and by tests exercising mixed valid/invalid combinations in a single message.
- **The `error` payload's `details` shape is populated correctly and usefully** — `rejectedCapabilities: { index, reason }[]` and `rejectedFields: { field, reason }[]` are both populated with specific, human-readable reasons (e.g. `"id" must be a non-empty string`, `"state" must be a number`) rather than a generic message, and `index`/`field` correctly identify exactly which entry/field is at fault. Verified directly against real error payloads produced by both the test suite and my live script.
- **`docs/PROTOCOL.md` is accurate against the implemented behavior.** The new "Capability validation errors" section's example payloads, message text, and field descriptions match the actual code strings exactly (I compared them character-for-character against `messageHandler.ts`/`profileRouter.ts`'s literal error message strings), the register-vs-`capability_update` `icon`/`null` distinction is called out explicitly and correctly, and the new heading anchors (`#error-either-direction`, `#capability-validation-errors`) resolve to real headings in the file. This also closes part of the still-open QA-011 gap from `focus-profile-routing` (this document's ongoing accuracy), though QA-011 itself (the pre-existing `capability_update` doc gap from before this change) is a separate, already-tracked item — not re-litigated here.

One Minor, code-level finding did surface, in an area not explicitly called out in this session's scope but adjacent to it: `profileRouter.ts`'s pre-existing `capability_updated` log line is unconditional and was not updated to account for the new possibility that *every* field in a `capability_update` was rejected and nothing was actually applied — the log still unconditionally states "applied live capability_update to stored capability record" even when the stored record was left completely untouched. See QA-016.

Full test suite: `gatoway-core` 155/155 passing (up from 129 before this change), `stream-deck-plugin` 65/65 passing (unaffected, no files touched — confirmed via `git diff --stat`), both packages' `tsc --noEmit` clean.

---

## Issue Log

| ID | Severity | Location | Description | Status |
|----|----------|----------|-------------|--------|
| QA-016 | Minor | `gatoway-core/src/routing/profileRouter.ts:231-256` | The `capability_updated` log event unconditionally logged "applied live capability_update to stored capability record" even when every field in the update was rejected and nothing was actually applied. | **Resolved (commit `1c66228`)** |

**Status values:**
- `Open` — not yet fixed; needs architect attention
- `Resolved in review` — fixed or clarified during the review conversation
- `Deferred` — acknowledged, decision made to address in a later cycle

---

## Issue Detail

### QA-016 · Minor · `gatoway-core/src/routing/profileRouter.ts:236-239`

**What:** `handleCapabilityUpdate`'s pre-existing `logger.info` call —
```ts
this.logger.info(
  { event: "capability_updated", connectionId: connection.id, capabilityId },
  "applied live capability_update to stored capability record",
);
```
fires unconditionally after the per-field validation loop, regardless of whether any field actually passed validation. This log line predates this change (it existed, accurately, when every field was always accepted with no validation at all); this change added the ability for validation to reject some or all fields, but did not revisit this log statement to account for that new possibility.

**Scenario:** A `capability_update` message where every present field (`icon`/`label`/`state`) fails validation — exactly the profile-routing spec's own "All fields invalid, nothing applied" scenario, which this change's own test suite exercises (`profileRouter.test.ts` "applies no changes and reports every field when all fields in the update are invalid").

**Evidence:** I traced that exact test: `manager.get(app.id)?.capabilities` is asserted to equal the original, completely unchanged capability, and the only message sent is the `error` — yet the code path that runs immediately after building `rejectedFields` unconditionally logs `event: "capability_updated"` with message text "applied... to stored capability record." No test in the suite asserts on this log call's content (all existing assertions target the `sent` array and `manager.get(...)`, never the logger), so this specific inaccuracy is invisible to the automated suite, mirroring exactly the kind of gap `gatoway-core-foundation`'s QA-001 and `stream-deck-plugin-skeleton`'s QA-007 previously found in this project — a log statement that no longer accurately reflects what happened once a new code path (validation/rejection) was added nearby.

**Impact:** Low severity — this is purely an observability/log-accuracy gap, not a functional defect; the actual applied/rejected field behavior is correct and separately, accurately reported via the `error` message's `rejectedFields`. But it works directly against this change's own stated purpose (giving plugin authors and whoever debugs Gatoway core's logs an accurate trail of what happened) and against `REQUIREMENTS.md` FR-006/NFR 3.6's intent for detailed, trustworthy logs: someone reading the log in isolation (without cross-referencing the `error` message) would be told an update was "applied" in the one case where it definitely was not.

**Suggested fix direction:** The outcome needed is that this log line (or a differently-worded one) accurately reflects whether anything was actually applied — e.g. only logging `capability_updated` when at least one field was actually applied, or including which fields were applied/rejected in the log's own structured fields rather than a fixed human-readable message that assumes success. Not prescribing the exact wording or condition.

**Root-cause level:** Code. Neither `design.md` nor either delta spec makes any claim about this specific log line's content — this is an implementation detail that fell out of sync with the new validation behavior added right next to it, not a design or requirements gap.

---

## Areas Specifically Verified (per review scope)

- **Partial acceptance, register (`capabilities` array):** Confirmed via code inspection (`resolveCapabilities`'s independent `forEach`) and via both `messageHandler.test.ts` and `focusProfileRouting.integration.test.ts` tests exercising a malformed entry alongside otherwise-valid ones, and every-entry-malformed. One integration test goes further than checking the `error` payload alone: it continues the scenario end-to-end (focuses the connection, sends a real `input_event` over a second real socket, and confirms the resolved `command` arrives correctly for a capability that *was* validly registered alongside the dropped one) — genuine proof the registration is fully functional afterward, not merely accepted in name.
- **Partial acceptance, `capability_update` fields:** Confirmed via `profileRouter.test.ts`'s three dedicated tests (mixed valid+invalid, all-invalid, all-valid) and the integration test, all asserting directly against the live, stored `Capability` object's actual field values after the update — not merely that "no exception was thrown."
- **`register_ack`-before-`error` ordering (design.md D3):** Confirmed via the existing ordered-array unit test assertion and via a live, temporary script against a real TCP socket (see Summary). Order holds for both the TCP-credential-validating path and the already-authenticated/WebSocket path, since both call the same two `sendMessage`-wrapping functions synchronously back-to-back with nothing that could reorder them (`ws.send`/`socket.write` both preserve call order for a single connection).
- **Register-time `icon: null` rejection vs. `capability_update`'s `icon: null` acceptance:** Confirmed by direct reading of `capabilityValidation.ts`'s two validation functions (see Summary) and by a dedicated, explicitly-commented unit test for the register-time rejection case. This is the one place in this change most at risk of an easy off-by-one-concept mistake, and it is implemented correctly.
- **Per-entry/per-field independence:** Confirmed no shared mutable state or early-return-on-first-failure exists in either validation function or either call site; multiple simultaneous rejections (different indices/fields, different reasons) are each reported correctly and independently, per both the existing tests and my own live script.
- **`error` payload `details` shape and usefulness:** Confirmed populated with specific, actionable `reason` strings (never a generic "invalid" or an empty object) and correct `index`/`field` identifiers, both via the test suite and my own live-captured payloads.
- **`docs/PROTOCOL.md` accuracy:** Confirmed the new "Capability validation errors" section's example JSON, message strings, and field descriptions match the actual implementation character-for-character, and that both new heading anchors used elsewhere in the diff resolve to real headings.
- **Backward compatibility (task 1.5, 3.6):** Confirmed the pre-existing "omission means unchanged, explicit array replaces" re-registration semantics (QA-003, from `gatoway-core-foundation`) are untouched by this change when the explicit array is fully valid — the relevant pre-existing tests (`messageHandler.test.ts` "preserves previously-declared capabilities...", "replaces capabilities...") still pass unchanged, and the full suite shows no regressions elsewhere (155/155 `gatoway-core`, 65/65 `stream-deck-plugin`, both typechecks clean).

---

## Observations

- The `error` message's `ErrorPayload.details` field remains typed as `unknown` (pre-existing, from `gatoway-core-foundation`) rather than a discriminated union covering the new `{ rejectedCapabilities }`/`{ rejectedFields }` shapes this change introduces. This is consistent with the pre-existing, intentionally generic `error` message design (D3: "no new message type"), and both new call sites construct `details` correctly by hand — not a defect, just a spot where a future reader of `messages.ts` alone (without `docs/PROTOCOL.md`) wouldn't discover these two `details` shapes from the type system.
- `handleCapabilityUpdate` re-renders the bound Stream Deck position even in the case where every field in the `capability_update` was rejected and nothing changed (the capability's `label`/`icon`/`state` are resent to the display unchanged). This is harmless — it's a full, idempotent restatement of current display state, consistent with how this same code path already behaves for a genuinely valid but no-op update — but combined with QA-016's log-accuracy gap, it means the *only* correct signal that "nothing was actually applied" is the separate `error` message, not the log or the fact that a render was sent.

---

## Testing Coverage Assessment

Both new validation functions have thorough, well-targeted unit tests (`capabilityValidation.test.ts`) covering every documented rule (non-empty `id`/`label`, exact `type` enum, wrong-typed `description`/`icon`/`state`, and the register-vs-`capability_update` `icon`/`null` asymmetry specifically). `messageHandler.test.ts` and `profileRouter.test.ts` each add targeted tests for the mixed-valid/invalid, all-invalid, and all-valid cases at the handler level, asserting against the live stored state and the literal `sent` message sequence (including order, for the register case). The integration suite adds two real-socket tests that carry a malformed-capability registration through to a real, resolved `input_event`/`command` round-trip, which is stronger evidence than a unit test alone that partial acceptance doesn't just "look right" but functions correctly end-to-end. No test in the suite exercises QA-016 directly since it's a log-content assertion, matching the pattern noted in the finding itself.

Manual/live verification (real TCP wire order, real error payload contents) was performed directly in this static session via a temporary, deleted script, in addition to the automated suite — appropriate given this session's specific ask to verify (not just read) the ordering and partial-acceptance claims.

---

## Review Verdict

**Recommendation:** ⚠️ **Conditional pass** — No Critical or Major issues. Every area this session was specifically asked to scrutinize — genuine partial acceptance at both the capability-array and field level, `register_ack`-before-`error` ordering (confirmed live, not just asserted), the register-vs-`capability_update` `icon`/`null` asymmetry, per-entry/per-field independence, and the `error` payload's `details` shape — is implemented correctly and is well-tested. One Minor, code-level finding (QA-016: a pre-existing log line not updated to account for the new "nothing was applied" case) is open but non-blocking; the architect/developer may fix it now or defer it. This change is ready for `/verify` once QA-016 is triaged.

---
---

# Re-verification Session — 2026-07-15 — `validate-capability-payloads` (QA-016)

**Reviewer:** QA Engineer
**Scope:** Re-review of commit `1c66228` ("validate-capability-payloads: fix QA-016 - inaccurate capability_updated log") against the QA-016 finding above. Diff reviewed: `git show 1c66228` (`gatoway-core/src/routing/profileRouter.ts`, `gatoway-core/test/unit/profileRouter.test.ts`). Full test suite and typecheck re-run for both workspace packages on the current working tree (branch `validate-capability-payloads`, HEAD `1c66228`).
**Prepared for:** Technical Architect

## Summary

QA-016 is resolved as claimed. `handleCapabilityUpdate` (`profileRouter.ts:200-256`) now tracks an `appliedFields` array alongside the pre-existing `rejectedFields`, and the previously-unconditional `capability_updated` log is now gated on `appliedFields.length > 0`: when at least one field was actually applied it logs the existing `capability_updated` event (now additionally carrying the `appliedFields` list), and when nothing was applied it logs a distinct `capability_update_not_applied` event carrying `rejectedFields`, with wording ("applied no fields to stored capability record") that no longer claims something happened when it didn't. Both new assertions in `profileRouter.test.ts` check the correct event name, the correct message string, and the correct structured content — not merely "some `logger.info` call occurred." No regressions found: full `gatoway-core` suite (155/155) and `stream-deck-plugin` suite (65/65, unaffected — no files in that package touched) both pass, and both packages' `tsc --noEmit` are clean.

## Re-verification of QA-016

**What was checked:** Read the full current body of `handleCapabilityUpdate` (`profileRouter.ts:180-287`) end to end, not just the diff hunk, to confirm the new `appliedFields` tracking is wired correctly against the pre-existing `rejectedFields` tracking and doesn't change any other behavior (field-application logic, `sendError` call, the post-update render sweep). Then read both modified/added test blocks in full and ran the actual suite rather than trusting the test names alone.

**Code correctness, traced field-by-field:**
- `appliedFields: string[] = []` is declared alongside the pre-existing `rejectedFields` and pushed to in the same three `if (validation.X.ok)` branches that already mutate `capability.X` — i.e., `appliedFields` is populated exactly where (and only where) the stored record is actually written, not inferred separately. There's no path where a field is applied without also being pushed to `appliedFields`, or vice versa.
- The gating condition (`if (appliedFields.length > 0) { ...capability_updated... } else { ...capability_update_not_applied... }`) is a clean if/else — exactly one of the two events fires per call, never both, never neither. This directly fixes the original defect: a case with all fields rejected now produces zero `capability_updated` log calls (confirmed below), instead of one falsely-worded one.
- The `else` branch's `rejectedFields` will correctly be `[]` (not misleading) for the edge case where a `capability_update` supplies none of `icon`/`label`/`state` at all (e.g. only `capabilityId`) — no test in the suite exercises this specific zero-fields-present case, but I traced it directly: `validation.icon`/`.label`/`.state` would all be `undefined` (falsy), so none of the three `if` blocks execute, `appliedFields` and `rejectedFields` both stay `[]`, and the `else` branch logs `capability_update_not_applied` with `rejectedFields: []`. This is accurate (nothing was applied and nothing was rejected — there was simply nothing to act on) and is a pre-existing, harmless gap in test coverage rather than a defect introduced by this fix; not blocking.
- The `sendError` call (only reached when `rejectedFields.length > 0`) and the render-sweep logic below the log block are both untouched by this diff, and I confirmed by reading the surrounding lines that neither was accidentally affected by the refactor (e.g. no accidental early return was introduced by the new `if`/`else`).

**Test correctness — "at least one field applied" path** (`profileRouter.test.ts:499-536`, "applies only the valid fields and sends a follow-up error naming the rejected field"): the scenario applies a valid `label` and an invalid `state`. The new assertion is:
```ts
expect(logger.info).toHaveBeenCalledWith(
  expect.objectContaining({ event: "capability_updated", appliedFields: ["label"] }),
  "applied live capability_update to stored capability record",
);
```
This asserts on the specific `event` name, the specific `appliedFields` content (not just "was called"), and the exact message string — a real content assertion, not a call-count check. I confirmed by tracing the code that `appliedFields` here is genuinely `["label"]` (icon was never present in this payload so its `if (validation.icon)` guard never runs; state was rejected so never pushed) — the test's expected value matches the actual code path exactly, not a coincidentally-passing loose match.

**Test correctness — "all fields rejected" path** (`profileRouter.test.ts:538-585`, "applies no changes and reports every field when all fields in the update are invalid"): this is the exact scenario the original QA-016 finding cited. The new assertions are:
```ts
expect(logger.info).not.toHaveBeenCalledWith(
  expect.objectContaining({ event: "capability_updated" }),
  expect.anything(),
);
expect(logger.info).toHaveBeenCalledWith(
  expect.objectContaining({
    event: "capability_update_not_applied",
    connectionId: app.id,
    capabilityId: "cap.one",
    rejectedFields: [
      { field: "icon", reason: '"icon" must be a string or null' },
      { field: "label", reason: '"label" must be a string' },
      { field: "state", reason: '"state" must be a number' },
    ],
  }),
  "capability_update applied no fields to stored capability record",
);
```
This is precisely the right pair of assertions to close the original gap: the first proves the old, inaccurate `capability_updated` event genuinely never fires in this scenario (not just "some other event also fired"), and the second proves the *correct* event fires, with the *correct* event name, the *correct* connection/capability identifiers, the *correct* full `rejectedFields` content (all three fields, correct reasons, correct order), and the *correct* message string. I ran this exact test in isolation to confirm it passes against the real (non-mocked-away) code path, not just read it:

```
$ npx vitest run --run -t "applies no changes and reports every field when all fields in the update are invalid"
 Test Files  1 passed | 18 skipped (19)
      Tests  1 passed | 154 skipped (155)
```

Both assertions genuinely exercise the fix — this is not a test that would pass equally well against the old, buggy code (I confirmed this by mentally reverting the gating logic: the old unconditional `capability_updated` log would immediately fail the `not.toHaveBeenCalledWith` assertion, and the `capability_update_not_applied` event wouldn't exist at all, failing the second assertion outright).

## Regression check

- Ran `npm test` in `gatoway-core/`: **155/155 tests passing** across all test files — unchanged in count from the pre-fix baseline recorded in the original static review session (the fix's new assertions were added inside two pre-existing `it` blocks rather than as new test cases, so the total test count is expected to stay the same; confirmed this matches the diff, which adds no new `it(...)` blocks).
- Ran `npx tsc --noEmit -p tsconfig.json` in `gatoway-core/`: **clean, zero errors.**
- Ran `npm test` in `stream-deck-plugin/`: **65/65 tests passing**, and `npx tsc --noEmit -p tsconfig.json` clean — confirmed unaffected, since `git diff --stat` for commit `1c66228` shows only `gatoway-core/src/routing/profileRouter.ts` and `gatoway-core/test/unit/profileRouter.test.ts` touched.
- Reviewed `git show 1c66228` in full (not just the two touched functions in isolation) to confirm no unrelated lines were altered; the diff is confined exactly to the described fix and its two targeted test additions.
- No new Critical/Major/Minor issues were found during this re-review.

## Observation (new, non-blocking, process-only)

- The identifier `QA-016` has been used twice in this report for two unrelated findings on two different changes: line 960 (`wildcard-origin-allowlist`'s task-evidence gap, still `Open`) and line 1122 (this session's `profileRouter.ts` log-accuracy fix, now `Resolved`). This is a pre-existing ID-collision in the report's own history, not introduced by this session — I did not renumber past entries, since that would rewrite the historical record this report is supposed to preserve. Flagging so the architect is aware that searching this document for "QA-016" surfaces two distinct, unrelated issues; the main agent/architect should assign the next new finding `QA-017` (the highest ID actually used anywhere in this report) to avoid a third collision.

## Final Review Verdict

**Recommendation:** ✅ **Pass** — QA-016 is confirmed resolved: the log now accurately distinguishes "at least one field applied" from "nothing applied," both new test assertions genuinely check the correct event, message, and structured content (not just that a log call happened), and the "at least one field applied" path's existing behavior is correctly preserved and now additionally carries `appliedFields`. Full test suites for both workspace packages pass (155/155, 65/65) and both typechecks are clean. No new issues were found. This change has no open Critical/Major/Minor issues remaining and is ready for `/verify` and, following that, `doc-writer` and `/opsx:archive`.

---

# Interactive Verification Session (`/verify`) — 2026-07-15 — Live xDender integration

**Reviewer:** QA Engineer (interactive, with user)
**Scope:** First real end-to-end connection from an actual third-party plugin (xDender, the xDesign browser extension) against a standalone Gatoway core instance, coordinated live with a separate xDender-side verification session. Not tied to a single OpenSpec change — this is a live protocol/deployment check against the system as it currently stands on `main`.
**Prepared for:** Technical Architect

## Summary

xDender's WebSocket connection, registration, and focus reporting all worked correctly against real, live third-party data — a genuine, non-fixture confirmation that `validate-capability-payloads`' validation logic and the focus-tracking mechanism both hold up outside the test suite. However, this session also surfaced one real, pre-existing deployment gap (QA-017, Major, code/design-level) and one requirements-level finding (QA-018, Major) that changes the shape of what a future change needs to build. Root cause for QA-018 is **not** a defect in `persisted-layout-config` as specified — the spec was implemented correctly — but the requirement itself no longer matches what the project owner actually needs now that a real plugin is involved.

## Live verification steps and observations

1. **Environment check before connecting anything:** the Stream Deck-spawned Gatoway core instance (PID 79372, child of plugin PID 79371) had no `GATOWAY_ALLOWED_ORIGINS` set at all — confirmed via `ps eww` on the running process. Per `config.ts`, an unset allowlist defaults to `[]` (fail closed), which would have rejected xDender's Firefox `moz-extension://` origin outright. See QA-017 below.
2. Stopped the Stream Deck-spawned instance (killing the plugin process; Elgato's own Stream Deck app auto-restarted it once, spawning a second uninstrumented instance on the same ports, which had to be stopped by quitting the Stream Deck application entirely) and started a standalone `gatoway-core` instance with `GATOWAY_ALLOWED_ORIGINS=moz-extension://*` set explicitly, confirmed via `ps eww` on the new process and a clean `gatoway_core_started` log line (`tcpPort: 47821`, `wsPort: 47822`).
3. **xDender connected successfully:** log shows `connection_accepted` → `connection_authenticated` → `authentication_succeeded` (transport `websocket`) → `message_received` (`register`, `pluginType: "xdesign"`, 8 capabilities: `open-sidebar`, `create-sketch`, `line`, `rectangle`, `circle`, `extrude`, `fillet`, `chamfer`, all well-formed) → `registered` → `register_ack` sent with `status: "ok"`. **No follow-up `error` message was sent**, confirming all 8 real, live capabilities passed `validateCapability()` cleanly — the first live-data confirmation of `validate-capability-payloads`'s validation path outside its own test fixtures.
4. **Focus tracking exercised live:** four `focus` messages arrived in sequence (`true` → `false` → `true` → `false`), each producing a correctly-sequenced `focus_changed` event with accurate `previousConnectionId`/`focusedConnectionId` transitions — matches `focus-tracking` spec exactly.
5. Two earlier `authentication_failed` WebSocket attempts appear in the log (`origin: "https://www.google.com"`, and `origin: "https://oi000582862-eu1-makers-ifwe.3dexperience.3ds.com"` twice) — **confirmed by the user to be unrelated to xDender**, so not investigated further as part of this session; noted only as a curiosity for the user to check separately at their leisure (not a Gatoway-side defect either way — the allowlist correctly rejected an origin it wasn't configured to accept).
6. Checked `layout.json`: contains only leftover `test-app`/`test-app-other` fixture profiles from earlier development sessions — no `xdesign` profile exists. None of xDender's 8 registered capabilities are bound to any physical position. This is expected given the current design (see QA-018), not a bug on its own — but it means the full `input_event` → `command` → capability-action round trip could not be exercised live in this session; only registration and focus were verified end-to-end.

## Issue Log

| ID | Severity | Location | Description | Status |
|----|----------|----------|-------------|--------|
| QA-017 | Major | Deployment/operational gap — `GATOWAY_ALLOWED_ORIGINS`, `gatoway-core/README.md` | No documented way exists to set `GATOWAY_ALLOWED_ORIGINS` (or any `GATOWAY_*` env var) for a Gatoway core instance spawned by the Stream Deck *application*, which is normally launched via the Dock/Finder (GUI), not a terminal shell — it never inherits a shell profile's exported env vars. Confirmed live: the running Stream Deck-spawned instance had no allowlist set at all. | Open |
| QA-018 | Major | Requirements-level — layout/capability-position binding ownership | The protocol has no mechanism for a plugin to provide or suggest *any* layout information — `register` only declares capability shape (id/label/type/icon/state), nothing about desired position. `persisted-layout-config`'s design (correctly implemented as specified) made position-binding 100% host-side and hand-authored, with zero plugin input, deferring any UI for it as post-MVP (`REQUIREMENTS.md` open question #4). The user has now clarified their original intent was that the extension itself would provide/suggest a layout — a materially different model than what was built. This is not a code or design defect in the existing change; the requirement itself needs to be revisited. | Open |

**Status values:**
- `Open` — not yet fixed; needs architect/requirements-owner attention

## Issue Detail

### QA-017 · Major · Deployment/operational gap

**What:** `GATOWAY_ALLOWED_ORIGINS` (and every other `GATOWAY_*` override) is only ever read from `process.env` at Gatoway core startup. When Gatoway core is spawned as a child of the Stream Deck plugin (`AD-1`), and the Stream Deck *application* itself is launched via the Dock/Finder/Login Items rather than a terminal, there is no path by which a user-exported shell environment variable reaches that process tree at all.

**Scenario:** Any real end user (or the project owner, day-to-day) who wants WebSocket-based plugins to work needs a persistent way to set `GATOWAY_ALLOWED_ORIGINS` for a GUI-launched Stream Deck app — every session, not just this one-off terminal-launched standalone test.

**Evidence:** Live-confirmed: `ps eww <pid>` on the Stream Deck-spawned Gatoway core process showed only `GATOWAY_TCP_PORT`/`GATOWAY_TOKEN_FILE` set (both of which come from the plugin's own `coreProcessSupervisor.ts` passing them explicitly to `spawn()`), with no `GATOWAY_ALLOWED_ORIGINS` anywhere. A `launchctl setenv` workaround exists on macOS but is undocumented, macOS-specific, and not a real cross-platform solution.

**Impact:** Any browser-based plugin (xDender today, any future one) cannot connect at all through the normal, GUI-launched Stream Deck path — only through a manually-started standalone instance, which isn't how the product is meant to run day-to-day.

**Suggested fix direction:** Not prescribing the mechanism, but the outcome needed is that `GATOWAY_ALLOWED_ORIGINS` (and likely the other `GATOWAY_*` overrides) can be configured persistently for the Stream Deck-spawned instance without relying on shell environment inheritance — e.g. the Stream Deck plugin's own config file/Property Inspector passing it through to `coreProcessSupervisor.ts`'s `spawn()` call, similar to how `GATOWAY_TCP_PORT`/`GATOWAY_TOKEN_FILE` are already passed today.

### QA-018 · Major · Requirements-level

**What:** No message in the protocol lets a plugin communicate anything about desired physical layout. `Capability` (declared in `register`) has no position hint of any kind. The entire position-to-capability binding lives in a separate, local, hand-authored JSON file (`layout.json`) that Gatoway core reads once at its own startup — completely disconnected from anything a plugin sends.

**Scenario:** A real plugin author (xDender) or the project owner, onboarding a new plugin with several capabilities (xDesign declared 8), currently has no way to get any of them onto the physical device without manually hand-writing JSON bindings and restarting Gatoway core — and the Stream Deck application itself only ever offers a generic, unlabeled "Key"/"Dial" action to drag onto the grid, with no indication anywhere in the Stream Deck UI of what capabilities exist or how to wire one up.

**Evidence:** `docs/LAYOUT_CONFIG.md` states explicitly: "This is a local, per-machine config file, not part of the wire protocol — it is read once by Gatoway core at its own startup, not exchanged with any plugin over TCP or WebSocket." `REQUIREMENTS.md` records this as an intentional, deferred scope decision: "No-code mapping/configuration UI... Deferred because the immediate need is developer-driven." The user has now stated this was based on an assumption "that the extension would provide the layout" — i.e., the original intent differs from what was actually specified and built.

**Impact:** Blocks any realistic path to onboarding a real plugin's capabilities onto physical positions without hand-editing JSON and restarting Gatoway core — acceptable for solo developer testing, but confirmed by the user to not match their actual intent for how this should work, even at the current stage.

**Suggested fix direction:** Not prescribing a solution — this needs a `/gather-requirements` pass to establish what the user actually wants (e.g., does a plugin send a *suggested* default layout at `register` time that Gatoway core auto-applies or offers as a starting point? Does this require `layout.json` to become dynamically updatable rather than read-once-at-startup? How do multiple simultaneous connections of the same `pluginType` resolve conflicting suggestions?) before any design or implementation work proceeds.

## Testing Coverage Assessment

This session was live/manual only (real WebSocket connection from the actual xDender extension) — no new automated tests were written or expected, since nothing in this session is a code change. Existing automated coverage (`gatoway-core`'s 155 unit/integration tests, particularly `capabilityValidation.test.ts` and `messageHandler.test.ts`) already covers the validation logic this session confirmed live; this session's value is confirming that coverage holds against uncontrolled, real-world plugin data rather than adding new coverage.

## Review Verdict

**Recommendation:** ❌ **Requires fixes** — Both QA-017 and QA-018 are Major and block real-world usability of the WebSocket transport path as currently deployed. QA-017 is a code/design-level gap the `developer`/architect can address directly. QA-018 is a requirements-level finding — per this project's own routing rules, it must go through `/gather-requirements` to confirm the intended behavior before any design or code work begins; do not patch this in code or design without that step, since doing so risks building the wrong mechanism a second time. Registration and focus-tracking behavior are otherwise confirmed correct against live, real-world plugin data.

---

# Static Review Session — 2026-07-15 — `plugin-allowed-origins-config`

**Reviewer:** QA Engineer
**Scope:** Static review of the OpenSpec change `plugin-allowed-origins-config` (branch `plugin-allowed-origins-config`, HEAD `53aed4a`) — the fix for QA-017 (Gatoway core, when spawned by the GUI-launched Stream Deck app, never had `GATOWAY_ALLOWED_ORIGINS` set). Reviewed: `stream-deck-plugin/src/coreLifecycle/allowedOriginsConfig.ts` (new), `coreLifecycle/config.ts` (`PluginCoreConfig`, `resolvePluginCoreConfig()`, `buildCoreChildEnv()`), `src/plugin.ts` wiring, `stream-deck-plugin/README.md`'s new documentation section, and the new/extended tests (`test/unit/allowedOriginsConfig.test.ts`, `test/unit/config.test.ts`), against `proposal.md`, `design.md` (D1-D4), the `stream-deck-core-lifecycle` delta spec, `tasks.md`, and QA-017's full original finding.
**Prepared for:** Technical Architect

## Summary

This is a clean, narrowly-scoped fix that closes QA-017 as designed. `buildCoreChildEnv()`'s "delete the inherited `GATOWAY_ALLOWED_ORIGINS` when the resolved list is empty" behavior is correct, deliberately tested (`config.test.ts`'s "deletes an inherited `GATOWAY_ALLOWED_ORIGINS`..." case), and — I confirmed by reading `gatoway-core/src/config.ts`'s `parseAllowlist()` directly — actually functionally equivalent to leaving an empty string in place, since `parseAllowlist` treats `""` and `undefined` identically (`if (!raw) return [];`); the delete is defensive belt-and-braces, not load-bearing, and does not risk regressing anything. `buildCoreChildEnv()` is only ever invoked from `plugin.ts`, wiring the Stream-Deck-spawned child's environment — the project's own `/verify` sessions that set `GATOWAY_ALLOWED_ORIGINS` directly on a manually-started standalone `gatoway-core` process never go through this function at all (confirmed: `git diff bc79de7 53aed4a --stat -- gatoway-core` shows zero files touched in `gatoway-core/`), so that path is provably unaffected. The four-case (missing/read-failed/invalid-JSON/invalid-shape/loaded) logging in `allowedOriginsConfig.ts` mirrors `gatoway-core/src/routing/layoutStore.ts`'s established pattern faithfully — same event-naming convention, same never-throws/fail-to-empty philosophy, no silently-swallowed error path — and `validateAllowedOriginsConfig()` genuinely rejects non-object roots, non-array `allowedOrigins`, and non-string/empty-string entries (not a loose `Array.isArray` check), each case covered by a dedicated unit test. `resolvePluginCoreConfig()`'s new optional `PluginLogger` parameter defaults to a no-op that only suppresses *logging* of an already-non-throwing loader — it never swallows a real error, since `loadAllowedOrigins` has no throwing path left uncaught, and the sole production call site (`plugin.ts`) always passes a real logger. I re-ran both workspaces' full test suites and typechecks myself rather than trusting the developer's report: `gatoway-core` 155/155 tests passing, `stream-deck-plugin` 86/86 tests passing, both `tsc --noEmit` clean. No Critical or Major issues found. Two non-blocking Observations below.

## Issue Log

No Open Critical, Major, Minor, or Question findings from this session.

## Per-area findings (from the review brief)

**1. Empty/omit-vs-delete behavior in `buildCoreChildEnv()` — confirmed correct, not a regression risk.** `stream-deck-plugin/src/coreLifecycle/config.ts:100-115`: when `config.allowedOrigins` is empty, the function explicitly `delete env.GATOWAY_ALLOWED_ORIGINS` rather than merely omitting an assignment, so any same-named value already present in `baseEnv` (the plugin process's own inherited environment, which defaults to `process.env`) is stripped before the child ever sees it. I confirmed this reflects a deliberate design choice (design.md D2, matching the existing unconditional-overwrite precedent for `GATOWAY_TCP_PORT`/`GATOWAY_TOKEN_FILE`) rather than an accidental side effect, and confirmed it is directly unit-tested (`config.test.ts`, "deletes an inherited `GATOWAY_ALLOWED_ORIGINS` from the base env when origins are empty"). I additionally traced `gatoway-core/src/config.ts`'s own `parseAllowlist(raw)` — `if (!raw) { return []; }` — which means an explicitly-set empty string and a fully-unset variable parse identically on the `gatoway-core` side, so this behavior can't cause any observable difference in `gatoway-core` even if the delete were somehow skipped; it's a correctness belt-and-braces measure, not one with a live failure mode. The standalone-`gatoway-core` `/verify` workflow (setting `GATOWAY_ALLOWED_ORIGINS` directly as an env var on a manually-started `gatoway-core` process) never calls `buildCoreChildEnv()` at all — it is a completely separate code path (a different binary/entry point, `gatoway-core/src/index.ts`, invoked directly rather than spawned as a child by this plugin) — and `git diff bc79de7 53aed4a --stat -- gatoway-core` confirms zero `gatoway-core/` files were touched by this change, so that workflow is provably unaffected.

**2. Four-case logging — confirmed faithful to `layoutStore.ts`'s pattern.** `allowedOriginsConfig.ts`'s `loadAllowedOrigins()` mirrors `gatoway-core/src/routing/layoutStore.ts`'s `load()` method event-for-event: `allowed_origins_config_missing` (ENOENT) / `allowed_origins_config_read_failed` (other read errors) / `allowed_origins_config_invalid_json` / `allowed_origins_config_invalid_shape` / `allowed_origins_config_loaded` — the same five practical cases `layoutStore.ts` actually implements (tasks.md/design.md describe it as "four-case" but both the precedent and this new code have always had five, since a non-ENOENT read failure is a distinct case from a missing file in both). Every branch returns `[]` and logs before returning; no branch swallows an error silently — a same-level (`info` for missing, `error` for the three failure cases) severity choice as the precedent, and the `error` object's message is always included in the log details.

**3. Schema validation — confirmed genuinely strict, not a loose `Array.isArray` check.** `validateAllowedOriginsConfig()` (`allowedOriginsConfig.ts:41-54`) rejects: a non-object root (`isPlainObject` check, also rejecting a bare array — tested), a present-but-non-array `allowedOrigins` (tested), and iterates every entry rejecting any non-string or empty-string value with an index-specific reason (tested for both a non-string entry and an empty-string entry). This is the same validation style as `gatoway-core/src/routing/layoutConfig.ts`'s `validateBinding()`, applied correctly to a flat string array rather than the more complex binding-object shape.

**4. `PluginLogger` optional parameter — confirmed it does not swallow a real error, and existing callers are unaffected.** `resolvePluginCoreConfig()`'s new `logger: PluginLogger = noopLogger` parameter only controls whether `loadAllowedOrigins()`'s already-non-throwing log calls are recorded or discarded — `loadAllowedOrigins` has no code path that throws past this point (every failure mode is caught and returns `[]`), so there is no real error that could be silently swallowed by the no-op default; only the *diagnostic record* of an expected fallback case is suppressed, and only for callers (i.e., tests) that don't pass a real logger. `resolvePluginCoreConfig()` had exactly one production call site before this change (`plugin.ts`) and still has exactly one after (confirmed via `grep -rn resolvePluginCoreConfig`); it now passes a real `PluginLogger` (`streamDeck.logger.createScope("gatoway-core-config")`), so production behavior is strictly additive — the port/token-file resolution logic and its existing tests (`config.test.ts`'s `GATOWAY_TCP_PORT`/`GATOWAY_TOKEN_FILE` cases) are untouched and still pass unmodified.

**5. Full test suite and typecheck — re-run directly, not trusted from the developer's report.**
- `gatoway-core`: `npm test` → **155/155 tests passing** (19 test files); `npx tsc --noEmit -p tsconfig.json` → clean, zero errors. Confirms `gatoway-core` itself is untouched by this change (as design.md D2 claims) and still fully green.
- `stream-deck-plugin`: `npm test` → **86/86 tests passing** (14 test files); `npx tsc --noEmit -p tsconfig.json` → clean, zero errors.

## Observations

- `allowedOriginsConfig.ts` uses synchronous `readFileSync` (`loadAllowedOrigins`) where `gatoway-core/src/routing/layoutStore.ts`'s equivalent `load()` uses `async readFile`. Not a bug — this loader runs once, synchronously, at plugin module-load time (before `streamDeck.connect()` in `plugin.ts`), and the file is expected to be tiny — but it's a deliberate stylistic divergence from the precedent this change explicitly says it mirrors, worth the architect's awareness in case a future refactor tries to unify the two loaders' shape.
- No test exercises `loadAllowedOrigins()`'s full success path with an explicitly-empty `{ "allowedOrigins": [] }` file (only `validateAllowedOriginsConfig()` is tested for that exact input, at the schema-validation level, not through the full `loadAllowedOrigins` read-parse-validate-log pipeline). Low-risk gap — the same code path is otherwise fully exercised for both a fully-empty environment (missing file) and non-empty content — but worth noting since a user explicitly disabling WS support by emptying the array (rather than deleting the file) is a real, if minor, path.
- `tasks.md` 4.2 ("manually verify with a real `allowed-origins.json` in place... confirm a Firefox-based plugin can connect through the normal Stream Deck-spawned path") is correctly left unchecked — this is the actual real-world QA-017 scenario and cannot be confirmed by static review or the automated suite; it is properly deferred to `/verify`, consistent with this project's established pattern for manual-hardware/manual-environment checks (e.g. `stream-deck-plugin-skeleton`'s task 5.3).

## Testing Coverage Assessment

New/extended coverage is thorough for the scope of this change: `allowedOriginsConfig.test.ts` covers `validateAllowedOriginsConfig()` (valid single/multiple origins, valid empty array, non-object root, non-array field, non-string entry, empty-string entry), `resolveAllowedOriginsFilePath()` (default path, env override including a path containing spaces), and `loadAllowedOrigins()` (valid single/multiple origins with correct log content, missing file, invalid JSON, wrong shape, non-string entry) — all against a real temp-directory filesystem, not mocked I/O. `config.test.ts`'s additions cover `resolvePluginCoreConfig()`'s new `allowedOrigins` resolution (via file override, missing-file fallback, and the no-logger-argument case) and `buildCoreChildEnv()`'s three origin-related behaviors (comma-joined when present, omitted when empty, deleted-from-base-env when empty and previously present). The one gap identified (`loadAllowedOrigins()` with an explicit empty array, full pipeline) is noted above as a non-blocking Observation. `coreProcessSupervisor`/`coreClient` tests were confirmed unaffected (task 3.3) — I verified no test file references `GATOWAY_ALLOWED_ORIGINS` outside the two files this change added/extended.

## Review Verdict

**Recommendation:** ✅ **Pass** — No Critical, Major, Minor, or Question issues are open. The fix directly and correctly closes QA-017's gap (a real, persistent, GUI-launch-compatible source for `GATOWAY_ALLOWED_ORIGINS`), the delete-on-empty behavior in `buildCoreChildEnv()` is confirmed correct and inert with respect to `gatoway-core`'s own parsing and the separate standalone-`gatoway-core` `/verify` code path, logging and schema validation are both faithful to established project conventions and genuinely strict, the optional-logger default cannot swallow a real error, and both workspaces' full test suites (155 + 86 = 241 tests) and typechecks pass under direct re-verification. Ready for `/verify` (in particular, `tasks.md` 4.2's still-outstanding manual Firefox-through-the-real-Stream-Deck-app check) and, following that, `doc-writer` and `/opsx:archive`.

---

# Static Review Session — 2026-07-16 — `extension-provided-slot-content`

**Reviewer:** QA Engineer
**Scope:** Static review of the OpenSpec change `extension-provided-slot-content` (branch `extension-provided-slot-content`, HEAD `bb12e4d`) — the QA-018 resolution: replaces the persisted `layout.json`/capability-id model with a live, ordinal-position-based model (`device_capacity`/`slot_capacity`, `register`'s `content`, ordinal `command.slotIndex`), and removes `persisted-layout-config`'s entire deliverable in the same step. Reviewed `proposal.md`, `design.md` (D1-D7), all four spec deltas (`message-protocol`, `profile-routing`, `stream-deck-core-lifecycle`, `layout-persistence` — a full REMOVAL delta), `tasks.md`, `REQUIREMENTS.md` v1.2 (FR-007/FR-008), and `ARCHITECTURE.md` v1.6 (AD-6/AD-8 revised, AD-9 added), against the implementation in both workspaces.
**Prepared for:** Technical Architect

---

## Summary

This is a clean, well-executed implementation of a genuinely large, cross-cutting change, and every specifically-flagged risk area checks out under direct code inspection and test execution — not just by trusting the developer's report. `profileRouter.ts`'s resolution logic implements all five steps of D6's algorithm correctly (position → ordinal index via `device_capacity`, underflow drop, no-focus drop, `render_update` derivation from declared content + capacity, and an idle sweep that genuinely spans the full `device_capacity` report rather than any stale profile data). The removal of `persisted-layout-config` is complete, not partial: a full-tree grep and `git diff --stat` both confirm `layoutConfig.ts`, `layoutStore.ts`, `layoutResolver.ts`, `configLayoutResolver.ts`, `capabilityLookup.ts`, their tests, `GATOWAY_LAYOUT_FILE`, and `docs/LAYOUT_CONFIG.md` are all gone, with no stale import or dead reference anywhere in either package's source or test tree (the only surviving mentions are explicitly historical/explanatory, in `ARCHITECTURE.md`'s R-6 record and `gatoway-core/README.md`'s "no layout config file" section, both of which correctly describe the removal in the past tense rather than implying the files still exist). `device_capacity` is genuinely restricted to the `pluginType: "stream-deck"` connection with no special auth bypass — that connection authenticates via the exact same TCP-token/WS-Origin path as any other connection; `pluginType` is simply a self-declared string checked at the routing layer, mirroring the pre-existing pattern already used for `render_update` targeting. `state` on a dial (`content.dials`) entry is genuinely rejected by `validateSlotContent()` (checked before the type check, so no code path lets a numeric `state` slip through on an encoder entry), and the renamed `rejectedContent: [{ controller, index, reason }]` error shape is asserted verbatim in `messageHandler.test.ts` against design.md's exact shape. The deterministic device-capacity ordering claim (row-then-column for keys, ascending index for dials) is genuinely implemented via `Array.prototype.sort()` with an explicit comparator in `deviceCapacity.ts`, and is tested by feeding the computation function's actions in deliberately shuffled order and asserting the sorted output — a real determinism proof, not just a comment's assertion. Re-registration re-render behavior is implemented and tested exactly as design.md D3/D5.5 describe: a focused connection's re-`register` triggers an immediate `render_update` sweep; a non-focused connection's re-`register` stores the new content silently. The 72×72px/144×144px (@2x) icon guidance in `docs/PROTOCOL.md` is genuinely traceable to `@elgato/schemas`' own bundled manifest schema (confirmed directly in `node_modules/@elgato/schemas/streamdeck/plugins/manifest.json`, appearing identically across the key-state, multi-action, and dial/encoder icon fields), not merely asserted. Both workspaces' full test suites and typechecks were re-run directly rather than trusted from the developer's report: `gatoway-core` **114/114** tests passing, `stream-deck-plugin` **99/99** tests passing, both `tsc --noEmit` clean — matching the reported counts exactly.

The one gap this review surfaced (QA-019, Minor) is a testing-coverage accuracy issue, not a functional defect found by tracing the code: `tasks.md` 8.5 claims a test exists confirming "overflow (more declared content than capacity) never causes an out-of-range render," but no test anywhere in either test file that exercises `ProfileRouter` (`profileRouter.test.ts`, `focusProfileRouting.integration.test.ts`) ever configures a `device_capacity` report with more than one button position and one dial position — every single test in both files uses the same fixed one-button/one-dial fixture. The resolution and render-sweep code appears correct by inspection regardless of capacity size (both are bounded by iterating `device_capacity`'s own position list), but the specific overflow scenario, and any scenario mixing populated and idle slots within one multi-position sweep, is asserted only by static code trace in this review, not by the automated suite — an under-tested claim in the same spirit as the historical QA-008 finding (a claimed test that doesn't exist).

---

## Issue Log

| ID | Severity | Location | Description | Status |
|----|----------|----------|-------------|--------|
| QA-019 | Minor | `openspec/changes/extension-provided-slot-content/tasks.md:54`, `gatoway-core/test/unit/profileRouter.test.ts`, `gatoway-core/test/integration/focusProfileRouting.integration.test.ts` | Task 8.5 claims a test confirms declared content longer than device capacity ("overflow") never causes an out-of-range render, but no test in either file ever configures a `device_capacity` with more than one button/one dial position — the overflow and multi-slot-mixed-sweep scenarios are untested, though the code appears correct by inspection. | Open |

**Status values:**
- `Open` — not yet fixed; needs architect attention

---

## Issue Detail

### QA-019 · Minor · `gatoway-core/test/unit/profileRouter.test.ts`, `gatoway-core/test/integration/focusProfileRouting.integration.test.ts`

**What:** Every single test that exercises `ProfileRouter`'s resolution or rendering logic — across both `profileRouter.test.ts` (unit) and `focusProfileRouting.integration.test.ts` (integration) — uses the exact same fixed `device_capacity` fixture: exactly one button position (`{ row: 0, column: 0 }`) and one dial position (`{ index: 0 }`). No test anywhere configures a device capacity with more than one position of either kind, and no test declares `content.buttons`/`content.dials` longer than the reported capacity.

**Scenario:** `tasks.md` 8.5 is checked off as complete and explicitly claims: "Unit + integration tests for resolution: ordinal index resolved correctly; underflow (input event's index has no content entry) safely dropped; position not in `device_capacity` safely dropped; **overflow (more declared content than capacity) never causes an out-of-range render**." The underflow and "position not found" cases are genuinely tested (e.g. `profileRouter.test.ts`'s "ignores an input_event whose position is not in the latest device_capacity report" and "...content has no entry at that ordinal index (underflow)"), but the overflow case this same task line claims is tested does not appear anywhere.

**Evidence:**
```
$ grep -n "overflow" gatoway-core/test/unit/profileRouter.test.ts gatoway-core/test/integration/focusProfileRouting.integration.test.ts
(no matches)

$ grep -n "buttonPositions:\s*\[" gatoway-core/test/unit/profileRouter.test.ts gatoway-core/test/integration/focusProfileRouting.integration.test.ts
gatoway-core/test/unit/profileRouter.test.ts:18:  buttonPositions: [{ row: 0, column: 0 }],
gatoway-core/test/integration/focusProfileRouting.integration.test.ts:19:  buttonPositions: [{ row: 0, column: 0 }],
```
Both files share the same one-position-per-controller fixture (`DEVICE_CAPACITY`) throughout every test case. Tracing `sendContentSweepForController()` (`profileRouter.ts:309-332`) directly: it iterates `positions.forEach((position, index) => …)`, where `positions` comes from the latest `device_capacity` report — any `entries` (declared content) beyond `positions.length` are never visited by this loop, so an overflow can't cause an out-of-range render by construction. Similarly, `handleInputEvent`'s `slotIndex` is derived from `positions.findIndex(...)`, which is inherently bounded to `[0, positions.length)`, so it can never index past a `content` array's actual bounds in a way that would be unsafe. The implementation is very likely correct, but this was established by this review's own code trace, not by exercising it in the test suite as `tasks.md` claims.

**Impact:** Low — the code appears correct by inspection, and both bounding loops make an out-of-range access structurally difficult to introduce even by future error. The impact is on trust in the task list's own completeness claim (the same category of issue as the historical QA-008 finding): a future change touching `sendContentSweepForController`, `handleInputEvent`, or the ordinal-index math could regress the overflow-safety property with no test catching it, and no reviewer would learn that from running the suite.

**Suggested fix direction:** Add at least one test (unit is sufficient) that configures a `device_capacity` with N positions for a controller and a focused connection's `content` with more than N entries for that same controller, asserting exactly N `render_update`s are sent (no out-of-range access, no extra sends) and that an `input_event` for a position at the edge of capacity resolves normally. A second test with a device capacity of more than one position, where only some ordinal indices have declared content, would also directly exercise the "mixed sweep" case the idle-sweep-spans-full-capacity behavior implies but that the current single-position fixture can't distinguish from the "no content at all" case.

---

## Observations

- `gatoway-core/src/routing/profileRouter.ts`'s `handleDeviceCapacity` restricts acceptance to `connection.pluginType === STREAM_DECK_PLUGIN_TYPE`, but `pluginType` is simply a self-declared string checked at the routing layer — any connection that passes the ordinary TCP-token or WS-Origin authentication (there is no additional per-`pluginType` credential) could declare `pluginType: "stream-deck"` at `register` time and then send a spoofed `device_capacity` report, or have its own `render_update`s targeted at it via `findStreamDeckConnection()`'s identical pattern. This is not a new weakness introduced by this change — it is the same pre-existing precedent `render_update` targeting has always used — and the review brief's specific ask ("no special bypass — should still go through the same auth as any other connection") is satisfied: there is no special bypass. Flagged only as a pre-existing, unchanged architectural property worth the architect's awareness, not a regression.
- `openspec/specs/message-protocol/spec.md` and `openspec/specs/profile-routing/spec.md` (the consolidated, already-archived specs) still describe the old `capability_update`/`capabilityId` model in full. This is expected, not a defect: those files are only updated by `/opsx:archive`, which has not yet been run for this change — the delta specs under `openspec/changes/extension-provided-slot-content/specs/` are the correct, current source of truth pre-archive. Noted so the architect doesn't mistake this for a missed rewrite; it will resolve itself once this change is archived.
- `docs/PROTOCOL.md`'s icon guidance attributes the 72×72/144×144 sizing to "`@elgato/schemas`' own `States[].Image` schema entry" — the exact schema path in the installed package is actually the manifest's per-state `Image` field (and, separately, the dial/encoder icon field, both independently confirmed at the identical dimensions) rather than a single unified `States[].Image` node; a cosmetic imprecision in how the source is cited, not in the numbers themselves, which are correct.

---

## Testing Coverage Assessment

Coverage for this change is thorough and, with the one exception noted in QA-019, directly exercises every behavior this review was asked to scrutinise: the `SlotContent` validator (valid/invalid `label`/`icon`/`state`, including the dial-state rejection) is unit-tested exhaustively in `slotContentValidation.test.ts`; registration handling (partial-entry rejection + follow-up `error`, full replace, omission-preserves-prior) is covered in `messageHandler.test.ts`; `device_capacity` acceptance/rejection by `pluginType` is covered in both `messageHandler.test.ts` (dispatch) and `profileRouter.test.ts` (the actual accept/reject decision); `slot_capacity` delivery (post-`register_ack`, on focus gain, zero-default) is covered in `profileRouter.test.ts`; the D6 resolution algorithm's four safely-dropped cases (no focus, position not in capacity, underflow, focused-connection-missing race) and its two successful-resolution cases (button, dial with `delta`) are all directly tested; re-registration-while-focused/not-focused re-render behavior is tested with an explicit before/after content comparison; and the Stream Deck plugin's `computeDeviceCapacity()` ordering is proven deterministic against shuffled input order in `deviceCapacity.test.ts`. The one gap (overflow / multi-position mixed sweep, QA-019) is the only scenario from this review's eight focus areas not directly exercised by an automated test; every other claim in the review brief was independently confirmed by direct code trace, not merely by re-reading the developer's report.

---

## Review Verdict

**Recommendation:** ⚠️ **Conditional pass** — No Critical or Major issues were found; every specifically-flagged risk area (D6's five-step algorithm, complete removal of `persisted-layout-config`, `device_capacity`'s sender restriction and lack of auth bypass, dial-state validation and the `rejectedContent` error shape, deterministic device-capacity ordering, re-registration re-render behavior, the icon pixel-dimension claim, and both workspaces' test/typecheck results) was independently verified against the actual code and a direct re-run of the test suites, not taken on trust. The single open finding (QA-019, Minor) is a testing-coverage completeness gap — the code is very likely correct by inspection, but the specific "overflow never causes an out-of-range render" claim in `tasks.md` 8.5 is not actually backed by a test, and no test in the suite ever uses a device capacity of more than one position per controller. The architect may choose to have the developer add the two suggested tests before archiving, or accept the risk and defer it — this does not block `/verify`, since it does not represent a known-broken behavior, only an unverified one.

---

# Interactive Verification Session (`/verify`) — 2026-07-16 — `extension-provided-slot-content`

**Reviewer:** QA Engineer (interactive, with user)
**Scope:** Live hardware verification of `extension-provided-slot-content` (branch `extension-provided-slot-content`, HEAD `a60caed` at time of this session). QA-019 had already been fixed and re-verified via automated tests before this session began.

## Blocking finding: plugin crash-loops unconditionally on every startup

**What:** The freshly-built Stream Deck plugin was relaunched via the real Stream Deck application (after killing a stale standalone `gatoway-core` instance left over from an earlier session and doing a clean `npm run build` on this branch). With a real profile active (3 generic Key actions + 1 generic Dial action placed, showing "Gatoway"/"Dial" — stale content from a prior run, since nothing new had rendered), no `com.gatoway.streamdeck` or `gatoway-core` process ever appeared in `ps aux`, despite repeated checks over ~15 seconds.

**Scenario:** The plugin bundle's own SDK-generated logs (`stream-deck-plugin/com.gatoway.streamdeck.sdPlugin/logs/`) showed 10 crash log files within the span of one minute (`com.gatoway.streamdeck.0.log` through `.9.log`, timestamps 10:00–10:01), each ending in the same uncaught exception — the plugin process crashes immediately on every single startup attempt, and Elgato's own Stream Deck application keeps restarting it in a tight loop, which is why no live process was ever caught by `ps aux`.

**Evidence:**
```
Error: [ERR_NOT_SUPPORTED]: onDeviceDidChange requires Stream Deck version 7.0 or higher; please update the "Software.MinimumVersion" in the plugin's manifest to "7.0" or higher.
    at requiresVersion (.../node_modules/@elgato/streamdeck/dist/plugin/validation.js:34:15)
    at DeviceService.onDeviceDidChange (.../node_modules/@elgato/streamdeck/dist/plugin/devices/service.js:40:9)
    at <anonymous> (stream-deck-plugin/com.gatoway.streamdeck.sdPlugin/src/plugin.ts:74:20)
```
`stream-deck-plugin/com.gatoway.streamdeck.sdPlugin/manifest.json`'s `Software.MinimumVersion` is still `"6.5"` — task group 7's new `onDeviceDidChange` listener (added to detect live device connect/disconnect for `device_capacity` re-reporting, per design.md D1/task 7.3) requires SDK 7.0+, and the SDK's own runtime validation throws synchronously the moment this handler is registered, rather than merely warning. The manifest was never updated to match. The real, currently-installed Stream Deck application on this machine reports version `7.0.3` (confirmed via this session's own registration-info payload), so bumping the declared minimum is not just a workaround — it accurately reflects a real, already-satisfied requirement.

**Impact:** Total, unconditional blocker — the Stream Deck plugin cannot start at all in its current state, on any device, regardless of any placed action or device_capacity scenario. This blocks 100% of live verification for this change, not just the device-capacity-specific behaviors.

**Root-cause level:** Code (a manifest field that should have been updated alongside the SDK API it now depends on — not a design or requirements gap; design.md never specified a minimum SDK version, and this is purely a consequence of which SDK method the implementation chose to use).

**Suggested fix direction:** Update `manifest.json`'s `Software.MinimumVersion` to `"7.0"`.

## Status

**Recommendation:** ❌ **Requires fixes** — this is a Critical, code-level, unconditional blocker. Route to `developer` for the one-line manifest fix, then resume this `/verify` session to complete the live checks that couldn't even begin (device capacity detection/reporting, live focus/render/input round trip, re-registration re-render, overflow/underflow on real hardware).

---
