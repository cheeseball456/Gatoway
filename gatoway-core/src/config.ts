import os from "node:os";
import path from "node:path";

/** Runtime configuration for a single `startGatowayCore()` invocation. */
export interface GatowayCoreConfig {
  /** Port the TCP listener binds to on 127.0.0.1 (IPv4 loopback only, AD-4 v1.1). */
  tcpPort: number;
  /** Port the WebSocket listener binds to on 127.0.0.1 (IPv4 loopback only, AD-4 v1.1). */
  wsPort: number;
  /** Path to the auth token file (design.md's "Trade-off" note; overridable per Open Questions). */
  tokenFilePath: string;
  /**
   * Path to the layout config file (persisted-layout-config design.md D2): per-plugin-
   * type position-to-capability bindings, hand-authored JSON. Defaults alongside the
   * auth token file in the same per-OS config directory; overridable via
   * `GATOWAY_LAYOUT_FILE`, matching `GATOWAY_TOKEN_FILE`'s existing pattern.
   */
  layoutFilePath: string;
  /** Allowlisted WebSocket Origin values (design.md D5). Empty by default: fail closed. */
  allowedOrigins: readonly string[];
  /** Absolute path (including filename) of the active rotating log file. */
  logFilePath: string;
  /** Log rotation size threshold, in bytes. */
  logMaxSizeBytes: number;
  /** Number of rotated log files retained in addition to the active file. */
  logMaxFiles: number;
  /** Minimum log level passed to the logger. */
  logLevel: string;
}

const DEFAULT_TCP_PORT = 47821;
const DEFAULT_WS_PORT = 47822;
const DEFAULT_LOG_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB, per design.md D6
const DEFAULT_LOG_MAX_FILES = 5; // per design.md D6

/**
 * The per-OS user config directory Gatoway core uses by default for the auth token
 * file and the layout config file, absent an explicit override (design.md's
 * Trade-off note; persisted-layout-config design.md D2). Follows each platform's
 * conventional location; created on first run if missing.
 */
function defaultConfigDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "gatoway");
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "gatoway");
    default:
      return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "gatoway");
  }
}

/** The per-OS user log directory Gatoway core uses by default, absent an override. */
function defaultLogDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Logs", "gatoway");
    case "win32":
      return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "gatoway", "logs");
    default:
      return path.join(process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "gatoway", "logs");
  }
}

function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolves Gatoway core's runtime configuration from environment variables, falling
 * back to per-OS defaults. All GATOWAY_* variables are optional; documented here as
 * the single source of truth for the overrides this change introduces (design.md's
 * Open Questions recommends the token path be overridable for automated testing).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatowayCoreConfig {
  const configDir = env.GATOWAY_CONFIG_DIR ?? defaultConfigDir();
  const logDir = env.GATOWAY_LOG_DIR ?? defaultLogDir();

  return {
    tcpPort: parseIntEnv(env.GATOWAY_TCP_PORT, DEFAULT_TCP_PORT),
    wsPort: parseIntEnv(env.GATOWAY_WS_PORT, DEFAULT_WS_PORT),
    tokenFilePath: env.GATOWAY_TOKEN_FILE ?? path.join(configDir, "auth-token"),
    layoutFilePath: env.GATOWAY_LAYOUT_FILE ?? path.join(configDir, "layout.json"),
    allowedOrigins: parseAllowlist(env.GATOWAY_ALLOWED_ORIGINS),
    logFilePath: env.GATOWAY_LOG_FILE ?? path.join(logDir, "gatoway-core.log"),
    logMaxSizeBytes: parseIntEnv(env.GATOWAY_LOG_MAX_SIZE_BYTES, DEFAULT_LOG_MAX_SIZE_BYTES),
    logMaxFiles: parseIntEnv(env.GATOWAY_LOG_MAX_FILES, DEFAULT_LOG_MAX_FILES),
    logLevel: env.GATOWAY_LOG_LEVEL ?? "info",
  };
}
