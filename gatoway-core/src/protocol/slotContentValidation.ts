import type { Controller, SlotContent } from "./messages.js";

/**
 * Validates `SlotContent`-shaped data at `register` time (extension-provided-slot-
 * content design.md D3/D4): `content.buttons`/`content.dials` entries. Mirrors the
 * project's established validator style (never throws; returns a descriptive failure
 * reason instead of a boolean) - see the now-removed `capabilityValidation.ts` this
 * replaces.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type SlotContentValidationResult =
  | { ok: true; content: SlotContent }
  | { ok: false; reason: string };

/**
 * Validates a single `register`-time content entry against the `SlotContent` shape
 * (design.md D4): `label` a non-empty string (required); `icon` a string if present (no
 * `null` at registration - matching the old `Capability.icon` rule); `state` a number if
 * present, and only valid on a `content.buttons` entry - a `content.dials` entry
 * carrying `state` is itself a validation failure, since dials have no state concept
 * (matching `render_update`'s existing keys-only rule).
 *
 * `controller` tells the validator which array this entry came from (`"keypad"` for
 * `content.buttons`, `"encoder"` for `content.dials`) so it can enforce the
 * dials-never-have-state rule.
 */
export function validateSlotContent(
  value: unknown,
  controller: Controller,
): SlotContentValidationResult {
  if (!isPlainObject(value)) {
    return { ok: false, reason: "content entry is not an object" };
  }
  if (typeof value.label !== "string" || value.label.length === 0) {
    return { ok: false, reason: '"label" must be a non-empty string' };
  }
  if (value.icon !== undefined && typeof value.icon !== "string") {
    return { ok: false, reason: '"icon" must be a string if present' };
  }
  if (value.state !== undefined) {
    if (controller === "encoder") {
      return { ok: false, reason: '"state" is not valid on a dial (content.dials) entry' };
    }
    if (typeof value.state !== "number") {
      return { ok: false, reason: '"state" must be a number if present' };
    }
  }

  const content: SlotContent = { label: value.label };
  if (value.icon !== undefined) content.icon = value.icon as string;
  if (value.state !== undefined) content.state = value.state as number;
  return { ok: true, content };
}
