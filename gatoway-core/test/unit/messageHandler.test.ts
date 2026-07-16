import { describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../../src/connection/connectionManager.js";
import { handleRawMessage, type AuthenticateFn } from "../../src/connection/messageHandler.js";
import { encodeMessage } from "../../src/protocol/envelope.js";
import type { Logger } from "../../src/logging/logger.js";
import type { ProtocolRouter } from "../../src/connection/protocolRouter.js";
import type { SlotCapacityPayload } from "../../src/protocol/messages.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

const acceptAll: AuthenticateFn = () => ({ ok: true });
const rejectAll: AuthenticateFn = () => ({ ok: false, reason: "invalid_token" });

/**
 * A minimal fake `ProtocolRouter` supplying only `getSlotCapacity` (used by
 * `handleRegister` to validate declared content-map keys against the current device
 * capacity - design.md D4, amended v1.7 for QA-020); the other methods are unused by
 * these tests but must exist to satisfy the interface.
 */
function fakeRouter(capacity: SlotCapacityPayload): ProtocolRouter {
  return {
    handleRegistered: vi.fn(),
    handleFocus: vi.fn(),
    handleInputEvent: vi.fn(),
    handleDeviceCapacity: vi.fn(),
    getSlotCapacity: () => capacity,
  };
}

const CAPACITY: SlotCapacityPayload = { buttonSlots: 3, dialSlots: 2 };

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
      payload: { pluginType: "lightroom", content: {}, token: "good" },
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
      payload: { pluginType: "lightroom", token: "bad" },
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

  it("declares content without re-authenticating a preAuthenticated (WebSocket) connection", () => {
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
      payload: { pluginType: "xdesign", content: { B1: { label: "A" } } },
    });
    handleRawMessage(register, connection, manager, rejectAll, logger, fakeRouter(CAPACITY));

    expect(connection.state).toBe("authenticated");
    expect(connection.pluginType).toBe("xdesign");
    expect(sent).toEqual([
      { type: "register_ack", connectionId: connection.id, payload: { status: "ok", connectionId: connection.id } },
    ]);
  });

  // QA-001: a TCP connection's first `register` message (the credential-validating
  // path) must log the declared content with the same detail as the equivalent
  // WebSocket registration, even though it's dispatched before the generic
  // `message_received` log block ever runs for that connection.
  it("logs the declared content in detail for a TCP connection's initial registration", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const connection = manager.accept({ transport: "tcp", send: vi.fn(), close: vi.fn() });

    const content = { B1: { label: "A" } };
    const register = encodeMessage({
      type: "register",
      payload: { pluginType: "lightroom", content, token: "good" },
    });
    handleRawMessage(register, connection, manager, acceptAll, logger, fakeRouter(CAPACITY));

    const info = logger.info as ReturnType<typeof vi.fn>;
    const succeeded = info.mock.calls.find(
      ([entry]) => (entry as { event?: string }).event === "authentication_succeeded",
    );
    expect(succeeded).toBeDefined();
    expect(succeeded?.[0]).toMatchObject({ pluginType: "lightroom", content });
  });

  // QA-001: same assertion for the WebSocket (preAuthenticated) path, so both
  // transports' registration events are checked for equivalent detail.
  it("logs the declared content in detail for a WebSocket connection's registration", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const connection = manager.accept({
      transport: "websocket",
      preAuthenticated: true,
      send: vi.fn(),
      close: vi.fn(),
    });

    const content = { D1: { label: "B" } };
    const register = encodeMessage({
      type: "register",
      payload: { pluginType: "xdesign", content },
    });
    handleRawMessage(register, connection, manager, acceptAll, logger, fakeRouter(CAPACITY));

    const info = logger.info as ReturnType<typeof vi.fn>;
    const registered = info.mock.calls.find(
      ([entry]) => (entry as { event?: string }).event === "registered",
    );
    expect(registered).toBeDefined();
    expect(registered?.[0]).toMatchObject({ pluginType: "xdesign", content });
  });

  // Omitting `content` on a subsequent `register` message must preserve the
  // previously-declared content rather than silently wiping it (mirrors the old
  // `capabilities` field's QA-003 rule).
  it("preserves previously-declared content when a re-registration omits the field", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const connection = manager.accept({ transport: "tcp", send: vi.fn(), close: vi.fn() });
    const router = fakeRouter(CAPACITY);

    const content = { B1: { label: "A" } };
    const initial = encodeMessage({
      type: "register",
      payload: { pluginType: "lightroom", content, token: "good" },
    });
    handleRawMessage(initial, connection, manager, acceptAll, logger, router);
    expect(connection.content).toEqual(content);

    // Re-register without a `content` field at all.
    const reRegister = encodeMessage({
      type: "register",
      payload: { pluginType: "lightroom" },
    });
    handleRawMessage(reRegister, connection, manager, acceptAll, logger, router);

    expect(connection.content).toEqual(content);
  });

  // An explicit (even empty) `content` on re-registration should still replace the
  // prior declaration — only *omission* means "unchanged".
  it("replaces content when a re-registration explicitly provides a new map", () => {
    const logger = fakeLogger();
    const manager = new ConnectionManager(logger);
    const connection = manager.accept({ transport: "tcp", send: vi.fn(), close: vi.fn() });
    const router = fakeRouter(CAPACITY);

    const initial = encodeMessage({
      type: "register",
      payload: {
        pluginType: "lightroom",
        content: { B1: { label: "A" } },
        token: "good",
      },
    });
    handleRawMessage(initial, connection, manager, acceptAll, logger, router);

    const reRegister = encodeMessage({
      type: "register",
      payload: { pluginType: "lightroom", content: {} },
    });
    handleRawMessage(reRegister, connection, manager, acceptAll, logger, router);

    expect(connection.content).toEqual({});
  });

  it("registers successfully with only the valid content entries when one entry is malformed, and sends a follow-up error", () => {
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
      payload: {
        pluginType: "lightroom",
        content: {
          B1: { label: "One" },
          B2: { label: "" },
        },
        token: "good",
      },
    });
    handleRawMessage(register, connection, manager, acceptAll, logger, fakeRouter(CAPACITY));

    expect(connection.state).toBe("authenticated");
    expect(connection.content).toEqual({ B1: { label: "One" } });
    expect(sent).toEqual([
      { type: "register_ack", connectionId: connection.id, payload: { status: "ok", connectionId: connection.id } },
      {
        type: "error",
        connectionId: connection.id,
        payload: {
          message:
            "one or more declared content entries were invalid and have been dropped from the connection's content",
          details: { rejectedContent: [{ label: "B2", reason: '"label" must be a non-empty string' }] },
        },
      },
    ]);
  });

  it("registers successfully with empty content when every declared entry is malformed", () => {
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
      payload: {
        pluginType: "lightroom",
        content: {
          B1: { label: "" },
          D1: { label: "Zoom", state: 1 },
        },
        token: "good",
      },
    });
    handleRawMessage(register, connection, manager, acceptAll, logger, fakeRouter(CAPACITY));

    expect(connection.state).toBe("authenticated");
    expect(connection.content).toEqual({});
    const errorMessage = sent.find((m) => (m as { type: string }).type === "error") as
      | { payload: { details: { rejectedContent: { label: string; reason: string }[] } } }
      | undefined;
    expect(errorMessage).toBeDefined();
    expect(errorMessage?.payload.details.rejectedContent).toEqual([
      { label: "B1", reason: '"label" must be a non-empty string' },
      { label: "D1", reason: '"state" is not valid on a dial (D-prefixed) entry' },
    ]);
  });

  it("rejects a content entry whose key is not a currently-valid label for the reported device capacity", () => {
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
      payload: {
        pluginType: "lightroom",
        // B4 is out of range for a 3-button-slot capacity; Unknown isn't a label at all.
        content: { B1: { label: "One" }, B4: { label: "Overflow" }, Unknown: { label: "Bad" } },
        token: "good",
      },
    });
    handleRawMessage(register, connection, manager, acceptAll, logger, fakeRouter(CAPACITY));

    expect(connection.content).toEqual({ B1: { label: "One" } });
    const errorMessage = sent.find((m) => (m as { type: string }).type === "error") as
      | { payload: { details: { rejectedContent: { label: string; reason: string }[] } } }
      | undefined;
    expect(errorMessage?.payload.details.rejectedContent.map((r) => r.label)).toEqual(["B4", "Unknown"]);
  });

  // QA-021: capacity being unknown must not be conflated with a known `0` - a
  // canonically-formed label is accepted provisionally rather than rejected outright.
  it("accepts a canonically-formed content entry provisionally while device capacity is unknown", () => {
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
      payload: {
        pluginType: "lightroom",
        content: { B5: { label: "Maybe Out Of Range" } },
        token: "good",
      },
    });
    handleRawMessage(
      register,
      connection,
      manager,
      acceptAll,
      logger,
      fakeRouter({ buttonSlots: null, dialSlots: null }),
    );

    expect(connection.content).toEqual({ B5: { label: "Maybe Out Of Range" } });
    expect(sent.map((m) => (m as { type: string }).type)).toEqual(["register_ack"]);
  });

  // QA-022: a non-canonical key (e.g. a leading zero) must be rejected regardless of
  // whether device capacity is currently known, since it could never be resolved.
  it("rejects a non-canonical label form regardless of whether device capacity is known", () => {
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
      payload: {
        pluginType: "lightroom",
        content: { B01: { label: "Bad Form" } },
        token: "good",
      },
    });
    handleRawMessage(
      register,
      connection,
      manager,
      acceptAll,
      logger,
      fakeRouter({ buttonSlots: null, dialSlots: null }),
    );

    expect(connection.content).toEqual({});
    const errorMessage = sent.find((m) => (m as { type: string }).type === "error") as
      | { payload: { details: { rejectedContent: { label: string; reason: string }[] } } }
      | undefined;
    expect(errorMessage?.payload.details.rejectedContent).toEqual([
      { label: "B01", reason: '"B01" is not a valid position label (expected "B<n>" or "D<n>", no leading zeros)' },
    ]);
  });

  it("sends no follow-up error when every declared content entry is valid", () => {
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
      payload: {
        pluginType: "lightroom",
        content: { B1: { label: "One" } },
        token: "good",
      },
    });
    handleRawMessage(register, connection, manager, acceptAll, logger, fakeRouter(CAPACITY));

    expect(sent.map((m) => (m as { type: string }).type)).toEqual(["register_ack"]);
  });

  describe("device_capacity", () => {
    it("dispatches to the router when sent by a registered connection", () => {
      const logger = fakeLogger();
      const manager = new ConnectionManager(logger);
      const connection = manager.accept({ transport: "tcp", send: vi.fn(), close: vi.fn() });
      manager.transition(connection.id, "authenticated");
      manager.setPluginInfo(connection.id, "stream-deck", {});

      const router = {
        handleRegistered: vi.fn(),
        handleFocus: vi.fn(),
        handleInputEvent: vi.fn(),
        handleDeviceCapacity: vi.fn(),
        getSlotCapacity: () => ({ buttonSlots: 0, dialSlots: 0 }),
      };

      const message = encodeMessage({
        type: "device_capacity",
        payload: { buttonPositions: [{ row: 0, column: 0 }], dialPositions: [] },
      });
      handleRawMessage(message, connection, manager, acceptAll, logger, router);

      expect(router.handleDeviceCapacity).toHaveBeenCalledWith(connection, {
        buttonPositions: [{ row: 0, column: 0 }],
        dialPositions: [],
      });
    });
  });
});
