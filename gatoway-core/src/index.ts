import { loadConfig, type GatowayCoreConfig } from "./config.js";
import { createLogger, type Logger } from "./logging/logger.js";
import { generateToken, writeTokenFile } from "./auth/token.js";
import { ConnectionManager } from "./connection/connectionManager.js";
import { startTcpListener, type TcpListenerHandle } from "./connection/tcpListener.js";
import { startWsListener, type WsListenerHandle } from "./connection/wsListener.js";

export type { GatowayCoreConfig } from "./config.js";
export { ConnectionManager } from "./connection/connectionManager.js";
export type { ConnectionRecord, ConnectionState, Transport } from "./connection/types.js";
export type { GatowayMessage } from "./protocol/envelope.js";
export type {
  Capability,
  ErrorPayload,
  RegisterAckPayload,
  RegisterPayload,
} from "./protocol/messages.js";

export interface GatowayCoreHandle {
  readonly config: GatowayCoreConfig;
  readonly manager: ConnectionManager;
  readonly logger: Logger;
  /** The loopback addresses/ports actually bound by the TCP and WebSocket listeners. */
  readonly tcpAddresses: { address: string; port: number }[];
  readonly wsAddresses: { address: string; port: number }[];
  /** Stops both listeners. Does not remove the token file (regenerated on next start). */
  close: () => Promise<void>;
}

export interface StartGatowayCoreOptions {
  /** Overrides environment-derived configuration. Primarily for tests. */
  config?: Partial<GatowayCoreConfig>;
  /** Overrides process.env for config resolution when `config` isn't fully specified. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Starts Gatoway core: the TCP and WebSocket listeners (both loopback-bound), the auth
 * token handshake, the unified message protocol, connection lifecycle tracking, and
 * diagnostics logging (design.md D1). Exposed as a single entry point so a future
 * Stream Deck plugin change can invoke it as a child process without this change
 * needing to know how it will be launched.
 */
export async function startGatowayCore(
  options: StartGatowayCoreOptions = {},
): Promise<GatowayCoreHandle> {
  const config: GatowayCoreConfig = {
    ...loadConfig(options.env),
    ...options.config,
  };

  const logger = createLogger({
    logFilePath: config.logFilePath,
    maxSizeBytes: config.logMaxSizeBytes,
    maxFiles: config.logMaxFiles,
    level: config.logLevel,
  });

  const token = generateToken();
  try {
    await writeTokenFile(config.tokenFilePath, token);
  } catch (err) {
    // The token file's user-only permission is the boundary that keeps other local
    // processes from authenticating (NFR 3.3). We log this loudly but do not abort
    // startup: loopback-only binding (AD-4) still holds regardless, and a hard crash
    // here would be a worse outcome for a personal-use tool than a logged warning.
    logger.error(
      { event: "token_file_write_failed", error: (err as Error).message },
      "failed to write or restrict the auth token file; local-process authentication is weakened",
    );
  }

  const manager = new ConnectionManager(logger);

  const tcpHandle: TcpListenerHandle = await startTcpListener({
    port: config.tcpPort,
    manager,
    logger,
    currentToken: token,
  });

  const wsHandle: WsListenerHandle = await startWsListener({
    port: config.wsPort,
    manager,
    logger,
    allowedOrigins: config.allowedOrigins,
  });

  logger.info(
    { event: "gatoway_core_started", tcpPort: config.tcpPort, wsPort: config.wsPort },
    "Gatoway core started",
  );

  return {
    config,
    manager,
    logger,
    tcpAddresses: tcpHandle.addresses,
    wsAddresses: wsHandle.addresses,
    close: async () => {
      await Promise.all([tcpHandle.close(), wsHandle.close()]);
      logger.info({ event: "gatoway_core_stopped" }, "Gatoway core stopped");
      await new Promise<void>((resolve) => {
        const flushable = logger as unknown as { flush?: (cb: () => void) => void };
        if (typeof flushable.flush === "function") {
          flushable.flush(resolve);
        } else {
          resolve();
        }
      });
    },
  };
}

// Allow running this module directly (e.g. `node dist/index.js` or `tsx src/index.ts`)
// as a standalone process, per design.md's Non-Goal that process spawning/supervision
// belongs to the Stream Deck plugin's own change — this only needs to be runnable
// stand-alone.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  startGatowayCore().catch((err) => {
    console.error("Gatoway core failed to start:", err);
    process.exitCode = 1;
  });
}
