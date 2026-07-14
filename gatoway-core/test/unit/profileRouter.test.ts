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

/** A small, fully-controllable LayoutResolver test double (independent of the fixture). */
function fakeLayoutResolver(): LayoutResolver {
  const positions: PositionRef[] = [
    { controller: "keypad", position: { row: 0, column: 0 } },
    { controller: "encoder", position: { index: 0 } },
  ];
  const capability: Capability = { id: "cap.one", label: "One", type: "button" };
  return {
    resolve(connectionId, controller, position) {
      if (!connectionId) return null;
      if (controller === "keypad" && "row" in position && position.row === 0 && position.column === 0) {
        return capability;
      }
      if (controller === "encoder" && "index" in position && position.index === 0) {
        return capability;
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

  it("resolves an input_event against the focused connection's binding and sends a command", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const focusTracker = new FocusTracker(logger);
    const router = new ProfileRouter({ manager, focusTracker, layoutResolver: fakeLayoutResolver(), logger });
    const appSent: unknown[] = [];
    const app = acceptConnection(manager, appSent);
    manager.transition(app.id, "authenticated");
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

  it("sends a render sweep reflecting the newly-focused connection's bound layout to the Stream Deck connection", () => {
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

    router.handleFocus(app, { focused: true });

    expect(streamDeckSent).toEqual([
      {
        type: "render_update",
        connectionId: streamDeck.id,
        payload: { controller: "keypad", position: { row: 0, column: 0 }, icon: undefined, label: "One" },
      },
      {
        type: "render_update",
        connectionId: streamDeck.id,
        payload: { controller: "encoder", position: { index: 0 }, icon: undefined, label: "One" },
      },
    ]);
  });

  it("sends an idle render sweep to the Stream Deck connection when focus is cleared via blur", () => {
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
    router.handleFocus(app, { focused: true });
    streamDeckSent.length = 0;

    router.handleFocus(app, { focused: false });

    expect(streamDeckSent).toEqual([
      {
        type: "render_update",
        connectionId: streamDeck.id,
        payload: { controller: "keypad", position: { row: 0, column: 0 }, label: "Gatoway", state: 0 },
      },
      {
        type: "render_update",
        connectionId: streamDeck.id,
        payload: { controller: "encoder", position: { index: 0 }, label: "Gatoway", state: 0 },
      },
    ]);
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
    router.handleFocus(app, { focused: true });
    streamDeckSent.length = 0;

    manager.disconnect(app.id, "socket_closed");

    expect(focusTracker.current).toBeNull();
    expect(streamDeckSent.length).toBeGreaterThan(0);
    for (const message of streamDeckSent) {
      expect((message as { payload: { label?: string } }).payload.label).toBe("Gatoway");
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
      expect((message as { payload: { label?: string } }).payload.label).toBe("Gatoway");
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
});
