import { createServer, type AddressInfo } from "node:net";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import { ConnectionManager } from "../../src/connection/connectionManager.js";
import { startTcpListener, type TcpListenerHandle } from "../../src/connection/tcpListener.js";
import { FocusTracker } from "../../src/focus/focusTracker.js";
import { createTestFixtureLayoutResolver } from "../../src/routing/testFixtureLayoutResolver.js";
import { ProfileRouter, STREAM_DECK_PLUGIN_TYPE } from "../../src/routing/profileRouter.js";
import { encodeMessage, type GatowayMessage } from "../../src/protocol/envelope.js";
import type { Capability } from "../../src/protocol/messages.js";
import { encodeNdjsonLine, NdjsonDecoder } from "../../src/protocol/tcpFraming.js";

/**
 * The test-fixture layout resolver (`testFixtureLayoutResolver.ts`) only ever binds
 * capability *ids* to positions (design.md D3, amended) - a test-double app connection
 * must actually declare capabilities under these same ids for the bound layout sweep
 * and resolved commands to carry any real data, exactly as a real application plugin
 * would need to.
 */
const FIXTURE_CAPABILITIES: Capability[] = [
  { id: "test-fixture.button.one", label: "Fixture A", type: "button", icon: "fixture-a.png" },
  { id: "test-fixture.button.two", label: "Fixture B", type: "button", icon: "fixture-b.png" },
  { id: "test-fixture.dial.one", label: "Fixture Dial", type: "dial" },
];

/**
 * Integration test using test-double TCP connections (tasks.md 6.3): no real second
 * application plugin exists yet (proposal.md's "Out of scope"), so this exercises
 * focus tracking and profile routing against a real, running Gatoway core TCP listener
 * the same way `gatoway-core-foundation`'s own tests exercise real sockets - one
 * test-double connection stands in for the Stream Deck plugin (registers as
 * `stream-deck`), another stands in for an application plugin (registers, reports
 * focus, and is the target of resolved `command` messages).
 */

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

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      for (const line of this.decoder.push(chunk)) {
        this.received.push(JSON.parse(line) as GatowayMessage);
      }
    });
  }

  static async connectAndRegister(
    port: number,
    token: string,
    pluginType: string,
    capabilities: Capability[] = [],
  ): Promise<TestDoubleClient> {
    const socket = await connectTo(port);
    const client = new TestDoubleClient(socket);
    client.send({
      type: "register",
      payload: { pluginType, capabilities, token },
    });
    await client.waitForMessageType("register_ack");
    return client;
  }

  send(message: GatowayMessage): void {
    this.socket.write(encodeNdjsonLine(encodeMessage(message)));
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
    const layoutResolver = createTestFixtureLayoutResolver();
    const router = new ProfileRouter({ manager, focusTracker, layoutResolver, logger });
    manager.onDisconnect((record) => router.handleDisconnect(record.id));

    handle = await startTcpListener({ port, manager, logger, currentToken: token, router });
    return { port, token };
  }

  it("sends the idle render sweep to the Stream Deck connection as soon as it registers", async () => {
    const { port, token } = await start();

    const streamDeck = await TestDoubleClient.connectAndRegister(port, token, STREAM_DECK_PLUGIN_TYPE);
    clients.push(streamDeck);

    const idleUpdates = await streamDeck.waitForMessageType("render_update", 3);
    expect(idleUpdates).toHaveLength(3);
    for (const update of idleUpdates) {
      expect((update.payload as { label?: string }).label).toBe("Gatoway");
      // design.md D4 (amended): the idle sweep explicitly resets icon to null rather
      // than omitting it, so a previously-focused connection's icon never stays stuck.
      expect((update.payload as { icon?: string | null }).icon).toBeNull();
    }
  });

  it("routes a resolved input_event to the focused application connection as a command", async () => {
    const { port, token } = await start();

    const streamDeck = await TestDoubleClient.connectAndRegister(port, token, STREAM_DECK_PLUGIN_TYPE);
    clients.push(streamDeck);
    await streamDeck.waitForMessageType("render_update", 3); // initial idle sweep

    const app = await TestDoubleClient.connectAndRegister(port, token, "test-app", FIXTURE_CAPABILITIES);
    clients.push(app);

    app.send({ type: "focus", payload: { focused: true } });
    const boundUpdates = await streamDeck.waitForMessageType("render_update", 6); // 3 idle + 3 bound
    expect(boundUpdates.slice(3).map((m) => (m.payload as { label?: string }).label)).toEqual(
      expect.arrayContaining(["Fixture A", "Fixture B", "Fixture Dial"]),
    );

    streamDeck.send({
      type: "input_event",
      payload: { controller: "keypad", position: { row: 0, column: 0 }, eventType: "keyDown" },
    });

    const [command] = await app.waitForMessageType("command");
    expect(command.payload).toEqual({
      capabilityId: "test-fixture.button.one",
      eventType: "keyDown",
      delta: undefined,
    });
  });

  it("silently ignores an input_event resolved against a position with no binding", async () => {
    const { port, token } = await start();

    const streamDeck = await TestDoubleClient.connectAndRegister(port, token, STREAM_DECK_PLUGIN_TYPE);
    clients.push(streamDeck);
    await streamDeck.waitForMessageType("render_update", 3);

    const app = await TestDoubleClient.connectAndRegister(port, token, "test-app", FIXTURE_CAPABILITIES);
    clients.push(app);
    app.send({ type: "focus", payload: { focused: true } });
    await streamDeck.waitForMessageType("render_update", 6);

    streamDeck.send({
      type: "input_event",
      payload: { controller: "keypad", position: { row: 9, column: 9 }, eventType: "keyDown" },
    });

    // Give the (non-)delivery a moment, then confirm no command ever arrived.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(app.received.filter((m) => m.type === "command")).toHaveLength(0);
  });

  it("silently ignores an input_event whose bound capability id the focused application never declared", async () => {
    const { port, token } = await start();

    const streamDeck = await TestDoubleClient.connectAndRegister(port, token, STREAM_DECK_PLUGIN_TYPE);
    clients.push(streamDeck);
    await streamDeck.waitForMessageType("render_update", 3);

    // Registers with no capabilities at all - the fixture layout still binds
    // "test-fixture.button.one" at (0,0), but this app never declared it.
    const app = await TestDoubleClient.connectAndRegister(port, token, "test-app");
    clients.push(app);
    app.send({ type: "focus", payload: { focused: true } });

    streamDeck.send({
      type: "input_event",
      payload: { controller: "keypad", position: { row: 0, column: 0 }, eventType: "keyDown" },
    });

    // Give the (non-)delivery a moment: no bound-sweep entries were sendable (nothing
    // declared), so still only the initial idle sweep's 3, and no command arrived.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(streamDeck.received.filter((m) => m.type === "render_update")).toHaveLength(3);
    expect(app.received.filter((m) => m.type === "command")).toHaveLength(0);
  });

  it("reverts to the idle sweep when the focused application blurs", async () => {
    const { port, token } = await start();

    const streamDeck = await TestDoubleClient.connectAndRegister(port, token, STREAM_DECK_PLUGIN_TYPE);
    clients.push(streamDeck);
    await streamDeck.waitForMessageType("render_update", 3);

    const app = await TestDoubleClient.connectAndRegister(port, token, "test-app", FIXTURE_CAPABILITIES);
    clients.push(app);
    app.send({ type: "focus", payload: { focused: true } });
    await streamDeck.waitForMessageType("render_update", 6);

    app.send({ type: "focus", payload: { focused: false } });

    const allUpdates = await streamDeck.waitForMessageType("render_update", 9);
    const idleUpdates = allUpdates.slice(6);
    expect(idleUpdates.every((m) => (m.payload as { label?: string }).label === "Gatoway")).toBe(true);
    // Confirms the previously-shown Fixture A/B icons don't stay stuck: the idle sweep
    // explicitly resets icon to null rather than omitting it (design.md D4, amended).
    expect(idleUpdates.every((m) => (m.payload as { icon?: string | null }).icon === null)).toBe(true);
  });

  it("reverts to the idle sweep when the focused application disconnects unexpectedly", async () => {
    const { port, token } = await start();

    const streamDeck = await TestDoubleClient.connectAndRegister(port, token, STREAM_DECK_PLUGIN_TYPE);
    clients.push(streamDeck);
    await streamDeck.waitForMessageType("render_update", 3);

    const app = await TestDoubleClient.connectAndRegister(port, token, "test-app", FIXTURE_CAPABILITIES);
    app.send({ type: "focus", payload: { focused: true } });
    await streamDeck.waitForMessageType("render_update", 6);

    app.close();

    const allUpdates = await streamDeck.waitForMessageType("render_update", 9);
    const idleUpdates = allUpdates.slice(6);
    expect(idleUpdates.every((m) => (m.payload as { label?: string }).label === "Gatoway")).toBe(true);
    expect(idleUpdates.every((m) => (m.payload as { icon?: string | null }).icon === null)).toBe(true);
  });

  describe("capability_update (task-group-7 addendum)", () => {
    it("immediately re-renders a bound position when the focused application pushes a capability_update", async () => {
      const { port, token } = await start();

      const streamDeck = await TestDoubleClient.connectAndRegister(port, token, STREAM_DECK_PLUGIN_TYPE);
      clients.push(streamDeck);
      await streamDeck.waitForMessageType("render_update", 3); // initial idle sweep

      const app = await TestDoubleClient.connectAndRegister(port, token, "test-app", FIXTURE_CAPABILITIES);
      clients.push(app);
      app.send({ type: "focus", payload: { focused: true } });
      await streamDeck.waitForMessageType("render_update", 6); // 3 idle + 3 bound

      app.send({
        type: "capability_update",
        payload: { capabilityId: "test-fixture.button.one", icon: "fixture-a-active.png", label: "Fixture A!" },
      });

      const updates = await streamDeck.waitForMessageType("render_update", 7);
      const pushed = updates[6];
      expect(pushed.payload).toEqual({
        controller: "keypad",
        position: { row: 0, column: 0 },
        icon: "fixture-a-active.png",
        label: "Fixture A!",
        state: undefined,
      });
    });

    it("applies a capability_update from a non-focused connection without rendering anything", async () => {
      const { port, token } = await start();

      const streamDeck = await TestDoubleClient.connectAndRegister(port, token, STREAM_DECK_PLUGIN_TYPE);
      clients.push(streamDeck);
      await streamDeck.waitForMessageType("render_update", 3);

      const focusedApp = await TestDoubleClient.connectAndRegister(
        port,
        token,
        "test-app-a",
        FIXTURE_CAPABILITIES,
      );
      clients.push(focusedApp);
      focusedApp.send({ type: "focus", payload: { focused: true } });
      await streamDeck.waitForMessageType("render_update", 6);

      const backgroundApp = await TestDoubleClient.connectAndRegister(
        port,
        token,
        "test-app-b",
        FIXTURE_CAPABILITIES,
      );
      clients.push(backgroundApp);

      backgroundApp.send({
        type: "capability_update",
        payload: { capabilityId: "test-fixture.button.two", label: "Should Not Render" },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(streamDeck.received.filter((m) => m.type === "render_update")).toHaveLength(6);
    });

    it("ignores a capability_update for a capability id the application did not declare", async () => {
      const { port, token } = await start();

      const streamDeck = await TestDoubleClient.connectAndRegister(port, token, STREAM_DECK_PLUGIN_TYPE);
      clients.push(streamDeck);
      await streamDeck.waitForMessageType("render_update", 3);

      const app = await TestDoubleClient.connectAndRegister(port, token, "test-app", FIXTURE_CAPABILITIES);
      clients.push(app);
      app.send({ type: "focus", payload: { focused: true } });
      await streamDeck.waitForMessageType("render_update", 6);

      app.send({
        type: "capability_update",
        payload: { capabilityId: "never-declared.capability", label: "Should Not Apply" },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(streamDeck.received.filter((m) => m.type === "render_update")).toHaveLength(6);
    });
  });
});
