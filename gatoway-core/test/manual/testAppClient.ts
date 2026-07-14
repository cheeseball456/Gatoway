#!/usr/bin/env tsx
/**
 * Manual test-double application-plugin client (tasks.md 6.3/6.5, extended by
 * task-group-7's addendum for `capability_update`).
 *
 * No real second application plugin exists yet (Lightroom/xDesign are future changes -
 * proposal.md's "Out of scope"), so this script stands in for one: it connects to a
 * running Gatoway core, registers as pluginType "test-app" (declaring capabilities under
 * the fixture ids below - design.md D3, amended: a live capability is only rendered if
 * the connection itself has actually declared it), and lets a human toggle its focus
 * state or push a live capability update from stdin so the focus-tracking/profile-
 * routing/capability-update mechanism can be exercised end to end against real Stream
 * Deck+ hardware running the actual Stream Deck plugin (the real display client) - task
 * 6.5's manual/live-hardware verification.
 *
 * persisted-layout-config (tasks.md 4.4): since `testFixtureLayoutResolver.ts` was
 * replaced by a real, file-backed layout, actually seeing a bound key/dial on real
 * hardware now additionally requires a hand-authored layout config file (at the path
 * `loadConfig().layoutFilePath` resolves to, or wherever `GATOWAY_LAYOUT_FILE` points)
 * binding a "test-app" profile's positions to the capability ids below, e.g.:
 * ```json
 * {
 *   "profiles": {
 *     "test-app": {
 *       "bindings": [
 *         { "controller": "keypad", "position": { "row": 0, "column": 0 }, "capabilityId": "test-fixture.button.one" },
 *         { "controller": "keypad", "position": { "row": 0, "column": 1 }, "capabilityId": "test-fixture.button.two" },
 *         { "controller": "encoder", "position": { "index": 0 }, "capabilityId": "test-fixture.dial.one" }
 *       ]
 *     }
 *   }
 * }
 * ```
 * Without such a file (or with the wrong plugin type/positions/ids), Gatoway core still
 * starts and this client still connects and registers fine - `focus`/`update` below
 * simply have nothing bound to actually render (safe no-op, matching an unbound
 * position generally).
 *
 * Usage (with Gatoway core already running, e.g. via the Stream Deck plugin or
 * `npm run dev --workspace=gatoway-core`):
 *   npm run manual:test-app-client --workspace=gatoway-core
 *
 * Once connected and registered, type at the prompt:
 *   focus    - report focused: true (should bind the layout config's two keys and one
 *              dial on the real hardware, per whatever's configured for "test-app")
 *   blur     - report focused: false (should revert the hardware to the idle appearance,
 *              explicitly resetting icon rather than leaving a previous one stuck)
 *   update   - push a capability_update for "test-fixture.button.one" (should
 *              immediately update the real hardware if this client is currently
 *              focused, without needing another focus change or key press)
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
import type { Capability } from "../../src/protocol/messages.js";
import { encodeNdjsonLine, NdjsonDecoder } from "../../src/protocol/tcpFraming.js";

/** Registered under pluginType "test-app" below; a layout config must bind these ids. */
const FIXTURE_CAPABILITIES: Capability[] = [
  { id: "test-fixture.button.one", label: "Fixture A", type: "button" },
  { id: "test-fixture.button.two", label: "Fixture B", type: "button" },
  { id: "test-fixture.dial.one", label: "Fixture Dial", type: "dial" },
];

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
        payload: { pluginType: "test-app", capabilities: FIXTURE_CAPABILITIES, token },
      }),
    ),
  );

  console.log(
    "[test-app] registered as pluginType 'test-app'. Commands: focus | blur | update | quit",
  );

  let updateToggle = false;
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
    if (line === "update") {
      // Alternates between two labels each time, so a repeated "update" visibly toggles
      // the real hardware's key label if this test-double is currently focused
      // (design.md D7, task-group-7 addendum).
      updateToggle = !updateToggle;
      socket.write(
        encodeNdjsonLine(
          encodeMessage({
            type: "capability_update",
            payload: {
              capabilityId: "test-fixture.button.one",
              label: updateToggle ? "Fixture A (pushed)" : "Fixture A",
            },
          }),
        ),
      );
      continue;
    }
    console.log("unrecognized command; expected: focus | blur | update | quit");
  }
  rl.close();
  socket.end();
}

main().catch((err) => {
  console.error("manual test-app client failed:", err);
  process.exitCode = 1;
});
