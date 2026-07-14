/**
 * Payload shapes for the message-protocol capability. `register`/`register_ack`/`error`
 * were defined by `gatoway-core-foundation`; `focus`, `input_event`, `render_update`,
 * and `command` are added by `focus-profile-routing` (design.md D1) to implement AD-7
 * (self-reported focus) and AD-8 (generic, position-based action model).
 */

/** A single capability (button or dial action) a plugin declares at registration. */
export interface Capability {
  id: string;
  label: string;
  type: "button" | "dial";
  description?: string;
  icon?: string;
}

/**
 * Sent by a plugin to authenticate and declare its capability manifest.
 *
 * `token` is required for TCP (native) connections and validated against the current
 * auth token file. WebSocket (browser) connections authenticate via the `Origin`
 * header at the HTTP-upgrade stage (see design.md D5) and do not need to supply a
 * token here, so the field is optional in the shared shape.
 */
export interface RegisterPayload {
  pluginType: string;
  capabilities: Capability[];
  token?: string;
}

export type RegisterAckStatus = "ok" | "rejected";

/** Sent by Gatoway core in response to a `register` message. */
export interface RegisterAckPayload {
  status: RegisterAckStatus;
  connectionId: string;
  reason?: string;
}

/** Usable by either Gatoway core or a connected plugin to report a protocol-level error. */
export interface ErrorPayload {
  message: string;
  details?: unknown;
}

/**
 * Which physical control surface an `input_event`/`render_update` addresses (design.md
 * D1, AD-8). Position-addressed only - never app- or command-specific.
 */
export type Controller = "keypad" | "encoder";

/** A physical key's position, matching the Elgato SDK's own row/column addressing. */
export interface KeypadPosition {
  row: number;
  column: number;
}

/** A physical dial's position, matching the Elgato SDK's own index addressing. */
export interface EncoderPosition {
  index: number;
}

/** `{ row, column }` for `controller: "keypad"`, `{ index }` for `controller: "encoder"`. */
export type Position = KeypadPosition | EncoderPosition;

/**
 * Sent by an application plugin to report its own focus state (design.md D1/D2, AD-7).
 * No acknowledgement message: focus changes are frequent and self-correcting (a
 * connection disconnecting is what resolves a crashed app that never sent `focused:
 * false`, not a missed message - see focus-tracking spec).
 */
export interface FocusPayload {
  focused: boolean;
}

/** The kind of physical interaction an `input_event` reports. */
export type InputEventType = "keyDown" | "keyUp" | "rotate" | "push";

/**
 * Sent by the Stream Deck plugin to report raw physical input (design.md D1, AD-8): no
 * app-specific meaning attached, only which position was interacted with and how.
 * `delta` is present only when `eventType` is `"rotate"`.
 */
export interface InputEventPayload {
  controller: Controller;
  position: Position;
  eventType: InputEventType;
  delta?: number;
}

/**
 * Sent by Gatoway core to the Stream Deck plugin to specify what to display at a given
 * position (design.md D1/D4, AD-8). Fields other than `controller`/`position` are
 * optional and sparse - an update only sets what is changing; omitted fields leave
 * whatever was previously displayed at that position unchanged.
 */
export interface RenderUpdatePayload {
  controller: Controller;
  position: Position;
  icon?: string;
  label?: string;
  state?: number;
}

/**
 * Sent by Gatoway core to the currently-focused application connection once an
 * `input_event` has been resolved against that connection's bound capability
 * (profile-routing spec: "Input Event Resolution Against the Focused Connection").
 *
 * NOTE: design.md's D1 enumerates exactly three new message types (`focus`,
 * `input_event`, `render_update`) and does not itself define this fourth type, even
 * though the `profile-routing` spec explicitly requires Gatoway core to "forward a
 * corresponding command to that connection" once resolution succeeds. This shape is a
 * minimal, implementation-level fill of that gap (same envelope, no new framing),
 * added here so the resolution behavior the spec requires is actually implementable -
 * flagged back to the design/architecture level rather than left silently unaddressed
 * (see this change's developer report).
 */
export interface CommandPayload {
  capabilityId: string;
  eventType: InputEventType;
  delta?: number;
}
