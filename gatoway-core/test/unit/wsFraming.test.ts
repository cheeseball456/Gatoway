import { describe, expect, it } from "vitest";
import { decodeWsFrame, encodeWsFrame } from "../../src/protocol/wsFraming.js";

describe("wsFraming", () => {
  it("round-trips a message as a single frame", () => {
    const message = { type: "register", payload: { pluginType: "xdesign" } };
    expect(decodeWsFrame(encodeWsFrame(message))).toEqual(message);
  });
});
