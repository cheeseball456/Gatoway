import type { GatowayMessage } from "../protocol/envelope.js";
import type { Capability } from "../protocol/messages.js";

export type Transport = "tcp" | "websocket";

/**
 * Connection lifecycle states (connection-management spec: "Connection Lifecycle
 * State Tracking"). Transitions only ever move forward through this order:
 * connected -> authenticating -> authenticated -> disconnected.
 */
export type ConnectionState =
  | "connected"
  | "authenticating"
  | "authenticated"
  | "disconnected";

/** One live (or just-closed) plugin session tracked by the ConnectionManager. */
export interface ConnectionRecord {
  /** Unique per connection, assigned at accept time; never derived from plugin type or transport. */
  readonly id: string;
  readonly transport: Transport;
  state: ConnectionState;
  readonly connectedAt: number;
  /** Populated once a `register` message is processed. */
  pluginType?: string;
  capabilities?: Capability[];
  /** Sends a message to this connection's remote peer, using its transport's framing. */
  send: (message: GatowayMessage) => void;
  /** Closes the underlying transport-level connection. */
  close: (reason?: string) => void;
}
