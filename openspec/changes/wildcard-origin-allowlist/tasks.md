## 1. Wildcard Matching

- [x] 1.1 Update `isOriginAllowed()` (`gatoway-core/src/auth/originAllowlist.ts`) to treat an allowlist entry ending in `*` as a prefix match, and any other entry as an exact match (unchanged behavior)
- [x] 1.2 Handle the degenerate case of a bare `*` entry (matches everything) without special-casing it incorrectly — it should just mean "prefix is empty string," which correctly matches any origin, consistent with the general rule

## 2. Testing

- [x] 2.1 Unit tests: exact-match entries still behave exactly as before (existing tests must keep passing)
- [x] 2.2 Unit tests: a wildcard entry (e.g. `moz-extension://*`) matches multiple different origins sharing that prefix
- [x] 2.3 Unit tests: a wildcard entry does NOT match an origin with a different scheme/prefix (e.g. `moz-extension://*` does not match `chrome-extension://foo`)
- [x] 2.4 Unit tests: an allowlist with both an exact entry and a wildcard entry correctly accepts origins matching either
- [x] 2.5 Manually verify: run the existing manual WebSocket test client with `GATOWAY_ALLOWED_ORIGINS=moz-extension://*` and confirm both a `moz-extension://<uuid-A>` and `moz-extension://<uuid-B>` origin are both accepted, while a non-matching origin is still refused
  - [x] QA-016 follow-up: confirmed via `npm run manual:ws-client` against a real, standalone-launched Gatoway core process configured with `GATOWAY_ALLOWED_ORIGINS=moz-extension://*` — two distinct `moz-extension://` origins (different UUIDs) were both accepted, and a throwaway ad hoc script driving a `chrome-extension://` origin against the same running instance was refused

## 3. Documentation

- [x] 3.1 Update `docs/PROTOCOL.md`'s authentication section to document wildcard syntax and the Chrome-vs-Firefox recommendation (exact id for Chrome, `moz-extension://*` for Firefox)
- [x] 3.2 Update `gatoway-core/README.md`'s `GATOWAY_ALLOWED_ORIGINS` description with the same guidance and a concrete example
