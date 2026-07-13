import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger, type Logger } from "../../src/logging/logger.js";

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition not met before timeout");
}

describe("logger rotation (integration)", () => {
  let dir: string;
  let logger: Logger | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gatoway-log-test-"));
  });

  afterEach(async () => {
    logger = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("rotates the log file once the size threshold is exceeded, bounded by the retention limit", async () => {
    const logFilePath = join(dir, "gatoway-core.log");
    logger = createLogger({
      logFilePath,
      maxSizeBytes: 512, // forces rotation almost immediately (tasks.md 6.5)
      maxFiles: 2,
      level: "info",
    });

    const padding = "x".repeat(200);
    for (let i = 0; i < 200; i += 1) {
      logger.info({ event: "test_fill", i, padding }, "filling the log to force rotation");
    }

    await waitFor(async () => {
      const files = await readdir(dir);
      return files.length > 1;
    }, 10_000);

    await waitFor(async () => {
      const files = await readdir(dir);
      // maxFiles rotated files + 1 active file.
      return files.length <= 3;
    }, 10_000);

    const files = await readdir(dir);
    expect(files.length).toBeGreaterThan(1);
    expect(files.length).toBeLessThanOrEqual(3);
  }, 20_000);
});
