import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "../logging/logger.js";
import type { Controller, Position } from "../protocol/messages.js";
import type { LayoutBinding, LayoutConfigFile } from "./layoutConfig.js";
import { validateLayoutConfig } from "./layoutConfig.js";
import type { PositionRef } from "./layoutResolver.js";
import { samePosition } from "./position.js";

export interface LayoutStoreOptions {
  /** Path to the layout config file (config.ts's `layoutFilePath`, D2). */
  filePath: string;
  logger: Logger;
}

/**
 * Owns the layout config file (persisted-layout-config design.md D5): loads it once at
 * Gatoway core startup, exposes read access backing the config-driven `LayoutResolver`
 * (`configLayoutResolver.ts`), and exposes a write path (`setBinding`/`removeBinding`/
 * `save()`) that nothing in this change calls yet - deliberate, forward-looking API
 * surface for a future no-code mapping UI (proposal.md's "What Changes"), not scope
 * creep to trim.
 *
 * A missing or malformed config file never crashes Gatoway core (design.md D4): `load()`
 * logs a clear message and leaves the in-memory layout empty, matching this codebase's
 * existing resilience posture (e.g. `index.ts`'s token-file write failure).
 */
export class LayoutStore {
  private readonly filePath: string;
  private readonly logger: Logger;
  private profiles = new Map<string, LayoutBinding[]>();

  constructor(options: LayoutStoreOptions) {
    this.filePath = options.filePath;
    this.logger = options.logger;
  }

  /**
   * Reads and parses the config file at `filePath`. Missing file, invalid JSON, and
   * valid-JSON-wrong-shape all fail safe to an empty in-memory layout with a clear log
   * message (design.md D4, tasks.md 2.1-2.4) - never thrown/rejected past this method.
   */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.logger.info(
          { event: "layout_config_missing", path: this.filePath },
          `no layout config file found at ${this.filePath}; starting with an empty layout (every position unbound). See docs/PROTOCOL.md for the expected schema.`,
        );
      } else {
        this.logger.error(
          { event: "layout_config_read_failed", path: this.filePath, error: (err as Error).message },
          "failed to read the layout config file; falling back to an empty layout",
        );
      }
      this.profiles = new Map();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.error(
        { event: "layout_config_invalid_json", path: this.filePath, error: (err as Error).message },
        "layout config file contains invalid JSON; falling back to an empty layout",
      );
      this.profiles = new Map();
      return;
    }

    const validation = validateLayoutConfig(parsed);
    if (!validation.ok) {
      this.logger.error(
        { event: "layout_config_invalid_shape", path: this.filePath, reason: validation.reason },
        "layout config file does not match the expected profiles/bindings shape; falling back to an empty layout",
      );
      this.profiles = new Map();
      return;
    }

    const profiles = new Map<string, LayoutBinding[]>();
    for (const [pluginType, profile] of Object.entries(validation.config.profiles)) {
      profiles.set(pluginType, [...profile.bindings]);
    }
    this.profiles = profiles;
    this.logger.info(
      { event: "layout_config_loaded", path: this.filePath, profileCount: profiles.size },
      "loaded layout config",
    );
  }

  /** This plugin type's configured bindings, or an empty list if it has no profile. */
  getProfile(pluginType: string): readonly LayoutBinding[] {
    return this.profiles.get(pluginType) ?? [];
  }

  /**
   * Every distinct controller/position pair bound in *any* configured profile
   * (design.md D3) - not just one profile's bindings - so the idle sweep can reset every
   * position any profile might have left showing something.
   */
  allPositions(): PositionRef[] {
    const result: PositionRef[] = [];
    for (const bindings of this.profiles.values()) {
      for (const binding of bindings) {
        const alreadyIncluded = result.some(
          (ref) => ref.controller === binding.controller && samePosition(ref.position, binding.position),
        );
        if (!alreadyIncluded) {
          result.push({ controller: binding.controller, position: binding.position });
        }
      }
    }
    return result;
  }

  /**
   * Sets (or replaces) the binding for `pluginType` at `controller`/`position` to
   * `capabilityId`, in memory only - call `save()` to persist. Unused by this change;
   * built as the API surface a future no-code mapping UI needs (design.md D5).
   */
  setBinding(pluginType: string, controller: Controller, position: Position, capabilityId: string): void {
    const bindings = [...(this.profiles.get(pluginType) ?? [])];
    const index = bindings.findIndex(
      (binding) => binding.controller === controller && samePosition(binding.position, position),
    );
    const updated: LayoutBinding = { controller, position, capabilityId };
    if (index >= 0) {
      bindings[index] = updated;
    } else {
      bindings.push(updated);
    }
    this.profiles.set(pluginType, bindings);
  }

  /** Removes the binding (if any) for `pluginType` at `controller`/`position`, in memory only. */
  removeBinding(pluginType: string, controller: Controller, position: Position): void {
    const bindings = this.profiles.get(pluginType);
    if (!bindings) {
      return;
    }
    this.profiles.set(
      pluginType,
      bindings.filter(
        (binding) => !(binding.controller === controller && samePosition(binding.position, position)),
      ),
    );
  }

  /**
   * Persists the current in-memory layout back to the config file, atomically
   * (design.md D5): writes to a temp file in the same directory, then renames it over
   * the target, so a crash mid-write can never leave a corrupted config file.
   *
   * If the `rename()` step fails (e.g. a cross-device rename, a permissions error, or a
   * concurrent lock on the target), the target file is never touched - but the temp file
   * would otherwise be leaked forever (QA-013). On that failure path we best-effort
   * `unlink()` the temp file before re-throwing the original error; a failure to clean up
   * is logged as a secondary warning but never masks (or replaces) the original error the
   * caller needs to see.
   */
  async save(): Promise<void> {
    const config: LayoutConfigFile = { profiles: {} };
    for (const [pluginType, bindings] of this.profiles.entries()) {
      config.profiles[pluginType] = { bindings: [...bindings] };
    }

    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(config, null, 2), "utf8");
    try {
      await rename(tempPath, this.filePath);
    } catch (err) {
      try {
        await unlink(tempPath);
      } catch (cleanupErr) {
        this.logger.warn(
          {
            event: "layout_config_temp_cleanup_failed",
            path: tempPath,
            error: (cleanupErr as Error).message,
          },
          "failed to clean up the temp file left behind by a failed layout config save; it may need manual removal",
        );
      }
      throw err;
    }
  }
}
