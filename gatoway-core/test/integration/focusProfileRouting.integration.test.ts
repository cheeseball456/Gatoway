import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import { ConnectionManager } from "../../src/connection/connectionManager.js";
import { startTcpListener, type TcpListenerHandle } from "../../src/connection/tcpListener.js";
import { FocusTracker } from "../../src/focus/focusTracker.js";
import { ProfileRouter, STREAM_DECK_PLUGIN_TYPE } from "../../src/routing/profileRouter.js";
import { encodeMessage, type GatowayMessage } from "../../src/protocol/envelope.js";
import type { DeviceCapacityPayload, RegisterContent } from "../../src/protocol/messages.js";
import { encodeNdjsonLine, NdjsonDecoder } from "../../src/protocol/tcpFraming.js";

/**
 * The fixture device capacity a test-double Stream Deck connection reports
 * (extension-provided-slot-content design.md D1, amended v1.7 for QA-020): one button
 * slot ("B1"), one dial slot ("D1"). An application test-double declares content
 * addressed by those fixed labels, sized to fit (or deliberately not, to exercise
 * underflow).
 */
const DEVICE_CAPACITY: DeviceCapacityPayload = {
  buttonPositions: [{ row: 0, column: 0 }],
  dialPositions: [{ index: 0 }],
};

/** A two-button-slot capacity, used by the content-validation tests below to exercise a shape-invalid (not out-of-range) rejection at a second, still in-capacity label. */
const TWO_BUTTON_DEVICE_CAPACITY: DeviceCapacityPayload = {
  buttonPositions: [{ row: 0, column: 0 }, { row: 0, column: 1 }],
  dialPositions: [{ index: 0 }],
};

const FIXTURE_CONTENT: RegisterContent = {
  B1: { label: "Fixture A", icon: "fixture-a.png" },
  D1: { label: "Fixture Dial" },
};

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function silentLogger() {
  return pino({ level: "silent" });
}

function connectTo(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => resolve(socket));
    socket.on("error", reject);
  });
}

/** A test-double client: connects, registers, and records every message it receives. */
class TestDoubleClient {
  readonly received: GatowayMessage[] = [];
  private readonly decoder = new NdjsonDecoder();
  private closed = false;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      for (const line of this.decoder.push(chunk)) {
        this.received.push(JSON.parse(line) as GatowayMessage);
      }
    });
    socket.on("close", () => {
      this.closed = true;
    });
  }

  static async connectAndRegister(
    port: number,
    token: string,
    pluginType: string,
    content?: RegisterContent,
  ): Promise<TestDoubleClient> {
    const socket = await connectTo(port);
    const client = new TestDoubleClient(socket);
    client.send({
      type: "register",
      payload: { pluginType, content, token },
    });
    await client.waitForMessageType("register_ack");
    return client;
  }

  /**
   * Connects without sending `register` (reconnection scenario): lets a test simulate a
   * fresh connection that tries to skip straight to some other message type, which
   * Gatoway core should reject exactly as it would any never-registered connection.
   */
  static async connectOnly(port: number): Promise<TestDoubleClient> {
    const socket = await connectTo(port);
    return new TestDoubleClient(socket);
  }

  send(message: GatowayMessage): void {
    this.socket.write(encodeNdjsonLine(encodeMessage(message)));
  }

  /** Whether Gatoway core has closed this connection from its end. */
  isClosed(): boolean {
    return this.closed;
  }

  async waitForMessageType(type: string, count = 1): Promise<GatowayMessage[]> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const matches = this.received.filter((m) => m.type === type);
      if (matches.length >= count) {
        return matches;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${count} message(s) of type "${type}"`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  close(): void {
    this.socket.destroy();
  }
}

/**
 * Integration test using test-double TCP connections: no real second application
 * plugin exists yet, so this exercises focus tracking, live slot-capacity tracking, and
 * label-addressed profile routing (amended v1.7 for QA-020) against a real, running
 * Gatoway core TCP listener - one test-double connection stands in for the Stream Deck
 * plugin (registers as `stream-deck`, reports `device_capacity`), another stands in for
 * an application plugin (registers with `content`, reports focus, and is the target of
 * resolved `command` messages).
 */
describe("focus tracking + profile routing (integration)", () => {
  let handle: TcpListenerHandle | undefined;
  const clients: TestDoubleClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.close();
    }
    await handle?.close();
    handle = undefined;
  });

  async function start(): Promise<{ port: number; token: string }> {
    const token = "the-real-token";
    const port = await findFreePort();
    const logger = silentLogger();
    const manager = new ConnectionManager(logger);
    const focusTracker = new FocusTracker(logger);

    const router = new ProfileRouter({ manager, focusTracker, logger });
    manager.onDisconnect((record) => router.handleDisconnect(record.id));

    handle = await startTcpListener({ port, manager, logger, currentToken: token, router });
    return { port, token };
  }

  /** Registers the Stream Deck test-double and reports the given (or fixture) device capacity. */
  async function registerStreamDeck(
    port: number,
    token: string,
    capacity: DeviceCapacityPayload = DEVICE_CAPACITY,
  ): Promise<TestDoubleClient> {
    const streamDeck = await TestDoubleClient.connectAndRegister(port, token, STREAM_DECK_PLUGIN_TYPE);
    streamDeck.send({ type: "device_capacity", payload: capacity });
    // No ack for device_capacity - give it a moment to be processed before proceeding.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return streamDeck;
  }

  it("sends zero counts and no idle sweep before any device_capacity has ever been received", async () => {
    const { port, token } = await start();

    const streamDeck = await TestDoubleClient.connectAndRegister(port, token, STREAM_DECK_PLUGIN_TYPE);
    clients.push(streamDeck);

    // No device_capacity reported yet - zero physical positions exist to sweep, and an
    // application plugin sees zero slot counts (design.md D2's "safe, nothing rendered
    // yet" fallback).
    const app = await TestDoubleClient.connectAndRegister(port, token, "test-app", FIXTURE_CONTENT);
    clients.push(app);
    const [slotCapacity] = await app.waitForMessageType("slot_capacity");
    expect(slotCapacity.payload).toEqual({ buttonSlots: 0, dialSlots: 0 });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(streamDeck.received.filter((m) => m.type === "render_update")).toHaveLength(0);
  });

  it("sends the idle render sweep to the Stream Deck connection once it re-registers after device_capacity is known", async () => {
    const { port, token } = await start();

    const streamDeck = await registerStreamDeck(port, token);
    clients.push(streamDeck);

    // Re-registering triggers `handleRegistered` again, now with a known device
    // capacity - the resulting sweep spans exactly the reported positions.
    streamDeck.send({
      type: "register",
      payload: { pluginType: STREAM_DECK_PLUGIN_TYPE, token },
    });

    const updates = await streamDeck.waitForMessageType("render_update", 2);
    for (const update of updates) {
      expect((update.payload as { label?: string }).label).toBe("Gatoway");
      expect((update.payload as { icon?: string | null }).icon).toBeNull();
    }
  });

  it("delivers slot_capacity reflecting device_capacity, and sends a render sweep once capacity + focus are both present", async () => {
    const { port, token } = await start();

    const streamDeck = await registerStreamDeck(port, token);
    clients.push(streamDeck);

    const app = await TestDoubleClient.connectAndRegister(port, token, "test-app", FIXTURE_CONTENT);
    clients.push(app);
    const [slotCapacity] = await app.waitForMessageType("slot_capacity");
    expect(slotCapacity.payload).toEqual({ buttonSlots: 1, dialSlots: 1 });

    app.send({ type: "focus", payload: { focused: true } });
    const updates = await streamDeck.waitForMessageType("render_update", 2);
    expect(updates.map((m) => (m.payload as { label?: string }).label)).toEqual(
      expect.arrayContaining(["Fixture A", "Fixture Dial"]),
    );
  });

  it("routes a resolved input_event to the focused application connection as a command with its fixed label", async () => {
    const { port, token } = await start();

    const streamDeck = await registerStreamDeck(port, token);
    clients.push(streamDeck);

    const app = await TestDoubleClient.connectAndRegister(port, token, "test-app", FIXTURE_CONTENT);
    clients.push(app);
    app.send({ type: "focus", payload: { focused: true } });
    await streamDeck.waitForMessageType("render_update", 2);

    streamDeck.send({
      type: "input_event",
      payload: { controller: "keypad", position: { row: 0, column: 0 }, eventType: "keyDown" },
    });

    const [command] = await app.waitForMessageType("command");
    expect(command.payload).toEqual({
      label: "B1",
      eventType: "keyDown",
      delta: undefined,
    });
  });

  it("silently ignores an input_event whose position is not part of the current device capacity", async () => {
    const { port, token } = await start();

    const streamDeck = await registerStreamDeck(port, token);
    clients.push(streamDeck);

    const app = await TestDoubleClient.connectAndRegister(port, token, "test-app", FIXTURE_CONTENT);
    clients.push(app);
    app.send({ type: "focus", payload: { focused: true } });
    await streamDeck.waitForMessageType("render_update", 2);

    streamDeck.send({
      type: "input_event",
      payload: { controller: "keypad", position: { row: 9, column: 9 }, eventType: "keyDown" },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(app.received.filter((m) => m.type === "command")).toHaveLength(0);
  });

  it("silently ignores an input_event when the focused application declared no content for the resolved label (underflow)", async () => {
    const { port, token } = await start();

    const streamDeck = await registerStreamDeck(port, token);
    clients.push(streamDeck);

    // Registers with no content at all - the device has one button/dial slot, but this
    // app never declared anything to fill them.
    const app = await TestDoubleClient.connectAndRegister(port, token, "test-app");
    clients.push(app);
    app.send({ type: "focus", payload: { focused: true } });

    streamDeck.send({
      type: "input_event",
      payload: { controller: "keypad", position: { row: 0, column: 0 }, eventType: "keyDown" },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(app.received.filter((m) => m.type === "command")).toHaveLength(0);
  });

  it("QA-010 regression: sends icon:null (not omitted) on the wire when focus supersedes directly to an app whose content has no icon", async () => {
    const { port, token } = await start();

    const streamDeck = await registerStreamDeck(port, token);
    clients.push(streamDeck);

    const appA = await TestDoubleClient.connectAndRegister(port, token, "test-app-a", FIXTURE_CONTENT);
    clients.push(appA);
    appA.send({ type: "focus", payload: { focused: true } });
    const bound = await streamDeck.waitForMessageType("render_update", 2);
    const keypadOneFromA = bound.find(
      (m) => (m.payload as { controller?: string }).controller === "keypad",
    );
    expect((keypadOneFromA?.payload as { icon?: string | null }).icon).toBe("fixture-a.png");

    // App B directly supersedes App A's focus (last-report-wins, no intervening
    // blur/idle sweep) - its own content at the same label has no icon.
    const appB = await TestDoubleClient.connectAndRegister(port, token, "test-app-b", {
      B1: { label: "No Icon" },
    });
    clients.push(appB);
    appB.send({ type: "focus", payload: { focused: true } });

    const afterSupersede = await streamDeck.waitForMessageType("render_update", 3);
    const keypadOneFromB = afterSupersede[2];
    const payload = keypadOneFromB!.payload as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(payload, "icon")).toBe(true);
    expect(payload.icon).toBeNull();
  });

  it("reverts to the idle sweep when the focused application blurs", async () => {
    const { port, token } = await start();

    const streamDeck = await registerStreamDeck(port, token);
    clients.push(streamDeck);

    const app = await TestDoubleClient.connectAndRegister(port, token, "test-app", FIXTURE_CONTENT);
    clients.push(app);
    app.send({ type: "focus", payload: { focused: true } });
    await streamDeck.waitForMessageType("render_update", 2);

    app.send({ type: "focus", payload: { focused: false } });

    const allUpdates = await streamDeck.waitForMessageType("render_update", 4);
    const idleUpdates = allUpdates.slice(2);
    expect(idleUpdates.every((m) => (m.payload as { label?: string }).label === "Gatoway")).toBe(true);
    expect(idleUpdates.every((m) => (m.payload as { icon?: string | null }).icon === null)).toBe(true);
  });

  it("reverts to the idle sweep when the focused application disconnects unexpectedly", async () => {
    const { port, token } = await start();

    const streamDeck = await registerStreamDeck(port, token);
    clients.push(streamDeck);

    const app = await TestDoubleClient.connectAndRegister(port, token, "test-app", FIXTURE_CONTENT);
    app.send({ type: "focus", payload: { focused: true } });
    await streamDeck.waitForMessageType("render_update", 2);

    app.close();

    const allUpdates = await streamDeck.waitForMessageType("render_update", 4);
    const idleUpdates = allUpdates.slice(2);
    expect(idleUpdates.every((m) => (m.payload as { label?: string }).label === "Gatoway")).toBe(true);
    expect(idleUpdates.every((m) => (m.payload as { icon?: string | null }).icon === null)).toBe(true);
  });

  describe("re-registration while focused (design.md D3/D5.5)", () => {
    it("immediately re-renders a position when the focused application re-registers with new content", async () => {
      const { port, token } = await start();

      const streamDeck = await registerStreamDeck(port, token);
      clients.push(streamDeck);

      const app = await TestDoubleClient.connectAndRegister(port, token, "test-app", FIXTURE_CONTENT);
      clients.push(app);
      app.send({ type: "focus", payload: { focused: true } });
      await streamDeck.waitForMessageType("render_update", 2);

      app.send({
        type: "register",
        payload: {
          pluginType: "test-app",
          content: { B1: { label: "Fixture A!", icon: "fixture-a-active.png" } },
        },
      });

      const updates = await streamDeck.waitForMessageType("render_update", 4);
      const pushed = updates.find(
        (m) => (m.payload as { label?: string }).label === "Fixture A!",
      );
      expect(pushed?.payload).toEqual({
        controller: "keypad",
        position: { row: 0, column: 0 },
        icon: "fixture-a-active.png",
        label: "Fixture A!",
        state: undefined,
      });
    });

    it("applies a re-registration from a non-focused connection without rendering anything", async () => {
      const { port, token } = await start();

      const streamDeck = await registerStreamDeck(port, token);
      clients.push(streamDeck);

      const focusedApp = await TestDoubleClient.connectAndRegister(
        port,
        token,
        "test-app-a",
        FIXTURE_CONTENT,
      );
      clients.push(focusedApp);
      focusedApp.send({ type: "focus", payload: { focused: true } });
      await streamDeck.waitForMessageType("render_update", 2);

      const backgroundApp = await TestDoubleClient.connectAndRegister(
        port,
        token,
        "test-app-b",
        FIXTURE_CONTENT,
      );
      clients.push(backgroundApp);

      backgroundApp.send({
        type: "register",
        payload: {
          pluginType: "test-app-b",
          content: { B1: { label: "Should Not Render" } },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(streamDeck.received.filter((m) => m.type === "render_update")).toHaveLength(2);
    });
  });

  describe("content payload validation", () => {
    it("registers successfully with only the valid content entries and sends a follow-up error naming the rejected one", async () => {
      const { port, token } = await start();

      // Two button slots known up front (Stream Deck registers first), so "B2" is a
      // currently-valid label - the rejection below is purely shape-based (an empty
      // "label" value), not an out-of-range label (design.md D4, amended v1.7).
      const streamDeck = await registerStreamDeck(port, token, TWO_BUTTON_DEVICE_CAPACITY);
      clients.push(streamDeck);

      const app = await TestDoubleClient.connectAndRegister(port, token, "test-app", {
        B1: { label: "Fixture A" },
        B2: { label: "" },
      } as unknown as RegisterContent);
      clients.push(app);

      const [errorMessage] = await app.waitForMessageType("error");
      expect(
        (
          errorMessage.payload as {
            details: { rejectedContent: { label: string; reason: string }[] };
          }
        ).details.rejectedContent,
      ).toEqual([{ label: "B2", reason: '"label" must be a non-empty string' }]);

      // Registration still succeeded with the valid content: focusing and resolving an
      // input_event against it still works end to end.
      app.send({ type: "focus", payload: { focused: true } });
      await streamDeck.waitForMessageType("render_update", 1);
      streamDeck.send({
        type: "input_event",
        payload: { controller: "keypad", position: { row: 0, column: 0 }, eventType: "keyDown" },
      });
      const [command] = await app.waitForMessageType("command");
      expect(command.payload).toEqual({
        label: "B1",
        eventType: "keyDown",
        delta: undefined,
      });
    });

    it("registers with empty content and sends a follow-up error when every declared entry is malformed", async () => {
      const { port, token } = await start();

      // Stream Deck registers first, so "B1"/"D1" are both in-range - the rejections
      // below are purely shape-based (design.md D4, amended v1.7).
      const streamDeck = await registerStreamDeck(port, token);
      clients.push(streamDeck);

      const app = await TestDoubleClient.connectAndRegister(port, token, "test-app", {
        B1: { label: "" },
        D1: { label: "Zoom", state: 1 },
      } as unknown as RegisterContent);
      clients.push(app);

      const [ack] = await app.waitForMessageType("register_ack");
      expect((ack.payload as { status: string }).status).toBe("ok");

      const [errorMessage] = await app.waitForMessageType("error");
      expect(
        (
          errorMessage.payload as {
            details: { rejectedContent: { label: string; reason: string }[] };
          }
        ).details.rejectedContent,
      ).toHaveLength(2);
    });

    it("rejects a content entry whose key is out of range for the currently-reported device capacity", async () => {
      const { port, token } = await start();

      // Only one button slot known ("B1") - "B2" is a currently-invalid (out-of-range)
      // label, even though it is correctly shaped.
      const streamDeck = await registerStreamDeck(port, token);
      clients.push(streamDeck);

      const app = await TestDoubleClient.connectAndRegister(port, token, "test-app", {
        B1: { label: "Fixture A" },
        B2: { label: "Overflow" },
      } as unknown as RegisterContent);
      clients.push(app);

      const [errorMessage] = await app.waitForMessageType("error");
      const rejected = (
        errorMessage.payload as { details: { rejectedContent: { label: string; reason: string }[] } }
      ).details.rejectedContent;
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.label).toBe("B2");
      expect(rejected[0]?.reason).toContain("out of range");
    });
  });

  describe("reconnection", () => {
    it("gives a reconnecting connection no content or focus until it re-registers and re-asserts focus", async () => {
      const { port, token } = await start();

      const streamDeck = await registerStreamDeck(port, token);
      clients.push(streamDeck);

      // First connection: registers, focuses, gets the bound sweep.
      const original = await TestDoubleClient.connectAndRegister(port, token, "test-app", FIXTURE_CONTENT);
      original.send({ type: "focus", payload: { focused: true } });
      await streamDeck.waitForMessageType("render_update", 2);

      // Disconnects unexpectedly (e.g. a dropped socket) - focus clears, reverting to idle.
      original.close();
      await streamDeck.waitForMessageType("render_update", 4);

      // Reconnects as a brand-new connection. Trying to skip straight to `focus`
      // without a fresh `register` first must be rejected exactly like any other
      // never-registered connection (nothing carries over from the old connection).
      const skippedRegister = await TestDoubleClient.connectOnly(port);
      skippedRegister.send({ type: "focus", payload: { focused: true } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(skippedRegister.isClosed()).toBe(true);
      expect(streamDeck.received.filter((m) => m.type === "render_update")).toHaveLength(4);

      // Reconnects properly this time: fresh `register`, but no `focus` yet - still
      // must not be treated as focused/bound just because it was previously.
      const reconnected = await TestDoubleClient.connectAndRegister(port, token, "test-app", FIXTURE_CONTENT);
      clients.push(reconnected);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(streamDeck.received.filter((m) => m.type === "render_update")).toHaveLength(4);

      // Only once it explicitly re-asserts focus does the bound sweep fire again.
      reconnected.send({ type: "focus", payload: { focused: true } });
      const afterReassert = await streamDeck.waitForMessageType("render_update", 6);
      expect(afterReassert.slice(4).map((m) => (m.payload as { label?: string }).label)).toEqual(
        expect.arrayContaining(["Fixture A", "Fixture Dial"]),
      );
    });
  });
});
