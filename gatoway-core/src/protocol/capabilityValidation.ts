import type { Capability, CapabilityUpdatePayload } from "./messages.js";

/**
 * Validates capability-shaped data at the two points a plugin author's own bug could
 * otherwise be silently accepted (proposal.md "What Changes", design.md D1/D4):
 * `register`'s `capabilities` array and `capability_update`'s `icon`/`label`/`state`
 * fields. Mirrors `routing/layoutConfig.ts`'s `validateLayoutConfig()` style - never
 * throws, returns a descriptive failure reason instead - rather than inventing a
 * different validation idiom (design.md D4).
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type CapabilityValidationResult =
  | { ok: true; capability: Capability }
  | { ok: false; reason: string };

/**
 * Validates a single `register`-time capability entry against the documented
 * `Capability` shape (design.md D1): `id`/`label` non-empty strings, `type` exactly
 * `"button"` or `"dial"`, `description`/`icon` a string if present, `state` a number if
 * present. Register-time capabilities don't use `render_update`/`capability_update`'s
 * `null`-reset semantics for `icon` - only a string is accepted here, matching
 * `Capability`'s own declared type.
 */
export function validateCapability(value: unknown): CapabilityValidationResult {
  if (!isPlainObject(value)) {
    return { ok: false, reason: "capability is not an object" };
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    return { ok: false, reason: '"id" must be a non-empty string' };
  }
  if (typeof value.label !== "string" || value.label.length === 0) {
    return { ok: false, reason: '"label" must be a non-empty string' };
  }
  if (value.type !== "button" && value.type !== "dial") {
    return { ok: false, reason: '"type" must be exactly "button" or "dial"' };
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    return { ok: false, reason: '"description" must be a string if present' };
  }
  if (value.icon !== undefined && typeof value.icon !== "string") {
    return { ok: false, reason: '"icon" must be a string if present' };
  }
  if (value.state !== undefined && typeof value.state !== "number") {
    return { ok: false, reason: '"state" must be a number if present' };
  }

  const capability: Capability = { id: value.id, label: value.label, type: value.type };
  if (value.description !== undefined) capability.description = value.description as string;
  if (value.icon !== undefined) capability.icon = value.icon as string;
  if (value.state !== undefined) capability.state = value.state as number;
  return { ok: true, capability };
}

/** A single field-level rejection, either `ok: false` (invalid) or absent from the payload entirely. */
type FieldValidation<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface CapabilityUpdateFieldValidation {
  icon?: FieldValidation<string | null>;
  label?: FieldValidation<string>;
  state?: FieldValidation<number>;
}

/**
 * Validates each field present in a `capability_update` payload independently
 * (design.md D1/D2): `icon` a string or `null` if present (matching its existing
 * three-way "unchanged"/reset/set semantics), `label` a string if present, `state` a
 * number if present. A field absent from the payload has no entry in the result at all
 * - the caller applies exactly the fields present with `ok: true`, and reports exactly
 * the fields present with `ok: false`, leaving any field omitted from the payload
 * (and therefore from this result) untouched, same as today.
 */
export function validateCapabilityUpdateFields(
  payload: CapabilityUpdatePayload,
): CapabilityUpdateFieldValidation {
  const result: CapabilityUpdateFieldValidation = {};

  if (payload.icon !== undefined) {
    if (payload.icon === null || typeof payload.icon === "string") {
      result.icon = { ok: true, value: payload.icon };
    } else {
      result.icon = { ok: false, reason: '"icon" must be a string or null' };
    }
  }
  if (payload.label !== undefined) {
    if (typeof payload.label === "string") {
      result.label = { ok: true, value: payload.label };
    } else {
      result.label = { ok: false, reason: '"label" must be a string' };
    }
  }
  if (payload.state !== undefined) {
    if (typeof payload.state === "number") {
      result.state = { ok: true, value: payload.state };
    } else {
      result.state = { ok: false, reason: '"state" must be a number' };
    }
  }

  return result;
}
