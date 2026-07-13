import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startGatowayCore, type GatowayCoreHandle } from "@gatoway/core";
import { CoreClient } from "../../src/coreClient/coreClient.js";
import type { PluginLogger } from "../../src/logging/pluginLogger.js";

// tasks.md 5.2: exercises CoreClient's real connect/register/retry logic (real TCP
// socket, real token file read) against a real, running Gatoway core instance —
// started here in-process purely as the test's server-side harness. Production
// spawning of Gatoway core still always happens out-of-process via
// CoreProcessSupervisor (design.md D2/AD-1); this test only needs a live listener to
// talk to, which `startGatowayCore()` (a supported, exported entry point) provides
// without needing a built `dist/` on disk.

function silentLogger(): PluginLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met before timeout");
}

describe("CoreClient (integration, against a real Gatoway core instance)", () => {
  let core: GatowayCoreHandle | undefined;
  let client: CoreClient | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    client?.stop();
    client = undefined;
    await core?.close();
    core = undefined;
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("registers successfully with the real register/register_ack handshake and treats itself as connected", async () => {
    dir = await mkdtemp(join(tmpdir(), "core client integration test-"));
    const tokenFilePath = join(dir, "auth-token");
    const tcpPort = await findFreePort();
    const wsPort = await findFreePort();

    core = await startGatowayCore({
      config: {
        tcpPort,
        wsPort,
        tokenFilePath,
        allowedOrigins: [],
        logFilePath: join(dir, "gatoway-core.log"),
        logMaxSizeBytes: 1024 * 1024,
        logMaxFiles: 1,
        logLevel: "silent",
      },
    });

    client = new CoreClient({ port: tcpPort, tokenFilePath, logger: silentLogger() });
    client.start();

    await waitFor(() => client?.currentState === "connected", 5_000);
    expect(client.currentState).toBe("connected");
  });

  it("is rejected with an invalid token, then succeeds once the real (current) token is read after retrying", async () => {
    dir = await mkdtemp(join(tmpdir(), "core client integration test-"));
    const tokenFilePath = join(dir, "auth-token");
    const tcpPort = await findFreePort();
    const wsPort = await findFreePort();

    core = await startGatowayCore({
      config: {
        tcpPort,
        wsPort,
        tokenFilePath,
        allowedOrigins: [],
        logFilePath: join(dir, "gatoway-core.log"),
        logMaxSizeBytes: 1024 * 1024,
        logMaxFiles: 1,
        logLevel: "silent",
      },
    });

    // Simulate a stale/incorrect token on the very first read; the real token file is
    // already in place by the second attempt, so the client's backoff retry succeeds.
    let readCount = 0;
    client = new CoreClient({
      port: tcpPort,
      tokenFilePath,
      logger: silentLogger(),
      readToken: async (path) => {
        readCount += 1;
        if (readCount === 1) {
          return "definitely-not-the-real-token";
        }
        return readFile(path, "utf8");
      },
      scheduleReconnect: (_delayMs, fn) => {
        // Fire immediately rather than waiting out the real backoff delay in a test.
        setImmediate(fn);
        return () => undefined;
      },
    });
    client.start();

    await waitFor(() => client?.currentState === "connected", 5_000);
    expect(client.currentState).toBe("connected");
    expect(readCount).toBeGreaterThanOrEqual(2);
  });
});
