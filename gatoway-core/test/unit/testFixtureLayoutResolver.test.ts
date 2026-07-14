import { describe, expect, it } from "vitest";
import { createTestFixtureLayoutResolver } from "../../src/routing/testFixtureLayoutResolver.js";

describe("createTestFixtureLayoutResolver", () => {
  it("resolves a bound keypad position to its capability id, for any connection ID", () => {
    const resolver = createTestFixtureLayoutResolver();

    const capabilityId = resolver.resolve("any-connection", "keypad", { row: 0, column: 0 });

    expect(capabilityId).toBe("test-fixture.button.one");
  });

  it("resolves a bound encoder position to its capability id, for any connection ID", () => {
    const resolver = createTestFixtureLayoutResolver();

    const capabilityId = resolver.resolve("any-connection", "encoder", { index: 0 });

    expect(capabilityId).toBe("test-fixture.dial.one");
  });

  it("returns null for an unbound position", () => {
    const resolver = createTestFixtureLayoutResolver();

    expect(resolver.resolve("any-connection", "keypad", { row: 1, column: 3 })).toBeNull();
    expect(resolver.resolve("any-connection", "encoder", { index: 3 })).toBeNull();
  });

  it("returns null for an empty connection ID", () => {
    const resolver = createTestFixtureLayoutResolver();

    expect(resolver.resolve("", "keypad", { row: 0, column: 0 })).toBeNull();
  });

  it("does not confuse a keypad position with an encoder position sharing a numeric value", () => {
    const resolver = createTestFixtureLayoutResolver();

    // Keypad (0,0) is bound; encoder index 0 is bound too, but they must not cross-match.
    expect(resolver.resolve("c", "encoder", { row: 0, column: 0 } as never)).toBeNull();
  });

  it("allPositions() lists every controller/position pair the fixture layout covers", () => {
    const resolver = createTestFixtureLayoutResolver();

    expect(resolver.allPositions()).toEqual([
      { controller: "keypad", position: { row: 0, column: 0 } },
      { controller: "keypad", position: { row: 0, column: 1 } },
      { controller: "encoder", position: { index: 0 } },
    ]);
  });
});
