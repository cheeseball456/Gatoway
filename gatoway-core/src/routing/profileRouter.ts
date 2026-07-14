import type { ConnectionManager } from "../connection/connectionManager.js";
import { sendMessage } from "../connection/messageHandler.js";
import type { ProtocolRouter } from "../connection/protocolRouter.js";
import type { ConnectionRecord } from "../connection/types.js";
import type { FocusTracker } from "../focus/focusTracker.js";
import type { Logger } from "../logging/logger.js";
import type {
  CommandPayload,
  FocusPayload,
  InputEventPayload,
  RenderUpdatePayload,
} from "../protocol/messages.js";
import type { LayoutResolver } from "./layoutResolver.js";

/**
 * The plugin type the Stream Deck plugin declares at registration (matches
 * `stream-deck-plugin/src/coreClient/coreClient.ts`'s `PLUGIN_TYPE`). Only this
 * connection ever receives `render_update` messages (design.md D4/D5, AD-8): it is the
 * one physical display Gatoway core drives.
 */
export const STREAM_DECK_PLUGIN_TYPE = "stream-deck";

/** The built-in idle appearance's label (design.md D4: matches the old static Idle key's title). */
const IDLE_LABEL = "Gatoway";

export interface ProfileRouterOptions {
  manager: ConnectionManager;
  focusTracker: FocusTracker;
  layoutResolver: LayoutResolver;
  logger: Logger;
}

/**
 * Implements the `profile-routing` capability (design.md D3/D4): resolves incoming
 * `input_event`s against the currently-focused connection's bound capability, and keeps
 * the Stream Deck plugin's display in sync with focus changes - the focused
 * connection's bound layout, or the built-in idle appearance when nothing is focused.
 */
export class ProfileRouter implements ProtocolRouter {
  private readonly manager: ConnectionManager;
  private readonly focusTracker: FocusTracker;
  private readonly layoutResolver: LayoutResolver;
  private readonly logger: Logger;

  constructor(options: ProfileRouterOptions) {
    this.manager = options.manager;
    this.focusTracker = options.focusTracker;
    this.layoutResolver = options.layoutResolver;
    this.logger = options.logger;
  }

  /**
   * Sends the current focus state's render sweep to a newly-(re)registered connection,
   * if it's the Stream Deck display connection (tasks.md 3.4/3.5's initial case: the
   * display connects while focus is still at its default of "none").
   */
  handleRegistered(connection: ConnectionRecord): void {
    if (connection.pluginType !== STREAM_DECK_PLUGIN_TYPE) {
      return;
    }
    this.sendSweepTo(connection, this.focusTracker.current);
  }

  handleFocus(connection: ConnectionRecord, payload: FocusPayload): void {
    const event = this.focusTracker.reportFocus(connection.id, Boolean(payload?.focused));
    if (!event) {
      return;
    }
    this.broadcastForFocusChange(event.focusedConnectionId);
  }

  /** Called via `ConnectionManager.onDisconnect` (tasks.md 2.4), wired in `index.ts`. */
  handleDisconnect(connectionId: string): void {
    const event = this.focusTracker.clearIfFocused(connectionId, "disconnect");
    if (!event) {
      return;
    }
    this.broadcastForFocusChange(event.focusedConnectionId);
  }

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

    const capability = this.layoutResolver.resolve(focusedId, payload.controller, payload.position);
    if (!capability) {
      this.logger.info(
        {
          event: "input_event_ignored",
          reason: "no_binding",
          focusedConnectionId: focusedId,
          controller: payload.controller,
          position: payload.position,
        },
        "ignoring input_event: focused connection has no capability bound at this position",
      );
      return;
    }

    const commandPayload: CommandPayload = {
      capabilityId: capability.id,
      eventType: payload.eventType,
      delta: payload.delta,
    };
    sendMessage(focusedConnection, this.logger, {
      type: "command",
      connectionId: focusedConnection.id,
      payload: commandPayload,
    });
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
      this.sendBoundLayoutSweep(streamDeckConnection, focusedConnectionId);
    } else {
      this.sendIdleSweep(streamDeckConnection);
    }
  }

  private sendBoundLayoutSweep(
    streamDeckConnection: ConnectionRecord,
    focusedConnectionId: string,
  ): void {
    for (const { controller, position } of this.layoutResolver.allPositions()) {
      const capability = this.layoutResolver.resolve(focusedConnectionId, controller, position);
      if (!capability) {
        continue;
      }
      const payload: RenderUpdatePayload = {
        controller,
        position,
        icon: capability.icon,
        label: capability.label,
      };
      this.sendRenderUpdate(streamDeckConnection, payload);
    }
  }

  private sendIdleSweep(streamDeckConnection: ConnectionRecord): void {
    for (const { controller, position } of this.layoutResolver.allPositions()) {
      const payload: RenderUpdatePayload = { controller, position, label: IDLE_LABEL, state: 0 };
      this.sendRenderUpdate(streamDeckConnection, payload);
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
