import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/logging/logger.js";
import { LayoutStore } from "../../src/routing/layoutStore.js";

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
  });
});
