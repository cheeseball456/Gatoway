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

// extension-provided-slot-content (design.md D1, tasks.md 7.1-7.2, amended v1.7 tasks.md
// 10.5-10.6): tracks the most recently *sent* device_capacity report, so a
// re-computation triggered by a device connect/disconnect/change event only actually
// sends a fresh report when the derived position lists changed, never on every event
// unconditionally. Capacity is now derived purely from Device.size/Device.type (fixed
// hardware facts), so - unlike the superseded v1.6 placement-derived version - only a
// device event can ever actually change it; there is no longer any action-placement
// listening here at all (QA-020).
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

// Re-sends device_capacity only when the connected device itself changes (tasks.md
// 10.6, amended v1.7 for QA-020): connected, disconnected, or swapped for a different
// model. Placing or removing a generic Key/Dial action no longer triggers a
// recomputation at all - unlike the superseded v1.6 model, physical capacity is a fixed
// hardware fact (Device.size/Device.type), not a function of what's currently placed,
// so there is nothing for an action-placement listener to usefully react to here. Each
// handler recomputes and only actually sends a fresh report if the derived lists
// changed, so a redundant SDK event (e.g. onDeviceDidChange firing without an actual
// capacity change) is a harmless no-op rather than needless traffic.
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
