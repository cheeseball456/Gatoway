import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { CoreProcessSupervisor } from "../../src/coreLifecycle/coreProcessSupervisor.js";
import type { PluginLogger } from "../../src/logging/pluginLogger.js";

function fakeLogger(): PluginLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A minimal fake child process: an EventEmitter with a `kill` spy and a `pid`. */
function fakeChild(pid = 1234): ChildProcess & EventEmitter {
  const emitter = new EventEmitter() as ChildProcess & EventEmitter;
  (emitter as unknown as { pid: number }).pid = pid;
  (emitter as unknown as { kill: () => boolean }).kill = vi.fn(() => true);
  return emitter;
}

describe("CoreProcessSupervisor", () => {
  it("spawns Gatoway core on start()", () => {
    const logger = fakeLogger();
    const spawnChild = vi.fn(() => fakeChild());
    const supervisor = new CoreProcessSupervisor({
      logger,
      locateEntryPoint: () => "/fake/dist/index.js",
      spawnChild,
    });

    supervisor.start();

    expect(spawnChild).toHaveBeenCalledTimes(1);
    expect(spawnChild).toHaveBeenCalledWith("/fake/dist/index.js", expect.anything());
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("spawned"),
      expect.objectContaining({ event: "gatoway_core_spawned" }),
    );
  });

  it("restarts the child after a backoff delay when it exits unexpectedly", () => {
    const logger = fakeLogger();
    const children = [fakeChild(1), fakeChild(2)];
    const spawnChild = vi.fn(() => children.shift() as ReturnType<typeof fakeChild>);
    let scheduledFn: (() => void) | undefined;
    const scheduleRestart = vi.fn((_delayMs: number, fn: () => void) => {
      scheduledFn = fn;
      return () => {
        scheduledFn = undefined;
      };
    });
    const backoffMs = vi.fn(() => 42);

    const supervisor = new CoreProcessSupervisor({
      logger,
      locateEntryPoint: () => "/fake/dist/index.js",
      spawnChild,
      scheduleRestart,
      backoffMs,
    });

    supervisor.start();
    const firstChild = spawnChild.mock.results[0]?.value as EventEmitter;
    firstChild.emit("exit", 1, null);

    expect(backoffMs).toHaveBeenCalledWith(1);
    expect(scheduleRestart).toHaveBeenCalledWith(42, expect.any(Function));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("restarting"),
      expect.objectContaining({ event: "gatoway_core_restarting", attempt: 1 }),
    );

    // Only after the scheduled backoff fires does the supervisor actually respawn.
    expect(spawnChild).toHaveBeenCalledTimes(1);
    scheduledFn?.();
    expect(spawnChild).toHaveBeenCalledTimes(2);
  });

  it("logs the exit reason (code/signal) when restarting", () => {
    const logger = fakeLogger();
    const supervisor = new CoreProcessSupervisor({
      logger,
      locateEntryPoint: () => "/fake/dist/index.js",
      spawnChild: () => fakeChild(),
      scheduleRestart: () => () => undefined,
    });

    supervisor.start();
    const child = supervisor.currentChild as unknown as EventEmitter;
    child.emit("exit", null, "SIGKILL");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: null, signal: "SIGKILL" }),
    );
  });

  it("does not restart after an intentional stop()", () => {
    const logger = fakeLogger();
    const scheduleRestart = vi.fn();
    const supervisor = new CoreProcessSupervisor({
      logger,
      locateEntryPoint: () => "/fake/dist/index.js",
      spawnChild: () => fakeChild(),
      scheduleRestart,
    });

    supervisor.start();
    const child = supervisor.currentChild as unknown as EventEmitter;
    supervisor.stop();
    child.emit("exit", 0, null);

    expect(scheduleRestart).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("planned shutdown"),
      expect.objectContaining({ event: "gatoway_core_exited_expected" }),
    );
  });

  it("reports a clear, visible error when the entry point cannot be located, instead of failing silently", () => {
    const logger = fakeLogger();
    const spawnChild = vi.fn();
    const supervisor = new CoreProcessSupervisor({
      logger,
      locateEntryPoint: () => {
        throw new Error("Cannot find module '@gatoway/core/dist/index.js'");
      },
      spawnChild,
    });

    supervisor.start();

    expect(spawnChild).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("cannot spawn Gatoway core"),
      expect.objectContaining({ event: "gatoway_core_spawn_failed", reason: "entry_point_not_found" }),
    );
  });

  it("reports a clear, visible error when spawning itself throws", () => {
    const logger = fakeLogger();
    const supervisor = new CoreProcessSupervisor({
      logger,
      locateEntryPoint: () => "/fake/dist/index.js",
      spawnChild: () => {
        throw new Error("ENOENT");
      },
    });

    supervisor.start();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("cannot spawn Gatoway core"),
      expect.objectContaining({ event: "gatoway_core_spawn_failed", reason: "spawn_threw" }),
    );
  });
});
