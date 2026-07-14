import type { ConnectionRecord } from "../connection/types.js";
import type { Capability } from "../protocol/messages.js";

/**
 * Finds a capability by id within a connection's own declared capability list
 * (design.md D3/D7, task-group-7 addendum). This is the live, up-to-date source of
 * truth for a capability's display data - `LayoutResolver` only ever answers *which
 * capability id* is bound to a position; the actual `Capability` object (including any
 * `capability_update` changes applied since registration) always comes from here,
 * never from the layout binding itself.
 *
 * Returns `undefined` when there's nothing to find: no connection, no capability id, or
 * the connection simply never declared a capability under that id. Callers treat this
 * exactly like an unresolved layout binding - log and no-op, never throw or crash
 * (profile-routing spec: "Input Events Are Safely Ignored When Unresolvable" and
 * "Update ignored for an undeclared capability id").
 */
export function findCapability(
  connection: ConnectionRecord | undefined,
  capabilityId: string | null | undefined,
): Capability | undefined {
  if (!connection || !capabilityId) {
    return undefined;
  }
  return connection.capabilities?.find((capability) => capability.id === capabilityId);
}
