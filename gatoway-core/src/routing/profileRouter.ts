import type { ConnectionManager } from "../connection/connectionManager.js";
import { sendMessage } from "../connection/messageHandler.js";
import type { ProtocolRouter } from "../connection/protocolRouter.js";
import type { ConnectionRecord } from "../connection/types.js";
import type { FocusTracker } from "../focus/focusTracker.js";
import type { Logger } from "../logging/logger.js";
import type {
  CapabilityUpdatePayload,
  CommandPayload,
  FocusPayload,
  InputEventPayload,
  RenderUpdatePayload,
} from "../protocol/messages.js";
import { findCapability } from "./capabilityLookup.js";
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
 * Implements the `profile-routing` capability (design.md D3/D4/D7): resolves incoming
 * `input_event`s against the currently-focused connection's bound capability, keeps the
 * Stream Deck plugin's display in sync with focus changes - the focused connection's
 * bound layout, or the built-in idle appearance when nothing is focused - and applies
 * live `capability_update`s a connection pushes for its own already-declared
 * capabilities, immediately re-rendering when the update affects what's on screen.
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

    const capabilityId = this.layoutResolver.resolve(focusedId, payload.controller, payload.position);
    if (!capabilityId) {
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

    // design.md D3 (amended): the layout only binds a capability *id* to this position
    // - the live capability itself must actually be among the focused connection's own
    // declared capabilities. A stale/unknown id here is treated exactly like an
    // unresolved binding, never a crash (profile-routing spec).
    const capability = findCapability(focusedConnection, capabilityId);
    if (!capability) {
      this.logger.info(
        {
          event: "input_event_ignored",
          reason: "bound_capability_undeclared",
          focusedConnectionId: focusedId,
          capabilityId,
          controller: payload.controller,
          position: payload.position,
        },
        "ignoring input_event: focused connection has not declared the capability bound at this position",
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

  /**
   * Handles an incoming `capability_update` (design.md D7, task-group-7 addendum): a
   * connection pushing a live display change to one of its own already-declared
   * capabilities. Looks the target capability up within the *sender's own* connection
   * record only - an app can never update another connection's capabilities - sparse-
   * merges whatever fields were provided into the stored record, and, if the sender is
   * currently focused and the capability is bound to a position, immediately re-renders
   * that position rather than waiting for the next `input_event` or focus change.
   */
  handleCapabilityUpdate(connection: ConnectionRecord, payload: CapabilityUpdatePayload): void {
    const capabilityId = payload?.capabilityId;
    const capability = findCapability(connection, capabilityId);
    if (!capability) {
      this.logger.info(
        {
          event: "capability_update_ignored",
          reason: "undeclared_capability",
          connectionId: connection.id,
          capabilityId,
        },
        "ignoring capability_update: capability id is not among this connection's own declared capabilities",
      );
      return;
    }

    if (payload.icon !== undefined) {
      // `null` is an explicit reset to "no icon" on the stored record (mirrors
      // render_update's manifest-default-reset semantics); omitted means unchanged.
      capability.icon = payload.icon === null ? undefined : payload.icon;
    }
    if (payload.label !== undefined) {
      capability.label = payload.label;
    }
    if (payload.state !== undefined) {
      capability.state = payload.state;
    }

    this.logger.info(
      { event: "capability_updated", connectionId: connection.id, capabilityId },
      "applied live capability_update to stored capability record",
    );

    if (this.focusTracker.current !== connection.id) {
      // Stored, but this connection's layout isn't currently displayed (profile-routing
      // spec: "Update while not focused produces no render").
      return;
    }

    const streamDeckConnection = this.findStreamDeckConnection();
    if (!streamDeckConnection) {
      return;
    }

    for (const { controller, position } of this.layoutResolver.allPositions()) {
      const boundCapabilityId = this.layoutResolver.resolve(connection.id, controller, position);
      if (boundCapabilityId !== capabilityId) {
        continue;
      }
      this.sendRenderUpdate(streamDeckConnection, {
        controller,
        position,
        icon: capability.icon,
        label: capability.label,
        state: capability.state,
      });
    }
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
    const focusedConnection = this.manager.get(focusedConnectionId);
    for (const { controller, position } of this.layoutResolver.allPositions()) {
      const capabilityId = this.layoutResolver.resolve(focusedConnectionId, controller, position);
      if (!capabilityId) {
        continue;
      }
      // design.md D3 (amended): render the *live* capability from the connection's own
      // declared capabilities, not a static snapshot embedded in the layout resolver -
      // this is what actually makes capability_update (D7) able to change what renders.
      const capability = findCapability(focusedConnection, capabilityId);
      if (!capability) {
        this.logger.info(
          {
            event: "bound_capability_undeclared",
            focusedConnectionId,
            capabilityId,
            controller,
            position,
          },
          "layout resolver bound a capability id the focused connection has not declared; skipping render for this position",
        );
        continue;
      }
      const payload: RenderUpdatePayload = {
        controller,
        position,
        icon: capability.icon,
        label: capability.label,
        state: capability.state,
      };
      this.sendRenderUpdate(streamDeckConnection, payload);
    }
  }

  private sendIdleSweep(streamDeckConnection: ConnectionRecord): void {
    for (const { controller, position } of this.layoutResolver.allPositions()) {
      // design.md D4 (amended): explicitly reset `icon` to `null` rather than omitting
      // it - an omitted field means "unchanged" (sparse-update semantics), so an idle
      // sweep that never mentions `icon` would leave a previously-focused connection's
      // capability icon visually stuck after focus clears.
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
