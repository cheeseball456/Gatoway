#!/usr/bin/env tsx
/**
 * Manual TCP test client (tasks.md 6.2).
 *
 * Connects to a running Gatoway core TCP listener twice: once presenting the current
 * valid token (read from the auth token file), and once presenting a deliberately
 * invalid token, printing the observed accept/reject behavior for each.
 *
 * Usage (with Gatoway core already running in another terminal, e.g. `npm run dev`):
 *   npm run manual:tcp-client
 *
 * Honors the same GATOWAY_TCP_PORT / GATOWAY_TOKEN_FILE environment variables as
 * Gatoway core itself, so it finds the right port and token file by default.
 */
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { loadConfig } from "../../src/config.js";
import { encodeMessage } from "../../src/protocol/envelope.js";
import { encodeNdjsonLine, NdjsonDecoder } from "../../src/protocol/tcpFraming.js";

async function attempt(port: number, token: string, label: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        encodeNdjsonLine(
          encodeMessage({
            type: "register",
            payload: { pluginType: "manual-test-client", capabilities: [], token },
          }),
        ),
      );
    });

    const decoder = new NdjsonDecoder();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      for (const line of decoder.push(chunk)) {
        console.log(`[${label}] received:`, line);
        // The server closes rejected connections itself; for an accepted connection
        // this client closes voluntarily once it has seen the ack, since this script
        // only exercises accept/reject behavior rather than acting as a real plugin.
        if (line.includes('"status":"ok"')) {
          socket.end();
        }
      }
    });
    socket.on("close", () => {
      console.log(`[${label}] connection closed`);
      resolve();
    });
    socket.on("error", (err) => {
      console.error(`[${label}] socket error:`, err.message);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const currentToken = (await readFile(config.tokenFilePath, "utf8")).trim();

  console.log(`Using TCP port ${config.tcpPort}, token file ${config.tokenFilePath}`);

  console.log("\n--- Attempt 1: valid token (expect register_ack status=ok) ---");
  await attempt(config.tcpPort, currentToken, "valid-token");

  console.log("\n--- Attempt 2: invalid token (expect register_ack status=rejected, then close) ---");
  await attempt(config.tcpPort, "not-the-real-token", "invalid-token");
}

main().catch((err) => {
  console.error("manual TCP test client failed:", err);
  process.exitCode = 1;
});
