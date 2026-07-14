/**
 * The generic Keypad action's actual rendering/input-forwarding logic (stream-deck-
 * idle-display / message-protocol specs), extracted from `genericKeyAction.ts`'s
 * `@action`-decorated class so it can be unit tested directly - the same separation
 * `idleKeyRenderer.ts` used, for the same reason: `@elgato/streamdeck`'s native
 * class-decorator syntax isn't executable under Vitest's SSR module runner (see that
 * file's own doc comment for the full explanation).
 */
import type { InputEventPayload } from "@gatoway/core";
import type { SdkCoordinates } from "./protocolPositions.js";
import { keypadPosition } from "./protocolPositions.js";
import type { RenderState } from "./renderStore.js";

/** The minimal shape of a Stream Deck key action instance this renderer depends on. */
export interface GenericKeyLike {
  isKey(): boolean;
  setTitle(title?: string): Promise<void>;
  setImage(image?: string): Promise<void>;
  setState(state: number): Promise<void>;
}

/**
 * Applies the given render state to a key instance. Only calls setters for fields that
 * are actually defined - an undefined field means "never set" or "unchanged", not
 * "reset to nothing" (message-protocol spec's sparse-update semantics), so it must
 * never be applied as an explicit reset. Does nothing if no render state exists yet for
 * this position (nothing has been rendered - the manifest's own default state stands).
 *
 * `icon` is handled specially (amended): `undefined` means "never touch the image" (no
 * call at all); `null` means "explicitly reset to the manifest's bundled default",
 * applied by calling `setImage()` with no argument - the Elgato SDK's own documented way
 * to do exactly that; a `string` sets that specific icon. `null` and `undefined` must
 * not be collapsed together, unlike a simple falsy/nullish check would do.
 */
export async function renderGenericKey(
  action: GenericKeyLike,
  state: RenderState | undefined,
): Promise<void> {
  if (!action.isKey() || !state) {
    return;
  }
  if (state.label !== undefined) {
    await action.setTitle(state.label);
  }
  if (state.icon !== undefined) {
    await action.setImage(state.icon === null ? undefined : state.icon);
  }
  if (state.state !== undefined) {
    await action.setState(state.state);
  }
}

/** Builds the `input_event` payload for a physical key press (message-protocol spec). */
export function buildKeyDownInputEvent(coordinates: SdkCoordinates): InputEventPayload {
  return { controller: "keypad", position: keypadPosition(coordinates), eventType: "keyDown" };
}

/** Builds the `input_event` payload for a physical key release (message-protocol spec). */
export function buildKeyUpInputEvent(coordinates: SdkCoordinates): InputEventPayload {
  return { controller: "keypad", position: keypadPosition(coordinates), eventType: "keyUp" };
}
