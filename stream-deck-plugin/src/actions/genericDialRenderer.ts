/**
 * The generic Encoder (dial) action's actual rendering/input-forwarding logic (stream-
 * deck-idle-display / message-protocol specs), extracted from `genericDialAction.ts`'s
 * `@action`-decorated class for the same reason as `genericKeyRenderer.ts` (see that
 * file's doc comment).
 */
import type { InputEventPayload } from "@gatoway/core";
import type { SdkCoordinates } from "./protocolPositions.js";
import { encoderPosition } from "./protocolPositions.js";
import type { RenderState } from "./renderStore.js";

/** The minimal shape of a Stream Deck dial action instance this renderer depends on. */
export interface GenericDialLike {
  isDial(): boolean;
  setTitle(title?: string): Promise<void>;
  setImage(image?: string): Promise<void>;
}

/**
 * The local default baseline applied when no remembered render state exists yet for a
 * position (design.md D6, QA-014) - must match this action's own declared default state
 * in `manifest.json` (`Actions[].States[0].Title`), currently `"Gatoway"`.
 */
export const GENERIC_DIAL_DEFAULT_LABEL = "Gatoway";

/**
 * Applies the given render state to a dial instance. Only `label`/`icon` apply -
 * unlike keys, dials have no two-state (`setState`) concept in the Elgato SDK, so a
 * `render_update`'s `state` field is simply not applicable here.
 *
 * When no render state exists yet for this position, this applies a local default
 * baseline immediately, independent of anything Gatoway core sends, for the same reason
 * and with the same one-time-fallback guarantee as `genericKeyRenderer.ts`'s
 * `renderGenericKey` - see that function's doc comment for the full explanation
 * (design.md D6, QA-014).
 *
 * `icon` is handled the same way as `genericKeyRenderer.ts`'s `renderGenericKey`
 * (amended): `undefined` means never touch the image; `null` means explicitly reset to
 * the manifest's bundled default via `setImage()` with no argument; a `string` sets
 * that specific icon.
 */
export async function renderGenericDial(
  action: GenericDialLike,
  state: RenderState | undefined,
): Promise<void> {
  if (!action.isDial()) {
    return;
  }
  if (!state) {
    await action.setTitle(GENERIC_DIAL_DEFAULT_LABEL);
    await action.setImage(undefined);
    return;
  }
  if (state.label !== undefined) {
    await action.setTitle(state.label);
  }
  if (state.icon !== undefined) {
    await action.setImage(state.icon === null ? undefined : state.icon);
  }
}

/** Builds the `input_event` payload for a dial rotation (message-protocol spec). */
export function buildDialRotateInputEvent(
  coordinates: SdkCoordinates,
  ticks: number,
): InputEventPayload {
  return {
    controller: "encoder",
    position: encoderPosition(coordinates),
    eventType: "rotate",
    delta: ticks,
  };
}

/**
 * Builds the `input_event` payload for a dial press. Reported as a single `"push"`
 * event on press (`onDialDown`) - the protocol's `input_event` type (design.md D1) has
 * no separate dial-release event distinct from a key's `keyUp`, unlike keys' matched
 * `keyDown`/`keyUp` pair. `onDialUp` is therefore intentionally not forwarded; see this
 * change's developer report for the design-level asymmetry this reflects.
 */
export function buildDialPushInputEvent(coordinates: SdkCoordinates): InputEventPayload {
  return { controller: "encoder", position: encoderPosition(coordinates), eventType: "push" };
}
