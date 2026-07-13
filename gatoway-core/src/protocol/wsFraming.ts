/**
 * Single-frame JSON framing for WebSocket connections (design.md D4).
 *
 * WebSocket's own framing already delimits messages, so no additional delimiter is
 * needed: one JSON object is sent as one text frame. This module exists as a thin,
 * transport-specific wrapper around the shared envelope encode/decode so that
 * connection code never talks to JSON.parse/stringify directly (mirrors the TCP
 * framing module's role for symmetry between the two transports).
 */
import { decodeMessage, encodeMessage, type GatowayMessage } from "./envelope.js";

/** Serializes a message as a single WebSocket text frame payload. */
export function encodeWsFrame(message: GatowayMessage): string {
  return encodeMessage(message);
}

/** Parses a single WebSocket text frame payload into a GatowayMessage. */
export function decodeWsFrame(raw: string): GatowayMessage {
  return decodeMessage(raw);
}
