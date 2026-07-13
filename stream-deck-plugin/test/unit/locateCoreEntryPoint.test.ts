import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { locateCoreEntryPoint } from "../../src/coreLifecycle/locateCoreEntryPoint.js";

describe("locateCoreEntryPoint", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("resolves @gatoway/core's built entry point via the workspace dependency", () => {
    const resolved = locateCoreEntryPoint();
    expect(resolved).toMatch(/gatoway-core[/\\]dist[/\\]index\.js$/);
  });

  it("throws (rather than returning a guessed path) when @gatoway/core cannot be resolved from the given location", async () => {
    // A directory with its own space in the name and no node_modules of its own,
    // isolated from this package's node_modules — reproducing the "cannot locate the
    // built entry point" case tasks.md 2.5 requires be reported, not silently guessed.
    dir = await mkdtemp(join(tmpdir(), "locate core entry point test-"));
    const resolveFromUrl = pathToFileURL(join(dir, "not-a-real-module.js")).href;
    expect(() => locateCoreEntryPoint(resolveFromUrl)).toThrow();
  });
});
