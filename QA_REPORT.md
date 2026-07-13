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
