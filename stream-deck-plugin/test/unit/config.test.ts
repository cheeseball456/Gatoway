import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCoreChildEnv, resolvePluginCoreConfig } from "../../src/coreLifecycle/config.js";
import type { PluginLogger } from "../../src/logging/pluginLogger.js";

function fakeLogger(): PluginLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("resolvePluginCoreConfig", () => {
  it("falls back to gatoway-core's own default TCP port when unset", () => {
    const config = resolvePluginCoreConfig({});
    expect(config.tcpPort).toBe(47821);
  });

  it("honors GATOWAY_TCP_PORT and GATOWAY_TOKEN_FILE overrides", () => {
    const config = resolvePluginCoreConfig({
      GATOWAY_TCP_PORT: "54321",
      GATOWAY_TOKEN_FILE: "/tmp/some path/token",
    });
    expect(config.tcpPort).toBe(54321);
    expect(config.tokenFilePath).toBe("/tmp/some path/token");
  });

  it("ignores a non-numeric GATOWAY_TCP_PORT and falls back to the default", () => {
    const config = resolvePluginCoreConfig({ GATOWAY_TCP_PORT: "not-a-number" });
    expect(config.tcpPort).toBe(47821);
  });

  describe("allowedOrigins", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "gatoway-plugin-core-config-"));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("resolves origins from GATOWAY_ALLOWED_ORIGINS_FILE when it points to a valid config file", async () => {
      const filePath = join(dir, "allowed-origins.json");
      await writeFile(filePath, JSON.stringify({ allowedOrigins: ["moz-extension://*"] }), "utf8");
      const logger = fakeLogger();

      const config = resolvePluginCoreConfig({ GATOWAY_ALLOWED_ORIGINS_FILE: filePath }, logger);

      expect(config.allowedOrigins).toEqual(["moz-extension://*"]);
      expect(logger.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ event: "allowed_origins_config_loaded" }),
      );
    });

    it("falls back to an empty allowlist when GATOWAY_ALLOWED_ORIGINS_FILE points to a missing file", () => {
      const logger = fakeLogger();

      const config = resolvePluginCoreConfig(
        { GATOWAY_ALLOWED_ORIGINS_FILE: join(dir, "does-not-exist.json") },
        logger,
      );

      expect(config.allowedOrigins).toEqual([]);
      expect(logger.info).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ event: "allowed_origins_config_missing" }),
      );
    });

    it("works without a logger argument, defaulting to a no-op", () => {
      expect(() =>
        resolvePluginCoreConfig({ GATOWAY_ALLOWED_ORIGINS_FILE: join(dir, "does-not-exist.json") }),
      ).not.toThrow();
    });
  });
});

describe("buildCoreChildEnv", () => {
  it("passes the resolved port/token path through as GATOWAY_* env vars, preserving the rest of the base env", () => {
    const env = buildCoreChildEnv(
      { tcpPort: 12345, tokenFilePath: "/fake/token", allowedOrigins: [] },
      { SOME_OTHER_VAR: "kept" },
    );
    expect(env.GATOWAY_TCP_PORT).toBe("12345");
    expect(env.GATOWAY_TOKEN_FILE).toBe("/fake/token");
    expect(env.SOME_OTHER_VAR).toBe("kept");
  });

  it("sets GATOWAY_ALLOWED_ORIGINS to a comma-joined list when origins are present", () => {
    const env = buildCoreChildEnv(
      { tcpPort: 12345, tokenFilePath: "/fake/token", allowedOrigins: ["moz-extension://*", "chrome-extension://abc"] },
      {},
    );
    expect(env.GATOWAY_ALLOWED_ORIGINS).toBe("moz-extension://*,chrome-extension://abc");
  });

  it("omits GATOWAY_ALLOWED_ORIGINS entirely (not an empty string) when origins are empty", () => {
    const env = buildCoreChildEnv({ tcpPort: 12345, tokenFilePath: "/fake/token", allowedOrigins: [] }, {});
    expect("GATOWAY_ALLOWED_ORIGINS" in env).toBe(false);
  });

  it("deletes an inherited GATOWAY_ALLOWED_ORIGINS from the base env when origins are empty", () => {
    const env = buildCoreChildEnv(
      { tcpPort: 12345, tokenFilePath: "/fake/token", allowedOrigins: [] },
      { GATOWAY_ALLOWED_ORIGINS: "chrome-extension://leaked" },
    );
    expect("GATOWAY_ALLOWED_ORIGINS" in env).toBe(false);
  });
});
