import { describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../../src/connection/connectionManager.js";
import { FocusTracker } from "../../src/focus/focusTracker.js";
import type { Logger } from "../../src/logging/logger.js";
import type { GatowayMessage, RegisterContent } from "../../src/index.js";
import { ProfileRouter, STREAM_DECK_PLUGIN_TYPE } from "../../src/routing/profileRouter.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/** A single button + a single dial, at labels "B1"/"D1". */
const CONTENT_ONE: RegisterContent = {
  B1: { label: "One", icon: "one.png" },
  D1: { label: "One", icon: "one.png" },
};

const DEVICE_CAPACITY = {
  buttonPositions: [{ row: 0, column: 0 }],
  dialPositions: [{ index: 0 }],
};

/**
 * A multi-position device capacity (QA-019): 3 button slots + 2 dial slots, so
 * overflow (a connection declaring content for labels beyond physical capacity) and
 * mixed populated/idle sweeps can actually be distinguished from the single-position
 * fixture above, which can't tell "no content" apart from "overflow dropped" or "some
 * slots idle, some populated" apart from "all slots the same".
 */
const MULTI_DEVICE_CAPACITY = {
  buttonPositions: [
    { row: 0, column: 0 },
    { row: 0, column: 1 },
    { row: 0, column: 2 },
  ],
  dialPositions: [{ index: 0 }, { index: 1 }],
};

function acceptConnection(manager: ConnectionManager, sent: unknown[]) {
  return manager.accept({
    transport: "tcp",
    send: (m: GatowayMessage) => sent.push(m),
    close: vi.fn(),
  });
}

/** Registers the Stream Deck connection and reports the given (or fixture) device capacity. */
function registerStreamDeck(
  router: ProfileRouter,
  manager: ConnectionManager,
  sent: unknown[],
  capacity = DEVICE_CAPACITY,
) {
  const streamDeck = acceptConnection(manager, sent);
  manager.transition(streamDeck.id, "authenticated");
  manager.setPluginInfo(streamDeck.id, STREAM_DECK_PLUGIN_TYPE, {});
  router.handleDeviceCapacity(streamDeck, capacity);
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
      manager.setPluginInfo(streamDeck.id, STREAM_DECK_PLUGIN_TYPE, {});

      router.handleDeviceCapacity(streamDeck, DEVICE_CAPACITY);

      const sent: unknown[] = [];
      const receiver = manager.accept({ transport: "tcp", send: (m) => sent.push(m), close: vi.fn() });
      manager.transition(receiver.id, "authenticated");
      manager.setPluginInfo(receiver.id, "test-app", {});
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
      manager.setPluginInfo(app.id, "test-app", {});

      router.handleDeviceCapacity(app, DEVICE_CAPACITY);

      const receiverSent: unknown[] = [];
      const receiver = manager.accept({ transport: "tcp", send: (m) => receiverSent.push(m), close: vi.fn() });
      manager.transition(receiver.id, "authenticated");
      manager.setPluginInfo(receiver.id, "test-app-2", {});
      router.handleRegistered(receiver);

      expect(receiverSent).toEqual([
        { type: "slot_capacity", connectionId: receiver.id, payload: { buttonSlots: 0, dialSlots: 0 } },
      ]);
    });
  });

  describe("getSlotCapacity", () => {
    it("reflects the most recent device_capacity report", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const router = new ProfileRouter({ manager, focusTracker: new FocusTracker(logger), logger });
      expect(router.getSlotCapacity()).toEqual({ buttonSlots: 0, dialSlots: 0 });

      registerStreamDeck(router, manager, [], MULTI_DEVICE_CAPACITY);

      expect(router.getSlotCapacity()).toEqual({ buttonSlots: 3, dialSlots: 2 });
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

    it("ignores an input_event when the focused connection's content has no entry for the resolved label (underflow)", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, logger });
      const streamDeck = registerStreamDeck(router, manager, []);
      const appSent: unknown[] = [];
      const app = acceptConnection(manager, appSent);
      manager.transition(app.id, "authenticated");
      // Declares no content at all - the device has a button/dial slot, but this
      // connection's own content is missing that label (underflow, expected per FR-007).
      manager.setPluginInfo(app.id, "test-app", {});
      focusTracker.reportFocus(app.id, true);

      router.handleInputEvent(streamDeck, {
        controller: "keypad",
        position: { row: 0, column: 0 },
        eventType: "keyDown",
      });

      expect(appSent.filter((m) => (m as { type: string }).type === "command")).toEqual([]);
    });

    it("resolves an input_event against the focused connection's declared content and sends a command with its fixed label", () => {
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
          payload: { label: "B1", eventType: "keyDown", delta: undefined },
        },
      ]);
    });

    it("resolves a dial rotation against the focused connection's content, carrying delta through", () => {
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
          payload: { label: "D1", eventType: "rotate", delta: 3 },
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
        B1: { label: "No Icon" },
        D1: { label: "No Icon" },
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

    it("sweeps a physical position to idle when the focused connection's content has no entry for its label", () => {
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
      manager.setPluginInfo(app.id, "test-app", {});

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
      manager.setPluginInfo(app.id, "some-other-app", {});

      router.handleRegistered(app);

      expect(sent).toEqual([
        { type: "slot_capacity", connectionId: app.id, payload: { buttonSlots: 0, dialSlots: 0 } },
      ]);
    });
  });

  describe("overflow / multi-position mixed sweep (QA-019)", () => {
    it("never renders or resolves past device capacity when a connection declares content for labels beyond physical slots (overflow)", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, logger });
      const streamDeckSent: unknown[] = [];
      const streamDeck = registerStreamDeck(router, manager, streamDeckSent, MULTI_DEVICE_CAPACITY);
      streamDeckSent.length = 0;

      // 5 button labels and 4 dial labels declared, but the device only has 3 button
      // slots ("B1".."B3") and 2 dial slots ("D1"/"D2") - the labels beyond capacity
      // ("B4", "B5", "D3", "D4") have no physical position and must never be rendered.
      const appSent: unknown[] = [];
      const app = acceptConnection(manager, appSent);
      manager.transition(app.id, "authenticated");
      manager.setPluginInfo(app.id, "test-app", {
        B1: { label: "Button 0" },
        B2: { label: "Button 1" },
        B3: { label: "Button 2" },
        B4: { label: "Button 3 (overflow)" },
        B5: { label: "Button 4 (overflow)" },
        D1: { label: "Dial 0" },
        D2: { label: "Dial 1" },
        D3: { label: "Dial 2 (overflow)" },
        D4: { label: "Dial 3 (overflow)" },
      });

      router.handleFocus(app, { focused: true });

      const keypadUpdates = streamDeckSent.filter(
        (m) => (m as { payload: { controller?: string } }).payload.controller === "keypad",
      ) as { payload: { position: unknown; label: string } }[];
      const encoderUpdates = streamDeckSent.filter(
        (m) => (m as { payload: { controller?: string } }).payload.controller === "encoder",
      ) as { payload: { position: unknown; label: string } }[];

      // Exactly one render_update per physical position - never one per declared entry.
      expect(keypadUpdates).toHaveLength(3);
      expect(encoderUpdates).toHaveLength(2);
      expect(keypadUpdates.map((m) => m.payload.label)).toEqual(["Button 0", "Button 1", "Button 2"]);
      expect(encoderUpdates.map((m) => m.payload.label)).toEqual(["Dial 0", "Dial 1"]);
      // The overflow entries never appear anywhere in the sweep.
      const allLabels = streamDeckSent.map((m) => (m as { payload: { label: string } }).payload.label);
      expect(allLabels).not.toContain("Button 3 (overflow)");
      expect(allLabels).not.toContain("Button 4 (overflow)");
      expect(allLabels).not.toContain("Dial 2 (overflow)");
      expect(allLabels).not.toContain("Dial 3 (overflow)");

      // An input_event at the last in-capacity position still resolves normally.
      router.handleInputEvent(streamDeck, {
        controller: "keypad",
        position: { row: 0, column: 2 },
        eventType: "keyDown",
      });
      expect(appSent.filter((m) => (m as { type: string }).type === "command")).toEqual([
        {
          type: "command",
          connectionId: app.id,
          payload: { label: "B3", eventType: "keyDown", delta: undefined },
        },
      ]);
    });

    it("renders a mixed sweep of populated and idle positions in a single focus render (not all-idle or all-populated)", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const focusTracker = new FocusTracker(logger);
      const router = new ProfileRouter({ manager, focusTracker, logger });
      const streamDeckSent: unknown[] = [];
      registerStreamDeck(router, manager, streamDeckSent, MULTI_DEVICE_CAPACITY);
      streamDeckSent.length = 0;

      // Declares fewer labels than physical capacity for both controllers: 2 of 3
      // button slots ("B1"/"B2") and 1 of 2 dial slots ("D1") get real content; the
      // rest must fall back to the idle appearance in the very same sweep.
      const app = acceptConnection(manager, []);
      manager.transition(app.id, "authenticated");
      manager.setPluginInfo(app.id, "test-app", {
        B1: { label: "Button 0", icon: "b0.png" },
        B2: { label: "Button 1", icon: "b1.png" },
        D1: { label: "Dial 0" },
      });

      router.handleFocus(app, { focused: true });

      const keypadUpdates = streamDeckSent.filter(
        (m) => (m as { payload: { controller?: string } }).payload.controller === "keypad",
      ) as { payload: { position: unknown; label: string; icon: string | null } }[];
      const encoderUpdates = streamDeckSent.filter(
        (m) => (m as { payload: { controller?: string } }).payload.controller === "encoder",
      ) as { payload: { position: unknown; label: string; icon: string | null } }[];

      expect(keypadUpdates).toHaveLength(3);
      expect(keypadUpdates[0]!.payload).toMatchObject({ label: "Button 0", icon: "b0.png" });
      expect(keypadUpdates[1]!.payload).toMatchObject({ label: "Button 1", icon: "b1.png" });
      // The third button position ("B3") has no declared entry - idle, in the same
      // sweep as the two populated positions above (not a separate all-idle sweep).
      expect(keypadUpdates[2]!.payload).toMatchObject({ label: "Gatoway", icon: null });

      expect(encoderUpdates).toHaveLength(2);
      expect(encoderUpdates[0]!.payload).toMatchObject({ label: "Dial 0" });
      expect(encoderUpdates[1]!.payload).toMatchObject({ label: "Gatoway", icon: null });
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
        B1: { label: "Two", icon: "two.png" },
        D1: { label: "Two", icon: "two.png" },
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
