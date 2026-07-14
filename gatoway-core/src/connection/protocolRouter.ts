import type {
  CapabilityUpdatePayload,
  FocusPayload,
  InputEventPayload,
} from "../protocol/messages.js";
import type { ConnectionRecord } from "./types.js";

/**
 * The collaborator `messageHandler.ts` dispatches `focus`/`input_event`/
 * `capability_update` messages to, and notifies of successful (re-)registrations,
 * without itself needing to know anything about focus tracking or profile routing
 * (focus-tracking / profile-routing capabilities; design.md D2-D4, D7). Implemented by
 * `routing/profileRouter.ts`.
 *
 * Deliberately optional wherever it's threaded through (`handleRawMessage`, the TCP/WS
 * listeners): existing tests exercise those functions without a router, exactly as
 * before this change, since registration/error handling is unaffected by it.
 */
export interface ProtocolRouter {
  /**
   * Called once a connection completes (re-)registration. Used to send the Stream Deck
   * plugin's connection an immediate render sweep reflecting current focus state (e.g.
   * the idle appearance, if it's the first connection and nothing is focused yet).
   */
  handleRegistered(connection: ConnectionRecord): void;
  /** Called when an authenticated connection sends a `focus` message. */
  handleFocus(connection: ConnectionRecord, payload: FocusPayload): void;
  /** Called when an authenticated connection sends an `input_event` message. */
  handleInputEvent(connection: ConnectionRecord, payload: InputEventPayload): void;
  /**
   * Called when an authenticated connection sends a `capability_update` message
   * (design.md D7, task-group-7 addendum): a live display change to one of its own
   * already-declared capabilities.
   */
  handleCapabilityUpdate(connection: ConnectionRecord, payload: CapabilityUpdatePayload): void;
}
