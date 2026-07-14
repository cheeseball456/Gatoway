import type { LayoutResolver, PositionRef } from "./layoutResolver.js";
import type { LayoutStore } from "./layoutStore.js";
import { samePosition } from "./position.js";

/**
 * Builds the real, `LayoutStore`-backed `LayoutResolver` (persisted-layout-config
 * design.md D1/D2/D3), replacing `testFixtureLayoutResolver.ts`'s in-code fixture behind
 * the exact same `LayoutResolver` interface. `resolve()` looks bindings up by plugin
 * type (design.md D1); `allPositions()` delegates directly to `LayoutStore.allPositions()`,
 * which already unions across every configured profile (design.md D3).
 */
export function createLayoutResolver(store: LayoutStore): LayoutResolver {
  return {
    resolve(pluginType, controller, position) {
      if (!pluginType) {
        return null;
      }
      const binding = store
        .getProfile(pluginType)
        .find((b) => b.controller === controller && samePosition(b.position, position));
      return binding ? binding.capabilityId : null;
    },
    allPositions(): PositionRef[] {
      return store.allPositions();
    },
  };
}
