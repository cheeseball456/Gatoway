/**
 * Payload shapes for the message-protocol capability. `register`/`register_ack`/`error`
 * were defined by `gatoway-core-foundation`; `focus`, `input_event`, `render_update`,
 * `command` were added by `focus-profile-routing` (design.md D1) to implement AD-7
 * (self-reported focus) and AD-8 (generic, position-based action model).
 *
 * `extension-provided-slot-content` (design.md D1-D6, amended v1.7 for QA-020) replaces
 * the old `Capability`/`capability_update`/`capabilityId` model entirely: a plugin's
 * declared content is a flat map keyed by a fixed, stable position label (`"B1"`,
 * `"D1"`, ...), derived from the connected device's fixed physical capacity - never by
 * an ordinal array index (v1.6's superseded model, which conflated physical capacity
 * with live placement - see QA-020) or a plugin-chosen id. Gatoway core also tracks the
 * device's fixed slot capacity (`device_capacity`/`slot_capacity`) instead of resolving
 * positions against a persisted, host-side layout file - see
 * `gatoway-core/src/routing/profileRouter.ts`.
 */

/**
 * A single item of content (button or dial) a plugin currently wants displayed at one
 * fixed, physical-position label (design.md D3, e.g. `"B1"`, `"D1"`). Addressed only by
 * its key within `RegisterContent` - never by an id, since Gatoway core never needs to
 * look this up by anything other than that label.
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
 * The full, label-addressed content a connection currently wants displayed (design.md
 * D3, amended v1.7): a flat map keyed by fixed position label (`"B1"`, `"B2"`, ...,
 * `"D1"`, ...) - a label's own `B`/`D` prefix identifies which physical control type it
 * addresses, so there is no need for separate `buttons`/`dials` containers (v1.6's
 * superseded shape). A label always corresponds to the same physical position for as
 * long as the connected device itself doesn't change (AD-9) - never to a live
 * placement-derived ordinal index (QA-020). A plugin need not declare every label a
 * device's current `slot_capacity` makes available: an omitted label simply isn't
 * rendered at that physical position, exactly mirroring the old array-underflow
 * behavior.
 */
export type RegisterContent = Record<string, SlotContent>;

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
 * D1, AD-8). Position-addressed only - never app- or command-specific. Still used for
 * `input_event`/`render_update`, which remain physical-position addressed (the Stream
 * Deck plugin still deals in real physical positions, not labels) - see `CommandPayload`
 * for the label-addressed shape resolved *from* a `Controller`+`Position` pair.
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
 * `input_event` has been resolved against a fixed label within that connection's own
 * declared content (`extension-provided-slot-content` design.md D5/D6, amended v1.7,
 * profile-routing spec: "Input Event Resolution Against the Focused Connection").
 * `label` identifies the entry within the focused connection's own `content` map (e.g.
 * `"B3"`, `"D1"`) - Gatoway core carries no other meaning for it. There is no separate
 * `controller` field (dropped in v1.7, superseding the `{ controller, slotIndex }`
 * shape): the label's own prefix (`B` for button, `D` for dial) already conveys the
 * controller type, so carrying both would be redundant. `eventType`/`delta` carry the
 * same raw gesture information the originating `input_event` reported.
 */
export interface CommandPayload {
  label: string;
  eventType: InputEventType;
  delta?: number;
}

/**
 * Sent by the Stream Deck plugin connection (and only that connection - design.md D1)
 * reporting the connected device's **fixed physical layout** (amended v1.7, superseding
 * v1.6's live-placement report - see QA-020): the ordered list of physical button
 * positions (`buttonPositions`) and the ordered list of physical dial positions
 * (`dialPositions`), derived from the device's actual hardware capacity
 * (`Device.size`/`Device.type`) - never from which positions currently have a generic
 * Key/Dial action placed on them. Sent once at that connection's own registration, and
 * again only if the connected device itself changes (connected, disconnected, or
 * swapped for a different model) - placing or removing a generic action does *not*
 * trigger a new report, since physical capacity hasn't changed.
 *
 * Order within each list must be stable and deterministic, since Gatoway core derives
 * each position's fixed label directly from its index in these lists
 * (`buttonPositions[0]` is `"B1"`, `buttonPositions[1]` is `"B2"`, ..., `dialPositions[0]`
 * is `"D1"`, and so on) - see `stream-deck-plugin/src/coreClient/deviceCapacity.ts` for
 * the Stream Deck plugin's own chosen ordering rule. Because this is now derived from
 * fixed hardware facts rather than live placement, the order no longer shuffles due to
 * unrelated placement changes - only a genuine device change ever changes it.
 */
export interface DeviceCapacityPayload {
  buttonPositions: Position[];
  dialPositions: Position[];
}

/**
 * Sent by Gatoway core to an application plugin, reporting how many button/dial slots
 * the connected device physically has - bare counts only, derived from the most recent
 * `device_capacity` report (design.md D2, amended v1.8 for QA-021). An application
 * plugin derives its own valid label set (`"B1".."B<buttonSlots>"`,
 * `"D1".."D<dialSlots>"`) from these counts, once known, using the documented labeling
 * convention; the actual label strings are never enumerated over the wire, since both
 * sides derive them identically from the same counts.
 *
 * `null` means capacity is **not yet known** - no `device_capacity` report has ever
 * been received (e.g. Gatoway core was spawned by the Stream Deck plugin, which has
 * connected back but hasn't reported its device's capacity yet, while an
 * application plugin has already registered). This is deliberately distinct from a
 * known `0`, which means the device is known to genuinely have none of that control
 * type - collapsing both into `0` (the pre-v1.8 shape) meant a plugin that registered
 * before capacity was ever known had its content permanently rejected as "out of
 * range," with no path to recovery (QA-021).
 *
 * Sent once immediately after that connection's own successful `register_ack`, again
 * every time Gatoway core records that connection as newly focused, and again,
 * unsolicited, to every currently-connected application plugin the first time real
 * capacity becomes known after having been unknown, and on any subsequent
 * `device_capacity` change (design.md D2's broadcast rule) - not just to whichever
 * connection's own register/focus-gain happened to trigger the underlying
 * `device_capacity` report.
 */
export interface SlotCapacityPayload {
  buttonSlots: number | null;
  dialSlots: number | null;
}
