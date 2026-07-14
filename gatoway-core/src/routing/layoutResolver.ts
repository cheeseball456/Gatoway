import type { Controller, Position } from "../protocol/messages.js";

/** One addressable controller/position pair a layout covers. */
export interface PositionRef {
  controller: Controller;
  position: Position;
}

/**
 * Resolves what capability *id* (if any) is bound to a given controller/position for a
 * plugin type's currently-active layout (profile-routing capability; design.md D3,
 * AD-6/AD-8: Gatoway core owns the position -> capability mapping, not the app plugins).
 *
 * `focus-profile-routing` deliberately proved the routing/resolution interface and logic
 * using an in-code test fixture (`testFixtureLayoutResolver.ts`, since removed) - not
 * real persistence. `persisted-layout-config` replaces it with a config-file-backed
 * implementation (`configLayoutResolver.ts`) behind this same interface.
 *
 * **Amended (persisted-layout-config design.md D1):** `resolve()` now takes the
 * requesting connection's *plugin type* (e.g. `"lightroom"`, `"xdesign"`), not its
 * connection id. A connection id is regenerated every time a plugin reconnects, so it
 * was never a valid key for anything persisted; plugin type is the stable identity
 * `register` already declares, and is what real, file-backed bindings are keyed by
 * (design.md D2).
 *
 * **Amended (design.md D3, prior):** `resolve()` originally returned a full `Capability`
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
  /** The capability id bound at `controller`/`position` for `pluginType`, or `null` if unbound. */
  resolve(pluginType: string, controller: Controller, position: Position): string | null;
  /**
   * Every controller/position pair any configured profile addresses (design.md D3: the
   * union across *all* profiles, not just one). Used to paint a connection's full bound
   * layout when it gains focus, and to sweep the built-in idle appearance across the
   * whole layout when focus clears (tasks.md 3.4/3.5) - the idle sweep must reset every
   * position any profile might have left showing something, not just whichever
   * profile's connection was last focused.
   */
  allPositions(): PositionRef[];
}
