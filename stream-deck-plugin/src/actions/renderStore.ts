/**
 * Tracks the most recently rendered content for every position `render_update`
 * messages have addressed (stream-deck-idle-display spec: "Displayed Content Persists
 * Across Gatoway Core Disconnects"). A plain module-level-friendly class with no
 * dependency on Gatoway core's connection state at all - that's the point: content
 * here is never cleared by anything in this package, so it simply survives
 * disconnects/restarts by construction, and is re-applied whenever an action next
 * appears (`onWillAppear`) regardless of connection state at that moment.
 */
import type { Controller, Position, RenderUpdatePayload } from "@gatoway/core";
import { positionsMatch } from "./protocolPositions.js";

/** The merged (sparse-update-applied) render state last known for one position. */
export interface RenderState {
  icon?: string;
  label?: string;
  state?: number;
}

interface Entry {
  controller: Controller;
  position: Position;
  state: RenderState;
}

export class RenderStore {
  private readonly entries: Entry[] = [];

  /**
   * Merges a `render_update` into whatever was previously known for that position
   * (fields it omits leave the existing value in place - message-protocol spec's
   * "Render Update Message Type": "an update only sets what is changing") and returns
   * the resulting merged state.
   */
  apply(payload: RenderUpdatePayload): RenderState {
    const existing = this.findEntry(payload.controller, payload.position);
    const next: RenderState = {
      icon: payload.icon ?? existing?.state.icon,
      label: payload.label ?? existing?.state.label,
      state: payload.state ?? existing?.state.state,
    };
    if (existing) {
      existing.state = next;
    } else {
      this.entries.push({ controller: payload.controller, position: payload.position, state: next });
    }
    return next;
  }

  /** The last known render state for a position, or `undefined` if never rendered. */
  get(controller: Controller, position: Position): RenderState | undefined {
    return this.findEntry(controller, position)?.state;
  }

  private findEntry(controller: Controller, position: Position): Entry | undefined {
    return this.entries.find(
      (entry) => entry.controller === controller && positionsMatch(entry.position, position),
    );
  }
}
