## 1. Wildcard Matching

- [ ] 1.1 Update `isOriginAllowed()` (`gatoway-core/src/auth/originAllowlist.ts`) to treat an allowlist entry ending in `*` as a prefix match, and any other entry as an exact match (unchanged behavior)
- [ ] 1.2 Handle the degenerate case of a bare `*` entry (matches everything) without special-casing it incorrectly — it should just mean "prefix is empty string," which correctly matches any origin, consistent with the general rule

## 2. Testing

- [ ] 2.1 Unit tests: exact-match entries still behave exactly as before (existing tests must keep passing)
- [ ] 2.2 Unit tests: a wildcard entry (e.g. `moz-extension://*`) matches multiple different origins sharing that prefix
- [ ] 2.3 Unit tests: a wildcard entry does NOT match an origin with a different scheme/prefix (e.g. `moz-extension://*` does not match `chrome-extension://foo`)
- [ ] 2.4 Unit tests: an allowlist with both an exact entry and a wildcard entry correctly accepts origins matching either
- [ ] 2.5 Manually verify: run the existing manual WebSocket test client with `GATOWAY_ALLOWED_ORIGINS=moz-extension://*` and confirm both a `moz-extension://<uuid-A>` and `moz-extension://<uuid-B>` origin are both accepted, while a non-matching origin is still refused

## 3. Documentation

- [ ] 3.1 Update `docs/PROTOCOL.md`'s authentication section to document wildcard syntax and the Chrome-vs-Firefox recommendation (exact id for Chrome, `moz-extension://*` for Firefox)
- [ ] 3.2 Update `gatoway-core/README.md`'s `GATOWAY_ALLOWED_ORIGINS` description with the same guidance and a concrete example
