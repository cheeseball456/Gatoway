import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import type {
  DeviceCapacityPayload,
  GatowayMessage,
  InputEventPayload,
  RegisterAckPayload,
  RegisterPayload,
  RenderUpdatePayload,
} from "@gatoway/core";
import { nextBackoffDelayMs } from "../backoff.js";
import type { PluginLogger } from "../logging/pluginLogger.js";
import { encodeNdjsonLine, NdjsonLineDecoder } from "./protocol.js";

/** The plugin type this Stream Deck plugin declares in its `register` message (design.md D3). */
const PLUGIN_TYPE = "stream-deck";

/**
 * How long after `start()` a connection failure is treated as an expected part of
 * Gatoway core's own startup (QA-007) rather than a genuine problem. The freshly-spawned
 * Gatoway core process needs a little time to start Node, write its token file, and bind
 * its TCP listener; the client's very first attempt(s) routinely race this on a cold
 * start. Comfortably longer than that normal startup window, short enough that a real,
 * ongoing failure still escalates promptly.
 */
const DEFAULT_INITIAL_GRACE_PERIOD_MS = 5_000;

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
  /** Overridable for tests: the current time in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** See `DEFAULT_INITIAL_GRACE_PERIOD_MS`. */
  initialGracePeriodMs?: number;
  /**
   * Invoked whenever Gatoway core sends a `render_update` message (focus-profile-routing,
   * design.md D1/D4). The generic Key/Dial actions (`plugin.ts`) use this to keep their
   * displayed content in sync with whichever connection currently has focus.
   */
  onRenderUpdate?: (payload: RenderUpdatePayload) => void;
  /**
   * Invoked once immediately after this connection completes registration with Gatoway
   * core (extension-provided-slot-content design.md D1, tasks.md 7.2) - `plugin.ts` uses
   * this to send the Stream Deck plugin's own initial `device_capacity` report, since it
   * must be sent "once at that connection's own registration".
   */
  onRegistered?: () => void;
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
 * spec): presents the current token, declares plugin type `stream-deck` with no
 * declared `content` (it is the display client, not an application connection with its
 * own ordinally-addressed content), and retries with backoff on disconnect or
 * rejection.
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
  private readonly now: () => number;
  private readonly initialGracePeriodMs: number;
  private readonly onRenderUpdate: ((payload: RenderUpdatePayload) => void) | undefined;
  private readonly onRegistered: (() => void) | undefined;

  private state: CoreClientState = "disconnected";
  private socket: Socket | undefined;
  private decoder = new NdjsonLineDecoder();
  private stopped = false;
  private reconnectAttempt = 0;
  private cancelPendingReconnect: (() => void) | undefined;
  private startedAt = 0;

  constructor(options: CoreClientOptions) {
    this.logger = options.logger;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port;
    this.tokenFilePath = options.tokenFilePath;
    this.connectFn = options.connectFn ?? defaultConnect;
    this.readToken = options.readToken ?? defaultReadToken;
    this.scheduleReconnect = options.scheduleReconnect ?? defaultScheduleReconnect;
    this.backoffMs = options.backoffMs ?? ((attempt) => nextBackoffDelayMs(attempt));
    this.now = options.now ?? Date.now;
    this.initialGracePeriodMs = options.initialGracePeriodMs ?? DEFAULT_INITIAL_GRACE_PERIOD_MS;
    this.onRenderUpdate = options.onRenderUpdate;
    this.onRegistered = options.onRegistered;
  }

  /** The client's current connection state. */
  get currentState(): CoreClientState {
    return this.state;
  }

  /** Begins connecting (tasks.md 3.2). Safe to call once per client instance. */
  start(): void {
    this.stopped = false;
    this.startedAt = this.now();
    void this.connectOnce();
  }

  /**
   * Forwards a raw physical input event to Gatoway core (design.md D1, AD-8). Dropped
   * (logged, not queued/retried) when not currently connected - there is no focused
   * application to route it to in that case anyway, and no `input_event` acknowledgement
   * exists in the protocol to make retrying meaningful.
   */
  sendInputEvent(payload: InputEventPayload): void {
    if (this.state !== "connected" || !this.socket) {
      this.logger.warn("dropping input_event: not connected to Gatoway core", {
        event: "core_client_input_event_dropped",
        payload,
      });
      return;
    }
    const message: GatowayMessage<InputEventPayload> = { type: "input_event", payload };
    this.socket.write(encodeNdjsonLine(message));
  }

  /**
   * Sends a `device_capacity` report to Gatoway core (extension-provided-slot-content
   * design.md D1, tasks.md 7.2/7.3): the ordered list of physical positions currently
   * holding this plugin's own generic Key/Dial actions. Dropped (logged, not queued) when
   * not currently connected - Gatoway core will get a fresh report once this connection
   * re-registers anyway (design.md D1: "sent once at that connection's own
   * registration").
   */
  sendDeviceCapacity(payload: DeviceCapacityPayload): void {
    if (this.state !== "connected" || !this.socket) {
      this.logger.warn("dropping device_capacity: not connected to Gatoway core", {
        event: "core_client_device_capacity_dropped",
        payload,
      });
      return;
    }
    const message: GatowayMessage<DeviceCapacityPayload> = { type: "device_capacity", payload };
    this.socket.write(encodeNdjsonLine(message));
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
      this.logConnectFailure("failed to read Gatoway core's auth token file; will retry", {
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
      this.logConnectFailure("failed to open a TCP connection to Gatoway core; will retry", {
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
      // The Stream Deck plugin's own connection declares no `content` (design.md D3,
      // AD-8): it is the one display client Gatoway core sends `render_update` to, not
      // an application connection with its own ordinally-addressed content to declare.
      const payload: RegisterPayload = { pluginType: PLUGIN_TYPE, token };
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
    if (message.type === "render_update") {
      this.onRenderUpdate?.(message.payload as RenderUpdatePayload);
      return;
    }

    if (message.type !== "register_ack") {
      // No other message types are handled by this client (proposal.md's "Out of scope").
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
      this.onRegistered?.();
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

  /**
   * Logs a connection-attempt failure (token read or TCP connect) at a level that
   * reflects how expected it is. During `initialGracePeriodMs` after `start()`, a failed
   * attempt is normal - Gatoway core, just spawned, is still starting up - so it's logged
   * at `info` rather than `error` (QA-007); once that grace period has elapsed, the same
   * failure is escalated to `error` since it no longer has a benign explanation.
   */
  private logConnectFailure(message: string, details: Record<string, unknown>): void {
    if (this.now() - this.startedAt < this.initialGracePeriodMs) {
      this.logger.info(
        `${message} (Gatoway core may still be starting up; not yet treated as an error)`,
        details,
      );
      return;
    }
    this.logger.error(message, details);
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
