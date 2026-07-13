import { describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../../src/connection/connectionManager.js";
import { handleRawMessage, type AuthenticateFn } from "../../src/connection/messageHandler.js";
import { encodeMessage } from "../../src/protocol/envelope.js";
import type { Logger } from "../../src/logging/logger.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

const acceptAll: AuthenticateFn = () => ({ ok: true });
const rejectAll: AuthenticateFn = () => ({ ok: false, reason: "invalid_token" });

describe("handleRawMessage", () => {
  it("authenticates on a valid register message and sends register_ack ok", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const sent: unknown[] = [];
    const connection = manager.accept({
      transport: "tcp",
      send: (m) => sent.push(m),
      close: vi.fn(),
    });

    const register = encodeMessage({
      type: "register",
      payload: { pluginType: "lightroom", capabilities: [], token: "good" },
    });
    handleRawMessage(register, connection, manager, acceptAll, logger);

    expect(connection.state).toBe("authenticated");
    expect(sent).toEqual([
      { type: "register_ack", connectionId: connection.id, payload: { status: "ok", connectionId: connection.id } },
    ]);
  });

  it("rejects and closes on a failed register message", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const close = vi.fn();
    const sent: unknown[] = [];
    const connection = manager.accept({
      transport: "tcp",
      send: (m) => sent.push(m),
      close,
    });

    const register = encodeMessage({
      type: "register",
      payload: { pluginType: "lightroom", capabilities: [], token: "bad" },
    });
    handleRawMessage(register, connection, manager, rejectAll, logger);

    expect(close).toHaveBeenCalledWith("invalid_token");
    expect(manager.get(connection.id)).toBeUndefined();
    expect(sent).toEqual([
      {
        type: "register_ack",
        connectionId: connection.id,
        payload: { status: "rejected", connectionId: connection.id, reason: "invalid_token" },
      },
    ]);
  });

  it("rejects and closes a non-register message sent before authentication", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const close = vi.fn();
    const connection = manager.accept({ transport: "tcp", send: vi.fn(), close });

    const other = encodeMessage({ type: "command", payload: {} });
    handleRawMessage(other, connection, manager, acceptAll, logger);

    expect(close).toHaveBeenCalled();
    expect(manager.get(connection.id)).toBeUndefined();
  });

  it("closes the connection on an unparseable message before authentication", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const close = vi.fn();
    const connection = manager.accept({ transport: "tcp", send: vi.fn(), close });

    handleRawMessage("not json", connection, manager, acceptAll, logger);

    expect(close).toHaveBeenCalled();
    expect(manager.get(connection.id)).toBeUndefined();
  });

  it("responds with an error message on a malformed message from an authenticated connection", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const sent: unknown[] = [];
    const connection = manager.accept({
      transport: "websocket",
      preAuthenticated: true,
      send: (m) => sent.push(m),
      close: vi.fn(),
    });

    handleRawMessage("not json", connection, manager, acceptAll, logger);

    expect(sent).toHaveLength(1);
    expect((sent[0] as { type: string }).type).toBe("error");
    expect(connection.state).toBe("authenticated");
  });

  it("declares capabilities without re-authenticating a preAuthenticated (WebSocket) connection", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const sent: unknown[] = [];
    const connection = manager.accept({
      transport: "websocket",
      preAuthenticated: true,
      send: (m) => sent.push(m),
      close: vi.fn(),
    });

    const register = encodeMessage({
      type: "register",
      payload: { pluginType: "xdesign", capabilities: [{ id: "a", label: "A", type: "button" }] },
    });
    handleRawMessage(register, connection, manager, rejectAll, logger);

    expect(connection.state).toBe("authenticated");
    expect(connection.pluginType).toBe("xdesign");
    expect(sent).toEqual([
      { type: "register_ack", connectionId: connection.id, payload: { status: "ok", connectionId: connection.id } },
    ]);
  });
});
