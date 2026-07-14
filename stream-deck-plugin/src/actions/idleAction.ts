import { action, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";
import { renderIdleKey } from "./idleKeyRenderer.js";

/** Must match the `UUID` declared for this action in `manifest.json` (design.md D5). */
export const IDLE_ACTION_UUID = "com.gatoway.streamdeck.idle";

/**
 * The Stream Deck plugin's single static idle key (stream-deck-idle-display spec:
 * "Idle Profile Content Is Static"). Its icon/label are otherwise fixed by
 * `manifest.json`; `onWillAppear` re-asserts the fixed title explicitly (see
 * `idleKeyRenderer.ts`) so the requirement is satisfied by plugin code, not merely by
 * manifest defaults.
 *
 * Renders unconditionally at startup (design.md D4): `onWillAppear` fires whenever this
 * key appears on the currently-displayed profile, entirely independent of whether
 * `CoreClient`/`CoreProcessSupervisor` have connected to Gatoway core yet. There is
 * deliberately no `onKeyDown` handler, so pressing this key sends no command and
 * changes no content — there is no `command` message type yet, and no application
 * connected to route input to (proposal.md's "Out of scope").
 *
 * This class is intentionally a thin adapter with no independent logic of its own (see
 * `idleKeyRenderer.ts` for why, and for where the actual behavior is unit tested).
 */
@action({ UUID: IDLE_ACTION_UUID })
export class IdleAction extends SingletonAction {
  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    await renderIdleKey(ev.action);
  }
}
