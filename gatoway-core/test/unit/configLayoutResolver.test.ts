import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../src/logging/logger.js";
import { createLayoutResolver } from "../../src/routing/configLayoutResolver.js";
import { LayoutStore } from "../../src/routing/layoutStore.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe("createLayoutResolver (config-backed LayoutResolver)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gatoway-config-layout-resolver-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function loadedStore(config: unknown): Promise<LayoutStore> {
    const filePath = join(dir, "layout.json");
    await writeFile(filePath, JSON.stringify(config), "utf8");
    const store = new LayoutStore({ filePath, logger: fakeLogger() });
    await store.load();
    return store;
  }

  it("resolves a bound position for the requesting plugin type", async () => {
    const store = await loadedStore({
      profiles: {
        lightroom: {
          bindings: [{ controller: "keypad", position: { row: 0, column: 0 }, capabilityId: "next-photo" }],
        },
      },
    });
    const resolver = createLayoutResolver(store);

    expect(resolver.resolve("lightroom", "keypad", { row: 0, column: 0 })).toBe("next-photo");
  });

  it("returns null for a position unbound in the requesting plugin type's profile", async () => {
    const store = await loadedStore({
      profiles: {
        lightroom: {
          bindings: [{ controller: "keypad", position: { row: 0, column: 0 }, capabilityId: "next-photo" }],
        },
      },
    });
    const resolver = createLayoutResolver(store);

    expect(resolver.resolve("lightroom", "keypad", { row: 5, column: 5 })).toBeNull();
  });

  it("returns null for a falsy plugin type", async () => {
    const store = await loadedStore({
      profiles: {
        lightroom: {
          bindings: [{ controller: "keypad", position: { row: 0, column: 0 }, capabilityId: "next-photo" }],
        },
      },
    });
    const resolver = createLayoutResolver(store);

    expect(resolver.resolve("", "keypad", { row: 0, column: 0 })).toBeNull();
  });

  it("does not confuse a keypad position with an encoder position sharing a numeric value", async () => {
    const store = await loadedStore({
      profiles: {
        lightroom: {
          bindings: [{ controller: "encoder", position: { index: 0 }, capabilityId: "exposure" }],
        },
      },
    });
    const resolver = createLayoutResolver(store);

    expect(resolver.resolve("lightroom", "keypad", { row: 0, column: 0 })).toBeNull();
  });

  it("resolves identically for two different connections declaring the same plugin type", async () => {
    // design.md D1: plugin type, not connection id, is the resolution key - two
    // separate connections (e.g. across a reconnect, which regenerates the connection
    // id) that both declare the same plugin type must resolve identically.
    const store = await loadedStore({
      profiles: {
        lightroom: {
          bindings: [{ controller: "keypad", position: { row: 0, column: 0 }, capabilityId: "next-photo" }],
        },
      },
    });
    const resolver = createLayoutResolver(store);

    const first = resolver.resolve("lightroom", "keypad", { row: 0, column: 0 });
    const second = resolver.resolve("lightroom", "keypad", { row: 0, column: 0 });

    expect(first).toBe("next-photo");
    expect(second).toBe("next-photo");
  });

  it("resolves the correct profile when multiple plugin types are configured, without cross-contamination", async () => {
    const store = await loadedStore({
      profiles: {
        lightroom: {
          bindings: [{ controller: "keypad", position: { row: 0, column: 0 }, capabilityId: "next-photo" }],
        },
        xdesign: {
          bindings: [{ controller: "keypad", position: { row: 0, column: 0 }, capabilityId: "zoom-in" }],
        },
      },
    });
    const resolver = createLayoutResolver(store);

    expect(resolver.resolve("lightroom", "keypad", { row: 0, column: 0 })).toBe("next-photo");
    expect(resolver.resolve("xdesign", "keypad", { row: 0, column: 0 })).toBe("zoom-in");
  });

  it("allPositions() unions every position bound across all configured profiles", async () => {
    const store = await loadedStore({
      profiles: {
        lightroom: {
          bindings: [{ controller: "keypad", position: { row: 0, column: 0 }, capabilityId: "next-photo" }],
        },
        xdesign: {
          bindings: [{ controller: "encoder", position: { index: 1 }, capabilityId: "rotate" }],
        },
      },
    });
    const resolver = createLayoutResolver(store);

    expect(resolver.allPositions()).toEqual(
      expect.arrayContaining([
        { controller: "keypad", position: { row: 0, column: 0 } },
        { controller: "encoder", position: { index: 1 } },
      ]),
    );
    expect(resolver.allPositions()).toHaveLength(2);
  });

  it("resolves to null for every position when the config file is missing (fresh install)", async () => {
    const store = new LayoutStore({ filePath: join(dir, "missing.json"), logger: fakeLogger() });
    await store.load();
    const resolver = createLayoutResolver(store);

    expect(resolver.resolve("lightroom", "keypad", { row: 0, column: 0 })).toBeNull();
    expect(resolver.allPositions()).toEqual([]);
  });
});
