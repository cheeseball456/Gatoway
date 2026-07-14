import type { GatowayMessage } from "@gatoway/core";

/**
 * A small, independent newline-delimited-JSON encoder/decoder for the Stream Deck
 * plugin's TCP connection to Gatoway core (design.md D3, message-protocol capability).
 *
 * This plugin is a *client* of Gatoway core's existing protocol, exactly as the
 * Lightroom Lua plugin (a different language/runtime entirely) will be — so it
 * implements the documented wire format for itself here, using `@gatoway/core`'s
 * exported `GatowayMessage`/payload *types* for compile-time safety, rather than
 * importing gatoway-core's internal (non-exported) framing/envelope modules. The
 * format itself matches gatoway-core/src/protocol/tcpFraming.ts and envelope.ts
 * exactly: one JSON object per line, newline-terminated.
 */

/** Serializes a single message as one newline-terminated JSON line. */
export function encodeNdjsonLine(message: GatowayMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Incrementally decodes newline-delimited JSON from a TCP byte stream. `push` buffers
 * partial data and returns any complete, parsed messages found so far, in order. Empty
 * lines are skipped. Throws if a complete line is not valid JSON.
 */
export class NdjsonLineDecoder {
  private buffer = "";

  push(chunk: string): GatowayMessage[] {
    this.buffer += chunk;
    const messages: GatowayMessage[] = [];
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length > 0) {
        messages.push(JSON.parse(line) as GatowayMessage);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
    return messages;
  }
}
