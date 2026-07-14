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

  describe("wildcard entries", () => {
    const wildcardAllowlist = ["moz-extension://*"];

    it("accepts multiple different origins sharing the wildcard's prefix", () => {
      expect(isOriginAllowed("moz-extension://aaaa-uuid", wildcardAllowlist)).toBe(true);
      expect(isOriginAllowed("moz-extension://bbbb-uuid", wildcardAllowlist)).toBe(true);
    });

    it("rejects an origin with a different scheme/prefix", () => {
      expect(isOriginAllowed("chrome-extension://foo", wildcardAllowlist)).toBe(false);
    });

    it("accepts origins matching either an exact or a wildcard entry in a mixed allowlist", () => {
      const mixed = ["chrome-extension://abc123", "moz-extension://*"];
      expect(isOriginAllowed("chrome-extension://abc123", mixed)).toBe(true);
      expect(isOriginAllowed("moz-extension://any-uuid-at-all", mixed)).toBe(true);
      expect(isOriginAllowed("chrome-extension://evil000", mixed)).toBe(false);
    });

    it("treats a bare '*' entry as matching any origin (empty-string prefix)", () => {
      expect(isOriginAllowed("chrome-extension://anything", ["*"])).toBe(true);
      expect(isOriginAllowed("moz-extension://anything-else", ["*"])).toBe(true);
    });
  });
});
