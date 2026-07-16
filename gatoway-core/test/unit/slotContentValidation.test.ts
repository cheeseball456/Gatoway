import { describe, expect, it } from "vitest";
import { validateSlotContent } from "../../src/protocol/slotContentValidation.js";

describe("validateSlotContent", () => {
  it("accepts a minimal valid button entry", () => {
    const result = validateSlotContent({ label: "One" }, "keypad");
    expect(result).toEqual({ ok: true, content: { label: "One" } });
  });

  it("accepts a fully-populated valid button entry", () => {
    const result = validateSlotContent(
      { label: "One", icon: "icon.png", state: 1 },
      "keypad",
    );
    expect(result).toEqual({
      ok: true,
      content: { label: "One", icon: "icon.png", state: 1 },
    });
  });

  it("accepts a valid dial entry with no state field", () => {
    const result = validateSlotContent({ label: "Zoom", icon: "zoom.png" }, "encoder");
    expect(result).toEqual({ ok: true, content: { label: "Zoom", icon: "zoom.png" } });
  });

  it("rejects a non-object value", () => {
    expect(validateSlotContent("not an object", "keypad").ok).toBe(false);
    expect(validateSlotContent(null, "keypad").ok).toBe(false);
    expect(validateSlotContent([], "keypad").ok).toBe(false);
  });

  it("rejects a missing or empty label", () => {
    expect(validateSlotContent({}, "keypad").ok).toBe(false);
    expect(validateSlotContent({ label: "" }, "keypad").ok).toBe(false);
  });

  it("rejects a non-string icon", () => {
    const result = validateSlotContent({ label: "One", icon: 42 }, "keypad");
    expect(result.ok).toBe(false);
  });

  it("rejects icon: null at register time (no null-reset semantics at declaration time)", () => {
    const result = validateSlotContent({ label: "One", icon: null }, "keypad");
    expect(result.ok).toBe(false);
  });

  it("rejects a non-number state on a button entry", () => {
    const result = validateSlotContent({ label: "One", state: "1" }, "keypad");
    expect(result.ok).toBe(false);
  });

  it("rejects any state field at all on a dial (encoder) entry, even a valid number", () => {
    const result = validateSlotContent({ label: "Zoom", state: 1 }, "encoder");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("dial");
    }
  });
});
