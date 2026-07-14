import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger.js";
import type { Capability } from "../protocol/messages.js";
import type { ConnectionRecord, ConnectionState, Transport } from "./types.js";

const STATE_ORDER: readonly ConnectionState[] = [
  "connected",
  "authenticating",
  "authenticated",
  "disconnected",
];

function isForwardTransition(from: ConnectionState, to: ConnectionState): boolean {
  return STATE_ORDER.indexOf(to) === STATE_ORDER.indexOf(from) + 1;
}

export interface AcceptConnectionOptions {
  transport: Transport;
  send: (message: import("../protocol/envelope.js").GatowayMessage) => void;
  close: (reason?: string) => void;
  /**
   * Set true when the transport has already authenticated the connection before it
   * reaches the ConnectionManager (the WebSocket path: the Origin check happens during
   * the HTTP upgrade, before a connection record exists at all — design.md D5).
   * When true, the connection is walked straight through
   * connected -> authenticating -> authenticated as one atomic step.
   */
  preAuthenticated?: boolean;
}

/**
 * Owns connection state for every accepted connection, regardless of transport
 * (design.md D2/D3). Assigns each connection a unique ID at accept time and is the
 * single place lifecycle events are logged (connection-management spec, tasks.md 3.1).
 */
export class ConnectionManager {
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly disconnectListeners: Array<
    (record: ConnectionRecord, reason?: string) => void
  > = [];

  constructor(private readonly logger: Logger) {}

  /**
   * Registers a listener invoked whenever a connection disconnects (after it has been
   * removed from tracking). Additive hook for focus-tracking (task 2.4): lets
   * `ProfileRouter` clear focus on disconnect without `ConnectionManager` needing to
   * know anything about focus/profile-routing itself.
   */
  onDisconnect(listener: (record: ConnectionRecord, reason?: string) => void): void {
    this.disconnectListeners.push(listener);
  }

  /** Registers a newly-accepted connection and assigns it a unique connection ID. */
  accept(options: AcceptConnectionOptions): ConnectionRecord {
    const id = randomUUID();
    const record: ConnectionRecord = {
      id,
      transport: options.transport,
      state: "connected",
      connectedAt: Date.now(),
      send: options.send,
      close: options.close,
    };
    this.connections.set(id, record);
    this.logger.info(
      { event: "connection_accepted", connectionId: id, transport: record.transport },
      "connection accepted",
    );

    this.transition(id, "authenticating");
    if (options.preAuthenticated) {
      this.transition(id, "authenticated");
    }

    return record;
  }

  /** Looks up a connection by ID, or `undefined` if it has no active record. */
  get(id: string): ConnectionRecord | undefined {
    return this.connections.get(id);
  }

  /** Returns a snapshot of all currently-tracked connections. */
  list(): ConnectionRecord[] {
    return [...this.connections.values()];
  }

  /**
   * Moves a connection to the next state in its lifecycle. Only forward transitions in
   * the fixed order (connected -> authenticating -> authenticated -> disconnected) are
   * permitted; anything else is a programming error in this codebase, not a
   * client-triggerable condition, so it throws rather than silently proceeding.
   */
  transition(id: string, next: ConnectionState): void {
    const record = this.connections.get(id);
    if (!record) {
      return;
    }
    if (!isForwardTransition(record.state, next)) {
      throw new Error(
        `invalid connection state transition for ${id}: ${record.state} -> ${next}`,
      );
    }
    record.state = next;
    if (next === "authenticated") {
      this.logger.info(
        { event: "connection_authenticated", connectionId: id, transport: record.transport },
        "connection authenticated",
      );
    }
  }

  /** Records the plugin's declared type and capability manifest from its `register` message. */
  setPluginInfo(id: string, pluginType: string, capabilities: Capability[]): void {
    const record = this.connections.get(id);
    if (!record) {
      return;
    }
    record.pluginType = pluginType;
    record.capabilities = capabilities;
  }

  /** Marks a connection disconnected and removes it from active tracking (tasks.md 3.6). */
  disconnect(id: string, reason?: string): void {
    const record = this.connections.get(id);
    if (!record || record.state === "disconnected") {
      return;
    }
    record.state = "disconnected";
    this.connections.delete(id);
    this.logger.info(
      {
        event: "connection_disconnected",
        connectionId: id,
        transport: record.transport,
        reason,
      },
      "connection disconnected",
    );
    for (const listener of this.disconnectListeners) {
      listener(record, reason);
    }
  }
}
