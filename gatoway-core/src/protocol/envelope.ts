/**
 * The unified message envelope shared by every transport (TCP and WebSocket).
 *
 * Per ARCHITECTURE.md AD-3 and design.md D4: message-handling logic does not fork by
 * transport, only the connection-accept code does. Every message, regardless of which
 * listener received it, is parsed into this same shape before being dispatched.
 */
export interface GatowayMessage<TPayload = unknown> {
  /** Message type discriminator, e.g. "register", "register_ack", "error". */
  type: string;
  /** The connection this message concerns. Optional: not always known/needed on send. */
  connectionId?: string;
  /** Message-type-specific payload. */
  payload: TPayload;
}

/** Raised when raw input cannot be parsed into a valid GatowayMessage envelope. */
export class MessageParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageParseError";
  }
}

/** Serializes a message to its JSON string form (no transport-specific framing applied). */
export function encodeMessage(message: GatowayMessage): string {
  return JSON.stringify(message);
}

/**
 * Parses a raw JSON string into a GatowayMessage, validating the envelope shape.
 * Throws MessageParseError if the input is not valid JSON or does not match the
 * required envelope: a string `type`, an object `payload`, and an optional string
 * `connectionId`.
 */
export function decodeMessage(raw: string): GatowayMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new MessageParseError(`invalid JSON: ${(err as Error).message}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MessageParseError("message envelope must be a JSON object");
  }

  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.type !== "string" || candidate.type.length === 0) {
    throw new MessageParseError("message envelope requires a non-empty string \"type\"");
  }

  if (
    candidate.connectionId !== undefined &&
    typeof candidate.connectionId !== "string"
  ) {
    throw new MessageParseError("\"connectionId\", when present, must be a string");
  }

  if (
    typeof candidate.payload !== "object" ||
    candidate.payload === null ||
    Array.isArray(candidate.payload)
  ) {
    throw new MessageParseError("message envelope requires an object \"payload\"");
  }

  return {
    type: candidate.type,
    connectionId: candidate.connectionId as string | undefined,
    payload: candidate.payload,
  };
}
