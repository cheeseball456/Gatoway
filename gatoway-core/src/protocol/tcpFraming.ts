/**
 * Newline-delimited JSON framing for TCP connections (design.md D4).
 *
 * TCP is a byte stream with no built-in message boundaries, so each JSON message is
 * terminated with a `\n`. This matches the framing the existing Lightroom Lua plugin
 * already uses, so it can be reused when that plugin is adapted in a later change.
 */

/** Serializes a single JSON line for sending over a TCP connection. */
export function encodeNdjsonLine(json: string): string {
  return `${json}\n`;
}

/**
 * Incrementally decodes newline-delimited JSON from a TCP byte stream.
 *
 * TCP delivers data in arbitrarily-sized chunks that may split a single message across
 * chunks, or contain multiple messages in one chunk. `push` buffers partial data and
 * returns any complete lines found so far, in order. Empty lines (e.g. a stray `\r\n`)
 * are skipped.
 */
export class NdjsonDecoder {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length > 0) {
        lines.push(line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
    return lines;
  }
}
