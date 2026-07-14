import {
  action,
  SingletonAction,
  type KeyDownEvent,
  type KeyUpEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import type { InputEventPayload, RenderUpdatePayload } from "@gatoway/core";
import {
  buildKeyDownInputEvent,
  buildKeyUpInputEvent,
  renderGenericKey,
} from "./genericKeyRenderer.js";
import { keypadPosition, positionsMatch } from "./protocolPositions.js";
import type { RenderStore } from "./renderStore.js";

/** Must match the `UUID` declared for this action in `manifest.json` (design.md D5). */
export const GENERIC_KEY_ACTION_UUID = "com.gatoway.streamdeck.key";

/**
 * Gatoway's generic, position-based Keypad action (AD-8, design.md D5, superseding
 * `stream-deck-plugin-skeleton`'s single static `Idle` action - see the
 * `stream-deck-idle-display` delta spec's Reason/Migration). Has no app-specific or
 * idle-specific knowledge of its own: it forwards raw physical key events to Gatoway
 * core as `input_event` messages, and displays whatever the most recent `render_update`
 * for its position specified - including the idle appearance, which is just what
 * Gatoway core renders when nothing is focused (D4).
 *
 * This class is intentionally a thin adapter with no independent logic of its own (see
 * `genericKeyRenderer.ts` for the actual behavior, which is unit tested directly, and
 * `idleKeyRenderer.ts`'s doc comment for why this class itself cannot be).
 */
@action({ UUID: GENERIC_KEY_ACTION_UUID })
export class GenericKeyAction extends SingletonAction {
  constructor(
    private readonly renderStore: RenderStore,
    private readonly sendInputEvent: (payload: InputEventPayload) => void,
  ) {
    super();
  }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!ev.action.isKey() || !ev.action.coordinates) {
      return;
    }
    const position = keypadPosition(ev.action.coordinates);
    await renderGenericKey(ev.action, this.renderStore.get("keypad", position));
  }

  override onKeyDown(ev: KeyDownEvent): void {
    // `coordinates` is `undefined` only when part of a multi-action (no single physical
    // position to forward - not a position-addressed event, so nothing to send).
    if (!ev.action.coordinates) {
      return;
    }
    this.sendInputEvent(buildKeyDownInputEvent(ev.action.coordinates));
  }

  override onKeyUp(ev: KeyUpEvent): void {
    if (!ev.action.coordinates) {
      return;
    }
    this.sendInputEvent(buildKeyUpInputEvent(ev.action.coordinates));
  }

  /**
   * Applies a live `render_update` to any currently-visible instance at that position
   * (design.md D4/D5) - `onWillAppear` alone only covers an instance's *next* appearance,
   * not one already on screen when the update arrives.
   */
  applyRenderUpdate(payload: RenderUpdatePayload): void {
    if (payload.controller !== "keypad") {
      return;
    }
    for (const instance of this.actions) {
      if (!instance.isKey() || !instance.coordinates) {
        continue;
      }
      if (positionsMatch(keypadPosition(instance.coordinates), payload.position)) {
        void renderGenericKey(instance, this.renderStore.get("keypad", payload.position));
      }
    }
  }
}
