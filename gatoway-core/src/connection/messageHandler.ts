import type { Logger } from "../logging/logger.js";
import {
  decodeMessage,
  MessageParseError,
  type GatowayMessage,
} from "../protocol/envelope.js";
import { validateSlotContentEntry } from "../protocol/slotContentValidation.js";
import type {
  DeviceCapacityPayload,
  ErrorPayload,
  FocusPayload,
  InputEventPayload,
  RegisterAckPayload,
  RegisterContent,
  RegisterPayload,
  SlotCapacityPayload,
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
 * semantically-invalid-but-well-formed payload contents (rejected `register` content
 * entries) - no new message type is introduced for the latter.
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

/** A single rejected `content` entry, reported by the label it was declared under (amended v1.7 for QA-020). */
export interface RejectedContentEntry {
  label: string;
  reason: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves the `content` a `register` message declares (extension-provided-slot-content
 * design.md D3/D4, amended v1.7 for QA-020): an explicit `content` replaces the
 * connection's previously-declared content in full (omission means "unchanged", never
 * cleared), with each map entry validated independently against both its key (must be a
 * currently-valid label for `capacity`) and its value (the `SlotContent` shape). An
 * entry that fails either check is dropped from the map rather than failing the whole
 * registration; the caller reports dropped entries (label + reason) via a follow-up
 * `error` message.
 */
function resolveContent(
  payload: Partial<RegisterPayload>,
  connection: ConnectionRecord,
  capacity: SlotCapacityPayload,
): { content: RegisterContent; rejected: RejectedContentEntry[] } {
  if (!payload.content) {
    return { content: connection.content ?? {}, rejected: [] };
  }

  const rejected: RejectedContentEntry[] = [];
  const content: RegisterContent = {};
  if (isPlainObject(payload.content)) {
    for (const [label, value] of Object.entries(payload.content)) {
      const validation = validateSlotContentEntry(label, value, capacity);
      if (validation.ok) {
        content[label] = validation.content;
      } else {
        rejected.push({ label, reason: validation.reason });
      }
    }
  }
  return { content, rejected };
}

/**
 * Sends the follow-up `error` message identifying rejected `register` content entries
 * (design.md D4, tasks.md 2.2/3.2): sent after `register_ack`, since the connection did
 * authenticate/register successfully regardless - the content issue is reported
 * separately, not folded into `register_ack`'s own status field, which only concerns
 * authentication. Sends nothing when every entry was valid.
 */
function sendRejectedContentError(
  connection: ConnectionRecord,
  logger: Logger,
  rejected: RejectedContentEntry[],
): void {
  if (rejected.length === 0) {
    return;
  }
  sendError(
    connection,
    logger,
    "one or more declared content entries were invalid and have been dropped from the connection's content",
    { rejectedContent: rejected },
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
  // `content` omitted on a register message means "unchanged", not "cleared" (matching
  // the old `capabilities` field's QA-003 rule): only an explicit `content` (including
  // an empty map) replaces a previously-declared one. Each entry in an explicit
  // `content` map is validated against both its key (a currently-valid label for the
  // most recently reported device capacity - design.md D4, amended v1.7 for QA-020,
  // further amended v1.8 for QA-021: `null` counts mean "not yet known," and range
  // checking is skipped rather than treating that as a known-zero capacity) and its
  // value (the `SlotContent` shape); an invalid entry is dropped rather than failing
  // the whole registration, reported afterward via a follow-up `error` message.
  const capacity: SlotCapacityPayload =
    router?.getSlotCapacity() ?? { buttonSlots: null, dialSlots: null };
  const { content, rejected } = resolveContent(payload, connection, capacity);

  // Already authenticated: this is the WebSocket path (auth already happened at
  // upgrade time via the Origin allowlist) declaring its content, or a plugin
  // re-sending `register`. Either way, no credential check is re-run here.
  if (connection.state === "authenticated") {
    manager.setPluginInfo(connection.id, pluginType, content);
    logger.info(
      {
        event: "registered",
        connectionId: connection.id,
        transport: connection.transport,
        pluginType,
        content,
      },
      "plugin registered content",
    );
    sendRegisterAck(connection, logger, { status: "ok", connectionId: connection.id });
    sendRejectedContentError(connection, logger, rejected);
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

  manager.setPluginInfo(connection.id, pluginType, content);
  manager.transition(connection.id, "authenticated");
  // QA-001: this is the first `register` message for a TCP connection (the
  // credential-validating path). It arrives while the connection is still
  // `authenticating`, so it's dispatched here directly and never reaches the
  // generic `message_received` log block in `handleRawMessage` (that block is
  // gated on `authenticated`, which this connection only becomes a few lines
  // above). The equivalent WebSocket registration *does* reach that block,
  // because `preAuthenticated` connections are already `authenticated` by the
  // time their first message arrives (design.md D5). Logging `pluginType` and
  // `content` here ensures both transports produce the same registration
  // detail regardless of that authentication-timing difference.
  logger.info(
    {
      event: "authentication_succeeded",
      connectionId: connection.id,
      transport: connection.transport,
      pluginType,
      content,
    },
    "authentication succeeded",
  );
  sendRegisterAck(connection, logger, { status: "ok", connectionId: connection.id });
  sendRejectedContentError(connection, logger, rejected);
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

  if (message.type === "device_capacity") {
    router?.handleDeviceCapacity(connection, message.payload as DeviceCapacityPayload);
    return;
  }

  // `render_update`/`command`/`slot_capacity` are core -> plugin only; nothing
  // dispatches to Gatoway core sending them, so there's nothing to handle here even if
  // one arrived.
}
