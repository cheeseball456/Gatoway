import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("applies defaults when no environment variables are set", () => {
    const config = loadConfig({});
    expect(config.tcpPort).toBe(47821);
    expect(config.wsPort).toBe(47822);
    expect(config.allowedOrigins).toEqual([]);
    expect(config.logMaxFiles).toBe(5);
    expect(config.logMaxSizeBytes).toBe(10 * 1024 * 1024);
  });

  it("honors GATOWAY_* overrides", () => {
    const config = loadConfig({
      GATOWAY_TCP_PORT: "9001",
      GATOWAY_WS_PORT: "9002",
      GATOWAY_TOKEN_FILE: "/tmp/token",
      GATOWAY_LAYOUT_FILE: "/tmp/layout.json",
      GATOWAY_ALLOWED_ORIGINS: "chrome-extension://a, chrome-extension://b",
      GATOWAY_LOG_FILE: "/tmp/log.ndjson",
      GATOWAY_LOG_MAX_SIZE_BYTES: "2048",
      GATOWAY_LOG_MAX_FILES: "2",
      GATOWAY_LOG_LEVEL: "debug",
    });

    expect(config.tcpPort).toBe(9001);
    expect(config.wsPort).toBe(9002);
    expect(config.tokenFilePath).toBe("/tmp/token");
    expect(config.layoutFilePath).toBe("/tmp/layout.json");
    expect(config.allowedOrigins).toEqual(["chrome-extension://a", "chrome-extension://b"]);
    expect(config.logFilePath).toBe("/tmp/log.ndjson");
    expect(config.logMaxSizeBytes).toBe(2048);
    expect(config.logMaxFiles).toBe(2);
    expect(config.logLevel).toBe("debug");
  });

  it("defaults layoutFilePath alongside the auth token file in the same config directory", () => {
    const config = loadConfig({});
    expect(config.layoutFilePath.endsWith("layout.json")).toBe(true);
  });

  it("falls back to defaults for invalid numeric overrides", () => {
    const config = loadConfig({ GATOWAY_TCP_PORT: "not-a-number" });
    expect(config.tcpPort).toBe(47821);
  });
});
