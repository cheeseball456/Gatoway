/**
 * Payload shapes for the message-protocol capability. `register`/`register_ack`/`error`
 * were defined by `gatoway-core-foundation`; `focus`, `input_event`, `render_update`,
 * `command` were added by `focus-profile-routing` (design.md D1) to implement AD-7
 * (self-reported focus) and AD-8 (generic, position-based action model).
 *
 * `extension-provided-slot-content` (design.md D1-D6) replaces the old `Capability`/
 * `capability_update`/`capabilityId` model entirely: a plugin's declared content is now
 * two ordered, position-agnostic arrays (`SlotContent[]`), addressed only by ordinal
 * index, never by a plugin-chosen id. Gatoway core also now tracks live slot capacity
 * (`device_capacity`/`slot_capacity`) instead of resolving positions against a
 * persisted, host-side layout file - see `gatoway-core/src/routing/profileRouter.ts`.
 */

/**
 * A single item of content (button or dial) a plugin currently wants displayed at one
 * ordinal position within one control type (design.md D3). Addressed only by its
 * position within `RegisterContent.buttons`/`RegisterContent.dials` - never by an id,
 * since Gatoway core never needs to look this up by anything other than position.
 */
export interface SlotContent {
  /**
   * `undefined` here means "this slot currently has no icon" - whether because none was
   * ever declared, or because a later `register` explicitly omitted it while otherwise
   * replacing this entry (a fresh entry, not a sparse update - see `RegisterContent`'s
   * own doc comment: content-level `icon` never accepts `null`, unlike
   * `render_update`'s sparse three-way semantics).
   */
  icon?: string;
  /** Non-empty; human-readable name shown on the physical key/dial. */
  label: string;
  /** Toggle/indicator state (e.g. on/off) - buttons only, mirroring `render_update`'s `state`. */
  state?: number;
}

/**
 * The full, ordinal-addressed content a connection currently wants displayed (design.md
 * D3): `content.buttons[N]` fills the Nth position in the Stream Deck plugin's latest
 * `device_capacity.buttonPositions` report; `content.dials[N]` fills the Nth position in
 * `dialPositions`. Neither array carries any semantic id - "which array, which index" is
 * the entirety of how an entry is addressed, both at registration and later in a
 * resolved `command`.
 */
export interface RegisterContent {
  buttons: SlotContent[];
  dials: SlotContent[];
}

/**
 * Sent by a plugin to authenticate and declare its displayed content.
 *
 * `token` is required for TCP (native) connections and validated against the current
 * auth token file. WebSocket (browser) connections authenticate via the `Origin`
 * header at the HTTP-upgrade stage (see design.md D5) and do not need to supply a
 * token here, so the field is optional in the shared shape.
 */
export interface RegisterPayload {
  pluginType: string;
  content?: RegisterContent;
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
 *
 * `icon` additionally accepts `null` (design.md D4, amended): `undefined`/omitted means
 * "unchanged" (sparse-update semantics - indistinguishable from a dropped field once
 * this crosses the wire as JSON), while `null` means "explicitly reset to the
 * manifest's bundled default image", matching the Elgato Stream Deck SDK's own
 * `setImage()` call with no argument. Without this distinct value, the idle sweep would
 * have no way to actually clear a previously-focused connection's content icon - it
 * would either have to omit `icon` (leaving it stuck) or invent a fake sentinel string.
 */
export interface RenderUpdatePayload {
  controller: Controller;
  position: Position;
  icon?: string | null;
  label?: string;
  state?: number;
}

/**
 * Sent by Gatoway core to the currently-focused application connection once an
 * `input_event` has been resolved against an ordinal index within that connection's own
 * declared content (`extension-provided-slot-content` design.md D5/D6, profile-routing
 * spec: "Input Event Resolution Against the Focused Connection"). `slotIndex` identifies
 * the entry's position within `content.buttons` (`controller: "keypad"`) or
 * `content.dials` (`controller: "encoder"`) - Gatoway core carries no other meaning for
 * it. `eventType`/`delta` carry the same raw gesture information the originating
 * `input_event` reported.
 */
export interface CommandPayload {
  controller: Controller;
  slotIndex: number;
  eventType: InputEventType;
  delta?: number;
}

/**
 * Sent by the Stream Deck plugin connection (and only that connection - design.md D1)
 * reporting the connected device's live slot capacity: the ordered list of physical
 * positions currently holding a generic Key action, and the ordered list currently
 * holding a generic Dial action. Sent once at that connection's own registration, and
 * again any time the set of placed generic actions changes.
 *
 * Order within each list must be stable and deterministic so that ordinal index N
 * consistently means the same physical position across repeated reports, until capacity
 * actually changes - see `stream-deck-plugin/src/coreClient/deviceCapacity.ts` for the
 * Stream Deck plugin's own chosen ordering rule.
 */
export interface DeviceCapacityPayload {
  buttonPositions: Position[];
  dialPositions: Position[];
}

/**
 * Sent by Gatoway core to an application plugin, reporting how many button/dial slots
 * are currently available - bare counts only, derived from the most recent
 * `device_capacity` report (design.md D2). An application plugin has no use for actual
 * physical positions, only how many slots of each type it has to fill. Sent once
 * immediately after that connection's own successful `register_ack`, and again every
 * time Gatoway core records that connection as newly focused.
 */
export interface SlotCapacityPayload {
  buttonSlots: number;
  dialSlots: number;
}
