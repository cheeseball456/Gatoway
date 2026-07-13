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
  it("connects, registers as plugin type 'stream-deck' with an empty capability manifest, and presents the token", async () => {
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
      payload: { pluginType: "stream-deck", capabilities: [], token: "the-token" },
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
});
