/**
 * Checks a WebSocket upgrade request's `Origin` header against the configured
 * allowlist of known browser-extension origins (design.md D5, e.g.
 * `chrome-extension://<id>`).
 *
 * A missing/undefined origin is always rejected: legitimate browser clients always
 * send this header on a cross-origin WebSocket handshake.
 *
 * An allowlist entry ending in `*` is a trailing-wildcard prefix match (e.g.
 * `moz-extension://*` matches any origin starting with `moz-extension://`) — needed
 * because Firefox generates a random per-installation UUID in the `Origin` header that
 * an exact-match entry can never be pre-configured for (wildcard-origin-allowlist
 * design.md D1). An entry with no trailing `*` continues to require an exact match,
 * unchanged from before. A bare `*` entry is not special-cased: it degenerates to an
 * empty-string prefix, which (correctly, per design.md 1.2) matches any origin.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowlist: readonly string[],
): boolean {
  if (!origin) {
    return false;
  }
  return allowlist.some((entry) => {
    if (entry.endsWith("*")) {
      return origin.startsWith(entry.slice(0, -1));
    }
    return entry === origin;
  });
}
