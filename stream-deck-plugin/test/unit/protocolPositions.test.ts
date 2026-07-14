import { describe, expect, it } from "vitest";
import {
  encoderPosition,
  keypadPosition,
  positionsMatch,
} from "../../src/actions/protocolPositions.js";

describe("protocolPositions", () => {
  it("builds a keypad position from SDK coordinates", () => {
    expect(keypadPosition({ row: 1, column: 2 })).toEqual({ row: 1, column: 2 });
  });

  it("builds an encoder position from an SDK coordinate's column (row is always 0 for dials)", () => {
    expect(encoderPosition({ row: 0, column: 3 })).toEqual({ index: 3 });
  });

  it("matches two keypad positions with the same row/column", () => {
    expect(positionsMatch({ row: 0, column: 1 }, { row: 0, column: 1 })).toBe(true);
    expect(positionsMatch({ row: 0, column: 1 }, { row: 0, column: 2 })).toBe(false);
  });

  it("matches two encoder positions with the same index", () => {
    expect(positionsMatch({ index: 2 }, { index: 2 })).toBe(true);
    expect(positionsMatch({ index: 2 }, { index: 3 })).toBe(false);
  });

  it("never matches a keypad position against an encoder position", () => {
    expect(positionsMatch({ row: 0, column: 0 }, { index: 0 })).toBe(false);
  });
});
