import type { Logger } from "../logging/logger.js";
import {
  decodeMessage,
  MessageParseError,
  type GatowayMessage,
} from "../protocol/envelope.js";
import type {
  ErrorPayload,
  RegisterAckPayload,
  RegisterPayload,
} from "../protocol/messages.js";
import type { ConnectionManager } from "./connectionManager.js";
import type { ConnectionRecord } from "./types.js";

export type AuthenticationResult = { ok: true } | { ok: false; reason: string };

/**
 * Validates a `register` message's credentials for a connection still in the
 * `authenticating` state. For TCP this checks the presented token; WebSocket
 * connections are already authenticated by the time they reach this handler (the
 * Origin check happens at HTTP-upgrade time, before the connection exists at all — see
 * ConnectionManager's `preAuthenticated` option), so they never hit this path.
 */
export type AuthenticateFn = (
  connection: ConnectionRecord,
  payload: RegisterPayload,
) => AuthenticationResult;

/** Sends a message to a connection, logging outgoing traffic once authenticated (tasks.md 5.5). */
export function sendMessage(
  connection: ConnectionRecord,
  logger: Logger,
  message: GatowayMessage,
): void {
  connection.send(message);
  if (connection.state === "authenticated") {
    logger.info(
      {
        event: "message_sent",
        connectionId: connection.id,
        transport: connection.transport,
        messageType: message.type,
        payload: message.payload,
      },
      "message sent",
    );
  }
}

function sendError(
  connection: ConnectionRecord,
  logger: Logger,
  errorMessage: string,
  details?: unknown,
): void {
  const payload: ErrorPayload = { message: errorMessage, details };
  sendMessage(connection, logger, {
    type: "error",
    connectionId: connection.id,
    payload,
  });
}

function sendRegisterAck(
  connection: ConnectionRecord,
  logger: Logger,
  payload: RegisterAckPayload,
): void {
  sendMessage(connection, logger, {
    type: "register_ack",
    connectionId: connection.id,
    payload,
  });
}

function handleRegister(
  message: GatowayMessage,
  connection: ConnectionRecord,
  manager: ConnectionManager,
  authenticate: AuthenticateFn,
  logger: Logger,
): void {
  const payload = message.payload as Partial<RegisterPayload>;
  const pluginType = typeof payload.pluginType === "string" ? payload.pluginType : "unknown";
  const capabilities = Array.isArray(payload.capabilities) ? payload.capabilities : [];

  // Already authenticated: this is the WebSocket path (auth already happened at
  // upgrade time via the Origin allowlist) declaring its capability manifest, or a
  // plugin re-sending `register`. Either way, no credential check is re-run here.
  if (connection.state === "authenticated") {
    manager.setPluginInfo(connection.id, pluginType, capabilities);
    logger.info(
      {
        event: "registered",
        connectionId: connection.id,
        transport: connection.transport,
        pluginType,
      },
      "plugin registered capabilities",
    );
    sendRegisterAck(connection, logger, { status: "ok", connectionId: connection.id });
    return;
  }

  const result = authenticate(connection, payload as RegisterPayload);
  if (!result.ok) {
    logger.warn(
      {
        event: "authentication_failed",
        connectionId: connection.id,
        transport: connection.transport,
        reason: result.reason,
      },
      "authentication failed",
    );
    sendRegisterAck(connection, logger, {
      status: "rejected",
      connectionId: connection.id,
      reason: result.reason,
    });
    manager.disconnect(connection.id, result.reason);
    connection.close(result.reason);
    return;
  }

  manager.setPluginInfo(connection.id, pluginType, capabilities);
  manager.transition(connection.id, "authenticated");
  logger.info(
    {
      event: "authentication_succeeded",
      connectionId: connection.id,
      transport: connection.transport,
    },
    "authentication succeeded",
  );
  sendRegisterAck(connection, logger, { status: "ok", connectionId: connection.id });
}

/**
 * Dispatches a single raw (already-framed) message received on a connection. Shared by
 * both the TCP and WebSocket listeners: per design.md D2/D3, message-handling logic
 * does not fork by transport, only the connection-accept code does.
 */
export function handleRawMessage(
  raw: string,
  connection: ConnectionRecord,
  manager: ConnectionManager,
  authenticate: AuthenticateFn,
  logger: Logger,
): void {
  let message: GatowayMessage;
  try {
    message = decodeMessage(raw);
  } catch (err) {
    const reason = err instanceof MessageParseError ? err.message : "unparseable message";
    if (connection.state === "authenticated") {
      sendError(connection, logger, `malformed message: ${reason}`);
      return;
    }
    logger.warn(
      {
        event: "invalid_message_before_auth",
        connectionId: connection.id,
        transport: connection.transport,
        reason,
      },
      "closing connection: unparseable message before authentication",
    );
    manager.disconnect(connection.id, "invalid_message_before_auth");
    connection.close("invalid_message_before_auth");
    return;
  }

  if (connection.state === "authenticating") {
    if (message.type !== "register") {
      logger.warn(
        {
          event: "non_register_before_auth",
          connectionId: connection.id,
          transport: connection.transport,
          messageType: message.type,
        },
        "rejecting non-registration message before authentication",
      );
      manager.disconnect(connection.id, "non_register_before_auth");
      connection.close("non_register_before_auth");
      return;
    }
    handleRegister(message, connection, manager, authenticate, logger);
    return;
  }

  if (connection.state !== "authenticated") {
    // Connection already disconnected/closing; nothing left to dispatch to.
    return;
  }

  logger.info(
    {
      event: "message_received",
      connectionId: connection.id,
      transport: connection.transport,
      messageType: message.type,
      payload: message.payload,
    },
    "message received",
  );

  if (message.type === "register") {
    handleRegister(message, connection, manager, authenticate, logger);
    return;
  }

  if (message.type === "error") {
    // A peer reporting its own protocol-level error; nothing further to dispatch yet.
    return;
  }

  // Command and state-update message types are defined in a later change, once a
  // plugin exists to use them (proposal.md's "Out of scope"). Nothing to dispatch to.
}
