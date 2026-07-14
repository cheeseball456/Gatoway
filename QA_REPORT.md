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
| QA-013 | Minor | `gatoway-core/src/routing/layoutStore.ts:160-171` (`LayoutStore.save()`) | A failed `rename()` during `save()` leaves an orphaned `<file>.<uuid>.tmp` file behind in the config directory with no cleanup; the target config file itself is never corrupted (confirmed by fault injection), but repeated failures accumulate stray temp files indefinitely. Untested by the existing suite (which only exercises the happy path). | Open |

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
