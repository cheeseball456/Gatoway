#!/usr/bin/env tsx
/**
 * Manual test-double application-plugin client (tasks.md 6.3/6.5).
 *
 * No real second application plugin exists yet (Lightroom/xDesign are future changes -
 * proposal.md's "Out of scope"), so this script stands in for one: it connects to a
 * running Gatoway core, registers, and lets a human toggle its focus state from stdin
 * so the focus-tracking/profile-routing mechanism can be exercised end to end against
 * real Stream Deck+ hardware running the actual Stream Deck plugin (the real display
 * client) - task 6.5's manual/live-hardware verification.
 *
 * Usage (with Gatoway core already running, e.g. via the Stream Deck plugin or
 * `npm run dev --workspace=gatoway-core`):
 *   npm run manual:test-app-client --workspace=gatoway-core
 *
 * Once connected and registered, type at the prompt:
 *   focus    - report focused: true (should bind the test-fixture layout's two keys
 *              and one dial on the real hardware, per testFixtureLayoutResolver.ts)
 *   blur     - report focused: false (should revert the hardware to the idle appearance)
 *   quit     - disconnect (should also revert the hardware to idle, since a disconnect
 *              while focused clears focus just like an explicit blur)
 *
 * Any `command` message Gatoway core sends back (i.e. a bound key/dial on the real
 * hardware was pressed/rotated while this test-double is focused) is printed as it
 * arrives.
 */
import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { loadConfig } from "../../src/config.js";
import { encodeMessage } from "../../src/protocol/envelope.js";
import { encodeNdjsonLine, NdjsonDecoder } from "../../src/protocol/tcpFraming.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const token = (await readFile(config.tokenFilePath, "utf8")).trim();

  const socket = connect(config.tcpPort, "127.0.0.1");
  const decoder = new NdjsonDecoder();
  socket.setEncoding("utf8");

  socket.on("data", (chunk: string) => {
    for (const line of decoder.push(chunk)) {
      console.log("[test-app] received:", line);
    }
  });
  socket.on("close", () => console.log("[test-app] connection closed"));
  socket.on("error", (err) => console.error("[test-app] socket error:", err.message));

  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  socket.write(
    encodeNdjsonLine(
      encodeMessage({
        type: "register",
        payload: { pluginType: "test-app", capabilities: [], token },
      }),
    ),
  );

  console.log(
    "[test-app] registered as pluginType 'test-app'. Commands: focus | blur | quit",
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const line = (await rl.question("> ")).trim();
    if (line === "quit") {
      break;
    }
    if (line === "focus") {
      socket.write(encodeNdjsonLine(encodeMessage({ type: "focus", payload: { focused: true } })));
      continue;
    }
    if (line === "blur") {
      socket.write(encodeNdjsonLine(encodeMessage({ type: "focus", payload: { focused: false } })));
      continue;
    }
    console.log("unrecognized command; expected: focus | blur | quit");
  }
  rl.close();
  socket.end();
}

main().catch((err) => {
  console.error("manual test-app client failed:", err);
  process.exitCode = 1;
});
