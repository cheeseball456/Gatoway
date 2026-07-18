#!/usr/bin/env tsx
/**
 * Manual WebSocket test client (tasks.md 6.3).
 *
 * Connects to a running Gatoway core WebSocket listener twice: once with an Origin
 * header from GATOWAY_ALLOWED_ORIGINS (or a --origin override), and once with a
 * deliberately non-allowlisted Origin, printing the observed accept/reject behavior
 * for each.
 *
 * Usage (with Gatoway core already running, GATOWAY_ALLOWED_ORIGINS set to include
 * the origin this script will use):
 *   GATOWAY_ALLOWED_ORIGINS=chrome-extension://test-id npm run manual:ws-client
 */
import WebSocket from "ws";
import { loadConfig } from "../../src/config.js";
import { encodeMessage } from "../../src/protocol/envelope.js";

function attempt(port: number, origin: string, label: string): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });

    ws.on("open", () => {
      console.log(`[${label}] upgrade accepted; sending register`);
      ws.send(
        encodeMessage({
          type: "register",
          payload: { pluginType: "manual-test-client" },
        }),
      );
    });
    ws.on("message", (data) => {
      console.log(`[${label}] received:`, data.toString());
      ws.close();
    });
    ws.on("unexpected-response", (_req, res) => {
      console.log(`[${label}] upgrade refused with HTTP status ${res.statusCode}`);
    });
    ws.on("close", () => {
      console.log(`[${label}] connection closed`);
      resolve();
    });
    ws.on("error", (err) => {
      console.error(`[${label}] error:`, err.message);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const allowedOrigin = config.allowedOrigins[0] ?? "chrome-extension://replace-with-allowlisted-id";

  console.log(`Using WebSocket port ${config.wsPort}`);
  console.log(`Configured allowlist: ${JSON.stringify(config.allowedOrigins)}`);

  console.log("\n--- Attempt 1: allowlisted origin (expect upgrade accepted, register_ack status=ok) ---");
  await attempt(config.wsPort, allowedOrigin, "allowlisted-origin");

  console.log("\n--- Attempt 2: non-allowlisted origin (expect upgrade refused) ---");
  await attempt(config.wsPort, "chrome-extension://definitely-not-allowlisted", "unlisted-origin");
}

main().catch((err) => {
  console.error("manual WebSocket test client failed:", err);
  process.exitCode = 1;
});
