/**
 * The minimal logging surface this package depends on. Deliberately small (rather than
 * depending on `@elgato/streamdeck`'s or `@elgato/utils`'s concrete `Logger` type)
 * so tests can inject a plain fake without pulling in the SDK, while `streamDeck.logger`
 * (and its `createScope(...)` results) satisfy this shape as-is at the real call site in
 * `plugin.ts`.
 *
 * Calls follow gatoway-core's structured-logging convention adapted to this SDK logger's
 * message-first call shape: a human-readable message plus a details object carrying an
 * `event` field and any relevant context, e.g.
 * `logger.info("Gatoway core spawned", { event: "gatoway_core_spawned", pid })`.
 */
export interface PluginLogger {
  info: (message: string, details?: Record<string, unknown>) => void;
  warn: (message: string, details?: Record<string, unknown>) => void;
  error: (message: string, details?: Record<string, unknown>) => void;
}
