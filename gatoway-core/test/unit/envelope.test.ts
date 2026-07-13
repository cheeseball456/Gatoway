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
});
