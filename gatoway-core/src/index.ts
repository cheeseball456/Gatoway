import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type GatowayCoreConfig } from "./config.js";
import { createLogger, type Logger } from "./logging/logger.js";
import { generateToken, writeTokenFile } from "./auth/token.js";
import { ConnectionManager } from "./connection/connectionManager.js";
import { startTcpListener, type TcpListenerHandle } from "./connection/tcpListener.js";
import { startWsListener, type WsListenerHandle } from "./connection/wsListener.js";
import { FocusTracker } from "./focus/focusTracker.js";
import { ProfileRouter } from "./routing/profileRouter.js";

export type { GatowayCoreConfig } from "./config.js";
export { ConnectionManager } from "./connection/connectionManager.js";
export type { ConnectionRecord, ConnectionState, Transport } from "./connection/types.js";
export type { ProtocolRouter } from "./connection/protocolRouter.js";
export type { GatowayMessage } from "./protocol/envelope.js";
export type {
  CommandPayload,
  Controller,
  DeviceCapacityPayload,
  EncoderPosition,
  ErrorPayload,
  FocusPayload,
  InputEventPayload,
  InputEventType,
  KeypadPosition,
  Position,
  RegisterAckPayload,
  RegisterContent,
  RegisterPayload,
  RenderUpdatePayload,
  SlotCapacityPayload,
  SlotContent,
} from "./protocol/messages.js";
export { FocusTracker } from "./focus/focusTracker.js";
export type { FocusChangeEvent, FocusChangeReason } from "./focus/focusTracker.js";
export { ProfileRouter, STREAM_DECK_PLUGIN_TYPE } from "./routing/profileRouter.js";

export interface GatowayCoreHandle {
  readonly config: GatowayCoreConfig;
  readonly manager: ConnectionManager;
  readonly logger: Logger;
  /** Tracks which connection (if any) currently has focus (focus-tracking capability). */
  readonly focusTracker: FocusTracker;
  /**
   * Resolves input_events and drives render_updates, live slot-capacity tracking, and
   * slot_capacity delivery (profile-routing / stream-deck-core-lifecycle capabilities).
   */
  readonly profileRouter: ProfileRouter;
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

  const focusTracker = new FocusTracker(logger);
  // extension-provided-slot-content: Gatoway core persists no app-specific
  // configuration to disk as of this change (design.md D7) - slot capacity and
  // declared content both live in memory only, owned by ProfileRouter/ConnectionManager.
  const profileRouter = new ProfileRouter({ manager, focusTracker, logger });
  manager.onDisconnect((record) => profileRouter.handleDisconnect(record.id));

  const tcpHandle: TcpListenerHandle = await startTcpListener({
    port: config.tcpPort,
    manager,
    logger,
    currentToken: token,
    router: profileRouter,
  });

  const wsHandle: WsListenerHandle = await startWsListener({
    port: config.wsPort,
    manager,
    logger,
    allowedOrigins: config.allowedOrigins,
    router: profileRouter,
  });

  logger.info(
    { event: "gatoway_core_started", tcpPort: config.tcpPort, wsPort: config.wsPort },
    "Gatoway core started",
  );

  return {
    config,
    manager,
    logger,
    focusTracker,
    profileRouter,
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
//
// Comparing resolved filesystem paths (rather than building a `file://` URL by naive
// string concatenation) avoids a false negative whenever the invoking path contains
// characters that `file://` URLs percent-encode, e.g. spaces (QA-005): a naive
// `file://${process.argv[1]}` never matches `import.meta.url` in that case, so
// `invokedDirectly` was always false and this module silently never started when run
// directly.
//
// Node resolves symlinks by default when computing a directly-executed entry module's
// `import.meta.url` (`--preserve-symlinks-main` is off unless explicitly set), but does
// *not* resolve symlinks in `process.argv[1]` itself. That mismatch is not exotic: on
// macOS, `os.tmpdir()` returns `/tmp/...`, which is itself a symlink to `/private/tmp`,
// so simply resolving `process.argv[1]` with `path.resolve` (no symlink resolution)
// still fails to match whenever Gatoway core is launched from within a symlinked
// directory. Resolving both sides through `fs.realpathSync` keeps the comparison
// correct in that case too.
function isInvokedDirectly(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }
  try {
    const modulePath = fileURLToPath(import.meta.url);
    const entryPath = realpathSync(path.resolve(entryArg));
    return realpathSync(modulePath) === entryPath;
  } catch {
    // import.meta.url isn't a file:// URL, or argv[1]/this module's path can't be
    // resolved on disk — definitely not a direct file invocation.
    return false;
  }
}

if (isInvokedDirectly()) {
  startGatowayCore().catch((err) => {
    console.error("Gatoway core failed to start:", err);
    process.exitCode = 1;
  });
}
