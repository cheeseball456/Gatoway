import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, MessageParseError } from "../../src/protocol/envelope.js";

describe("envelope", () => {
  it("round-trips a message through encode/decode", () => {
    const message = { type: "register", connectionId: "abc-123", payload: { pluginType: "lightroom" } };
    const decoded = decodeMessage(encodeMessage(message));
    expect(decoded).toEqual(message);
  });

  it("allows connectionId to be omitted", () => {
    const raw = JSON.stringify({ type: "error", payload: { message: "oops" } });
    const decoded = decodeMessage(raw);
    expect(decoded.connectionId).toBeUndefined();
    expect(decoded.type).toBe("error");
  });

  it("rejects invalid JSON", () => {
    expect(() => decodeMessage("{not json")).toThrow(MessageParseError);
  });

  it("rejects a non-object envelope", () => {
    expect(() => decodeMessage(JSON.stringify("just a string"))).toThrow(MessageParseError);
    expect(() => decodeMessage(JSON.stringify([1, 2, 3]))).toThrow(MessageParseError);
  });

  it("rejects a missing type", () => {
    expect(() => decodeMessage(JSON.stringify({ payload: {} }))).toThrow(MessageParseError);
  });

  it("rejects a non-string connectionId", () => {
    expect(() =>
      decodeMessage(JSON.stringify({ type: "register", connectionId: 42, payload: {} })),
    ).toThrow(MessageParseError);
  });

  it("rejects a missing or non-object payload", () => {
    expect(() => decodeMessage(JSON.stringify({ type: "register" }))).toThrow(MessageParseError);
    expect(() =>
      decodeMessage(JSON.stringify({ type: "register", payload: "nope" })),
    ).toThrow(MessageParseError);
  });

  // tasks.md 1.4: the envelope is generic over `type` (it never enumerates known
  // message types), so `focus`/`input_event`/`render_update` round-trip through
  // encode/decode exactly like `register`/`register_ack`/`error` always have - no
  // change to envelope.ts itself was needed for this change.
  it("round-trips a focus message", () => {
    const message = { type: "focus", connectionId: "conn-1", payload: { focused: true } };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it("round-trips an input_event message (keypad, no delta)", () => {
    const message = {
      type: "input_event",
      payload: { controller: "keypad", position: { row: 0, column: 1 }, eventType: "keyDown" },
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it("round-trips an input_event message (encoder, with delta)", () => {
    const message = {
      type: "input_event",
      payload: { controller: "encoder", position: { index: 2 }, eventType: "rotate", delta: -3 },
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it("round-trips a render_update message with sparse fields", () => {
    const message = {
      type: "render_update",
      connectionId: "sd-conn",
      payload: { controller: "keypad", position: { row: 0, column: 0 }, label: "Gatoway" },
    };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });
});
