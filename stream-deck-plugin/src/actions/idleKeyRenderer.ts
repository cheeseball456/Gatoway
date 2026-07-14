/**
 * The idle key's actual rendering logic (stream-deck-idle-display spec), extracted from
 * `idleAction.ts`'s `@action`-decorated class so it can be unit tested directly.
 *
 * `idleAction.ts` uses `@elgato/streamdeck`'s native (TC39 stage-3) class-decorator
 * syntax, which Vitest's test runner cannot execute: its SSR module runner evaluates
 * transformed source via `vm.Script` ("script" goal), and this decorator syntax
 * currently only parses under "module" goal — a real engine/tooling limitation, not
 * something fixable via `tsconfig`/vitest config (the actual `tsc` build output is
 * unaffected: `tsc` already downlevels decorators to plain helper calls, which is why
 * `npm run build`/`npm start` work regardless). Keeping this action's actual behavior
 * in an undecorated, plain function follows the same separation DEVELOPER.md calls for
 * elsewhere in this codebase: pure logic kept independently testable from
 * side-effecting/framework-wired code.
 */

/** The fixed title shown on the idle key. There is no Property Inspector to change it. */
export const IDLE_ACTION_TITLE = "Gatoway";

/** The minimal shape of a Stream Deck action instance this renderer depends on. */
export interface IdleKeyLike {
  isKey(): boolean;
  setTitle(title?: string): Promise<void>;
}

/**
 * Renders the static idle key (stream-deck-idle-display spec: "Idle Profile Content Is
 * Static"): sets the fixed title for key instances, does nothing for non-key (dial)
 * instances. Independent of any Gatoway core connection state (design.md D4).
 */
export async function renderIdleKey(action: IdleKeyLike): Promise<void> {
  if (!action.isKey()) {
    return;
  }
  await action.setTitle(IDLE_ACTION_TITLE);
}
