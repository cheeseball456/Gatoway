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
 * Applies the given render state to a dial instance. Only `label`/`icon` apply -
 * unlike keys, dials have no two-state (`setState`) concept in the Elgato SDK, so a
 * `render_update`'s `state` field is simply not applicable here.
 */
export async function renderGenericDial(
  action: GenericDialLike,
  state: RenderState | undefined,
): Promise<void> {
  if (!action.isDial() || !state) {
    return;
  }
  if (state.label !== undefined) {
    await action.setTitle(state.label);
  }
  if (state.icon !== undefined) {
    await action.setImage(state.icon);
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
