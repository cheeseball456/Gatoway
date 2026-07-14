## Why

`ARCHITECTURE.md` AD-5 authenticates WebSocket (browser) connections by checking the
HTTP-upgrade request's `Origin` header against an exact-match allowlist
(`GATOWAY_ALLOWED_ORIGINS`). This works for Chrome, whose published/signed extensions
have a deterministic, stable id — but it fundamentally cannot work for Firefox: verified
against Mozilla's own documentation, Firefox generates a random internal UUID for every
installation of an extension, and that UUID (not the static `browser_specific_settings.
gecko.id` a developer can set in the manifest) is what actually appears in the `Origin`
header. Every user's Firefox install of a given extension sends a different, unpredictable
origin, so an exact-match allowlist can never be correctly pre-configured for Firefox.
Since xDender explicitly targets both Chrome and Firefox, this blocks Firefox support
entirely, not just as an edge case.

## What Changes

- `isOriginAllowed()` (and the `GATOWAY_ALLOWED_ORIGINS` allowlist it checks against)
  gains support for a trailing-wildcard pattern: an entry ending in `*` matches any
  origin sharing that prefix (e.g. `moz-extension://*` matches any Firefox extension's
  origin, whatever its per-install UUID). An entry with no trailing `*` continues to
  require an exact match, unchanged from today — this is purely additive.
- Document the Chrome-vs-Firefox split explicitly: pin an exact origin for Chrome (where
  the id is stable and worth pinning precisely), use a wildcard for Firefox (where exact
  matching is impossible by the platform's own design).
- Amend `ARCHITECTURE.md` AD-5 to record this as a real-world constraint discovered
  after the fact, not a new architectural trade-off — the underlying security posture is
  unchanged (loopback-only binding, AD-4, remains the actual boundary; Origin-checking
  was always meant to distinguish "a legitimate extension" from "another local process,"
  not to resist a sophisticated attacker who could forge the header regardless of what
  string is being matched).
- Out of scope: any change to the TCP token-based authentication path (unaffected); any
  change to the loopback-only binding (AD-4, unaffected); building any UI for managing the
  allowlist (still a hand-set environment variable).

## Capabilities

### Modified Capabilities
- `plugin-authentication`: the "WebSocket Origin Allowlisting" requirement is amended to describe wildcard-pattern matching in addition to exact-match, since an entry ending in `*` now means something a plain string-equality check did not previously support.

## Impact

- Changes `gatoway-core/src/auth/originAllowlist.ts`'s matching logic only — no change to
  `GATOWAY_ALLOWED_ORIGINS`'s parsing (still a comma-separated list), the WebSocket
  listener's upgrade-handling flow, or any other capability.
- Existing exact-match allowlist entries (e.g. any already-configured Chrome extension
  id) behave identically to today — this is a strictly additive capability.
- Unblocks Firefox support for xDender (and any future browser-based plugin) without
  requiring a different authentication mechanism for that browser specifically.
