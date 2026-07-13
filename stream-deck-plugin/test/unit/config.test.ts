import { describe, expect, it } from "vitest";
import { buildCoreChildEnv, resolvePluginCoreConfig } from "../../src/coreLifecycle/config.js";

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
});

describe("buildCoreChildEnv", () => {
  it("passes the resolved port/token path through as GATOWAY_* env vars, preserving the rest of the base env", () => {
    const env = buildCoreChildEnv(
      { tcpPort: 12345, tokenFilePath: "/fake/token" },
      { SOME_OTHER_VAR: "kept" },
    );
    expect(env.GATOWAY_TCP_PORT).toBe("12345");
    expect(env.GATOWAY_TOKEN_FILE).toBe("/fake/token");
    expect(env.SOME_OTHER_VAR).toBe("kept");
  });
});
