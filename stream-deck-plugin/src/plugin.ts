import streamDeck from "@elgato/streamdeck";
import type { DeviceCapacityPayload, RenderUpdatePayload } from "@gatoway/core";
import { GenericDialAction } from "./actions/genericDialAction.js";
import { GenericKeyAction } from "./actions/genericKeyAction.js";
import { RenderStore } from "./actions/renderStore.js";
import { buildCoreChildEnv, resolvePluginCoreConfig } from "./coreLifecycle/config.js";
import { CoreProcessSupervisor } from "./coreLifecycle/coreProcessSupervisor.js";
import { CoreClient } from "./coreClient/coreClient.js";
import { computeDeviceCapacity, deviceCapacityEqual } from "./coreClient/deviceCapacity.js";
import type { PluginLogger } from "./logging/pluginLogger.js";

streamDeck.logger.setLevel("info");

// The generic Key/Dial actions have no idle-specific or app-specific content of their
// own (AD-8, stream-deck-idle-display spec): whatever `renderStore` last learned from a
// `render_update` is what they display on `onWillAppear`, and that store is never
// cleared by anything in this package - so it (and therefore the display) survives
// Gatoway core disconnects/restarts, per that spec's "Displayed Content Persists"
// requirement. Registering the actions and connecting to the Stream Deck app is
// independent of Gatoway core's lifecycle below, exactly as the old static Idle action
// worked (design.md D4).
const renderStore = new RenderStore();

const configLogger: PluginLogger = streamDeck.logger.createScope("gatoway-core-config");
const coreConfig = resolvePluginCoreConfig(process.env, configLogger);

// extension-provided-slot-content (design.md D1, tasks.md 7.1-7.3): tracks the most
// recently *sent* device_capacity report, so a re-computation triggered by an SDK event
// (device connect/disconnect, action appear/disappear) only actually sends a fresh
// report when the derived position lists changed, never on every event unconditionally.
let lastReportedCapacity: DeviceCapacityPayload = { buttonPositions: [], dialPositions: [] };

function reportDeviceCapacity(force: boolean): void {
  const capacity = computeDeviceCapacity(streamDeck.devices);
  if (!force && deviceCapacityEqual(capacity, lastReportedCapacity)) {
    return;
  }
  lastReportedCapacity = capacity;
  coreClient.sendDeviceCapacity(capacity);
}

const clientLogger: PluginLogger = streamDeck.logger.createScope("gatoway-core-client");
const coreClient = new CoreClient({
  port: coreConfig.tcpPort,
  tokenFilePath: coreConfig.tokenFilePath,
  logger: clientLogger,
  onRenderUpdate: (payload: RenderUpdatePayload) => {
    renderStore.apply(payload);
    keyAction.applyRenderUpdate(payload);
    dialAction.applyRenderUpdate(payload);
  },
  // Sent once at this connection's own registration (design.md D1, tasks.md 7.2) -
  // `force: true` because the very first report must always go out, even if it happens
  // to compute as empty (equal to the zero-value default `lastReportedCapacity` starts
  // at).
  onRegistered: () => reportDeviceCapacity(true),
});

const keyAction = new GenericKeyAction(renderStore, (payload) => coreClient.sendInputEvent(payload));
const dialAction = new GenericDialAction(renderStore, (payload) => coreClient.sendInputEvent(payload));
streamDeck.actions.registerAction(keyAction);
streamDeck.actions.registerAction(dialAction);

// Re-sends device_capacity whenever the set of placed generic actions changes (tasks.md
// 7.3): an action (any action, not just ours - `computeDeviceCapacity` itself filters to
// just this plugin's own generic Key/Dial actions) appearing/disappearing, or the device
// itself connecting/disconnecting. Each handler recomputes and only actually sends a
// fresh report if the derived lists changed, so unrelated SDK events (e.g. a different
// plugin's action appearing) are harmless no-ops rather than needless traffic.
streamDeck.actions.onWillAppear(() => reportDeviceCapacity(false));
streamDeck.actions.onWillDisappear(() => reportDeviceCapacity(false));
streamDeck.devices.onDeviceDidConnect(() => reportDeviceCapacity(false));
streamDeck.devices.onDeviceDidDisconnect(() => reportDeviceCapacity(false));
streamDeck.devices.onDeviceDidChange(() => reportDeviceCapacity(false));

const lifecycleLogger: PluginLogger = streamDeck.logger.createScope("gatoway-core-lifecycle");
const supervisor = new CoreProcessSupervisor({
  logger: lifecycleLogger,
  childEnv: buildCoreChildEnv(coreConfig),
});
supervisor.start();

coreClient.start();

function shutdown(): void {
  coreClient.stop();
  supervisor.stop();
}
process.once("exit", shutdown);
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await streamDeck.connect();
