import type { Controller, Position } from "../protocol/messages.js";

/** One addressable controller/position pair a layout covers. */
export interface PositionRef {
  controller: Controller;
  position: Position;
}

/**
 * Resolves what capability *id* (if any) is bound to a given controller/position for a
 * connection's currently-active layout (profile-routing capability; design.md D3, AD-6/
 * AD-8: Gatoway core owns the position -> capability mapping, not the app plugins).
 *
 * design.md D3: this change proves the routing/resolution interface and logic using an
 * in-code test fixture (`testFixtureLayoutResolver.ts`) - not real persistence. Step 6
 * (ARCHITECTURE.md's delivery sequence) replaces the fixture with a config-file-backed
 * implementation behind this same interface, so nothing that depends on `LayoutResolver`
 * needs to change when that happens.
 *
 * **Amended (design.md D3):** `resolve()` originally returned a full `Capability`
 * object baked into the layout fixture itself, which meant a `capability_update` (D7)
 * could never actually change what renders - the fixture's embedded copy was static and
 * disconnected from anything an app actually registered or later updated. `resolve()`
 * now answers only *which capability id* occupies a position - a binding, still a
 * layout/persistence concern. The *live* `Capability` object (reflecting any
 * `capability_update` changes) is a connection-management concern instead, looked up
 * separately from the connection's own declared capabilities (see
 * `routing/capabilityLookup.ts`).
 */
export interface LayoutResolver {
  /** The capability id bound at `controller`/`position` for `connectionId`, or `null` if unbound. */
  resolve(connectionId: string, controller: Controller, position: Position): string | null;
  /**
   * Every controller/position pair this layout addresses. Used to paint a connection's
   * full bound layout when it gains focus, and to sweep the built-in idle appearance
   * across the whole layout when focus clears (tasks.md 3.4/3.5).
   */
  allPositions(): PositionRef[];
}
