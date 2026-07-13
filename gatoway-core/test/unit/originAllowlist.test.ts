import { describe, expect, it } from "vitest";
import { isOriginAllowed } from "../../src/auth/originAllowlist.js";

describe("originAllowlist", () => {
  const allowlist = ["chrome-extension://abc123", "moz-extension://def456"];

  it("accepts an allowlisted origin", () => {
    expect(isOriginAllowed("chrome-extension://abc123", allowlist)).toBe(true);
  });

  it("rejects a non-allowlisted origin", () => {
    expect(isOriginAllowed("chrome-extension://evil000", allowlist)).toBe(false);
  });

  it("rejects an undefined origin", () => {
    expect(isOriginAllowed(undefined, allowlist)).toBe(false);
  });

  it("rejects any origin against an empty allowlist (fail closed)", () => {
    expect(isOriginAllowed("chrome-extension://abc123", [])).toBe(false);
  });
});
