import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** See `genericKeyAction.test.ts`'s doc comment for why this is a structural check. */
describe("GenericDialAction", () => {
  it("defines onDialRotate and onDialDown handlers that forward input_events, and no onDialUp handler (no protocol event represents dial release)", () => {
    const filePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/actions/genericDialAction.ts",
    );
    const source = readFileSync(filePath, "utf8");
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(withoutComments).toContain("class GenericDialAction");
    expect(withoutComments).toMatch(/\bonDialRotate\s*\(/);
    expect(withoutComments).toMatch(/\bonDialDown\s*\(/);
    expect(withoutComments).toMatch(/\bonWillAppear\s*\(/);
    expect(withoutComments).not.toMatch(/\bonDialUp\s*\(/);
    expect(withoutComments).toContain("renderGenericDial");
    expect(withoutComments).toContain("buildDialRotateInputEvent");
    expect(withoutComments).toContain("buildDialPushInputEvent");
  });
});
