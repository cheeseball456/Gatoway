import streamDeck from "@elgato/streamdeck";
import { IdleAction } from "./actions/idleAction.js";
import { buildCoreChildEnv, resolvePluginCoreConfig } from "./coreLifecycle/config.js";
import { CoreProcessSupervisor } from "./coreLifecycle/coreProcessSupervisor.js";
import { CoreClient } from "./coreClient/coreClient.js";
import type { PluginLogger } from "./logging/pluginLogger.js";

streamDeck.logger.setLevel("info");

// Render the static idle profile immediately (design.md D4): registering the action
// and connecting to the Stream Deck app is independent of Gatoway core's lifecycle
// below, so the idle key appears whether or not Gatoway core is reachable yet.
streamDeck.actions.registerAction(new IdleAction());

const coreConfig = resolvePluginCoreConfig();

const lifecycleLogger: PluginLogger = streamDeck.logger.createScope("gatoway-core-lifecycle");
const supervisor = new CoreProcessSupervisor({
  logger: lifecycleLogger,
  childEnv: buildCoreChildEnv(coreConfig),
});
supervisor.start();

const clientLogger: PluginLogger = streamDeck.logger.createScope("gatoway-core-client");
const coreClient = new CoreClient({
  port: coreConfig.tcpPort,
  tokenFilePath: coreConfig.tokenFilePath,
  logger: clientLogger,
});
coreClient.start();

function shutdown(): void {
  coreClient.stop();
  supervisor.stop();
}
process.once("exit", shutdown);
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await streamDeck.connect();
