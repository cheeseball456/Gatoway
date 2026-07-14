import type { Capability, Controller, Position } from "../protocol/messages.js";
import type { LayoutResolver, PositionRef } from "./layoutResolver.js";

/**
 * ============================================================================
 * TEMPORARY TEST FIXTURE - NOT REAL PERSISTENCE.
 *
 * design.md D3 / ARCHITECTURE.md's delivery-sequence step 6: this file stands in for
 * the real, config-file-backed layout that step 6 will build. It exists solely to
 * prove `focus-profile-routing`'s routing/resolution interface and logic - both in this
 * package's own automated tests and in manual/live-hardware verification (tasks.md
 * 6.2/6.3/6.5) - without pulling persistence work into this change.
 *
 * Do NOT extend this into real persistence, multi-profile-per-plugin-type modeling, or
 * anything config-driven. Step 6 replaces this whole file with a config-file-backed
 * `LayoutResolver` behind the exact same interface; nothing else should need to change
 * when that happens.
 * ============================================================================
 *
 * The fixture applies the same small, hardcoded layout to *any* currently-connected
 * app connection, regardless of which one is asking (`connectionId` only needs to be
 * a non-empty string) - real per-plugin-type profiles (AD-6) are exactly the
 * persistence-modeling work step 6 owns, not this change's concern. The two keypad
 * positions and one dial index chosen below happen to match real Stream Deck+
 * hardware only so that a developer with a physical device can meaningfully place the
 * generic actions and see the mechanism work end to end (tasks.md 6.5) - that is not
 * itself part of this interface's contract.
 */

interface FixtureBinding {
  controller: Controller;
  position: Position;
  capability: Capability;
}

const FIXTURE_LAYOUT: readonly FixtureBinding[] = [
  {
    controller: "keypad",
    position: { row: 0, column: 0 },
    capability: { id: "test-fixture.button.one", label: "Fixture A", type: "button" },
  },
  {
    controller: "keypad",
    position: { row: 0, column: 1 },
    capability: { id: "test-fixture.button.two", label: "Fixture B", type: "button" },
  },
  {
    controller: "encoder",
    position: { index: 0 },
    capability: { id: "test-fixture.dial.one", label: "Fixture Dial", type: "dial" },
  },
];

function isKeypadPosition(position: Position): position is { row: number; column: number } {
  return "row" in position && "column" in position;
}

function samePosition(a: Position, b: Position): boolean {
  if (isKeypadPosition(a) && isKeypadPosition(b)) {
    return a.row === b.row && a.column === b.column;
  }
  if (!isKeypadPosition(a) && !isKeypadPosition(b)) {
    return a.index === b.index;
  }
  return false;
}

/** Builds the in-code test-fixture `LayoutResolver` described above. */
export function createTestFixtureLayoutResolver(): LayoutResolver {
  return {
    resolve(connectionId, controller, position) {
      if (!connectionId) {
        return null;
      }
      const binding = FIXTURE_LAYOUT.find(
        (b) => b.controller === controller && samePosition(b.position, position),
      );
      return binding ? binding.capability : null;
    },
    allPositions(): PositionRef[] {
      return FIXTURE_LAYOUT.map(({ controller, position }) => ({ controller, position }));
    },
  };
}
