import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadAllowedOrigins,
  resolveAllowedOriginsFilePath,
  validateAllowedOriginsConfig,
} from "../../src/coreLifecycle/allowedOriginsConfig.js";
import type { PluginLogger } from "../../src/logging/pluginLogger.js";

function fakeLogger(): PluginLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("validateAllowedOriginsConfig", () => {
  it("accepts a valid config with one origin", () => {
    const result = validateAllowedOriginsConfig({ allowedOrigins: ["moz-extension://*"] });
    expect(result).toEqual({ ok: true, config: { allowedOrigins: ["moz-extension://*"] } });
  });

  it("accepts a valid config with multiple origins", () => {
    const result = validateAllowedOriginsConfig({
      allowedOrigins: ["moz-extension://*", "chrome-extension://abc123"],
    });
    expect(result).toEqual({
      ok: true,
      config: { allowedOrigins: ["moz-extension://*", "chrome-extension://abc123"] },
    });
  });

  it("accepts a valid config with an empty allowedOrigins array", () => {
    const result = validateAllowedOriginsConfig({ allowedOrigins: [] });
    expect(result).toEqual({ ok: true, config: { allowedOrigins: [] } });
  });

  it("rejects a non-object root value", () => {
    const result = validateAllowedOriginsConfig(["moz-extension://*"]);
    expect(result.ok).toBe(false);
  });

  it("rejects a config where allowedOrigins is not an array", () => {
    const result = validateAllowedOriginsConfig({ allowedOrigins: "moz-extension://*" });
    expect(result).toEqual({ ok: false, reason: '"allowedOrigins" must be an array' });
  });

  it("rejects a config with a non-string entry", () => {
    const result = validateAllowedOriginsConfig({ allowedOrigins: ["moz-extension://*", 123] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("allowedOrigins[1]");
    }
  });

  it("rejects a config with an empty-string entry", () => {
    const result = validateAllowedOriginsConfig({ allowedOrigins: [""] });
    expect(result.ok).toBe(false);
  });
});

describe("resolveAllowedOriginsFilePath", () => {
  it("defaults to <configDir>/allowed-origins.json when unset", () => {
    expect(resolveAllowedOriginsFilePath({}, "/fake/config/dir")).toBe(
      join("/fake/config/dir", "allowed-origins.json"),
    );
  });

  it("honors a GATOWAY_ALLOWED_ORIGINS_FILE override", () => {
    expect(
      resolveAllowedOriginsFilePath({ GATOWAY_ALLOWED_ORIGINS_FILE: "/some path/origins.json" }, "/fake/config/dir"),
    ).toBe("/some path/origins.json");
  });
});

describe("loadAllowedOrigins", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gatoway-allowed-origins-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function filePath(): string {
    return join(dir, "allowed-origins.json");
  }

  it("loads a valid config file with one origin", async () => {
    await writeFile(filePath(), JSON.stringify({ allowedOrigins: ["moz-extension://*"] }), "utf8");
    const logger = fakeLogger();

    const origins = loadAllowedOrigins(filePath(), logger);

    expect(origins).toEqual(["moz-extension://*"]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "allowed_origins_config_loaded", originCount: 1 }),
    );
  });

  it("loads a valid config file with multiple origins", async () => {
    await writeFile(
      filePath(),
      JSON.stringify({ allowedOrigins: ["moz-extension://*", "chrome-extension://abc123"] }),
      "utf8",
    );
    const logger = fakeLogger();

    const origins = loadAllowedOrigins(filePath(), logger);

    expect(origins).toEqual(["moz-extension://*", "chrome-extension://abc123"]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "allowed_origins_config_loaded", originCount: 2 }),
    );
  });

  it("falls back to an empty allowlist and logs when no file exists", () => {
    const logger = fakeLogger();

    const origins = loadAllowedOrigins(join(dir, "does-not-exist.json"), logger);

    expect(origins).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("no allowed-origins config file found"),
      expect.objectContaining({ event: "allowed_origins_config_missing" }),
    );
  });

  it("falls back to an empty allowlist and logs an error when the file contains invalid JSON", async () => {
    await writeFile(filePath(), "{ not valid json", "utf8");
    const logger = fakeLogger();

    const origins = loadAllowedOrigins(filePath(), logger);

    expect(origins).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "allowed_origins_config_invalid_json" }),
    );
  });

  it("falls back to an empty allowlist and logs an error when allowedOrigins is not an array", async () => {
    await writeFile(filePath(), JSON.stringify({ allowedOrigins: "not-an-array" }), "utf8");
    const logger = fakeLogger();

    const origins = loadAllowedOrigins(filePath(), logger);

    expect(origins).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "allowed_origins_config_invalid_shape" }),
    );
  });

  it("falls back to an empty allowlist and logs an error when an entry is not a string", async () => {
    await writeFile(filePath(), JSON.stringify({ allowedOrigins: ["moz-extension://*", 42] }), "utf8");
    const logger = fakeLogger();

    const origins = loadAllowedOrigins(filePath(), logger);

    expect(origins).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "allowed_origins_config_invalid_shape" }),
    );
  });
});
