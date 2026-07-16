import type { Controller, SlotCapacityPayload, SlotContent } from "./messages.js";

/**
 * Validates `RegisterContent` map entries at `register` time (extension-provided-slot-
 * content design.md D3/D4, amended v1.7 for QA-020, further amended v1.8 for
 * QA-021/QA-022): each entry is keyed by a fixed position label (`"B1"`, `"D1"`, ...),
 * not an ordinal array index. Mirrors the project's established validator style (never
 * throws; returns a descriptive failure reason instead of a boolean) - see the
 * now-removed `capabilityValidation.ts` this originally replaced.
 */

/**
 * Canonical form only (QA-022 fix): exactly `B` or `D`, followed by a positive integer
 * with no leading zeros and no other characters. `[1-9]\d*` deliberately excludes
 * `"0"` itself (ordinals are 1-based) and any leading-zero form like `"B01"` - both of
 * which the original v1.7 pattern (`\d+`) wrongly accepted, even though the resolver
 * (`profileRouter.ts`'s `labelFor`) never derives anything but the canonical form, so a
 * non-canonical key could pass validation yet never actually be resolved.
 */
const LABEL_PATTERN = /^([BD])([1-9]\d*)$/;

export interface ParsedLabel {
  controller: Controller;
  /** 1-based ordinal within the label's own controller type, e.g. 3 for `"B3"`. */
  ordinal: number;
}

/**
 * Parses a fixed position label into its controller type and 1-based ordinal (design.md
 * D1/D3's labeling convention: a `B`/`D` prefix plus a 1-based ordinal). Returns `null`
 * for anything that doesn't match that convention at all (wrong prefix, non-numeric or
 * non-positive ordinal, extra characters, etc.) - the caller reports that as a rejection
 * reason, since Gatoway core recognizes no other label shape.
 */
export function parseLabel(label: string): ParsedLabel | null {
  const match = LABEL_PATTERN.exec(label);
  if (!match) {
    return null;
  }
  const ordinal = Number(match[2]);
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    return null;
  }
  return { controller: match[1] === "B" ? "keypad" : "encoder", ordinal };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type SlotContentValidationResult =
  | { ok: true; content: SlotContent }
  | { ok: false; reason: string };

/**
 * Validates a single `register`-time `content` map entry against both its key and its
 * value (design.md D4, amended v1.7, further amended v1.8 for QA-021/QA-022):
 *
 * - **Key** (`label`): must match the canonical labeling convention (`parseLabel`) -
 *   regardless of whether capacity is currently known (QA-022: a non-canonical form
 *   like `"B01"` is rejected unconditionally, since it could never be resolved
 *   anyway). Once the key is confirmed canonical, its range is checked against the
 *   most recently reported device capacity (`B<n>` only valid for
 *   `1 <= n <= capacity.buttonSlots`, `D<n>` only valid for
 *   `1 <= n <= capacity.dialSlots`) - **but only while that capacity dimension is
 *   actually known** (QA-021): while `buttonSlots`/`dialSlots` is still `null`
 *   (unknown), range checking is skipped entirely for that dimension, and a
 *   canonically-formed key is accepted provisionally (design.md D9: it may or may not
 *   turn out to be in range once capacity becomes known - it is never retroactively
 *   re-validated). An unrecognized or (when known) out-of-range label is itself a
 *   rejection reason, not just its value - this was new in v1.7 (QA-020): under v1.6's
 *   ordinal-index model there was no key to validate, since content was addressed by
 *   array position alone.
 * - **Value**: `label` (the value's own field - distinct from the map key of the same
 *   name, see `SlotContent`'s own doc comment) a non-empty string (required); `icon` a
 *   string if present (no `null` at registration); `state` a number if present, and
 *   only valid under a `B`-prefixed key (present under a `D`-prefixed key is itself a
 *   rejection, mirroring `render_update`'s existing keys-only `state` rule).
 */
export function validateSlotContentEntry(
  label: string,
  value: unknown,
  capacity: SlotCapacityPayload,
): SlotContentValidationResult {
  const parsed = parseLabel(label);
  if (!parsed) {
    return {
      ok: false,
      reason: `"${label}" is not a valid position label (expected "B<n>" or "D<n>", no leading zeros)`,
    };
  }

  const slots = parsed.controller === "keypad" ? capacity.buttonSlots : capacity.dialSlots;
  // `slots === null` means this dimension's capacity is not yet known (QA-021): skip
  // range checking entirely rather than treating "unknown" as if it were a known `0`,
  // which would permanently reject every label until the Stream Deck plugin reports
  // capacity - a canonically-formed key is accepted provisionally instead (design.md D9).
  if (slots !== null && parsed.ordinal > slots) {
    const kind = parsed.controller === "keypad" ? "button" : "dial";
    return {
      ok: false,
      reason: `"${label}" is out of range for the current device capacity (${slots} ${kind} slot(s))`,
    };
  }

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
    if (parsed.controller === "encoder") {
      return { ok: false, reason: '"state" is not valid on a dial (D-prefixed) entry' };
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
