import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import type { GatowayMessage, RegisterAckPayload, RegisterPayload } from "@gatoway/core";
import { nextBackoffDelayMs } from "../backoff.js";
import type { PluginLogger } from "../logging/pluginLogger.js";
import { encodeNdjsonLine, NdjsonLineDecoder } from "./protocol.js";

/** The plugin type this Stream Deck plugin declares in its `register` message (design.md D3). */
const PLUGIN_TYPE = "stream-deck";

export type CoreClientState = "disconnected" | "connecting" | "authenticating" | "connected";

export interface CoreClientOptions {
  /** Gatoway core's TCP listener port. */
  port: number;
  /** Loopback host to connect to. Defaults to "127.0.0.1" (AD-4). */
  host?: string;
  /** Path to Gatoway core's current auth token file. */
  tokenFilePath: string;
  logger: PluginLogger;
  /** Overridable for tests: opens the TCP socket. */
  connectFn?: (port: number, host: string) => Socket;
  /** Overridable for tests: reads the token file. */
  readToken?: (path: string) => Promise<string>;
  /** Overridable for tests: schedules `fn` after `delayMs`, returning a cancel function. */
  scheduleReconnect?: (delayMs: number, fn: () => void) => () => void;
  /** Overridable for tests: computes the backoff delay before reconnect attempt N. */
  backoffMs?: (attempt: number) => number;
}

function defaultConnect(port: number, host: string): Socket {
  return connect(port, host);
}

async function defaultReadToken(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function defaultScheduleReconnect(delayMs: number, fn: () => void): () => void {
  const timer = setTimeout(fn, delayMs);
  return () => clearTimeout(timer);
}

/**
 * Connects to Gatoway core's TCP listener as an authenticated client, using exactly the
 * existing `register`/`register_ack` handshake (design.md D3, stream-deck-core-client
 * spec): presents the current token, declares plugin type `stream-deck` with an empty
 * capability manifest (nothing to act on yet), and retries with backoff on disconnect
 * or rejection.
 */
export class CoreClient {
  private readonly logger: PluginLogger;
  private readonly host: string;
  private readonly port: number;
  private readonly tokenFilePath: string;
  private readonly connectFn: (port: number, host: string) => Socket;
  private readonly readToken: (path: string) => Promise<string>;
  private readonly scheduleReconnect: (delayMs: number, fn: () => void) => () => void;
  private readonly backoffMs: (attempt: number) => number;

  private state: CoreClientState = "disconnected";
  private socket: Socket | undefined;
  private decoder = new NdjsonLineDecoder();
  private stopped = false;
  private reconnectAttempt = 0;
  private cancelPendingReconnect: (() => void) | undefined;

  constructor(options: CoreClientOptions) {
    this.logger = options.logger;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port;
    this.tokenFilePath = options.tokenFilePath;
    this.connectFn = options.connectFn ?? defaultConnect;
    this.readToken = options.readToken ?? defaultReadToken;
    this.scheduleReconnect = options.scheduleReconnect ?? defaultScheduleReconnect;
    this.backoffMs = options.backoffMs ?? ((attempt) => nextBackoffDelayMs(attempt));
  }

  /** The client's current connection state. */
  get currentState(): CoreClientState {
    return this.state;
  }

  /** Begins connecting (tasks.md 3.2). Safe to call once per client instance. */
  start(): void {
    this.stopped = false;
    void this.connectOnce();
  }

  /** Stops the client: cancels any pending reconnect and closes the current socket. */
  stop(): void {
    this.stopped = true;
    this.cancelPendingReconnect?.();
    this.cancelPendingReconnect = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.state = "disconnected";
  }

  private async connectOnce(): Promise<void> {
    if (this.stopped) {
      return;
    }

    this.state = "connecting";
    this.logger.info("connecting to Gatoway core", {
      event: "core_client_connecting",
      host: this.host,
      port: this.port,
    });

    let token: string;
    try {
      token = (await this.readToken(this.tokenFilePath)).trim();
    } catch (err) {
      this.logger.error("failed to read Gatoway core's auth token file; will retry", {
        event: "core_client_token_read_failed",
        error: (err as Error).message,
      });
      this.state = "disconnected";
      this.scheduleRetry();
      return;
    }

    if (this.stopped) {
      return;
    }

    let socket: Socket;
    try {
      socket = this.connectFn(this.port, this.host);
    } catch (err) {
      this.logger.error("failed to open a TCP connection to Gatoway core; will retry", {
        event: "core_client_connect_failed",
        error: (err as Error).message,
      });
      this.state = "disconnected";
      this.scheduleRetry();
      return;
    }

    this.socket = socket;
    this.decoder = new NdjsonLineDecoder();
    socket.setEncoding("utf8");

    socket.once("connect", () => {
      this.state = "authenticating";
      const payload: RegisterPayload = { pluginType: PLUGIN_TYPE, capabilities: [], token };
      const message: GatowayMessage<RegisterPayload> = { type: "register", payload };
      socket.write(encodeNdjsonLine(message));
    });

    socket.on("data", (chunk: string) => {
      let messages: GatowayMessage[];
      try {
        messages = this.decoder.push(chunk);
      } catch (err) {
        this.logger.warn("received malformed data from Gatoway core", {
          event: "core_client_malformed_message",
          error: (err as Error).message,
        });
        return;
      }
      for (const message of messages) {
        this.handleMessage(message);
      }
    });

    socket.on("error", (err) => {
      this.logger.warn("Gatoway core TCP connection error", {
        event: "core_client_socket_error",
        error: err.message,
      });
    });

    socket.on("close", () => {
      const wasConnected = this.state === "connected";
      this.socket = undefined;
      if (this.stopped) {
        return;
      }
      this.state = "disconnected";
      this.logger.warn(
        wasConnected
          ? "disconnected from Gatoway core"
          : "connection to Gatoway core closed before registering",
        { event: "core_client_disconnected" },
      );
      this.scheduleRetry();
    });
  }

  private handleMessage(message: GatowayMessage): void {
    if (message.type !== "register_ack") {
      // No other message types are handled yet (proposal.md's "Out of scope").
      return;
    }

    const payload = message.payload as RegisterAckPayload;
    if (payload.status === "ok") {
      this.reconnectAttempt = 0;
      this.state = "connected";
      this.logger.info("registered with Gatoway core", {
        event: "core_client_connected",
        connectionId: payload.connectionId,
      });
      return;
    }

    this.logger.warn("Gatoway core rejected registration; retrying after backoff", {
      event: "core_client_registration_rejected",
      reason: payload.reason,
    });
    this.state = "disconnected";
    // The 'close' handler schedules the actual retry once the socket finishes closing.
    this.socket?.destroy();
  }

  private scheduleRetry(): void {
    if (this.stopped) {
      return;
    }
    this.reconnectAttempt += 1;
    const delayMs = this.backoffMs(this.reconnectAttempt);
    this.logger.info("retrying Gatoway core connection after backoff", {
      event: "core_client_retry_scheduled",
      attempt: this.reconnectAttempt,
      delayMs,
    });
    this.cancelPendingReconnect = this.scheduleReconnect(delayMs, () => {
      this.cancelPendingReconnect = undefined;
      void this.connectOnce();
    });
  }
}
