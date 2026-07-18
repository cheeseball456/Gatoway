import type { ConnectionManager } from "../connection/connectionManager.js";
import { sendMessage } from "../connection/messageHandler.js";
import type { ProtocolRouter } from "../connection/protocolRouter.js";
import type { ConnectionRecord } from "../connection/types.js";
import type { FocusTracker } from "../focus/focusTracker.js";
import type { Logger } from "../logging/logger.js";
import type {
  CommandPayload,
  Controller,
  DeviceCapacityPayload,
  FocusPayload,
  InputEventPayload,
  Position,
  RegisterContent,
  RenderUpdatePayload,
  SlotCapacityPayload,
} from "../protocol/messages.js";
import { samePosition } from "./position.js";

/**
 * The plugin type the Stream Deck plugin declares at registration (matches
 * `stream-deck-plugin/src/coreClient/coreClient.ts`'s `PLUGIN_TYPE`). Only this
 * connection ever receives `render_update` messages (design.md D4/D5, AD-8): it is the
 * one physical display Gatoway core drives. It is also the only connection allowed to
 * send `device_capacity` (extension-provided-slot-content design.md D1).
 */
export const STREAM_DECK_PLUGIN_TYPE = "stream-deck";

/** The built-in idle appearance's label (design.md D4: matches the old static Idle key's title). */
const IDLE_LABEL = "Gatoway";

export interface ProfileRouterOptions {
  manager: ConnectionManager;
  focusTracker: FocusTracker;
  logger: Logger;
}

/**
 * Implements the `profile-routing`/`stream-deck-core-lifecycle` capabilities
 * (extension-provided-slot-content design.md D1-D6/D9, amended v1.7 for QA-020, further
 * amended v1.8 for QA-021/QA-022): tracks the Stream Deck plugin's latest fixed
 * device-capacity report (distinguishing "not yet known" from a known zero, D2),
 * resolves incoming `input_event`s against the currently-focused connection's own
 * declared, label-addressed content, keeps the Stream Deck plugin's display in sync
 * with focus changes and live content updates (re-sent `register`), and delivers
 * `slot_capacity` to each application plugin at connection time, on every focus gain,
 * and, unsolicited, to every currently-connected application plugin whenever capacity
 * first becomes known or subsequently changes.
 *
 * Gatoway core has no semantic understanding of what any entry means (AD-8 revised) -
 * only which physical position a fixed label (`"B1"`, `"D1"`, ...) maps to (via the
 * latest `device_capacity` report) and which connection's content is currently
 * displayed. Labels are derived from `device_capacity`'s position-list index
 * (`buttonPositions[i]` -> `"B" + (i+1)`, `dialPositions[i]` -> `"D" + (i+1)`) - never
 * from live placement, which is what v1.6's superseded ordinal-index model conflated
 * (QA-020).
 */
export class ProfileRouter implements ProtocolRouter {
  private readonly manager: ConnectionManager;
  private readonly focusTracker: FocusTracker;
  private readonly logger: Logger;

  /**
   * The Stream Deck plugin's most recent `device_capacity` report (design.md D1).
   * `null` means no report has ever been received yet - distinct from a report whose
   * position lists are themselves empty (a known "zero of this control type," e.g. the
   * device disconnected - design.md D2, amended v1.8 for QA-021). Never confuse the two:
   * `getSlotCapacity()` must report `null` counts (unknown), not `0` counts (known
   * zero), while this is still `null`.
   */
  private latestCapacity: DeviceCapacityPayload | null = null;

  constructor(options: ProfileRouterOptions) {
    this.manager = options.manager;
    this.focusTracker = options.focusTracker;
    this.logger = options.logger;
  }

  /**
   * Handles a (re-)registration (tasks.md 3.4/4.1/5.5): the Stream Deck plugin gets its
   * current focus render sweep; any other (application) connection gets its initial
   * `slot_capacity`, plus an immediate re-render if it is already the focused connection
   * (design.md D3/D5.5 - re-registration while focused is the only content-update
   * mechanism, so it must trigger the same immediate re-render `capability_update` used
   * to).
   */
  handleRegistered(connection: ConnectionRecord): void {
    if (connection.pluginType === STREAM_DECK_PLUGIN_TYPE) {
      this.sendSweepTo(connection, this.focusTracker.current);
      return;
    }

    this.sendSlotCapacity(connection);
    if (this.focusTracker.current === connection.id) {
      this.rerenderFocusedConnection(connection.id);
    }
  }

  handleFocus(connection: ConnectionRecord, payload: FocusPayload): void {
    const event = this.focusTracker.reportFocus(connection.id, Boolean(payload?.focused));
    if (!event) {
      return;
    }
    this.broadcastForFocusChange(event.focusedConnectionId);
    if (event.focusedConnectionId) {
      const focusedConnection = this.manager.get(event.focusedConnectionId);
      if (focusedConnection) {
        this.sendSlotCapacity(focusedConnection);
      }
    }
  }

  /** Called via `ConnectionManager.onDisconnect` (tasks.md 2.4), wired in `index.ts`. */
  handleDisconnect(connectionId: string): void {
    const event = this.focusTracker.clearIfFocused(connectionId, "disconnect");
    if (!event) {
      return;
    }
    this.broadcastForFocusChange(event.focusedConnectionId);
  }

  /**
   * Handles a `device_capacity` report (design.md D1, tasks.md 3.4, amended v1.8 for
   * QA-021): accepted only from the Stream Deck plugin's own connection; the latest
   * report fully replaces the previous one (never merged, never persisted). Every
   * accepted report - whether this is the first one ever received (capacity
   * transitioning from unknown to known) or a later one (the device itself changed,
   * per the Stream Deck plugin's own `device_capacity` sending rule) - broadcasts a
   * fresh `slot_capacity` to every currently-connected application plugin, not just
   * whichever connection happens to register or gain focus next.
   */
  handleDeviceCapacity(connection: ConnectionRecord, payload: DeviceCapacityPayload): void {
    if (connection.pluginType !== STREAM_DECK_PLUGIN_TYPE) {
      this.logger.warn(
        {
          event: "device_capacity_rejected",
          connectionId: connection.id,
          pluginType: connection.pluginType,
        },
        "ignoring device_capacity from a connection that did not register as pluginType 'stream-deck'",
      );
      return;
    }

    this.latestCapacity = {
      buttonPositions: Array.isArray(payload?.buttonPositions) ? [...payload.buttonPositions] : [],
      dialPositions: Array.isArray(payload?.dialPositions) ? [...payload.dialPositions] : [],
    };
    this.logger.info(
      {
        event: "device_capacity_updated",
        connectionId: connection.id,
        buttonSlots: this.latestCapacity.buttonPositions.length,
        dialSlots: this.latestCapacity.dialPositions.length,
      },
      "stream deck plugin reported device capacity",
    );
    this.broadcastSlotCapacity();
  }

  /**
   * Sends a fresh `slot_capacity` to every currently-connected application plugin
   * (design.md D2, amended v1.8 for QA-021) - every authenticated connection with a
   * `pluginType` other than the Stream Deck plugin's own. Called whenever
   * `device_capacity` is accepted, covering both "capacity just became known for the
   * first time" and "the device itself changed" (the Stream Deck plugin only ever
   * re-sends `device_capacity` on a genuine device change, so every accepted report
   * here already represents one of those two cases).
   */
  private broadcastSlotCapacity(): void {
    for (const connection of this.manager.list()) {
      if (
        connection.state === "authenticated" &&
        connection.pluginType !== undefined &&
        connection.pluginType !== STREAM_DECK_PLUGIN_TYPE
      ) {
        this.sendSlotCapacity(connection);
      }
    }
  }

  /**
   * Resolves an `input_event` (design.md D6, amended v1.7 for QA-020): maps its
   * reported physical position to its fixed label via the latest `device_capacity`
   * report for the matching controller type (`buttonPositions[i]` -> `"B" + (i+1)`,
   * `dialPositions[i]` -> `"D" + (i+1)`), then checks whether the focused connection's
   * own declared `content` map has an entry for that label. Safely logs and drops at
   * every unresolvable step - no connection focused, position not in the latest
   * capacity report, or the focused connection's content has no entry for that label
   * (underflow) - never errors or crashes (profile-routing spec).
   */
  handleInputEvent(connection: ConnectionRecord, payload: InputEventPayload): void {
    const focusedId = this.focusTracker.current;
    if (!focusedId) {
      this.logger.info(
        {
          event: "input_event_ignored",
          reason: "no_focused_connection",
          fromConnectionId: connection.id,
          controller: payload?.controller,
          position: payload?.position,
        },
        "ignoring input_event: no connection is focused",
      );
      return;
    }

    const focusedConnection = this.manager.get(focusedId);
    if (!focusedConnection) {
      // The focused connection was cleared/disconnected between the tracker reporting
      // it as current and this lookup - a narrow race, not an error (profile-routing
      // spec: "SHALL NOT error or crash" when unresolvable).
      this.logger.info(
        {
          event: "input_event_ignored",
          reason: "focused_connection_missing",
          focusedConnectionId: focusedId,
        },
        "ignoring input_event: focused connection is no longer tracked",
      );
      return;
    }

    const positions = this.positionsFor(payload.controller);
    const index = positions.findIndex((position) => samePosition(position, payload.position));
    if (index === -1) {
      this.logger.info(
        {
          event: "input_event_ignored",
          reason: "position_not_in_device_capacity",
          focusedConnectionId: focusedId,
          controller: payload.controller,
          position: payload.position,
        },
        "ignoring input_event: reported position is not part of the current device capacity",
      );
      return;
    }

    const label = this.labelFor(payload.controller, index);
    const content = focusedConnection.content ?? {};
    if (!content[label]) {
      this.logger.info(
        {
          event: "input_event_ignored",
          reason: "no_content_at_label",
          focusedConnectionId: focusedId,
          label,
        },
        "ignoring input_event: focused connection has no declared content at this label",
      );
      return;
    }

    const commandPayload: CommandPayload = {
      label,
      eventType: payload.eventType,
      delta: payload.delta,
    };
    sendMessage(focusedConnection, this.logger, {
      type: "command",
      connectionId: focusedConnection.id,
      payload: commandPayload,
    });
  }

  private positionsFor(controller: Controller): Position[] {
    if (!this.latestCapacity) {
      return [];
    }
    return controller === "keypad"
      ? this.latestCapacity.buttonPositions
      : this.latestCapacity.dialPositions;
  }

  /**
   * Derives a physical position's fixed label from its controller type and 0-based
   * index within the latest `device_capacity` report (design.md D1/D6, amended v1.7 for
   * QA-020): `"B" + (index + 1)` for a button, `"D" + (index + 1)` for a dial. The
   * inverse of `slotContentValidation.ts`'s `parseLabel`.
   */
  private labelFor(controller: Controller, index: number): string {
    return (controller === "keypad" ? "B" : "D") + (index + 1);
  }

  /**
   * Returns the current button/dial slot counts, per `ProtocolRouter.getSlotCapacity`
   * (amended v1.8 for QA-021): `null` for both if no `device_capacity` report has ever
   * been received - never `0`, which would mean a genuinely known-empty device.
   */
  getSlotCapacity(): SlotCapacityPayload {
    if (!this.latestCapacity) {
      return { buttonSlots: null, dialSlots: null };
    }
    return {
      buttonSlots: this.latestCapacity.buttonPositions.length,
      dialSlots: this.latestCapacity.dialPositions.length,
    };
  }

  private sendSlotCapacity(connection: ConnectionRecord): void {
    sendMessage(connection, this.logger, {
      type: "slot_capacity",
      connectionId: connection.id,
      payload: this.getSlotCapacity(),
    });
  }

  private rerenderFocusedConnection(focusedConnectionId: string): void {
    const streamDeckConnection = this.findStreamDeckConnection();
    if (!streamDeckConnection) {
      return;
    }
    this.sendBoundContentSweep(streamDeckConnection, focusedConnectionId);
  }

  private broadcastForFocusChange(focusedConnectionId: string | null): void {
    const streamDeckConnection = this.findStreamDeckConnection();
    if (!streamDeckConnection) {
      // No display connected right now (or it's mid-reconnect) - nothing to render to;
      // `handleRegistered` sends the current sweep once it (re)connects.
      return;
    }
    this.sendSweepTo(streamDeckConnection, focusedConnectionId);
  }

  private sendSweepTo(
    streamDeckConnection: ConnectionRecord,
    focusedConnectionId: string | null,
  ): void {
    if (focusedConnectionId) {
      this.sendBoundContentSweep(streamDeckConnection, focusedConnectionId);
    } else {
      this.sendIdleSweep(streamDeckConnection);
    }
  }

  /**
   * Renders the focused connection's declared content (design.md D6, amended v1.7 for
   * QA-020): for each physical position, derives its fixed label and looks it up
   * directly in the focused connection's `content` map. Any physical position whose
   * label is absent from that map is swept to the idle appearance - mirroring the old
   * array-underflow idle sweep, just driven by map-key presence instead of array length.
   */
  private sendBoundContentSweep(
    streamDeckConnection: ConnectionRecord,
    focusedConnectionId: string,
  ): void {
    const focusedConnection = this.manager.get(focusedConnectionId);
    const content = focusedConnection?.content ?? {};
    this.sendContentSweepForController(streamDeckConnection, "keypad", content);
    this.sendContentSweepForController(streamDeckConnection, "encoder", content);
  }

  private sendContentSweepForController(
    streamDeckConnection: ConnectionRecord,
    controller: Controller,
    content: RegisterContent,
  ): void {
    const positions = this.positionsFor(controller);
    positions.forEach((position, index) => {
      const label = this.labelFor(controller, index);
      const entry = content[label];
      const payload: RenderUpdatePayload = entry
        ? {
            controller,
            position,
            // This sweep is always a full, authoritative statement of "what does this
            // position look like right now" - never a partial delta - so an unset
            // `entry.icon` must be asserted as an explicit `null` (reset to manifest
            // default), not omitted (QA-010's original reasoning, carried forward).
            icon: entry.icon ?? null,
            label: entry.label,
            state: entry.state,
          }
        : { controller, position, icon: null, label: IDLE_LABEL, state: 0 };
      this.sendRenderUpdate(streamDeckConnection, payload);
    });
  }

  private sendIdleSweep(streamDeckConnection: ConnectionRecord): void {
    for (const controller of ["keypad", "encoder"] as const) {
      for (const position of this.positionsFor(controller)) {
        // design.md D4 (amended): explicitly reset `icon` to `null` rather than
        // omitting it - an omitted field means "unchanged" (sparse-update semantics),
        // so an idle sweep that never mentions `icon` would leave a previously-focused
        // connection's icon visually stuck after focus clears.
        const payload: RenderUpdatePayload = {
          controller,
          position,
          icon: null,
          label: IDLE_LABEL,
          state: 0,
        };
        this.sendRenderUpdate(streamDeckConnection, payload);
      }
    }
  }

  private sendRenderUpdate(
    streamDeckConnection: ConnectionRecord,
    payload: RenderUpdatePayload,
  ): void {
    sendMessage(streamDeckConnection, this.logger, {
      type: "render_update",
      connectionId: streamDeckConnection.id,
      payload,
    });
  }

  private findStreamDeckConnection(): ConnectionRecord | undefined {
    return this.manager
      .list()
      .find((c) => c.pluginType === STREAM_DECK_PLUGIN_TYPE && c.state === "authenticated");
  }
}
