import { mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/logging/logger.js";
import { LayoutStore } from "../../src/routing/layoutStore.js";

// Partial mock: `rename`/`unlink` default to the real implementation, but individual
// QA-013 regression tests below override them per-call to simulate a failed rename (and,
// in one case, a failed cleanup) without disturbing every other test in this file, which
// all rely on the real filesystem.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) };
});

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe("LayoutStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gatoway-layout-store-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.mocked(rename).mockClear();
    vi.mocked(unlink).mockClear();
  });

  function filePath(): string {
    return join(dir, "layout.json");
  }

  describe("load()", () => {
    it("loads a valid config file's profiles and bindings", async () => {
      await writeFile(
        filePath(),
        JSON.stringify({
          profiles: {
            lightroom: {
              bindings: [
                { controller: "keypad", position: { row: 0, column: 0 }, capabilityId: "next-photo" },
                { controller: "encoder", position: { index: 0 }, capabilityId: "exposure" },
              ],
            },
          },
        }),
        "utf8",
      );
      const logger = fakeLogger();
      const store = new LayoutStore({ filePath: filePath(), logger });

      await store.load();

      expect(store.getProfile("lightroom")).toEqual([
        { controller: "keypad", position: { row: 0, column: 0 }, capabilityId: "next-photo" },
        { controller: "encoder", position: { index: 0 }, capabilityId: "exposure" },
      ]);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: "layout_config_loaded" }),
        expect.any(String),
      );
    });

    it("falls back to an empty layout and logs a clear message when no file exists", async () => {
      const logger = fakeLogger();
      const store = new LayoutStore({ filePath: join(dir, "does-not-exist.json"), logger });

      await store.load();

      expect(store.getProfile("lightroom")).toEqual([]);
      expect(store.allPositions()).toEqual([]);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: "layout_config_missing" }),
        expect.stringContaining("no layout config file found"),
      );
    });

    it("falls back to an empty layout and logs an error when the file contains invalid JSON", async () => {
      await writeFile(filePath(), "{ not valid json", "utf8");
      const logger = fakeLogger();
      const store = new LayoutStore({ filePath: filePath(), logger });

      await store.load();

      expect(store.getProfile("lightroom")).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: "layout_config_invalid_json" }),
        expect.any(String),
      );
    });

    it("falls back to an empty layout and logs an error when valid JSON has the wrong shape", async () => {
      await writeFile(filePath(), JSON.stringify({ profiles: "not-an-object" }), "utf8");
      const logger = fakeLogger();
      const store = new LayoutStore({ filePath: filePath(), logger });

      await store.load();

      expect(store.getProfile("lightroom")).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: "layout_config_invalid_shape" }),
        expect.any(String),
      );
    });

    it("falls back to an empty layout when a binding is missing required fields", async () => {
      await writeFile(
        filePath(),
        JSON.stringify({
          profiles: {
            lightroom: { bindings: [{ controller: "keypad", position: { row: 0, column: 0 } }] },
          },
        }),
        "utf8",
      );
      const logger = fakeLogger();
      const store = new LayoutStore({ filePath: filePath(), logger });

      await store.load();

      expect(store.getProfile("lightroom")).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: "layout_config_invalid_shape" }),
        expect.any(String),
      );
    });
  });

  describe("allPositions()", () => {
    it("unions distinct positions across every configured profile, not just one", async () => {
      await writeFile(
        filePath(),
        JSON.stringify({
          profiles: {
            lightroom: {
              bindings: [{ controller: "keypad", position: { row: 0, column: 0 }, capabilityId: "next-photo" }],
            },
            xdesign: {
              bindings: [
                { controller: "keypad", position: { row: 0, column: 0 }, capabilityId: "zoom-in" },
                { controller: "encoder", position: { index: 1 }, capabilityId: "rotate" },
              ],
            },
          },
        }),
        "utf8",
      );
      const logger = fakeLogger();
      const store = new LayoutStore({ filePath: filePath(), logger });

      await store.load();

      expect(store.allPositions()).toEqual(
        expect.arrayContaining([
          { controller: "keypad", position: { row: 0, column: 0 } },
          { controller: "encoder", position: { index: 1 } },
        ]),
      );
      // The keypad (0,0) position is bound in both profiles - the union must not
      // duplicate it.
      expect(store.allPositions()).toHaveLength(2);
    });
  });

  describe("setBinding() / removeBinding()", () => {
    it("reflects a newly-set binding in subsequent resolution reads", async () => {
      const logger = fakeLogger();
      const store = new LayoutStore({ filePath: filePath(), logger });
      await store.load(); // no file yet - starts empty

      store.setBinding("lightroom", "keypad", { row: 1, column: 1 }, "cap.new");

      expect(store.getProfile("lightroom")).toEqual([
        { controller: "keypad", position: { row: 1, column: 1 }, capabilityId: "cap.new" },
      ]);
    });

    it("replaces an existing binding at the same controller/position rather than duplicating it", async () => {
      const logger = fakeLogger();
      const store = new LayoutStore({ filePath: filePath(), logger });
      await store.load();

      store.setBinding("lightroom", "keypad", { row: 0, column: 0 }, "cap.one");
      store.setBinding("lightroom", "keypad", { row: 0, column: 0 }, "cap.two");

      expect(store.getProfile("lightroom")).toEqual([
        { controller: "keypad", position: { row: 0, column: 0 }, capabilityId: "cap.two" },
      ]);
    });

    it("removeBinding removes only the targeted binding", async () => {
      const logger = fakeLogger();
      const store = new LayoutStore({ filePath: filePath(), logger });
      await store.load();
      store.setBinding("lightroom", "keypad", { row: 0, column: 0 }, "cap.one");
      store.setBinding("lightroom", "encoder", { index: 0 }, "cap.two");

      store.removeBinding("lightroom", "keypad", { row: 0, column: 0 });

      expect(store.getProfile("lightroom")).toEqual([
        { controller: "encoder", position: { index: 0 }, capabilityId: "cap.two" },
      ]);
    });

    it("removeBinding on a plugin type with no profile is a no-op, not an error", async () => {
      const logger = fakeLogger();
      const store = new LayoutStore({ filePath: filePath(), logger });
      await store.load();

      expect(() => store.removeBinding("never-configured", "keypad", { row: 0, column: 0 })).not.toThrow();
    });
  });

  describe("save()", () => {
    it("persists the in-memory layout so loading it again reproduces the same bindings", async () => {
      const logger = fakeLogger();
      const store = new LayoutStore({ filePath: filePath(), logger });
      await store.load();
      store.setBinding("lightroom", "keypad", { row: 0, column: 0 }, "next-photo");
      store.setBinding("xdesign", "encoder", { index: 0 }, "zoom");

      await store.save();

      const reloaded = new LayoutStore({ filePath: filePath(), logger });
      await reloaded.load();
      expect(reloaded.getProfile("lightroom")).toEqual([
        { controller: "keypad", position: { row: 0, column: 0 }, capabilityId: "next-photo" },
      ]);
      expect(reloaded.getProfile("xdesign")).toEqual([
        { controller: "encoder", position: { index: 0 }, capabilityId: "zoom" },
      ]);
    });

    it("writes atomically: no temp file is left behind, and the target file always contains complete, valid JSON", async () => {
      const logger = fakeLogger();
      const store = new LayoutStore({ filePath: filePath(), logger });
      await store.load();
      store.setBinding("lightroom", "keypad", { row: 0, column: 0 }, "next-photo");

      await store.save();

      const { readdir } = await import("node:fs/promises");
      const files = await readdir(dir);
      expect(files).toEqual(["layout.json"]);
      const contents = await readFile(filePath(), "utf8");
      expect(() => JSON.parse(contents)).not.toThrow();
    });

    it("does not corrupt the previously-saved file if save() is called again with new data", async () => {
      const logger = fakeLogger();
      const store = new LayoutStore({ filePath: filePath(), logger });
      await store.load();
      store.setBinding("lightroom", "keypad", { row: 0, column: 0 }, "next-photo");
      await store.save();

      store.setBinding("lightroom", "keypad", { row: 1, column: 1 }, "prev-photo");
      await store.save();

      const reloaded = new LayoutStore({ filePath: filePath(), logger });
      await reloaded.load();
      expect(reloaded.getProfile("lightroom")).toEqual([
        { controller: "keypad", position: { row: 0, column: 0 }, capabilityId: "next-photo" },
        { controller: "keypad", position: { row: 1, column: 1 }, capabilityId: "prev-photo" },
      ]);
    });

    // QA-013 regression: a failed rename() must not leak the temp file, and must not
    // corrupt (or even touch) the previously-saved target file.
    it("cleans up the temp file and propagates the original error if rename() fails (QA-013)", async () => {
      const logger = fakeLogger();
      const store = new LayoutStore({ filePath: filePath(), logger });
      await store.load();
      store.setBinding("lightroom", "keypad", { row: 0, column: 0 }, "next-photo");
      await store.save();

      store.setBinding("lightroom", "keypad", { row: 1, column: 1 }, "prev-photo");
      const renameError = new Error("simulated rename failure");
      vi.mocked(rename).mockRejectedValueOnce(renameError);

      await expect(store.save()).rejects.toThrow("simulated rename failure");

      const { readdir } = await import("node:fs/promises");
      const files = await readdir(dir);
      expect(files).toEqual(["layout.json"]); // no orphaned .tmp file left behind

      const contents = await readFile(filePath(), "utf8");
      expect(JSON.parse(contents)).toEqual({
        profiles: { lightroom: { bindings: [{ controller: "keypad", position: { row: 0, column: 0 }, capabilityId: "next-photo" }] } },
      }); // target file still reflects the last successful save, untouched by the failed one
      expect(logger.warn).not.toHaveBeenCalled(); // cleanup itself succeeded, no secondary warning
    });

    it("logs a secondary warning (without masking the original error) if the temp-file cleanup itself fails", async () => {
      const logger = fakeLogger();
      const store = new LayoutStore({ filePath: filePath(), logger });
      await store.load();
      store.setBinding("lightroom", "keypad", { row: 0, column: 0 }, "next-photo");

      const renameError = new Error("simulated rename failure");
      vi.mocked(rename).mockRejectedValueOnce(renameError);
      const cleanupError = new Error("simulated unlink failure");
      vi.mocked(unlink).mockRejectedValueOnce(cleanupError);

      await expect(store.save()).rejects.toThrow("simulated rename failure");

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: "layout_config_temp_cleanup_failed", error: "simulated unlink failure" }),
        expect.any(String),
      );
    });
  });
});
