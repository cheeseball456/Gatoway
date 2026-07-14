import { describe, expect, it, vi } from "vitest";
import { FocusTracker } from "../../src/focus/focusTracker.js";
import type { Logger } from "../../src/logging/logger.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe("FocusTracker", () => {
  it("starts with no connection focused", () => {
    const tracker = new FocusTracker(fakeLogger());
    expect(tracker.current).toBeNull();
  });

  it("records a connection as focused when it reports focused: true", () => {
    const tracker = new FocusTracker(fakeLogger());
    const event = tracker.reportFocus("a", true);

    expect(tracker.current).toBe("a");
    expect(event).toEqual({ previousConnectionId: null, focusedConnectionId: "a", reason: "focus_gained" });
  });

  it("a new focus report supersedes the previous one without requiring a blur first", () => {
    const tracker = new FocusTracker(fakeLogger());
    tracker.reportFocus("a", true);

    const event = tracker.reportFocus("b", true);

    expect(tracker.current).toBe("b");
    expect(event).toEqual({ previousConnectionId: "a", focusedConnectionId: "b", reason: "focus_gained" });
  });

  it("clears focus when the currently focused connection reports focused: false", () => {
    const tracker = new FocusTracker(fakeLogger());
    tracker.reportFocus("a", true);

    const event = tracker.reportFocus("a", false);

    expect(tracker.current).toBeNull();
    expect(event).toEqual({ previousConnectionId: "a", focusedConnectionId: null, reason: "focus_lost" });
  });

  it("ignores a blur from a connection that isn't the currently focused one", () => {
    const tracker = new FocusTracker(fakeLogger());
    tracker.reportFocus("a", true);

    const event = tracker.reportFocus("b", false);

    expect(tracker.current).toBe("a");
    expect(event).toBeNull();
  });

  it("is a no-op when the already-focused connection re-reports focused: true", () => {
    const tracker = new FocusTracker(fakeLogger());
    tracker.reportFocus("a", true);

    const event = tracker.reportFocus("a", true);

    expect(tracker.current).toBe("a");
    expect(event).toBeNull();
  });

  it("clears focus when the focused connection disconnects", () => {
    const tracker = new FocusTracker(fakeLogger());
    tracker.reportFocus("a", true);

    const event = tracker.clearIfFocused("a");

    expect(tracker.current).toBeNull();
    expect(event).toEqual({ previousConnectionId: "a", focusedConnectionId: null, reason: "disconnect" });
  });

  it("leaves the focused connection unaffected when a non-focused connection disconnects", () => {
    const tracker = new FocusTracker(fakeLogger());
    tracker.reportFocus("a", true);

    const event = tracker.clearIfFocused("b");

    expect(tracker.current).toBe("a");
    expect(event).toBeNull();
  });

  it("logs every focus change with previous/next connection and reason", () => {
    const logger = fakeLogger();
    const tracker = new FocusTracker(logger);

    tracker.reportFocus("a", true);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "focus_changed",
        previousConnectionId: null,
        focusedConnectionId: "a",
        reason: "focus_gained",
      }),
      "focus changed",
    );
  });
});
