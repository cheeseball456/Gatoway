import streamDeck from "@elgato/streamdeck";
import type { RenderUpdatePayload } from "@gatoway/core";
import { GenericDialAction } from "./actions/genericDialAction.js";
import { GenericKeyAction } from "./actions/genericKeyAction.js";
import { RenderStore } from "./actions/renderStore.js";
import { buildCoreChildEnv, resolvePluginCoreConfig } from "./coreLifecycle/config.js";
import { CoreProcessSupervisor } from "./coreLifecycle/coreProcessSupervisor.js";
import { CoreClient } from "./coreClient/coreClient.js";
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
});

const keyAction = new GenericKeyAction(renderStore, (payload) => coreClient.sendInputEvent(payload));
const dialAction = new GenericDialAction(renderStore, (payload) => coreClient.sendInputEvent(payload));
streamDeck.actions.registerAction(keyAction);
streamDeck.actions.registerAction(dialAction);

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
