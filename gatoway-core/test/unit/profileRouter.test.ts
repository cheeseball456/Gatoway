import { describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../../src/connection/connectionManager.js";
import { FocusTracker } from "../../src/focus/focusTracker.js";
import type { Logger } from "../../src/logging/logger.js";
import type { Capability, GatowayMessage } from "../../src/index.js";
import type { LayoutResolver, PositionRef } from "../../src/routing/layoutResolver.js";
import { ProfileRouter, STREAM_DECK_PLUGIN_TYPE } from "../../src/routing/profileRouter.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/** A capability the fixture resolver below binds to both of its two positions. */
const CAP_ONE: Capability = { id: "cap.one", label: "One", type: "button", icon: "one.png" };

/**
 * A small, fully-controllable LayoutResolver test double (independent of the real
 * fixture). Resolves to a capability *id* only (design.md D3, amended) - the live
 * `Capability` object itself always comes from whichever connection's own
 * `capabilities` array is being rendered, never from this resolver.
 */
function fakeLayoutResolver(): LayoutResolver {
  const positions: PositionRef[] = [
    { controller: "keypad", position: { row: 0, column: 0 } },
    { controller: "encoder", position: { index: 0 } },
  ];
  return {
    resolve(connectionId, controller, position) {
      if (!connectionId) return null;
      if (controller === "keypad" && "row" in position && position.row === 0 && position.column === 0) {
        return CAP_ONE.id;
      }
      if (controller === "encoder" && "index" in position && position.index === 0) {
        return CAP_ONE.id;
      }
      return null;
    },
    allPositions: () => positions,
  };
}

function acceptConnection(manager: ConnectionManager, sent: unknown[]) {
  return manager.accept({
    transport: "tcp",
    send: (m: GatowayMessage) => sent.push(m),
    close: vi.fn(),
  });
}

describe("ProfileRouter", () => {
  it("ignores an input_event when no connection is focused", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const router = new ProfileRouter({
      manager,
      focusTracker: new FocusTracker(logger),
      layoutResolver: fakeLayoutResolver(),
      logger,
    });
    const sent: unknown[] = [];
    const streamDeck = acceptConnection(manager, sent);

    router.handleInputEvent(streamDeck, {
      controller: "keypad",
      position: { row: 0, column: 0 },
      eventType: "keyDown",
    });

    expect(sent).toEqual([]);
  });

  it("ignores an input_event when the focused connection has no binding at that position", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const focusTracker = new FocusTracker(logger);
    const router = new ProfileRouter({ manager, focusTracker, layoutResolver: fakeLayoutResolver(), logger });
    const sent: unknown[] = [];
    const app = acceptConnection(manager, sent);
    manager.transition(app.id, "authenticated");
    focusTracker.reportFocus(app.id, true);

    router.handleInputEvent(app, {
      controller: "keypad",
      position: { row: 5, column: 5 },
      eventType: "keyDown",
    });

    expect(sent).toEqual([]);
  });

  it("ignores an input_event when the focused connection has not declared the bound capability id", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const focusTracker = new FocusTracker(logger);
    const router = new ProfileRouter({ manager, focusTracker, layoutResolver: fakeLayoutResolver(), logger });
    const appSent: unknown[] = [];
    const app = acceptConnection(manager, appSent);
    manager.transition(app.id, "authenticated");
    // Never declares "cap.one" - the layout resolver still binds it at (0,0).
    manager.setPluginInfo(app.id, "test-app", [{ id: "some.other.cap", label: "Other", type: "button" }]);
    focusTracker.reportFocus(app.id, true);
    const streamDeckSent: unknown[] = [];
    const streamDeck = acceptConnection(manager, streamDeckSent);

    router.handleInputEvent(streamDeck, {
      controller: "keypad",
      position: { row: 0, column: 0 },
      eventType: "keyDown",
    });

    expect(appSent).toEqual([]);
  });

  it("resolves an input_event against the focused connection's binding and sends a command", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const focusTracker = new FocusTracker(logger);
    const router = new ProfileRouter({ manager, focusTracker, layoutResolver: fakeLayoutResolver(), logger });
    const appSent: unknown[] = [];
    const app = acceptConnection(manager, appSent);
    manager.transition(app.id, "authenticated");
    manager.setPluginInfo(app.id, "test-app", [CAP_ONE]);
    focusTracker.reportFocus(app.id, true);
    const streamDeckSent: unknown[] = [];
    const streamDeck = acceptConnection(manager, streamDeckSent);

    router.handleInputEvent(streamDeck, {
      controller: "keypad",
      position: { row: 0, column: 0 },
      eventType: "keyDown",
    });

    expect(appSent).toEqual([
      {
        type: "command",
        connectionId: app.id,
        payload: { capabilityId: "cap.one", eventType: "keyDown", delta: undefined },
      },
    ]);
  });

  it("sends a render sweep reflecting the newly-focused connection's live bound capability data", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const focusTracker = new FocusTracker(logger);
    const router = new ProfileRouter({ manager, focusTracker, layoutResolver: fakeLayoutResolver(), logger });

    const streamDeckSent: unknown[] = [];
    const streamDeck = acceptConnection(manager, streamDeckSent);
    manager.transition(streamDeck.id, "authenticated");
    manager.setPluginInfo(streamDeck.id, STREAM_DECK_PLUGIN_TYPE, []);

    const appSent: unknown[] = [];
    const app = acceptConnection(manager, appSent);
    manager.transition(app.id, "authenticated");
    manager.setPluginInfo(app.id, "test-app", [CAP_ONE]);

    router.handleFocus(app, { focused: true });

    expect(streamDeckSent).toEqual([
      {
        type: "render_update",
        connectionId: streamDeck.id,
        payload: { controller: "keypad", position: { row: 0, column: 0 }, icon: "one.png", label: "One" },
      },
      {
        type: "render_update",
        connectionId: streamDeck.id,
        payload: { controller: "encoder", position: { index: 0 }, icon: "one.png", label: "One" },
      },
    ]);
  });

  it("skips a bound position, without crashing, when the layout resolver binds a capability id the focused connection never declared", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const focusTracker = new FocusTracker(logger);
    const router = new ProfileRouter({ manager, focusTracker, layoutResolver: fakeLayoutResolver(), logger });

    const streamDeckSent: unknown[] = [];
    const streamDeck = acceptConnection(manager, streamDeckSent);
    manager.transition(streamDeck.id, "authenticated");
    manager.setPluginInfo(streamDeck.id, STREAM_DECK_PLUGIN_TYPE, []);

    const appSent: unknown[] = [];
    const app = acceptConnection(manager, appSent);
    manager.transition(app.id, "authenticated");
    // Registers no capabilities at all - "cap.one" is bound by the resolver but not declared.
    manager.setPluginInfo(app.id, "test-app", []);

    router.handleFocus(app, { focused: true });

    expect(streamDeckSent).toEqual([]);
  });

  it("sends an idle render sweep, explicitly resetting icon to null, to the Stream Deck connection when focus is cleared via blur", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const focusTracker = new FocusTracker(logger);
    const router = new ProfileRouter({ manager, focusTracker, layoutResolver: fakeLayoutResolver(), logger });

    const streamDeckSent: unknown[] = [];
    const streamDeck = acceptConnection(manager, streamDeckSent);
    manager.transition(streamDeck.id, "authenticated");
    manager.setPluginInfo(streamDeck.id, STREAM_DECK_PLUGIN_TYPE, []);

    const appSent: unknown[] = [];
    const app = acceptConnection(manager, appSent);
    manager.transition(app.id, "authenticated");
    manager.setPluginInfo(app.id, "test-app", [CAP_ONE]);
    router.handleFocus(app, { focused: true });
    streamDeckSent.length = 0;

    router.handleFocus(app, { focused: false });

    expect(streamDeckSent).toEqual([
      {
        type: "render_update",
        connectionId: streamDeck.id,
        payload: { controller: "keypad", position: { row: 0, column: 0 }, label: "Gatoway", state: 0, icon: null },
      },
      {
        type: "render_update",
        connectionId: streamDeck.id,
        payload: { controller: "encoder", position: { index: 0 }, label: "Gatoway", state: 0, icon: null },
      },
    ]);
  });

  it("resets a previously-shown capability icon back to null rather than leaving it visually stuck when focus clears", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const focusTracker = new FocusTracker(logger);
    const router = new ProfileRouter({ manager, focusTracker, layoutResolver: fakeLayoutResolver(), logger });

    const streamDeckSent: unknown[] = [];
    const streamDeck = acceptConnection(manager, streamDeckSent);
    manager.transition(streamDeck.id, "authenticated");
    manager.setPluginInfo(streamDeck.id, STREAM_DECK_PLUGIN_TYPE, []);

    const app = acceptConnection(manager, []);
    manager.transition(app.id, "authenticated");
    manager.setPluginInfo(app.id, "test-app", [CAP_ONE]);
    router.handleFocus(app, { focused: true });

    // Confirm the bound sweep really did show a non-null icon first, so the reset below
    // is meaningfully checked against a "previously stuck" starting point.
    const boundIcon = (streamDeckSent[0] as { payload: { icon?: string | null } }).payload.icon;
    expect(boundIcon).toBe("one.png");
    streamDeckSent.length = 0;

    router.handleFocus(app, { focused: false });

    expect(streamDeckSent.length).toBeGreaterThan(0);
    for (const message of streamDeckSent) {
      expect((message as { payload: { icon?: string | null } }).payload.icon).toBeNull();
    }
  });

  it("sends an idle render sweep when the focused connection disconnects", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const focusTracker = new FocusTracker(logger);
    const router = new ProfileRouter({ manager, focusTracker, layoutResolver: fakeLayoutResolver(), logger });

    const streamDeckSent: unknown[] = [];
    const streamDeck = acceptConnection(manager, streamDeckSent);
    manager.transition(streamDeck.id, "authenticated");
    manager.setPluginInfo(streamDeck.id, STREAM_DECK_PLUGIN_TYPE, []);
    manager.onDisconnect((record) => router.handleDisconnect(record.id));

    const appSent: unknown[] = [];
    const app = acceptConnection(manager, appSent);
    manager.transition(app.id, "authenticated");
    manager.setPluginInfo(app.id, "test-app", [CAP_ONE]);
    router.handleFocus(app, { focused: true });
    streamDeckSent.length = 0;

    manager.disconnect(app.id, "socket_closed");

    expect(focusTracker.current).toBeNull();
    expect(streamDeckSent.length).toBeGreaterThan(0);
    for (const message of streamDeckSent) {
      expect((message as { payload: { label?: string; icon?: string | null } }).payload.label).toBe("Gatoway");
      expect((message as { payload: { label?: string; icon?: string | null } }).payload.icon).toBeNull();
    }
  });

  it("sends the idle sweep to a Stream Deck connection as soon as it (re)registers with nothing focused", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const focusTracker = new FocusTracker(logger);
    const router = new ProfileRouter({ manager, focusTracker, layoutResolver: fakeLayoutResolver(), logger });

    const streamDeckSent: unknown[] = [];
    const streamDeck = acceptConnection(manager, streamDeckSent);
    manager.transition(streamDeck.id, "authenticated");
    manager.setPluginInfo(streamDeck.id, STREAM_DECK_PLUGIN_TYPE, []);

    router.handleRegistered(streamDeck);

    expect(streamDeckSent.length).toBe(2);
    for (const message of streamDeckSent) {
      expect((message as { type: string }).type).toBe("render_update");
      expect((message as { payload: { label?: string; icon?: string | null } }).payload.label).toBe("Gatoway");
      expect((message as { payload: { label?: string; icon?: string | null } }).payload.icon).toBeNull();
    }
  });

  it("does not send a render sweep when a non-Stream-Deck connection registers", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const focusTracker = new FocusTracker(logger);
    const router = new ProfileRouter({ manager, focusTracker, layoutResolver: fakeLayoutResolver(), logger });

    const sent: unknown[] = [];
    const app = acceptConnection(manager, sent);
    manager.transition(app.id, "authenticated");
    manager.setPluginInfo(app.id, "some-other-app", []);

    router.handleRegistered(app);

    expect(sent).toEqual([]);
  });

  describe("capability_update (task-group-7 addendum)", () => {
    it("sparse-merges the update into the sender's own stored capability record", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, layoutResolver: fakeLayoutResolver(), logger });
      const app = acceptConnection(manager, []);
      manager.transition(app.id, "authenticated");
      manager.setPluginInfo(app.id, "test-app", [{ ...CAP_ONE }]);

      router.handleCapabilityUpdate(app, { capabilityId: "cap.one", label: "Updated Label" });

      expect(manager.get(app.id)?.capabilities).toEqual([
        { id: "cap.one", label: "Updated Label", type: "button", icon: "one.png" },
      ]);
    });

    it("immediately re-renders a bound position when the focused connection pushes a capability_update", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, layoutResolver: fakeLayoutResolver(), logger });

      const streamDeckSent: unknown[] = [];
      const streamDeck = acceptConnection(manager, streamDeckSent);
      manager.transition(streamDeck.id, "authenticated");
      manager.setPluginInfo(streamDeck.id, STREAM_DECK_PLUGIN_TYPE, []);

      const app = acceptConnection(manager, []);
      manager.transition(app.id, "authenticated");
      manager.setPluginInfo(app.id, "test-app", [{ ...CAP_ONE }]);
      router.handleFocus(app, { focused: true });
      streamDeckSent.length = 0;

      router.handleCapabilityUpdate(app, { capabilityId: "cap.one", icon: "two.png", label: "Two" });

      expect(streamDeckSent).toEqual([
        {
          type: "render_update",
          connectionId: streamDeck.id,
          payload: { controller: "keypad", position: { row: 0, column: 0 }, icon: "two.png", label: "Two" },
        },
        {
          type: "render_update",
          connectionId: streamDeck.id,
          payload: { controller: "encoder", position: { index: 0 }, icon: "two.png", label: "Two" },
        },
      ]);
    });

    it("stores a capability_update but sends no render when the sender is not the focused connection", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, layoutResolver: fakeLayoutResolver(), logger });

      const streamDeckSent: unknown[] = [];
      const streamDeck = acceptConnection(manager, streamDeckSent);
      manager.transition(streamDeck.id, "authenticated");
      manager.setPluginInfo(streamDeck.id, STREAM_DECK_PLUGIN_TYPE, []);

      const focusedApp = acceptConnection(manager, []);
      manager.transition(focusedApp.id, "authenticated");
      manager.setPluginInfo(focusedApp.id, "test-app-a", [{ id: "cap.other", label: "Other", type: "button" }]);
      router.handleFocus(focusedApp, { focused: true });
      streamDeckSent.length = 0;

      const backgroundApp = acceptConnection(manager, []);
      manager.transition(backgroundApp.id, "authenticated");
      manager.setPluginInfo(backgroundApp.id, "test-app-b", [{ ...CAP_ONE }]);

      router.handleCapabilityUpdate(backgroundApp, { capabilityId: "cap.one", label: "Updated" });

      expect(streamDeckSent).toEqual([]);
      expect(manager.get(backgroundApp.id)?.capabilities?.[0]?.label).toBe("Updated");
    });

    it("no-ops a capability_update for a capability id the sender never declared", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, layoutResolver: fakeLayoutResolver(), logger });

      const streamDeckSent: unknown[] = [];
      const streamDeck = acceptConnection(manager, streamDeckSent);
      manager.transition(streamDeck.id, "authenticated");
      manager.setPluginInfo(streamDeck.id, STREAM_DECK_PLUGIN_TYPE, []);

      const app = acceptConnection(manager, []);
      manager.transition(app.id, "authenticated");
      const original = { ...CAP_ONE };
      manager.setPluginInfo(app.id, "test-app", [original]);
      router.handleFocus(app, { focused: true });
      streamDeckSent.length = 0;

      router.handleCapabilityUpdate(app, { capabilityId: "cap.never-declared", label: "Should Not Apply" });

      expect(streamDeckSent).toEqual([]);
      expect(manager.get(app.id)?.capabilities).toEqual([original]);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: "capability_update_ignored", reason: "undeclared_capability" }),
        expect.any(String),
      );
    });
  });
});
