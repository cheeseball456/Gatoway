import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { CoreClient } from "../../src/coreClient/coreClient.js";
import type { PluginLogger } from "../../src/logging/pluginLogger.js";

function fakeLogger(): PluginLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A minimal fake socket: an EventEmitter with the methods CoreClient calls. */
function fakeSocket(): Socket & EventEmitter & { written: string[] } {
  const emitter = new EventEmitter() as Socket & EventEmitter & { written: string[] };
  emitter.written = [];
  (emitter as unknown as { setEncoding: () => void }).setEncoding = vi.fn();
  (emitter as unknown as { write: (data: string) => boolean }).write = vi.fn((data: string) => {
    emitter.written.push(data);
    return true;
  });
  (emitter as unknown as { destroy: () => void }).destroy = vi.fn(() => {
    emitter.emit("close");
  });
  return emitter;
}

function immediateSchedule(): (delayMs: number, fn: () => void) => () => void {
  return (_delayMs, fn) => {
    fn();
    return () => undefined;
  };
}

/** Flushes pending microtasks (promise continuations) so async CoreClient internals settle. */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe("CoreClient", () => {
  it("connects, registers as plugin type 'stream-deck' with no declared content, and presents the token", async () => {
    const logger = fakeLogger();
    const socket = fakeSocket();
    const client = new CoreClient({
      port: 47821,
      tokenFilePath: "/fake/token",
      logger,
      connectFn: () => socket,
      readToken: async () => "the-token\n",
    });

    client.start();
    await flush();
    socket.emit("connect");

    expect(socket.written).toHaveLength(1);
    const sent = JSON.parse(socket.written[0] as string);
    expect(sent).toEqual({
      type: "register",
      payload: { pluginType: "stream-deck", token: "the-token" },
    });
  });

  it("treats a register_ack with status 'ok' as connected", async () => {
    const logger = fakeLogger();
    const socket = fakeSocket();
    const client = new CoreClient({
      port: 47821,
      tokenFilePath: "/fake/token",
      logger,
      connectFn: () => socket,
      readToken: async () => "token",
    });

    client.start();
    await flush();
    socket.emit("connect");
    socket.emit(
      "data",
      `${JSON.stringify({ type: "register_ack", payload: { status: "ok", connectionId: "abc" } })}\n`,
    );

    expect(client.currentState).toBe("connected");
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("registered"),
      expect.objectContaining({ event: "core_client_connected", connectionId: "abc" }),
    );
  });

  it("does not treat itself as connected when registration is rejected, and retries after backoff", async () => {
    const logger = fakeLogger();
    const firstSocket = fakeSocket();
    const secondSocket = fakeSocket();
    const sockets = [firstSocket, secondSocket];
    const scheduleReconnect = vi.fn(immediateSchedule());
    const client = new CoreClient({
      port: 47821,
      tokenFilePath: "/fake/token",
      logger,
      connectFn: () => sockets.shift() as Socket,
      readToken: async () => "token",
      scheduleReconnect,
    });

    client.start();
    await flush();
    firstSocket.emit("connect");
    firstSocket.emit(
      "data",
      `${JSON.stringify({
        type: "register_ack",
        payload: { status: "rejected", connectionId: "abc", reason: "invalid_token" },
      })}\n`,
    );
    await flush();

    expect(client.currentState).not.toBe("connected");
    expect(scheduleReconnect).toHaveBeenCalled();
    // A second connection attempt was made once the rejected connection closed.
    expect(sockets).toHaveLength(0);
  });

  it("retries with backoff after the connection is lost following a successful connection", async () => {
    const logger = fakeLogger();
    const firstSocket = fakeSocket();
    const secondSocket = fakeSocket();
    const sockets = [firstSocket, secondSocket];
    const scheduleReconnect = vi.fn(immediateSchedule());
    const client = new CoreClient({
      port: 47821,
      tokenFilePath: "/fake/token",
      logger,
      connectFn: () => sockets.shift() as Socket,
      readToken: async () => "token",
      scheduleReconnect,
    });

    client.start();
    await flush();
    firstSocket.emit("connect");
    firstSocket.emit(
      "data",
      `${JSON.stringify({ type: "register_ack", payload: { status: "ok", connectionId: "abc" } })}\n`,
    );
    expect(client.currentState).toBe("connected");

    firstSocket.emit("close");
    await flush();

    expect(scheduleReconnect).toHaveBeenCalled();
    expect(client.currentState).not.toBe("connected");
  });

  it("logs a first-attempt token-read failure at 'info', not 'error', during the initial grace period (QA-007)", async () => {
    const logger = fakeLogger();
    const scheduleReconnect = vi.fn(() => () => undefined);
    const client = new CoreClient({
      port: 47821,
      tokenFilePath: "/fake/token",
      logger,
      connectFn: () => fakeSocket(),
      readToken: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      scheduleReconnect,
      now: () => 0,
    });

    client.start();
    await flush();

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("failed to read Gatoway core's auth token file"),
      expect.objectContaining({ event: "core_client_token_read_failed" }),
    );
  });

  it("escalates a token-read failure to 'error' once the initial grace period has elapsed (QA-007)", async () => {
    const logger = fakeLogger();
    let now = 0;
    let scheduledFn: (() => void) | undefined;
    const scheduleReconnect = vi.fn((_delayMs: number, fn: () => void) => {
      scheduledFn = fn;
      return () => {
        scheduledFn = undefined;
      };
    });
    const client = new CoreClient({
      port: 47821,
      tokenFilePath: "/fake/token",
      logger,
      connectFn: () => fakeSocket(),
      readToken: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      scheduleReconnect,
      now: () => now,
      initialGracePeriodMs: 5_000,
    });

    client.start();
    await flush();
    expect(logger.error).not.toHaveBeenCalled();

    // Past the grace period: the same kind of failure is no longer benign-by-default.
    now = 5_001;
    scheduledFn?.();
    await flush();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed to read Gatoway core's auth token file"),
      expect.objectContaining({ event: "core_client_token_read_failed" }),
    );
  });

  it("sends a well-formed input_event message once connected", async () => {
    const logger = fakeLogger();
    const socket = fakeSocket();
    const client = new CoreClient({
      port: 47821,
      tokenFilePath: "/fake/token",
      logger,
      connectFn: () => socket,
      readToken: async () => "token",
    });

    client.start();
    await flush();
    socket.emit("connect");
    socket.emit(
      "data",
      `${JSON.stringify({ type: "register_ack", payload: { status: "ok", connectionId: "abc" } })}\n`,
    );

    client.sendInputEvent({
      controller: "keypad",
      position: { row: 0, column: 0 },
      eventType: "keyDown",
    });

    expect(socket.written).toHaveLength(2); // register, then input_event
    expect(JSON.parse(socket.written[1] as string)).toEqual({
      type: "input_event",
      payload: { controller: "keypad", position: { row: 0, column: 0 }, eventType: "keyDown" },
    });
  });

  it("drops an input_event (logging a warning) rather than sending it while not connected", async () => {
    const logger = fakeLogger();
    const client = new CoreClient({
      port: 47821,
      tokenFilePath: "/fake/token",
      logger,
      connectFn: () => fakeSocket(),
      readToken: async () => "token",
    });

    client.sendInputEvent({
      controller: "keypad",
      position: { row: 0, column: 0 },
      eventType: "keyDown",
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("dropping input_event"),
      expect.objectContaining({ event: "core_client_input_event_dropped" }),
    );
  });

  it("invokes onRegistered once a register_ack with status 'ok' arrives", async () => {
    const logger = fakeLogger();
    const socket = fakeSocket();
    const onRegistered = vi.fn();
    const client = new CoreClient({
      port: 47821,
      tokenFilePath: "/fake/token",
      logger,
      connectFn: () => socket,
      readToken: async () => "token",
      onRegistered,
    });

    client.start();
    await flush();
    socket.emit("connect");
    expect(onRegistered).not.toHaveBeenCalled();
    socket.emit(
      "data",
      `${JSON.stringify({ type: "register_ack", payload: { status: "ok", connectionId: "abc" } })}\n`,
    );

    expect(onRegistered).toHaveBeenCalledTimes(1);
  });

  it("does not invoke onRegistered when registration is rejected", async () => {
    const logger = fakeLogger();
    const socket = fakeSocket();
    const onRegistered = vi.fn();
    const client = new CoreClient({
      port: 47821,
      tokenFilePath: "/fake/token",
      logger,
      connectFn: () => socket,
      readToken: async () => "token",
      scheduleReconnect: immediateSchedule(),
      onRegistered,
    });

    client.start();
    await flush();
    socket.emit("connect");
    socket.emit(
      "data",
      `${JSON.stringify({
        type: "register_ack",
        payload: { status: "rejected", connectionId: "abc", reason: "invalid_token" },
      })}\n`,
    );
    await flush();

    expect(onRegistered).not.toHaveBeenCalled();
  });

  it("sends a well-formed device_capacity message once connected", async () => {
    const logger = fakeLogger();
    const socket = fakeSocket();
    const client = new CoreClient({
      port: 47821,
      tokenFilePath: "/fake/token",
      logger,
      connectFn: () => socket,
      readToken: async () => "token",
    });

    client.start();
    await flush();
    socket.emit("connect");
    socket.emit(
      "data",
      `${JSON.stringify({ type: "register_ack", payload: { status: "ok", connectionId: "abc" } })}\n`,
    );

    client.sendDeviceCapacity({
      buttonPositions: [{ row: 0, column: 0 }],
      dialPositions: [{ index: 0 }],
    });

    expect(socket.written).toHaveLength(2); // register, then device_capacity
    expect(JSON.parse(socket.written[1] as string)).toEqual({
      type: "device_capacity",
      payload: { buttonPositions: [{ row: 0, column: 0 }], dialPositions: [{ index: 0 }] },
    });
  });

  it("drops a device_capacity report (logging a warning) rather than sending it while not connected", async () => {
    const logger = fakeLogger();
    const client = new CoreClient({
      port: 47821,
      tokenFilePath: "/fake/token",
      logger,
      connectFn: () => fakeSocket(),
      readToken: async () => "token",
    });

    client.sendDeviceCapacity({ buttonPositions: [], dialPositions: [] });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("dropping device_capacity"),
      expect.objectContaining({ event: "core_client_device_capacity_dropped" }),
    );
  });

  it("dispatches a render_update message to the onRenderUpdate callback", async () => {
    const logger = fakeLogger();
    const socket = fakeSocket();
    const onRenderUpdate = vi.fn();
    const client = new CoreClient({
      port: 47821,
      tokenFilePath: "/fake/token",
      logger,
      connectFn: () => socket,
      readToken: async () => "token",
      onRenderUpdate,
    });

    client.start();
    await flush();
    socket.emit("connect");
    const payload = { controller: "keypad", position: { row: 0, column: 0 }, label: "Hello" };
    socket.emit("data", `${JSON.stringify({ type: "render_update", payload })}\n`);

    expect(onRenderUpdate).toHaveBeenCalledWith(payload);
  });
});
