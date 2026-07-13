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

  // QA-001: a TCP connection's first `register` message (the credential-validating
  // path) must log the declared capability manifest with the same detail as the
  // equivalent WebSocket registration, even though it's dispatched before the
  // generic `message_received` log block ever runs for that connection.
  it("logs the capability manifest in detail for a TCP connection's initial registration", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const connection = manager.accept({ transport: "tcp", send: vi.fn(), close: vi.fn() });

    const capabilities = [{ id: "a", label: "A", type: "button" as const }];
    const register = encodeMessage({
      type: "register",
      payload: { pluginType: "lightroom", capabilities, token: "good" },
    });
    handleRawMessage(register, connection, manager, acceptAll, logger);

    const info = logger.info as ReturnType<typeof vi.fn>;
    const succeeded = info.mock.calls.find(
      ([entry]) => (entry as { event?: string }).event === "authentication_succeeded",
    );
    expect(succeeded).toBeDefined();
    expect(succeeded?.[0]).toMatchObject({ pluginType: "lightroom", capabilities });
  });

  // QA-001: same assertion for the WebSocket (preAuthenticated) path, so both
  // transports' registration events are checked for equivalent detail.
  it("logs the capability manifest in detail for a WebSocket connection's registration", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const connection = manager.accept({
      transport: "websocket",
      preAuthenticated: true,
      send: vi.fn(),
      close: vi.fn(),
    });

    const capabilities = [{ id: "b", label: "B", type: "dial" as const }];
    const register = encodeMessage({
      type: "register",
      payload: { pluginType: "xdesign", capabilities },
    });
    handleRawMessage(register, connection, manager, acceptAll, logger);

    const info = logger.info as ReturnType<typeof vi.fn>;
    const registered = info.mock.calls.find(
      ([entry]) => (entry as { event?: string }).event === "registered",
    );
    expect(registered).toBeDefined();
    expect(registered?.[0]).toMatchObject({ pluginType: "xdesign", capabilities });
  });

  // QA-003: an omitted `capabilities` field on a subsequent `register` message must
  // preserve the previously-declared manifest rather than silently wiping it.
  it("preserves previously-declared capabilities when a re-registration omits the field", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const connection = manager.accept({ transport: "tcp", send: vi.fn(), close: vi.fn() });

    const capabilities = [{ id: "a", label: "A", type: "button" as const }];
    const initial = encodeMessage({
      type: "register",
      payload: { pluginType: "lightroom", capabilities, token: "good" },
    });
    handleRawMessage(initial, connection, manager, acceptAll, logger);
    expect(connection.capabilities).toEqual(capabilities);

    // Re-register without a `capabilities` field at all.
    const reRegister = encodeMessage({
      type: "register",
      payload: { pluginType: "lightroom" },
    });
    handleRawMessage(reRegister, connection, manager, acceptAll, logger);

    expect(connection.capabilities).toEqual(capabilities);
  });

  // QA-003: an explicit (even empty) `capabilities` array on re-registration should
  // still replace the prior manifest — only *omission* means "unchanged".
  it("replaces capabilities when a re-registration explicitly provides a new list", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const connection = manager.accept({ transport: "tcp", send: vi.fn(), close: vi.fn() });

    const initial = encodeMessage({
      type: "register",
      payload: {
        pluginType: "lightroom",
        capabilities: [{ id: "a", label: "A", type: "button" as const }],
        token: "good",
      },
    });
    handleRawMessage(initial, connection, manager, acceptAll, logger);

    const reRegister = encodeMessage({
      type: "register",
      payload: { pluginType: "lightroom", capabilities: [] },
    });
    handleRawMessage(reRegister, connection, manager, acceptAll, logger);

    expect(connection.capabilities).toEqual([]);
  });
});
