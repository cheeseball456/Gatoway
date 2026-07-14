import { describe, expect, it, vi } from "vitest";
import {
  buildDialPushInputEvent,
  buildDialRotateInputEvent,
  renderGenericDial,
  type GenericDialLike,
} from "../../src/actions/genericDialRenderer.js";

function fakeDialAction(isDial = true): GenericDialLike & {
  setTitle: ReturnType<typeof vi.fn>;
  setImage: ReturnType<typeof vi.fn>;
} {
  return {
    isDial: () => isDial,
    setTitle: vi.fn(async () => undefined),
    setImage: vi.fn(async () => undefined),
  };
}

describe("renderGenericDial", () => {
  it("does nothing when no render state exists yet for this position", async () => {
    const action = fakeDialAction();
    await renderGenericDial(action, undefined);

    expect(action.setTitle).not.toHaveBeenCalled();
    expect(action.setImage).not.toHaveBeenCalled();
  });

  it("does nothing for a non-dial (key) instance even if render state exists", async () => {
    const action = fakeDialAction(false);
    await renderGenericDial(action, { label: "Hello" });

    expect(action.setTitle).not.toHaveBeenCalled();
  });

  it("applies label and icon when defined", async () => {
    const action = fakeDialAction();
    await renderGenericDial(action, { icon: "icon.png", label: "Hello", state: 1 });

    expect(action.setTitle).toHaveBeenCalledWith("Hello");
    expect(action.setImage).toHaveBeenCalledWith("icon.png");
  });

  it("only calls setters for fields that are actually defined", async () => {
    const action = fakeDialAction();
    await renderGenericDial(action, { label: "Only label" });

    expect(action.setTitle).toHaveBeenCalledWith("Only label");
    expect(action.setImage).not.toHaveBeenCalled();
  });

  // message-protocol spec (amended): icon: null means "reset to manifest default",
  // applied via setImage() with no argument - distinct from an omitted icon field.
  it("resets the image to the manifest default (calls setImage with no argument) when icon is explicitly null", async () => {
    const action = fakeDialAction();
    await renderGenericDial(action, { icon: null, label: "Idle" });

    expect(action.setImage).toHaveBeenCalledWith(undefined);
    expect(action.setImage).toHaveBeenCalledTimes(1);
  });

  it("never calls setImage when icon is omitted entirely, even though other fields are defined", async () => {
    const action = fakeDialAction();
    await renderGenericDial(action, { label: "Label only" });

    expect(action.setImage).not.toHaveBeenCalled();
  });
});

describe("input_event builders", () => {
  it("builds a rotate input_event with the rotation delta", () => {
    expect(buildDialRotateInputEvent({ row: 0, column: 2 }, -3)).toEqual({
      controller: "encoder",
      position: { index: 2 },
      eventType: "rotate",
      delta: -3,
    });
  });

  it("builds a push input_event with no delta", () => {
    expect(buildDialPushInputEvent({ row: 0, column: 2 })).toEqual({
      controller: "encoder",
      position: { index: 2 },
      eventType: "push",
    });
  });
});
