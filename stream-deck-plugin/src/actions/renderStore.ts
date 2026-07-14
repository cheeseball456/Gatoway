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

/**
 * The merged (sparse-update-applied) render state last known for one position.
 *
 * `icon` distinguishes three states, mirroring `RenderUpdatePayload`'s own semantics
 * (message-protocol spec's "Render Update Message Type", amended): `undefined` means no
 * `render_update` has ever set an icon for this position (nothing to apply - the
 * manifest's own default simply stands, untouched); `null` means a `render_update`
 * explicitly reset the icon back to that manifest default; a `string` is a specific
 * icon to display. Renderers must apply `null` and a `string` differently despite both
 * being "defined" - see `genericKeyRenderer.ts`/`genericDialRenderer.ts`.
 */
export interface RenderState {
  icon?: string | null;
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
   *
   * `icon` needs its own merge rule (amended): only an *omitted* `icon`
   * (`undefined`) means "leave unchanged" - `null` is a distinct, deliberate value
   * ("reset to manifest default") that must be stored and later applied as such, not
   * treated the same as omission. A plain `??` would incorrectly collapse `null` into
   * "unchanged" (both are "nullish"), so `icon` is merged with an explicit
   * `undefined`-only check instead of `label`/`state`'s simpler `??`.
   */
  apply(payload: RenderUpdatePayload): RenderState {
    const existing = this.findEntry(payload.controller, payload.position);
    const next: RenderState = {
      icon: payload.icon === undefined ? existing?.state.icon : payload.icon,
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
