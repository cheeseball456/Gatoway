import type { Logger } from "../logging/logger.js";
import {
  decodeMessage,
  MessageParseError,
  type GatowayMessage,
} from "../protocol/envelope.js";
import { validateCapability } from "../protocol/capabilityValidation.js";
import type {
  Capability,
  CapabilityUpdatePayload,
  ErrorPayload,
  FocusPayload,
  InputEventPayload,
  RegisterAckPayload,
  RegisterPayload,
} from "../protocol/messages.js";
import type { ConnectionManager } from "./connectionManager.js";
import type { ProtocolRouter } from "./protocolRouter.js";
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

/**
 * Sends an `error` message to a connection (design.md D3): reused as-is for both
 * envelope-level malformation (invalid JSON, non-object payload - the original use) and
 * semantically-invalid-but-well-formed payload contents (rejected `register`
 * capabilities/`capability_update` fields, added by `validate-capability-payloads`) -
 * no new message type is introduced for the latter.
 */
export function sendError(
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

export interface RejectedCapability {
  index: number;
  reason: string;
}

/**
 * Resolves the `capabilities` a `register` message declares (validate-capability-
 * payloads design.md D1/D2): an explicit array replaces the connection's previously-
 * declared manifest (QA-003 - omission means "unchanged", never cleared), with each
 * entry validated against the `Capability` shape independently. An entry that fails
 * validation is dropped from the returned manifest rather than failing the whole
 * registration; the caller reports dropped entries (index + reason) via a follow-up
 * `error` message.
 */
function resolveCapabilities(
  payload: Partial<RegisterPayload>,
  connection: ConnectionRecord,
): { capabilities: Capability[]; rejected: RejectedCapability[] } {
  if (!Array.isArray(payload.capabilities)) {
    return { capabilities: connection.capabilities ?? [], rejected: [] };
  }

  const capabilities: Capability[] = [];
  const rejected: RejectedCapability[] = [];
  payload.capabilities.forEach((raw, index) => {
    const result = validateCapability(raw);
    if (result.ok) {
      capabilities.push(result.capability);
    } else {
      rejected.push({ index, reason: result.reason });
    }
  });
  return { capabilities, rejected };
}

/**
 * Sends the follow-up `error` message identifying rejected `register` capabilities
 * (design.md D3, tasks.md 1.4): sent after `register_ack`, since the connection did
 * authenticate/register successfully regardless - the capability issue is reported
 * separately, not folded into `register_ack`'s own status field, which only concerns
 * authentication. Sends nothing when every capability was valid.
 */
function sendRejectedCapabilitiesError(
  connection: ConnectionRecord,
  logger: Logger,
  rejected: RejectedCapability[],
): void {
  if (rejected.length === 0) {
    return;
  }
  sendError(
    connection,
    logger,
    "one or more declared capabilities were invalid and have been dropped from the connection's manifest",
    { rejectedCapabilities: rejected },
  );
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
  router: ProtocolRouter | undefined,
): void {
  const payload = message.payload as Partial<RegisterPayload>;
  const pluginType = typeof payload.pluginType === "string" ? payload.pluginType : "unknown";
  // `capabilities` omitted on a register message means "unchanged", not "cleared"
  // (QA-003): only an explicit array replaces a previously-declared manifest. Each
  // entry in an explicit array is validated against the `Capability` shape (design.md
  // D1); an invalid entry is dropped rather than failing the whole registration
  // (design.md D2), reported afterward via a follow-up `error` message.
  const { capabilities, rejected } = resolveCapabilities(payload, connection);

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
        capabilities,
      },
      "plugin registered capabilities",
    );
    sendRegisterAck(connection, logger, { status: "ok", connectionId: connection.id });
    sendRejectedCapabilitiesError(connection, logger, rejected);
    router?.handleRegistered(connection);
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
  // QA-001: this is the first `register` message for a TCP connection (the
  // credential-validating path). It arrives while the connection is still
  // `authenticating`, so it's dispatched here directly and never reaches the
  // generic `message_received` log block in `handleRawMessage` (that block is
  // gated on `authenticated`, which this connection only becomes a few lines
  // above). The equivalent WebSocket registration *does* reach that block,
  // because `preAuthenticated` connections are already `authenticated` by the
  // time their first message arrives (design.md D5). Logging `pluginType` and
  // `capabilities` here ensures both transports produce the same registration
  // detail regardless of that authentication-timing difference.
  logger.info(
    {
      event: "authentication_succeeded",
      connectionId: connection.id,
      transport: connection.transport,
      pluginType,
      capabilities,
    },
    "authentication succeeded",
  );
  sendRegisterAck(connection, logger, { status: "ok", connectionId: connection.id });
  sendRejectedCapabilitiesError(connection, logger, rejected);
  router?.handleRegistered(connection);
}

/**
 * Dispatches a single raw (already-framed) message received on a connection. Shared by
 * both the TCP and WebSocket listeners: per design.md D2/D3, message-handling logic
 * does not fork by transport, only the connection-accept code does.
 *
 * `router` is optional (focus-tracking/profile-routing, design.md D2-D4): when omitted,
 * `register`/`error` handling behaves exactly as before this change, so existing
 * callers/tests are unaffected. Production wiring (`index.ts`) always supplies one.
 */
export function handleRawMessage(
  raw: string,
  connection: ConnectionRecord,
  manager: ConnectionManager,
  authenticate: AuthenticateFn,
  logger: Logger,
  router?: ProtocolRouter,
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
    handleRegister(message, connection, manager, authenticate, logger, router);
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
    handleRegister(message, connection, manager, authenticate, logger, router);
    return;
  }

  if (message.type === "error") {
    // A peer reporting its own protocol-level error; nothing further to dispatch yet.
    return;
  }

  if (message.type === "focus") {
    router?.handleFocus(connection, message.payload as FocusPayload);
    return;
  }

  if (message.type === "input_event") {
    router?.handleInputEvent(connection, message.payload as InputEventPayload);
    return;
  }

  if (message.type === "capability_update") {
    router?.handleCapabilityUpdate(connection, message.payload as CapabilityUpdatePayload);
    return;
  }

  // `render_update`/`command` are core -> plugin only; nothing dispatches to Gatoway
  // core sending them, so there's nothing to handle here even if one arrived.
}
