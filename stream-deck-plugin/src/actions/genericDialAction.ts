import {
  action,
  SingletonAction,
  type DialDownEvent,
  type DialRotateEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import type { InputEventPayload, RenderUpdatePayload } from "@gatoway/core";
import {
  buildDialPushInputEvent,
  buildDialRotateInputEvent,
  renderGenericDial,
} from "./genericDialRenderer.js";
import { encoderPosition, positionsMatch } from "./protocolPositions.js";
import type { RenderStore } from "./renderStore.js";

/** Must match the `UUID` declared for this action in `manifest.json` (design.md D5). */
export const GENERIC_DIAL_ACTION_UUID = "com.gatoway.streamdeck.dial";

/**
 * Gatoway's generic, position-based Encoder (dial) action (AD-8, design.md D5). Forwards
 * raw physical dial events (rotate, push) to Gatoway core as `input_event` messages,
 * and displays whatever the most recent `render_update` for its position specified -
 * see `genericKeyAction.ts`'s doc comment for the same rationale, applied here to dials.
 *
 * This class is intentionally a thin adapter with no independent logic of its own (see
 * `genericDialRenderer.ts` for the actual behavior, which is unit tested directly).
 */
@action({ UUID: GENERIC_DIAL_ACTION_UUID })
export class GenericDialAction extends SingletonAction {
  constructor(
    private readonly renderStore: RenderStore,
    private readonly sendInputEvent: (payload: InputEventPayload) => void,
  ) {
    super();
  }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!ev.action.isDial()) {
      return;
    }
    const position = encoderPosition(ev.action.coordinates);
    await renderGenericDial(ev.action, this.renderStore.get("encoder", position));
  }

  override onDialRotate(ev: DialRotateEvent): void {
    this.sendInputEvent(buildDialRotateInputEvent(ev.action.coordinates, ev.payload.ticks));
  }

  override onDialDown(ev: DialDownEvent): void {
    this.sendInputEvent(buildDialPushInputEvent(ev.action.coordinates));
  }

  // NB: no onDialUp handler - the protocol's input_event has no separate dial-release
  // event (see genericDialRenderer.ts's buildDialPushInputEvent doc comment).

  /**
   * Applies a live `render_update` to any currently-visible instance at that position
   * (design.md D4/D5), the same as `GenericKeyAction.applyRenderUpdate`.
   */
  applyRenderUpdate(payload: RenderUpdatePayload): void {
    if (payload.controller !== "encoder") {
      return;
    }
    for (const instance of this.actions) {
      if (!instance.isDial()) {
        continue;
      }
      if (positionsMatch(encoderPosition(instance.coordinates), payload.position)) {
        void renderGenericDial(instance, this.renderStore.get("encoder", payload.position));
      }
    }
  }
}
