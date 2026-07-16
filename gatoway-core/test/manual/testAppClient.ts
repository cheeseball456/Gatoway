#!/usr/bin/env tsx
/**
 * Manual test-double application-plugin client (extension-provided-slot-content
 * tasks.md 8.6, amended v1.7 tasks.md 10.8).
 *
 * No real second application plugin exists yet (Lightroom/xDesign are future changes),
 * so this script stands in for one: it connects to a running Gatoway core, registers as
 * pluginType "test-app" declaring a small fixture `content` (two buttons, one dial -
 * design.md D3, amended v1.7: addressed by fixed position label - `"B1"`, `"B2"`,
 * `"D1"` - never by an id or ordinal array index), and lets a human toggle its focus
 * state or push a live content update from stdin so the focus-tracking/profile-routing/
 * live-content-update mechanism can be exercised end to end against real Stream Deck+
 * hardware running the actual Stream Deck plugin (the real display client).
 *
 * Unlike the old `capabilities` + hand-authored `layout.json` model, **no separate
 * layout config file is needed anymore.** Gatoway core resolves this client's declared
 * content directly against whatever physical button/dial slots the Stream Deck plugin
 * reports (`device_capacity`) - `"B1"` always renders at the device's first physical
 * button slot, `"D1"` at its first physical dial slot, and so on, for as long as the
 * connected device itself doesn't change (QA-020: a label is never derived from live
 * placement). If the connected Stream Deck device's actual hardware capacity is smaller
 * than this fixture declares, the extra entries simply aren't rendered anywhere (safe
 * underflow/overflow, matching FR-007) - a Stream Deck+ (4 dials, 8 keys) or larger
 * shows the full fixture.
 *
 * Usage (with Gatoway core already running, e.g. via the Stream Deck plugin or
 * `npm run dev --workspace=gatoway-core`):
 *   npm run manual:test-app-client --workspace=gatoway-core
 *
 * Once connected and registered, type at the prompt:
 *   focus    - report focused: true (should render this fixture's two buttons and one
 *              dial on whatever physical slots the Stream Deck plugin currently reports)
 *   blur     - report focused: false (should revert the hardware to the idle appearance,
 *              explicitly resetting icon rather than leaving a previous one stuck)
 *   update   - re-sends `register` with the first button's label toggled (should
 *              immediately update the real hardware if this client is currently
 *              focused, without needing another focus change or key press - re-sending
 *              `register` is the only content-update mechanism now; there is no
 *              separate `capability_update` message anymore)
 *   quit     - disconnect (should also revert the hardware to idle, since a disconnect
 *              while focused clears focus just like an explicit blur)
 *
 * Any `command` message Gatoway core sends back (i.e. a rendered button/dial on the real
 * hardware was pressed/rotated while this test-double is focused) is printed as it
 * arrives, identified by its fixed `label` (e.g. `"B1"`) rather than any id or ordinal
 * index. Any `slot_capacity` message (sent right after registration, and again on every
 * focus gain) is also printed, showing how many button/dial slots this client currently
 * has to fill.
 */
import { createInterface } from "node:readline/promises";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { loadConfig } from "../../src/config.js";
import { encodeMessage } from "../../src/protocol/envelope.js";
import type { RegisterContent } from "../../src/protocol/messages.js";
import { encodeNdjsonLine, NdjsonDecoder } from "../../src/protocol/tcpFraming.js";

const PLUGIN_TYPE = "test-app";

function buildFixtureContent(labelSuffix: string): RegisterContent {
  return {
    B1: { label: `Fixture A${labelSuffix}` },
    B2: { label: "Fixture B" },
    D1: { label: "Fixture Dial" },
  };
}

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
        payload: { pluginType: PLUGIN_TYPE, content: buildFixtureContent(""), token },
      }),
    ),
  );

  console.log(
    `[test-app] registered as pluginType '${PLUGIN_TYPE}'. Commands: focus | blur | update | quit`,
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
      // the real hardware's first button's label if this test-double is currently
      // focused. Re-sends the connection's *entire* content map - the only mechanism
      // for any content change now (design.md D3) - rather than a single-field update.
      updateToggle = !updateToggle;
      socket.write(
        encodeNdjsonLine(
          encodeMessage({
            type: "register",
            payload: {
              pluginType: PLUGIN_TYPE,
              content: buildFixtureContent(updateToggle ? " (pushed)" : ""),
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
