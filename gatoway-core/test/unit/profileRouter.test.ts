import { describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../../src/connection/connectionManager.js";
import { FocusTracker } from "../../src/focus/focusTracker.js";
import type { Logger } from "../../src/logging/logger.js";
import type { GatowayMessage, RegisterContent } from "../../src/index.js";
import { ProfileRouter, STREAM_DECK_PLUGIN_TYPE } from "../../src/routing/profileRouter.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/** A single button + a single dial, at ordinal index 0 in each of their own arrays. */
const CONTENT_ONE: RegisterContent = {
  buttons: [{ label: "One", icon: "one.png" }],
  dials: [{ label: "One", icon: "one.png" }],
};

const DEVICE_CAPACITY = {
  buttonPositions: [{ row: 0, column: 0 }],
  dialPositions: [{ index: 0 }],
};

function acceptConnection(manager: ConnectionManager, sent: unknown[]) {
  return manager.accept({
    transport: "tcp",
    send: (m: GatowayMessage) => sent.push(m),
    close: vi.fn(),
  });
}

/** Registers the Stream Deck connection and reports the fixture device capacity. */
function registerStreamDeck(router: ProfileRouter, manager: ConnectionManager, sent: unknown[]) {
  const streamDeck = acceptConnection(manager, sent);
  manager.transition(streamDeck.id, "authenticated");
  manager.setPluginInfo(streamDeck.id, STREAM_DECK_PLUGIN_TYPE, { buttons: [], dials: [] });
  router.handleDeviceCapacity(streamDeck, DEVICE_CAPACITY);
  return streamDeck;
}

describe("ProfileRouter", () => {
  describe("device_capacity", () => {
    it("stores a report sent by the stream-deck connection", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const router = new ProfileRouter({ manager, focusTracker: new FocusTracker(logger), logger });
      const streamDeck = acceptConnection(manager, []);
      manager.transition(streamDeck.id, "authenticated");
      manager.setPluginInfo(streamDeck.id, STREAM_DECK_PLUGIN_TYPE, { buttons: [], dials: [] });

      router.handleDeviceCapacity(streamDeck, DEVICE_CAPACITY);

      const sent: unknown[] = [];
      const receiver = manager.accept({ transport: "tcp", send: (m) => sent.push(m), close: vi.fn() });
      manager.transition(receiver.id, "authenticated");
      manager.setPluginInfo(receiver.id, "test-app", { buttons: [], dials: [] });
      router.handleRegistered(receiver);

      expect(sent).toEqual([
        { type: "slot_capacity", connectionId: receiver.id, payload: { buttonSlots: 1, dialSlots: 1 } },
      ]);
    });

    it("ignores a report sent by a connection that did not register as stream-deck", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const router = new ProfileRouter({ manager, focusTracker: new FocusTracker(logger), logger });
      const app = acceptConnection(manager, []);
      manager.transition(app.id, "authenticated");
      manager.setPluginInfo(app.id, "test-app", { buttons: [], dials: [] });

      router.handleDeviceCapacity(app, DEVICE_CAPACITY);

      const receiverSent: unknown[] = [];
      const receiver = manager.accept({ transport: "tcp", send: (m) => receiverSent.push(m), close: vi.fn() });
      manager.transition(receiver.id, "authenticated");
      manager.setPluginInfo(receiver.id, "test-app-2", { buttons: [], dials: [] });
      router.handleRegistered(receiver);

      expect(receiverSent).toEqual([
        { type: "slot_capacity", connectionId: receiver.id, payload: { buttonSlots: 0, dialSlots: 0 } },
      ]);
    });
  });

  describe("input_event resolution", () => {
    it("ignores an input_event when no connection is focused", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const router = new ProfileRouter({ manager, focusTracker: new FocusTracker(logger), logger });
      const sent: unknown[] = [];
      const streamDeck = registerStreamDeck(router, manager, sent);
      sent.length = 0;

      router.handleInputEvent(streamDeck, {
        controller: "keypad",
        position: { row: 0, column: 0 },
        eventType: "keyDown",
      });

      expect(sent).toEqual([]);
    });

    it("ignores an input_event whose position is not in the latest device_capacity report", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, logger });
      const streamDeck = registerStreamDeck(router, manager, []);
      const appSent: unknown[] = [];
      const app = acceptConnection(manager, appSent);
      manager.transition(app.id, "authenticated");
      manager.setPluginInfo(app.id, "test-app", CONTENT_ONE);
      focusTracker.reportFocus(app.id, true);

      router.handleInputEvent(streamDeck, {
        controller: "keypad",
        position: { row: 5, column: 5 },
        eventType: "keyDown",
      });

      expect(appSent.filter((m) => (m as { type: string }).type === "command")).toEqual([]);
    });

    it("ignores an input_event when the focused connection's content has no entry at that ordinal index (underflow)", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, logger });
      const streamDeck = registerStreamDeck(router, manager, []);
      const appSent: unknown[] = [];
      const app = acceptConnection(manager, appSent);
      manager.transition(app.id, "authenticated");
      // Declares no content at all - the device has a button/dial slot, but this
      // connection's own content is shorter (underflow, expected per FR-007).
      manager.setPluginInfo(app.id, "test-app", { buttons: [], dials: [] });
      focusTracker.reportFocus(app.id, true);

      router.handleInputEvent(streamDeck, {
        controller: "keypad",
        position: { row: 0, column: 0 },
        eventType: "keyDown",
      });

      expect(appSent.filter((m) => (m as { type: string }).type === "command")).toEqual([]);
    });

    it("resolves an input_event against the focused connection's declared content and sends a command with its ordinal slotIndex", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, logger });
      const streamDeck = registerStreamDeck(router, manager, []);
      const appSent: unknown[] = [];
      const app = acceptConnection(manager, appSent);
      manager.transition(app.id, "authenticated");
      manager.setPluginInfo(app.id, "test-app", CONTENT_ONE);
      focusTracker.reportFocus(app.id, true);

      router.handleInputEvent(streamDeck, {
        controller: "keypad",
        position: { row: 0, column: 0 },
        eventType: "keyDown",
      });

      expect(appSent).toEqual([
        {
          type: "command",
          connectionId: app.id,
          payload: { controller: "keypad", slotIndex: 0, eventType: "keyDown", delta: undefined },
        },
      ]);
    });

    it("resolves a dial rotation against content.dials, carrying delta through", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, logger });
      const streamDeck = registerStreamDeck(router, manager, []);
      const appSent: unknown[] = [];
      const app = acceptConnection(manager, appSent);
      manager.transition(app.id, "authenticated");
      manager.setPluginInfo(app.id, "test-app", CONTENT_ONE);
      focusTracker.reportFocus(app.id, true);

      router.handleInputEvent(streamDeck, {
        controller: "encoder",
        position: { index: 0 },
        eventType: "rotate",
        delta: 3,
      });

      expect(appSent).toEqual([
        {
          type: "command",
          connectionId: app.id,
          payload: { controller: "encoder", slotIndex: 0, eventType: "rotate", delta: 3 },
        },
      ]);
    });
  });

  describe("focus + rendering", () => {
    it("sends a render sweep reflecting the newly-focused connection's declared content, plus a fresh slot_capacity", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, logger });
      const streamDeckSent: unknown[] = [];
      registerStreamDeck(router, manager, streamDeckSent);
      streamDeckSent.length = 0;

      const appSent: unknown[] = [];
      const app = acceptConnection(manager, appSent);
      manager.transition(app.id, "authenticated");
      manager.setPluginInfo(app.id, "test-app", CONTENT_ONE);

      router.handleFocus(app, { focused: true });

      expect(streamDeckSent).toEqual([
        {
          type: "render_update",
          connectionId: expect.any(String),
          payload: { controller: "keypad", position: { row: 0, column: 0 }, icon: "one.png", label: "One", state: undefined },
        },
        {
          type: "render_update",
          connectionId: expect.any(String),
          payload: { controller: "encoder", position: { index: 0 }, icon: "one.png", label: "One", state: undefined },
        },
      ]);
      expect(appSent).toEqual([
        { type: "slot_capacity", connectionId: app.id, payload: { buttonSlots: 1, dialSlots: 1 } },
      ]);
    });

    it("QA-010 regression: sends icon:null (not omitted) when focus supersedes directly to a connection whose content has no icon", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, logger });
      const streamDeckSent: unknown[] = [];
      registerStreamDeck(router, manager, streamDeckSent);
      streamDeckSent.length = 0;

      const appA = acceptConnection(manager, []);
      manager.transition(appA.id, "authenticated");
      manager.setPluginInfo(appA.id, "test-app-a", CONTENT_ONE);
      router.handleFocus(appA, { focused: true });
      const boundIcon = (streamDeckSent[0] as { payload: { icon?: string | null } }).payload.icon;
      expect(boundIcon).toBe("one.png");
      streamDeckSent.length = 0;

      const appB = acceptConnection(manager, []);
      manager.transition(appB.id, "authenticated");
      manager.setPluginInfo(appB.id, "test-app-b", {
        buttons: [{ label: "No Icon" }],
        dials: [{ label: "No Icon" }],
      });
      router.handleFocus(appB, { focused: true });

      expect(streamDeckSent).toEqual([
        {
          type: "render_update",
          connectionId: expect.any(String),
          payload: { controller: "keypad", position: { row: 0, column: 0 }, icon: null, label: "No Icon", state: undefined },
        },
        {
          type: "render_update",
          connectionId: expect.any(String),
          payload: { controller: "encoder", position: { index: 0 }, icon: null, label: "No Icon", state: undefined },
        },
      ]);
      for (const message of streamDeckSent) {
        const payload = (message as { payload: Record<string, unknown> }).payload;
        expect(Object.prototype.hasOwnProperty.call(payload, "icon")).toBe(true);
        expect(payload.icon).toBeNull();
      }
    });

    it("sweeps a physical position to idle when the focused connection's content is shorter than device capacity", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, logger });
      const streamDeckSent: unknown[] = [];
      registerStreamDeck(router, manager, streamDeckSent);
      streamDeckSent.length = 0;

      const app = acceptConnection(manager, []);
      manager.transition(app.id, "authenticated");
      // Declares no content at all - both physical positions should sweep to idle.
      manager.setPluginInfo(app.id, "test-app", { buttons: [], dials: [] });

      router.handleFocus(app, { focused: true });

      expect(streamDeckSent).toEqual([
        {
          type: "render_update",
          connectionId: expect.any(String),
          payload: { controller: "keypad", position: { row: 0, column: 0 }, icon: null, label: "Gatoway", state: 0 },
        },
        {
          type: "render_update",
          connectionId: expect.any(String),
          payload: { controller: "encoder", position: { index: 0 }, icon: null, label: "Gatoway", state: 0 },
        },
      ]);
    });

    it("sends an idle render sweep, explicitly resetting icon to null, to the Stream Deck connection when focus is cleared via blur", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, logger });
      const streamDeckSent: unknown[] = [];
      registerStreamDeck(router, manager, streamDeckSent);
      streamDeckSent.length = 0;

      const app = acceptConnection(manager, []);
      manager.transition(app.id, "authenticated");
      manager.setPluginInfo(app.id, "test-app", CONTENT_ONE);
      router.handleFocus(app, { focused: true });
      streamDeckSent.length = 0;

      router.handleFocus(app, { focused: false });

      expect(streamDeckSent).toEqual([
        {
          type: "render_update",
          connectionId: expect.any(String),
          payload: { controller: "keypad", position: { row: 0, column: 0 }, label: "Gatoway", state: 0, icon: null },
        },
        {
          type: "render_update",
          connectionId: expect.any(String),
          payload: { controller: "encoder", position: { index: 0 }, label: "Gatoway", state: 0, icon: null },
        },
      ]);
    });

    it("sends an idle render sweep when the focused connection disconnects", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, logger });
      const streamDeckSent: unknown[] = [];
      registerStreamDeck(router, manager, streamDeckSent);
      manager.onDisconnect((record) => router.handleDisconnect(record.id));
      streamDeckSent.length = 0;

      const app = acceptConnection(manager, []);
      manager.transition(app.id, "authenticated");
      manager.setPluginInfo(app.id, "test-app", CONTENT_ONE);
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
      const router = new ProfileRouter({ manager, focusTracker, logger });
      const streamDeckSent: unknown[] = [];
      const streamDeck = registerStreamDeck(router, manager, streamDeckSent);
      streamDeckSent.length = 0;

      router.handleRegistered(streamDeck);

      expect(streamDeckSent.length).toBe(2);
      for (const message of streamDeckSent) {
        expect((message as { type: string }).type).toBe("render_update");
        expect((message as { payload: { label?: string; icon?: string | null } }).payload.label).toBe("Gatoway");
        expect((message as { payload: { label?: string; icon?: string | null } }).payload.icon).toBeNull();
      }
    });

    it("sends slot_capacity (not a render sweep) when a non-Stream-Deck connection registers", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, logger });

      const sent: unknown[] = [];
      const app = acceptConnection(manager, sent);
      manager.transition(app.id, "authenticated");
      manager.setPluginInfo(app.id, "some-other-app", { buttons: [], dials: [] });

      router.handleRegistered(app);

      expect(sent).toEqual([
        { type: "slot_capacity", connectionId: app.id, payload: { buttonSlots: 0, dialSlots: 0 } },
      ]);
    });
  });

  describe("re-registration while focused (design.md D3/D5.5)", () => {
    it("immediately re-renders when the focused connection re-registers with new content", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, logger });
      const streamDeckSent: unknown[] = [];
      registerStreamDeck(router, manager, streamDeckSent);
      streamDeckSent.length = 0;

      const app = acceptConnection(manager, []);
      manager.transition(app.id, "authenticated");
      manager.setPluginInfo(app.id, "test-app", CONTENT_ONE);
      router.handleFocus(app, { focused: true });
      streamDeckSent.length = 0;

      manager.setPluginInfo(app.id, "test-app", {
        buttons: [{ label: "Two", icon: "two.png" }],
        dials: [{ label: "Two", icon: "two.png" }],
      });
      router.handleRegistered(app);

      expect(streamDeckSent).toEqual([
        {
          type: "render_update",
          connectionId: expect.any(String),
          payload: { controller: "keypad", position: { row: 0, column: 0 }, icon: "two.png", label: "Two", state: undefined },
        },
        {
          type: "render_update",
          connectionId: expect.any(String),
          payload: { controller: "encoder", position: { index: 0 }, icon: "two.png", label: "Two", state: undefined },
        },
      ]);
    });

    it("stores new content but sends no render when the re-registering connection is not focused", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, logger });
      const streamDeckSent: unknown[] = [];
      registerStreamDeck(router, manager, streamDeckSent);
      streamDeckSent.length = 0;

      const app = acceptConnection(manager, []);
      manager.transition(app.id, "authenticated");
      manager.setPluginInfo(app.id, "test-app", CONTENT_ONE);
      // Never focused.
      router.handleRegistered(app);

      expect(streamDeckSent.filter((m) => (m as { type: string }).type === "render_update")).toEqual([]);
    });
  });
});
