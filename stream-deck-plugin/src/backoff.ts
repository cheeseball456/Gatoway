/**
 * Shared backoff calculation used by both the Gatoway core process supervisor
 * (tasks.md 2.3: restart with a backoff delay) and the Gatoway core TCP client's
 * reconnect logic (tasks.md 3.4: retry with a backoff delay). Kept as a small, pure
 * function so it can be unit tested in isolation from any process/socket side effects.
 */
export interface BackoffOptions {
  /** Delay before the first retry, in milliseconds. Defaults to 1000. */
  initialDelayMs?: number;
  /** Upper bound on the computed delay, in milliseconds. Defaults to 30000. */
  maxDelayMs?: number;
  /** Growth factor applied per attempt. Defaults to 2 (doubling). */
  multiplier?: number;
}

const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_MULTIPLIER = 2;

/**
 * Computes the delay, in milliseconds, before the Nth retry/restart attempt
 * (1-indexed: `attempt` 1 is the first retry after an initial failure), growing
 * exponentially up to a cap so repeated failures don't retry in a tight loop nor wait
 * indefinitely long between attempts.
 */
export function nextBackoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const multiplier = options.multiplier ?? DEFAULT_MULTIPLIER;
  const safeAttempt = Math.max(1, attempt);
  const delayMs = initialDelayMs * multiplier ** (safeAttempt - 1);
  return Math.min(delayMs, maxDelayMs);
}
