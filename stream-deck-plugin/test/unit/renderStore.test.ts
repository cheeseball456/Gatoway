import { describe, expect, it } from "vitest";
import { RenderStore } from "../../src/actions/renderStore.js";

describe("RenderStore", () => {
  it("returns undefined for a position that has never been rendered", () => {
    const store = new RenderStore();
    expect(store.get("keypad", { row: 0, column: 0 })).toBeUndefined();
  });

  it("stores the full state from a fully-specified render_update", () => {
    const store = new RenderStore();
    const result = store.apply({
      controller: "keypad",
      position: { row: 0, column: 0 },
      icon: "icon.png",
      label: "Hello",
      state: 1,
    });

    expect(result).toEqual({ icon: "icon.png", label: "Hello", state: 1 });
    expect(store.get("keypad", { row: 0, column: 0 })).toEqual(result);
  });

  // message-protocol spec: "an update only sets what is changing" - a sparse update
  // must not clobber previously-set fields it omits.
  it("merges a sparse render_update, leaving previously-set fields not mentioned in the update unchanged", () => {
    const store = new RenderStore();
    store.apply({
      controller: "keypad",
      position: { row: 0, column: 0 },
      icon: "icon.png",
      label: "Hello",
      state: 1,
    });

    const merged = store.apply({
      controller: "keypad",
      position: { row: 0, column: 0 },
      label: "Updated",
    });

    expect(merged).toEqual({ icon: "icon.png", label: "Updated", state: 1 });
  });

  it("tracks keypad and encoder positions independently even when their numeric fields collide", () => {
    const store = new RenderStore();
    store.apply({ controller: "keypad", position: { row: 0, column: 0 }, label: "Key" });
    store.apply({ controller: "encoder", position: { index: 0 }, label: "Dial" });

    expect(store.get("keypad", { row: 0, column: 0 })?.label).toBe("Key");
    expect(store.get("encoder", { index: 0 })?.label).toBe("Dial");
  });

  it("persists applied state indefinitely (no clearing method exists) - stream-deck-idle-display: 'Displayed Content Persists'", () => {
    const store = new RenderStore();
    store.apply({ controller: "keypad", position: { row: 0, column: 0 }, label: "Still here" });

    // Nothing in this class can clear state - reading it repeatedly must return the
    // same result, simulating however much time (including a Gatoway core disconnect
    // and restart) passes between renders in the real plugin.
    expect(store.get("keypad", { row: 0, column: 0 })?.label).toBe("Still here");
    expect(store.get("keypad", { row: 0, column: 0 })?.label).toBe("Still here");
  });

  // message-protocol spec (amended): render_update's icon accepts null distinctly from
  // omission - null means "explicit reset to manifest default", omitted means
  // "unchanged". A naive `??` merge would wrongly collapse both into "unchanged".
  describe("icon: null vs. omitted icon (amended semantics)", () => {
    it("stores an explicit icon: null reset, distinct from an omitted icon", () => {
      const store = new RenderStore();
      store.apply({ controller: "keypad", position: { row: 0, column: 0 }, icon: "icon.png" });

      const merged = store.apply({ controller: "keypad", position: { row: 0, column: 0 }, icon: null });

      expect(merged.icon).toBeNull();
    });

    it("leaves a previously-set icon unchanged when a later update omits icon entirely", () => {
      const store = new RenderStore();
      store.apply({ controller: "keypad", position: { row: 0, column: 0 }, icon: "icon.png" });

      const merged = store.apply({ controller: "keypad", position: { row: 0, column: 0 }, label: "New label" });

      expect(merged.icon).toBe("icon.png");
    });

    it("leaves an explicit null reset in place across a subsequent update that omits icon", () => {
      const store = new RenderStore();
      store.apply({ controller: "keypad", position: { row: 0, column: 0 }, icon: "icon.png" });
      store.apply({ controller: "keypad", position: { row: 0, column: 0 }, icon: null });

      const merged = store.apply({ controller: "keypad", position: { row: 0, column: 0 }, label: "New label" });

      expect(merged.icon).toBeNull();
    });
  });
});
