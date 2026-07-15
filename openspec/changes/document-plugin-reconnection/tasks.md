## 1. Documentation

- [ ] 1.1 Add a "Reconnection" section to `docs/PROTOCOL.md` covering: a reconnecting connection must send a fresh `register` (nothing carries over from a prior connection); a still-active plugin must re-send `focus: true` after reconnecting (it is not automatically restored); Gatoway core's own tolerance for a plugin disconnecting/reconnecting at any time means there's no special handshake or grace period — just start over cleanly on the new connection
- [ ] 1.2 Cross-link the new section from wherever `register` and `focus` are documented, so a reader following either message's own section is pointed at the consolidated reconnection guidance

## 2. Verification

- [ ] 2.1 Confirm existing test coverage already exercises "reconnect requires fresh register" and "reconnect requires re-asserting focus" behavior (e.g. `focusTracker.test.ts`, `focusProfileRouting.integration.test.ts`); if a genuine gap exists in test coverage for either scenario, add a test — but do not treat this as a code change, since the behavior itself is already correct
- [ ] 2.2 Manually confirm the documented reconnection behavior against a real running Gatoway core instance: connect a test-app client, register, focus; disconnect it; reconnect the same client without re-registering/re-focusing and confirm nothing is bound/focused until it does so explicitly
