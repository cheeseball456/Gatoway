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
 * The local default baseline applied when no remembered render state exists yet for a
 * position (design.md D6, QA-014) - must match this action's own declared default state
 * in `manifest.json` (`Actions[].States[0].Title`), currently `"Gatoway"`.
 */
export const GENERIC_KEY_DEFAULT_LABEL = "Gatoway";

/**
 * Applies the given render state to a key instance. Only calls setters for fields that
 * are actually defined - an undefined field means "never set" or "unchanged", not
 * "reset to nothing" (message-protocol spec's sparse-update semantics), so it must
 * never be applied as an explicit reset.
 *
 * When no render state exists yet for this position - nothing has ever been rendered,
 * e.g. a fresh placement or the plugin process itself having just restarted, which wipes
 * `RenderStore`'s in-memory state entirely (design.md D6, QA-014) - this applies a local
 * default baseline (the manifest's own declared default label/icon) immediately,
 * independent of anything Gatoway core sends, rather than leaving the action looking
 * uninitialized. This is a one-time local fallback only: once a real `render_update`
 * arrives for this position, `RenderStore.apply()` always records an entry for it (see
 * that file), so this function is never invoked with an undefined `state` for that
 * position again - the branch below then applies normally, exactly as if no local
 * baseline had ever been applied.
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
  if (!action.isKey()) {
    return;
  }
  if (!state) {
    await action.setTitle(GENERIC_KEY_DEFAULT_LABEL);
    await action.setImage(undefined);
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
