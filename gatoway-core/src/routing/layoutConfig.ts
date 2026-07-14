import type { Controller, Position } from "../protocol/messages.js";

/**
 * On-disk schema for the layout config file (persisted-layout-config design.md D2):
 * one JSON file, profiles keyed by plugin type (e.g. `"lightroom"`, `"xdesign"`) - the
 * stable identity across reconnects (design.md D1) - each holding the list of
 * controller/position -> capability id bindings for that plugin type.
 *
 * ```jsonc
 * {
 *   "profiles": {
 *     "lightroom": {
 *       "bindings": [
 *         { "controller": "keypad", "position": { "row": 0, "column": 0 }, "capabilityId": "next-photo" },
 *         { "controller": "encoder", "position": { "index": 0 }, "capabilityId": "exposure" }
 *       ]
 *     }
 *   }
 * }
 * ```
 */
export interface LayoutBinding {
  controller: Controller;
  position: Position;
  capabilityId: string;
}

export interface LayoutProfileConfig {
  bindings: LayoutBinding[];
}

export interface LayoutConfigFile {
  profiles: Record<string, LayoutProfileConfig>;
}

export type LayoutConfigValidationResult =
  | { ok: true; config: LayoutConfigFile }
  | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidPosition(controller: unknown, position: unknown): position is Position {
  if (!isPlainObject(position)) {
    return false;
  }
  if (controller === "keypad") {
    return typeof position.row === "number" && typeof position.column === "number";
  }
  if (controller === "encoder") {
    return typeof position.index === "number";
  }
  return false;
}

function validateBinding(binding: unknown, path: string): string | null {
  if (!isPlainObject(binding)) {
    return `${path} is not an object`;
  }
  if (binding.controller !== "keypad" && binding.controller !== "encoder") {
    return `${path}.controller must be "keypad" or "encoder"`;
  }
  if (!isValidPosition(binding.controller, binding.position)) {
    return `${path}.position does not match its controller's expected shape`;
  }
  if (typeof binding.capabilityId !== "string" || binding.capabilityId.length === 0) {
    return `${path}.capabilityId must be a non-empty string`;
  }
  return null;
}

/**
 * Validates and narrows an arbitrary parsed JSON value against the layout config schema
 * (tasks.md 1.2/2.4). Never throws - a shape mismatch anywhere returns a descriptive
 * failure reason instead, so `LayoutStore.load()` can log it and fail safe (design.md
 * D4) rather than crash Gatoway core.
 */
export function validateLayoutConfig(value: unknown): LayoutConfigValidationResult {
  if (!isPlainObject(value)) {
    return { ok: false, reason: "root value is not an object" };
  }
  if (!isPlainObject(value.profiles)) {
    return { ok: false, reason: '"profiles" must be an object' };
  }

  const profiles: Record<string, LayoutProfileConfig> = {};
  for (const [pluginType, profile] of Object.entries(value.profiles)) {
    if (!isPlainObject(profile) || !Array.isArray(profile.bindings)) {
      return { ok: false, reason: `profiles.${pluginType} must be an object with a "bindings" array` };
    }
    for (const [index, binding] of profile.bindings.entries()) {
      const error = validateBinding(binding, `profiles.${pluginType}.bindings[${index}]`);
      if (error) {
        return { ok: false, reason: error };
      }
    }
    profiles[pluginType] = { bindings: profile.bindings as LayoutBinding[] };
  }

  return { ok: true, config: { profiles } };
}
