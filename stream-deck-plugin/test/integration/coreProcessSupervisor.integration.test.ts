import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreProcessSupervisor } from "../../src/coreLifecycle/coreProcessSupervisor.js";
import type { PluginLogger } from "../../src/logging/pluginLogger.js";

// tasks.md 5.1: exercises the real spawn/supervise/restart path against a genuine OS
// child process (design.md D2/AD-1's crash isolation is only meaningful if the child is
// really a separate process) — following the same approach as
// gatoway-core-foundation's cliEntrypoint.test.ts, which spawns a real process rather
// than only asserting against mocks.

function silentLogger(): PluginLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met before timeout");
}

describe("CoreProcessSupervisor (integration, real child process)", () => {
  let dir: string | undefined;
  let supervisor: CoreProcessSupervisor | undefined;

  afterEach(async () => {
    supervisor?.stop();
    supervisor = undefined;
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("spawns a real child process and restarts it (with backoff) after it exits unexpectedly", async () => {
    dir = await mkdtemp(join(tmpdir(), "core process supervisor test-"));
    const markerPath = join(dir, "runs.log");
    // A tiny standalone script: records that it ran, then exits immediately, simulating
    // an unexpected crash on every launch.
    const scriptPath = join(dir, "fake-core.mjs");
    await writeFile(
      scriptPath,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(markerPath)}, "run\\n");\nprocess.exit(1);\n`,
    );

    supervisor = new CoreProcessSupervisor({
      logger: silentLogger(),
      locateEntryPoint: () => scriptPath,
      backoffMs: () => 50,
    });

    supervisor.start();

    await waitFor(async () => {
      const content = await readFile(markerPath, "utf8").catch(() => "");
      return content.split("\n").filter(Boolean).length >= 2;
    }, 10_000);

    const content = await readFile(markerPath, "utf8");
    expect(content.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it("does not restart a real child process after an intentional stop()", async () => {
    dir = await mkdtemp(join(tmpdir(), "core process supervisor test-"));
    const markerPath = join(dir, "runs.log");
    const scriptPath = join(dir, "fake-core.mjs");
    // Stays alive until killed, so we can deterministically stop() it ourselves.
    await writeFile(
      scriptPath,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(markerPath)}, "run\\n");\nsetInterval(() => {}, 1000);\n`,
    );

    supervisor = new CoreProcessSupervisor({
      logger: silentLogger(),
      locateEntryPoint: () => scriptPath,
      backoffMs: () => 50,
    });

    supervisor.start();
    await waitFor(async () => (await readFile(markerPath, "utf8").catch(() => "")).length > 0, 5_000);

    supervisor.stop();
    // Give any (incorrect) restart a chance to happen, then confirm it didn't.
    await new Promise((r) => setTimeout(r, 300));

    const content = await readFile(markerPath, "utf8");
    expect(content.split("\n").filter(Boolean).length).toBe(1);
  }, 15_000);
});
