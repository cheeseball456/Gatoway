import type {
  DeviceCapacityPayload,
  FocusPayload,
  InputEventPayload,
} from "../protocol/messages.js";
import type { ConnectionRecord } from "./types.js";

/**
 * The collaborator `messageHandler.ts` dispatches `focus`/`input_event`/
 * `device_capacity` messages to, and notifies of successful (re-)registrations,
 * without itself needing to know anything about focus tracking, slot capacity, or
 * profile routing (focus-tracking / profile-routing / stream-deck-core-lifecycle
 * capabilities; design.md D2-D6). Implemented by `routing/profileRouter.ts`.
 *
 * Deliberately optional wherever it's threaded through (`handleRawMessage`, the TCP/WS
 * listeners): existing tests exercise those functions without a router, exactly as
 * before this change, since registration/error handling is unaffected by it.
 */
export interface ProtocolRouter {
  /**
   * Called once a connection completes (re-)registration. Used to send the Stream Deck
   * plugin's connection an immediate render sweep reflecting current focus state, and
   * to send an application plugin its initial `slot_capacity` (extension-provided-
   * slot-content design.md D2/D3) plus an immediate re-render if it is already focused.
   */
  handleRegistered(connection: ConnectionRecord): void;
  /** Called when an authenticated connection sends a `focus` message. */
  handleFocus(connection: ConnectionRecord, payload: FocusPayload): void;
  /** Called when an authenticated connection sends an `input_event` message. */
  handleInputEvent(connection: ConnectionRecord, payload: InputEventPayload): void;
  /**
   * Called when an authenticated connection sends a `device_capacity` message
   * (design.md D1, tasks.md 3.4): only accepted from the `pluginType: "stream-deck"`
   * connection - rejected/ignored from any other connection.
   */
  handleDeviceCapacity(connection: ConnectionRecord, payload: DeviceCapacityPayload): void;
}
