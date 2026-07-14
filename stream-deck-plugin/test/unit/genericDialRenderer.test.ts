import { describe, expect, it, vi } from "vitest";
import {
  buildDialPushInputEvent,
  buildDialRotateInputEvent,
  GENERIC_DIAL_DEFAULT_LABEL,
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
  // design.md D6 / QA-014: live hardware testing found the generic Dial action stuck
  // showing its manifest Name ("Dial") instead of its declared default Title ("Gatoway")
  // after a full plugin restart with a missing/empty layout config - this baseline closes
  // that gap.
  it("applies the local default baseline (manifest label, default icon) when no render state exists yet for this position, with no Gatoway core message involved at all", async () => {
    const action = fakeDialAction();
    await renderGenericDial(action, undefined);

    expect(action.setTitle).toHaveBeenCalledWith(GENERIC_DIAL_DEFAULT_LABEL);
    expect(action.setImage).toHaveBeenCalledWith(undefined);
  });

  it("does not apply the local default baseline to a non-dial (key) instance", async () => {
    const action = fakeDialAction(false);
    await renderGenericDial(action, undefined);

    expect(action.setTitle).not.toHaveBeenCalled();
    expect(action.setImage).not.toHaveBeenCalled();
  });

  it("a subsequent real render_update still overrides the local baseline normally", async () => {
    const action = fakeDialAction();

    // First appearance: no remembered state yet - local baseline applies.
    await renderGenericDial(action, undefined);
    expect(action.setTitle).toHaveBeenCalledWith(GENERIC_DIAL_DEFAULT_LABEL);

    // A real render_update subsequently arrives for this position (simulated here by
    // RenderStore having merged it and this function being invoked again with the
    // resulting defined state, exactly as applyRenderUpdate does).
    await renderGenericDial(action, { label: "Exposure", icon: "exposure.png" });

    expect(action.setTitle).toHaveBeenLastCalledWith("Exposure");
    expect(action.setImage).toHaveBeenLastCalledWith("exposure.png");
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
