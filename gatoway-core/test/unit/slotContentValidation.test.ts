import { describe, expect, it } from "vitest";
import { parseLabel, validateSlotContentEntry } from "../../src/protocol/slotContentValidation.js";
import type { SlotCapacityPayload } from "../../src/protocol/messages.js";

const CAPACITY: SlotCapacityPayload = { buttonSlots: 3, dialSlots: 2 };

describe("parseLabel", () => {
  it("parses a button label into its controller and 1-based ordinal", () => {
    expect(parseLabel("B1")).toEqual({ controller: "keypad", ordinal: 1 });
    expect(parseLabel("B3")).toEqual({ controller: "keypad", ordinal: 3 });
  });

  it("parses a dial label into its controller and 1-based ordinal", () => {
    expect(parseLabel("D1")).toEqual({ controller: "encoder", ordinal: 1 });
    expect(parseLabel("D2")).toEqual({ controller: "encoder", ordinal: 2 });
  });

  it("rejects anything not matching the B<n>/D<n> convention", () => {
    expect(parseLabel("")).toBeNull();
    expect(parseLabel("B")).toBeNull();
    expect(parseLabel("D")).toBeNull();
    expect(parseLabel("B0")).toBeNull();
    expect(parseLabel("B-1")).toBeNull();
    expect(parseLabel("X1")).toBeNull();
    expect(parseLabel("b1")).toBeNull();
    expect(parseLabel("B1x")).toBeNull();
  });
});

describe("validateSlotContentEntry", () => {
  it("accepts a minimal valid button entry within capacity", () => {
    const result = validateSlotContentEntry("B1", { label: "One" }, CAPACITY);
    expect(result).toEqual({ ok: true, content: { label: "One" } });
  });

  it("accepts a fully-populated valid button entry within capacity", () => {
    const result = validateSlotContentEntry(
      "B2",
      { label: "One", icon: "icon.png", state: 1 },
      CAPACITY,
    );
    expect(result).toEqual({
      ok: true,
      content: { label: "One", icon: "icon.png", state: 1 },
    });
  });

  it("accepts a valid dial entry with no state field, within capacity", () => {
    const result = validateSlotContentEntry("D1", { label: "Zoom", icon: "zoom.png" }, CAPACITY);
    expect(result).toEqual({ ok: true, content: { label: "Zoom", icon: "zoom.png" } });
  });

  it("rejects a label that doesn't match the B<n>/D<n> convention at all", () => {
    const result = validateSlotContentEntry("Next", { label: "One" }, CAPACITY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Next");
      expect(result.reason).toContain("not a valid position label");
    }
  });

  it("rejects a button label out of range for the current button capacity", () => {
    const result = validateSlotContentEntry("B4", { label: "One" }, CAPACITY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("B4");
      expect(result.reason).toContain("out of range");
    }
  });

  it("rejects a dial label out of range for the current dial capacity", () => {
    const result = validateSlotContentEntry("D3", { label: "Zoom" }, CAPACITY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("D3");
      expect(result.reason).toContain("out of range");
    }
  });

  it("rejects any label at all when the current capacity is zero", () => {
    const result = validateSlotContentEntry(
      "B1",
      { label: "One" },
      { buttonSlots: 0, dialSlots: 0 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("out of range");
    }
  });

  it("rejects a non-object value", () => {
    expect(validateSlotContentEntry("B1", "not an object", CAPACITY).ok).toBe(false);
    expect(validateSlotContentEntry("B1", null, CAPACITY).ok).toBe(false);
    expect(validateSlotContentEntry("B1", [], CAPACITY).ok).toBe(false);
  });

  it("rejects a missing or empty label", () => {
    expect(validateSlotContentEntry("B1", {}, CAPACITY).ok).toBe(false);
    expect(validateSlotContentEntry("B1", { label: "" }, CAPACITY).ok).toBe(false);
  });

  it("rejects a non-string icon", () => {
    const result = validateSlotContentEntry("B1", { label: "One", icon: 42 }, CAPACITY);
    expect(result.ok).toBe(false);
  });

  it("rejects icon: null at register time (no null-reset semantics at declaration time)", () => {
    const result = validateSlotContentEntry("B1", { label: "One", icon: null }, CAPACITY);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-number state on a button entry", () => {
    const result = validateSlotContentEntry("B1", { label: "One", state: "1" }, CAPACITY);
    expect(result.ok).toBe(false);
  });

  it("rejects any state field at all on a dial (D-prefixed) entry, even a valid number", () => {
    const result = validateSlotContentEntry("D1", { label: "Zoom", state: 1 }, CAPACITY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("dial");
    }
  });
});
