import { describe, expect, it, vi } from "vitest";
import {
  buildKeyDownInputEvent,
  buildKeyUpInputEvent,
  GENERIC_KEY_DEFAULT_LABEL,
  renderGenericKey,
  type GenericKeyLike,
} from "../../src/actions/genericKeyRenderer.js";

function fakeKeyAction(isKey = true): GenericKeyLike & {
  setTitle: ReturnType<typeof vi.fn>;
  setImage: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
} {
  return {
    isKey: () => isKey,
    setTitle: vi.fn(async () => undefined),
    setImage: vi.fn(async () => undefined),
    setState: vi.fn(async () => undefined),
  };
}

describe("renderGenericKey", () => {
  // design.md D6 / QA-014: a full plugin restart wipes RenderStore entirely, and a
  // missing/empty layout config gives Gatoway core zero positions to sweep - without
  // this local baseline, the action would otherwise be left showing nothing at all
  // (previously: no-op) or, on real hardware, an uninitialized-looking manifest default.
  it("applies the local default baseline (manifest label, default icon) when no render state exists yet for this position, with no Gatoway core message involved at all", async () => {
    const action = fakeKeyAction();
    await renderGenericKey(action, undefined);

    expect(action.setTitle).toHaveBeenCalledWith(GENERIC_KEY_DEFAULT_LABEL);
    expect(action.setImage).toHaveBeenCalledWith(undefined);
    expect(action.setState).not.toHaveBeenCalled();
  });

  it("does not apply the local default baseline to a non-key (dial) instance", async () => {
    const action = fakeKeyAction(false);
    await renderGenericKey(action, undefined);

    expect(action.setTitle).not.toHaveBeenCalled();
    expect(action.setImage).not.toHaveBeenCalled();
  });

  it("a subsequent real render_update still overrides the local baseline normally", async () => {
    const action = fakeKeyAction();

    // First appearance: no remembered state yet - local baseline applies.
    await renderGenericKey(action, undefined);
    expect(action.setTitle).toHaveBeenCalledWith(GENERIC_KEY_DEFAULT_LABEL);

    // A real render_update subsequently arrives for this position (simulated here by
    // RenderStore having merged it - see renderStore.test.ts - and this function being
    // invoked again with the resulting defined state, exactly as applyRenderUpdate does).
    await renderGenericKey(action, { label: "Next Photo", icon: "next-photo.png" });

    expect(action.setTitle).toHaveBeenLastCalledWith("Next Photo");
    expect(action.setImage).toHaveBeenLastCalledWith("next-photo.png");
  });

  it("does nothing for a non-key (dial) instance even if render state exists", async () => {
    const action = fakeKeyAction(false);
    await renderGenericKey(action, { label: "Hello" });

    expect(action.setTitle).not.toHaveBeenCalled();
  });

  it("applies every defined field of the render state", async () => {
    const action = fakeKeyAction();
    await renderGenericKey(action, { icon: "icon.png", label: "Hello", state: 1 });

    expect(action.setTitle).toHaveBeenCalledWith("Hello");
    expect(action.setImage).toHaveBeenCalledWith("icon.png");
    expect(action.setState).toHaveBeenCalledWith(1);
  });

  it("only calls setters for fields that are actually defined (sparse update semantics)", async () => {
    const action = fakeKeyAction();
    await renderGenericKey(action, { label: "Only label" });

    expect(action.setTitle).toHaveBeenCalledWith("Only label");
    expect(action.setImage).not.toHaveBeenCalled();
    expect(action.setState).not.toHaveBeenCalled();
  });

  // message-protocol spec (amended): icon: null means "reset to manifest default",
  // applied via setImage() with no argument - distinct from an omitted icon field,
  // which must never call setImage() at all.
  it("resets the image to the manifest default (calls setImage with no argument) when icon is explicitly null", async () => {
    const action = fakeKeyAction();
    await renderGenericKey(action, { icon: null, label: "Idle" });

    expect(action.setImage).toHaveBeenCalledWith(undefined);
    expect(action.setImage).toHaveBeenCalledTimes(1);
  });

  it("never calls setImage when icon is omitted entirely, even though other fields are defined", async () => {
    const action = fakeKeyAction();
    await renderGenericKey(action, { label: "Label only", state: 1 });

    expect(action.setImage).not.toHaveBeenCalled();
  });
});

describe("input_event builders", () => {
  it("builds a keyDown input_event addressed by row/column", () => {
    expect(buildKeyDownInputEvent({ row: 0, column: 1 })).toEqual({
      controller: "keypad",
      position: { row: 0, column: 1 },
      eventType: "keyDown",
    });
  });

  it("builds a keyUp input_event addressed by row/column", () => {
    expect(buildKeyUpInputEvent({ row: 0, column: 1 })).toEqual({
      controller: "keypad",
      position: { row: 0, column: 1 },
      eventType: "keyUp",
    });
  });
});
