import { describe, expect, it } from "vitest";
import { nextBackoffDelayMs } from "../../src/backoff.js";

describe("nextBackoffDelayMs", () => {
  it("returns the initial delay for the first attempt", () => {
    expect(nextBackoffDelayMs(1, { initialDelayMs: 1_000, multiplier: 2, maxDelayMs: 30_000 })).toBe(1_000);
  });

  it("doubles the delay for each subsequent attempt", () => {
    const options = { initialDelayMs: 1_000, multiplier: 2, maxDelayMs: 30_000 };
    expect(nextBackoffDelayMs(2, options)).toBe(2_000);
    expect(nextBackoffDelayMs(3, options)).toBe(4_000);
    expect(nextBackoffDelayMs(4, options)).toBe(8_000);
  });

  it("caps the delay at maxDelayMs", () => {
    const options = { initialDelayMs: 1_000, multiplier: 2, maxDelayMs: 5_000 };
    expect(nextBackoffDelayMs(10, options)).toBe(5_000);
  });

  it("treats attempt numbers below 1 as attempt 1", () => {
    const options = { initialDelayMs: 1_000, multiplier: 2, maxDelayMs: 30_000 };
    expect(nextBackoffDelayMs(0, options)).toBe(1_000);
    expect(nextBackoffDelayMs(-5, options)).toBe(1_000);
  });

  it("uses sensible defaults when no options are given", () => {
    expect(nextBackoffDelayMs(1)).toBe(1_000);
    expect(nextBackoffDelayMs(2)).toBe(2_000);
  });
});
