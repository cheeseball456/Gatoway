import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `idleAction.ts` uses `@elgato/streamdeck`'s native (TC39 stage-3) class-decorator
 * syntax, which Vitest's SSR module runner cannot execute (see the comment atop
 * `idleKeyRenderer.ts` for why) - so, unlike `idleKeyRenderer.test.ts`, this test cannot
 * simply `import` `IdleAction` and instantiate it.
 *
 * Instead, this is a structural check directly against `idleAction.ts`'s own source
 * (QA-008): the `stream-deck-idle-display` spec's "No dynamic key behavior" scenario
 * depends entirely on `IdleAction` never defining an `onKeyDown` handler, so pressing
 * the idle key sends no command. This asserts that directly, rather than relying only
 * on code review, so a future edit that accidentally adds an `onKeyDown` handler fails
 * this test.
 */
describe("IdleAction", () => {
  it("defines no onKeyDown handler, so pressing the idle key sends no command (stream-deck-idle-display: 'No dynamic key behavior')", () => {
    const filePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/actions/idleAction.ts",
    );
    const source = readFileSync(filePath, "utf8");

    // Strip comments before searching: this file's own doc comment deliberately mentions
    // "onKeyDown" (explaining *why* there is no such handler), which would otherwise
    // produce a false pass from a naive substring/regex check against the raw source.
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    // Sanity-check the extraction itself hasn't silently broken (e.g. file moved/renamed).
    expect(withoutComments).toContain("class IdleAction");

    expect(withoutComments).not.toMatch(/\bonKeyDown\s*\(/);
  });
});
