/**
 * Checks a WebSocket upgrade request's `Origin` header against the configured
 * allowlist of known browser-extension origins (design.md D5, e.g.
 * `chrome-extension://<id>`).
 *
 * A missing/undefined origin is always rejected: legitimate browser clients always
 * send this header on a cross-origin WebSocket handshake.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowlist: readonly string[],
): boolean {
  if (!origin) {
    return false;
  }
  return allowlist.includes(origin);
}
