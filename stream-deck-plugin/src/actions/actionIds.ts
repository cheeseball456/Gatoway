/**
 * The generic Key/Dial actions' manifest UUIDs (design.md D5, AD-8), factored out of
 * `genericKeyAction.ts`/`genericDialAction.ts` into their own plain module: those two
 * files use `@elgato/streamdeck`'s native class-decorator syntax, which Vitest's SSR
 * module runner cannot execute (see `genericKeyAction.test.ts`'s doc comment) - so
 * anything that only needs these id strings (e.g. `coreClient/deviceCapacity.ts`, and
 * its own unit tests) imports them from here instead, avoiding an accidental
 * dependency on the decorated action classes just to read a constant.
 */

/** Must match the `UUID` declared for the generic Key action in `manifest.json`. */
export const GENERIC_KEY_ACTION_UUID = "com.gatoway.streamdeck.key";

/** Must match the `UUID` declared for the generic Dial action in `manifest.json`. */
export const GENERIC_DIAL_ACTION_UUID = "com.gatoway.streamdeck.dial";
