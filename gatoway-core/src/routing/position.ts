import type { Position } from "../protocol/messages.js";

/** Narrows `Position` to the keypad shape (`{ row, column }`). */
export function isKeypadPosition(position: Position): position is { row: number; column: number } {
  return "row" in position && "column" in position;
}

/**
 * Structural equality between two `Position` values, correctly distinguishing a keypad
 * `{ row, column }` from an encoder `{ index }` even when their numeric fields happen to
 * coincide (e.g. keypad `{row:0,column:0}` vs encoder `{index:0}` must never match).
 * Shared by `LayoutStore` and the config-backed `LayoutResolver` (both need to compare
 * bound positions), and mirrors the equality check `testFixtureLayoutResolver.ts` used
 * before this change replaced it.
 */
export function samePosition(a: Position, b: Position): boolean {
  if (isKeypadPosition(a) && isKeypadPosition(b)) {
    return a.row === b.row && a.column === b.column;
  }
  if (!isKeypadPosition(a) && !isKeypadPosition(b)) {
    return a.index === b.index;
  }
  return false;
}
