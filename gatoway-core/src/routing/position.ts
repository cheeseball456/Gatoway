import type { Position } from "../protocol/messages.js";

/** Narrows `Position` to the keypad shape (`{ row, column }`). */
export function isKeypadPosition(position: Position): position is { row: number; column: number } {
  return "row" in position && "column" in position;
}

/**
 * Structural equality between two `Position` values, correctly distinguishing a keypad
 * `{ row, column }` from an encoder `{ index }` even when their numeric fields happen to
 * coincide (e.g. keypad `{row:0,column:0}` vs encoder `{index:0}` must never match).
 * Used by `profileRouter.ts` to resolve an `input_event`'s reported position against the
 * Stream Deck plugin's latest `device_capacity` report (extension-provided-slot-content
 * design.md D6).
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
