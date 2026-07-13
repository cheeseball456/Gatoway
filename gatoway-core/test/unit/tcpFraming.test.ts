import { describe, expect, it } from "vitest";
import { encodeNdjsonLine, NdjsonDecoder } from "../../src/protocol/tcpFraming.js";

describe("tcpFraming", () => {
  it("encodes a line with a trailing newline", () => {
    expect(encodeNdjsonLine('{"a":1}')).toBe('{"a":1}\n');
  });

  it("decodes a single complete line delivered in one chunk", () => {
    const decoder = new NdjsonDecoder();
    const lines = decoder.push('{"a":1}\n');
    expect(lines).toEqual(['{"a":1}']);
  });

  it("decodes multiple messages delivered in one chunk", () => {
    const decoder = new NdjsonDecoder();
    const lines = decoder.push('{"a":1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("buffers a message split across multiple chunks", () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push('{"a":')).toEqual([]);
    expect(decoder.push('1}\n')).toEqual(['{"a":1}']);
  });

  it("strips a trailing carriage return", () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  it("skips empty lines", () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push('\n{"a":1}\n\n')).toEqual(['{"a":1}']);
  });
});
