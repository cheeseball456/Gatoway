import { describe, expect, it, vi } from "vitest";
import { IDLE_ACTION_TITLE, renderIdleKey, type IdleKeyLike } from "../../src/actions/idleKeyRenderer.js";

function fakeAction(isKey: boolean): IdleKeyLike & { setTitle: ReturnType<typeof vi.fn> } {
  return {
    isKey: () => isKey,
    setTitle: vi.fn(async () => undefined),
  };
}

describe("renderIdleKey", () => {
  it("sets the fixed idle title for a key instance", async () => {
    const action = fakeAction(true);
    await renderIdleKey(action);
    expect(action.setTitle).toHaveBeenCalledTimes(1);
    expect(action.setTitle).toHaveBeenCalledWith(IDLE_ACTION_TITLE);
  });

  it("does nothing for a non-key (dial) instance", async () => {
    const action = fakeAction(false);
    await renderIdleKey(action);
    expect(action.setTitle).not.toHaveBeenCalled();
  });
});
