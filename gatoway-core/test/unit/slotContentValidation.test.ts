import { describe, expect, it } from "vitest";
import { parseLabel, validateSlotContentEntry } from "../../src/protocol/slotContentValidation.js";
import type { SlotCapacityPayload } from "../../src/protocol/messages.js";

const CAPACITY: SlotCapacityPayload = { buttonSlots: 3, dialSlots: 2 };
const UNKNOWN_CAPACITY: SlotCapacityPayload = { buttonSlots: null, dialSlots: null };

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

  it("rejects non-canonical leading-zero numeric forms (QA-022)", () => {
    expect(parseLabel("B01")).toBeNull();
    expect(parseLabel("D02")).toBeNull();
    expect(parseLabel("B007")).toBeNull();
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

  it("rejects any label at all when the current capacity is a known zero", () => {
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

  // QA-021: capacity being unknown (`null`) must not be conflated with a known `0` -
  // a canonically-formed label is accepted provisionally while capacity is unknown,
  // regardless of how large its ordinal is, since there is nothing to range-check
  // against yet (design.md D4/D9).
  it("accepts a canonically-formed button label provisionally while button capacity is unknown", () => {
    const result = validateSlotContentEntry("B5", { label: "One" }, UNKNOWN_CAPACITY);
    expect(result).toEqual({ ok: true, content: { label: "One" } });
  });

  it("accepts a canonically-formed dial label provisionally while dial capacity is unknown", () => {
    const result = validateSlotContentEntry("D9", { label: "Zoom" }, UNKNOWN_CAPACITY);
    expect(result).toEqual({ ok: true, content: { label: "Zoom" } });
  });

  it("skips only the unknown dimension's range check when one dimension is known and the other isn't", () => {
    const mixedCapacity: SlotCapacityPayload = { buttonSlots: 3, dialSlots: null };
    // Buttons: capacity known, out of range -> still rejected.
    const buttonResult = validateSlotContentEntry("B4", { label: "One" }, mixedCapacity);
    expect(buttonResult.ok).toBe(false);
    // Dials: capacity unknown -> accepted provisionally regardless of ordinal size.
    const dialResult = validateSlotContentEntry("D9", { label: "Zoom" }, mixedCapacity);
    expect(dialResult).toEqual({ ok: true, content: { label: "Zoom" } });
  });

  it("rejects a non-canonical label form regardless of whether capacity is known (QA-022)", () => {
    const knownResult = validateSlotContentEntry("B01", { label: "One" }, CAPACITY);
    expect(knownResult.ok).toBe(false);
    if (!knownResult.ok) {
      expect(knownResult.reason).toContain("B01");
    }

    const unknownResult = validateSlotContentEntry("B01", { label: "One" }, UNKNOWN_CAPACITY);
    expect(unknownResult.ok).toBe(false);
    if (!unknownResult.ok) {
      expect(unknownResult.reason).toContain("B01");
    }
  });

  it("still rejects an invalid value shape while capacity is unknown (only range-checking is skipped)", () => {
    const missingLabel = validateSlotContentEntry("B1", {}, UNKNOWN_CAPACITY);
    expect(missingLabel.ok).toBe(false);

    const stateOnDial = validateSlotContentEntry(
      "D1",
      { label: "Zoom", state: 1 },
      UNKNOWN_CAPACITY,
    );
    expect(stateOnDial.ok).toBe(false);
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
