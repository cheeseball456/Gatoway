import os from "node:os";
import path from "node:path";

/**
 * The Stream Deck plugin's view of how to reach the Gatoway core instance it spawns
 * itself (design.md D2). The plugin is the one launching Gatoway core, so it owns these
 * values and passes them to the child process via the `GATOWAY_*` environment variables
 * gatoway-core's own `loadConfig` already understands (see gatoway-core/src/config.ts) —
 * this avoids any ambiguity or duplicated defaulting logic for figuring out *which*
 * running instance's port/token file a freshly-spawned core actually used.
 */
export interface PluginCoreConfig {
  /** TCP port Gatoway core's listener will bind to, and this plugin will connect to. */
  tcpPort: number;
  /** Path to the auth token file Gatoway core will write, and this plugin will read. */
  tokenFilePath: string;
}

const DEFAULT_TCP_PORT = 47821; // matches gatoway-core/src/config.ts's own default

/**
 * The per-OS user config directory used for the token file by default, absent an
 * override. Mirrors gatoway-core's own default location (gatoway-core/src/config.ts)
 * so a manually-started standalone `gatoway-core` and this plugin agree on the token
 * file's location without any explicit override in the common case — this plugin
 * still always sets `GATOWAY_TOKEN_FILE` explicitly for the child it spawns, so this
 * matters only for consistency/least-surprise, not correctness.
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

/**
 * Resolves the port/token-file pair this plugin will use for the Gatoway core instance
 * it spawns, from environment overrides (primarily for tests) or per-OS defaults.
 */
export function resolvePluginCoreConfig(env: NodeJS.ProcessEnv = process.env): PluginCoreConfig {
  return {
    tcpPort: parsePort(env.GATOWAY_TCP_PORT) ?? DEFAULT_TCP_PORT,
    tokenFilePath: env.GATOWAY_TOKEN_FILE ?? path.join(defaultConfigDir(), "auth-token"),
  };
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Builds the environment for the spawned Gatoway core child process, so it binds to
 * exactly the port and writes to exactly the token file this plugin will use to
 * connect (design.md D2/D3).
 */
export function buildCoreChildEnv(
  config: PluginCoreConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    GATOWAY_TCP_PORT: String(config.tcpPort),
    GATOWAY_TOKEN_FILE: config.tokenFilePath,
  };
}
