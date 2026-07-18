import { readFileSync } from "node:fs";
import path from "node:path";
import type { PluginLogger } from "../logging/pluginLogger.js";

/**
 * On-disk schema for the allowed-origins config file (plugin-allowed-origins-config
 * design.md D1/D3): a small, dedicated local JSON file - separate from `layout.json`,
 * which is specifically about position-to-capability bindings, not connection
 * authentication - declaring the WebSocket `Origin` values this plugin should allow
 * when it spawns its Gatoway core child.
 *
 * ```jsonc
 * {
 *   "allowedOrigins": ["moz-extension://*", "chrome-extension://<published-id>"]
 * }
 * ```
 *
 * Each entry is validated only as a non-empty string here (design.md D3) - the
 * exact-match-vs-trailing-wildcard rule is `gatoway-core`'s own concern
 * (`parseAllowlist`/`isOriginAllowed`), enforced downstream once this list is forwarded
 * to the spawned child as `GATOWAY_ALLOWED_ORIGINS`, not re-validated here.
 */
export interface AllowedOriginsConfigFile {
  allowedOrigins: string[];
}

export type AllowedOriginsValidationResult =
  | { ok: true; config: AllowedOriginsConfigFile }
  | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates and narrows an arbitrary parsed JSON value against the allowed-origins
 * config schema (tasks.md 1.2). Never throws - a shape mismatch anywhere returns a
 * descriptive failure reason instead, so `loadAllowedOrigins` can log it and fail safe
 * (design.md D4) rather than block the plugin from spawning Gatoway core.
 */
export function validateAllowedOriginsConfig(value: unknown): AllowedOriginsValidationResult {
  if (!isPlainObject(value)) {
    return { ok: false, reason: "root value is not an object" };
  }
  if (!Array.isArray(value.allowedOrigins)) {
    return { ok: false, reason: '"allowedOrigins" must be an array' };
  }
  for (const [index, origin] of value.allowedOrigins.entries()) {
    if (typeof origin !== "string" || origin.length === 0) {
      return { ok: false, reason: `allowedOrigins[${index}] must be a non-empty string` };
    }
  }
  return { ok: true, config: { allowedOrigins: value.allowedOrigins as string[] } };
}

/**
 * Resolves the path to the allowed-origins config file: an explicit
 * `GATOWAY_ALLOWED_ORIGINS_FILE` override (matching `GATOWAY_TOKEN_FILE`'s existing
 * override pattern, tasks.md 1.3), or `<configDir>/allowed-origins.json` by default.
 */
export function resolveAllowedOriginsFilePath(env: NodeJS.ProcessEnv, configDir: string): string {
  return env.GATOWAY_ALLOWED_ORIGINS_FILE ?? path.join(configDir, "allowed-origins.json");
}

/**
 * Reads and parses the allowed-origins config file at `filePath`, read once at plugin
 * startup (no hot-reload, design.md Non-Goals). Missing file, invalid JSON, and
 * valid-JSON-wrong-shape all fail safe to an empty allowlist with a clear log message
 * (design.md D4, tasks.md 1.4) - a four-case log pattern (missing / invalid JSON /
 * invalid shape / loaded successfully) this project uses for its local config files -
 * never thrown past this function.
 */
export function loadAllowedOrigins(filePath: string, logger: PluginLogger): string[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      logger.info(
        `no allowed-origins config file found at ${filePath}; spawning Gatoway core with an empty Origin allowlist (every WebSocket-based plugin connection will be rejected until this is configured). See stream-deck-plugin/README.md for the expected schema.`,
        { event: "allowed_origins_config_missing", path: filePath },
      );
    } else {
      logger.error(
        "failed to read the allowed-origins config file; falling back to an empty Origin allowlist",
        { event: "allowed_origins_config_read_failed", path: filePath, error: (err as Error).message },
      );
    }
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error(
      "allowed-origins config file contains invalid JSON; falling back to an empty Origin allowlist",
      { event: "allowed_origins_config_invalid_json", path: filePath, error: (err as Error).message },
    );
    return [];
  }

  const validation = validateAllowedOriginsConfig(parsed);
  if (!validation.ok) {
    logger.error(
      'allowed-origins config file does not match the expected { "allowedOrigins": string[] } shape; falling back to an empty Origin allowlist',
      { event: "allowed_origins_config_invalid_shape", path: filePath, reason: validation.reason },
    );
    return [];
  }

  logger.info("loaded allowed-origins config", {
    event: "allowed_origins_config_loaded",
    path: filePath,
    originCount: validation.config.allowedOrigins.length,
  });
  return validation.config.allowedOrigins;
}
