import { describe, expect, it } from "vitest";
import {
  validateCapability,
  validateCapabilityUpdateFields,
} from "../../src/protocol/capabilityValidation.js";

describe("validateCapability", () => {
  it("accepts a minimal valid capability", () => {
    const result = validateCapability({ id: "cap.one", label: "One", type: "button" });
    expect(result).toEqual({
      ok: true,
      capability: { id: "cap.one", label: "One", type: "button" },
    });
  });

  it("accepts a fully-populated valid capability", () => {
    const result = validateCapability({
      id: "cap.one",
      label: "One",
      type: "dial",
      description: "A dial",
      icon: "icon.png",
      state: 1,
    });
    expect(result).toEqual({
      ok: true,
      capability: {
        id: "cap.one",
        label: "One",
        type: "dial",
        description: "A dial",
        icon: "icon.png",
        state: 1,
      },
    });
  });

  it("rejects a non-object value", () => {
    expect(validateCapability("not an object").ok).toBe(false);
    expect(validateCapability(null).ok).toBe(false);
    expect(validateCapability([]).ok).toBe(false);
  });

  it("rejects a missing or empty id", () => {
    expect(validateCapability({ label: "One", type: "button" }).ok).toBe(false);
    expect(validateCapability({ id: "", label: "One", type: "button" }).ok).toBe(false);
  });

  it("rejects a missing or empty label", () => {
    expect(validateCapability({ id: "cap.one", type: "button" }).ok).toBe(false);
    expect(validateCapability({ id: "cap.one", label: "", type: "button" }).ok).toBe(false);
  });

  it("rejects an invalid type", () => {
    expect(validateCapability({ id: "cap.one", label: "One", type: "slider" }).ok).toBe(false);
    expect(validateCapability({ id: "cap.one", label: "One" }).ok).toBe(false);
  });

  it("rejects a non-string description", () => {
    const result = validateCapability({
      id: "cap.one",
      label: "One",
      type: "button",
      description: 42,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-string icon", () => {
    const result = validateCapability({
      id: "cap.one",
      label: "One",
      type: "button",
      icon: 42,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects icon: null at register time (unlike capability_update's three-way semantics)", () => {
    const result = validateCapability({
      id: "cap.one",
      label: "One",
      type: "button",
      icon: null,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-number state", () => {
    const result = validateCapability({
      id: "cap.one",
      label: "One",
      type: "button",
      state: "1",
    });
    expect(result.ok).toBe(false);
  });
});

describe("validateCapabilityUpdateFields", () => {
  it("returns no entries when no optional fields are present", () => {
    expect(validateCapabilityUpdateFields({ capabilityId: "cap.one" })).toEqual({});
  });

  it("accepts a valid string icon, valid label, and valid state together", () => {
    const result = validateCapabilityUpdateFields({
      capabilityId: "cap.one",
      icon: "icon.png",
      label: "Label",
      state: 3,
    });
    expect(result).toEqual({
      icon: { ok: true, value: "icon.png" },
      label: { ok: true, value: "Label" },
      state: { ok: true, value: 3 },
    });
  });

  it("accepts icon: null as a valid reset", () => {
    const result = validateCapabilityUpdateFields({ capabilityId: "cap.one", icon: null });
    expect(result.icon).toEqual({ ok: true, value: null });
  });

  it("rejects a wrong-typed icon that is neither a string nor null", () => {
    const result = validateCapabilityUpdateFields({
      capabilityId: "cap.one",
      icon: 42 as unknown as string,
    });
    expect(result.icon?.ok).toBe(false);
  });

  it("rejects a wrong-typed label", () => {
    const result = validateCapabilityUpdateFields({
      capabilityId: "cap.one",
      label: 42 as unknown as string,
    });
    expect(result.label?.ok).toBe(false);
  });

  it("rejects a wrong-typed state", () => {
    const result = validateCapabilityUpdateFields({
      capabilityId: "cap.one",
      state: "3" as unknown as number,
    });
    expect(result.state?.ok).toBe(false);
  });

  it("validates a mix of valid and invalid fields independently", () => {
    const result = validateCapabilityUpdateFields({
      capabilityId: "cap.one",
      label: "Valid Label",
      state: "invalid" as unknown as number,
    });
    expect(result.label).toEqual({ ok: true, value: "Valid Label" });
    expect(result.state?.ok).toBe(false);
    expect(result.icon).toBeUndefined();
  });
});
