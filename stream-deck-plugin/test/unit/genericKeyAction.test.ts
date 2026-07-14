import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `genericKeyAction.ts` uses `@elgato/streamdeck`'s native (TC39 stage-3) class-decorator
 * syntax, which Vitest's SSR module runner cannot execute (see `idleKeyRenderer.ts`'s
 * doc comment, carried over from `stream-deck-plugin-skeleton`, for the full
 * explanation) - so this is a structural check against the source itself, mirroring
 * `idleAction.test.ts`'s approach but the other way around: this action *must* define
 * input-forwarding handlers (message-protocol spec: "Generic Actions Forward Input
 * Events"), unlike the old Idle action which deliberately defined none.
 */
describe("GenericKeyAction", () => {
  it("defines onKeyDown and onKeyUp handlers that forward input_events, and no app-specific/idle-specific rendering logic of its own", () => {
    const filePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/actions/genericKeyAction.ts",
    );
    const source = readFileSync(filePath, "utf8");
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(withoutComments).toContain("class GenericKeyAction");
    expect(withoutComments).toMatch(/\bonKeyDown\s*\(/);
    expect(withoutComments).toMatch(/\bonKeyUp\s*\(/);
    expect(withoutComments).toMatch(/\bonWillAppear\s*\(/);
    // Behavior is delegated to genericKeyRenderer.ts, not implemented inline here.
    expect(withoutComments).toContain("renderGenericKey");
    expect(withoutComments).toContain("buildKeyDownInputEvent");
    expect(withoutComments).toContain("buildKeyUpInputEvent");
  });
});
