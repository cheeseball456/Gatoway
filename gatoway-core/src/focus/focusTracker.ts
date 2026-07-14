import type { Logger } from "../logging/logger.js";

/** Why the focused connection changed, for logging (focus-tracking spec, tasks.md 2.5). */
export type FocusChangeReason = "focus_gained" | "focus_lost" | "disconnect";

/** Describes a change in which connection (if any) currently has focus. */
export interface FocusChangeEvent {
  previousConnectionId: string | null;
  focusedConnectionId: string | null;
  reason: FocusChangeReason;
}

/**
 * Tracks which single connection (if any) currently has focus (focus-tracking
 * capability; design.md D2). Last-report-wins, no explicit blur required: a connection
 * reporting `focused: true` unconditionally supersedes whatever connection was
 * previously focused, and a crashed/buggy app that never blurs is resolved by its
 * disconnect rather than by requiring a handshake (design.md D2's rejected alternative
 * explains why - a missed blur message must never leave the system stuck).
 *
 * Deliberately its own small component rather than living directly on
 * `ConnectionManager` (tasks.md 2.1's "or an adjacent component"): connection lifecycle
 * and focus are separate capabilities/specs, and keeping them separate avoids
 * `ConnectionManager` needing to know anything about focus semantics.
 */
export class FocusTracker {
  private focusedConnectionId: string | null = null;

  constructor(private readonly logger: Logger) {}

  /** The currently focused connection's ID, or `null` if nothing is focused (idle). */
  get current(): string | null {
    return this.focusedConnectionId;
  }

  /**
   * Applies a `focus` message from `connectionId`. `focused: true` always supersedes
   * any previous focus holder (even if `connectionId` was already focused - a no-op in
   * that case). `focused: false` only clears focus if `connectionId` is the connection
   * currently holding it; a blur from a connection that isn't (or is no longer) focused
   * is a no-op, since it has nothing to relinquish.
   *
   * Returns the resulting `FocusChangeEvent`, or `null` if nothing actually changed.
   */
  reportFocus(connectionId: string, focused: boolean): FocusChangeEvent | null {
    if (focused) {
      return this.setFocused(connectionId, "focus_gained");
    }
    if (this.focusedConnectionId !== connectionId) {
      return null;
    }
    return this.setFocused(null, "focus_lost");
  }

  /**
   * Clears focus if `connectionId` currently holds it - e.g. on disconnect (tasks.md
   * 2.4). No-op if `connectionId` isn't the focused connection.
   */
  clearIfFocused(
    connectionId: string,
    reason: FocusChangeReason = "disconnect",
  ): FocusChangeEvent | null {
    if (this.focusedConnectionId !== connectionId) {
      return null;
    }
    return this.setFocused(null, reason);
  }

  private setFocused(next: string | null, reason: FocusChangeReason): FocusChangeEvent | null {
    const previous = this.focusedConnectionId;
    if (previous === next) {
      return null;
    }
    this.focusedConnectionId = next;
    this.logger.info(
      {
        event: "focus_changed",
        previousConnectionId: previous,
        focusedConnectionId: next,
        reason,
      },
      "focus changed",
    );
    return { previousConnectionId: previous, focusedConnectionId: next, reason };
  }
}
