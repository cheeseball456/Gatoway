/**
 * Pure helpers translating between the Elgato Stream Deck SDK's own coordinate system
 * and Gatoway's protocol `Position` addressing (message-protocol spec's `input_event`/
 * `render_update` requirements, design.md D1).
 *
 * Per `ARCHITECTURE.md` AD-8's own note (echoed in the Elgato SDK's `Coordinates` type
 * doc comment): on a Stream Deck+, `row` is always `0` for encoder (dial) instances -
 * `column` is the dial's index. So an encoder's protocol position is simply its
 * `coordinates.column` reinterpreted as `index`; no separate SDK-side "index" concept
 * exists to read from.
 */
import type { Position } from "@gatoway/core";

/** The minimal coordinate shape both `KeyAction` and `DialAction` instances expose. */
export interface SdkCoordinates {
  row: number;
  column: number;
}

/** Builds a `{ row, column }` protocol position from a Keypad action's SDK coordinates. */
export function keypadPosition(coordinates: SdkCoordinates): Position {
  return { row: coordinates.row, column: coordinates.column };
}

/** Builds an `{ index }` protocol position from an Encoder (dial) action's SDK coordinates. */
export function encoderPosition(coordinates: SdkCoordinates): Position {
  return { index: coordinates.column };
}

function isKeypadPosition(position: Position): position is { row: number; column: number } {
  return "row" in position;
}

/** Whether two protocol positions of the same controller kind refer to the same spot. */
export function positionsMatch(a: Position, b: Position): boolean {
  if (isKeypadPosition(a) && isKeypadPosition(b)) {
    return a.row === b.row && a.column === b.column;
  }
  if (!isKeypadPosition(a) && !isKeypadPosition(b)) {
    return a.index === b.index;
  }
  return false;
}
