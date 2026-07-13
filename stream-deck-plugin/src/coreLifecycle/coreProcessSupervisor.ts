import { spawn, type ChildProcess } from "node:child_process";
import { nextBackoffDelayMs } from "../backoff.js";
import type { PluginLogger } from "../logging/pluginLogger.js";
import { locateCoreEntryPoint } from "./locateCoreEntryPoint.js";

/** If the child has been up longer than this, the next exit resets the backoff attempt counter. */
const DEFAULT_STABLE_AFTER_MS = 60_000;

export interface CoreProcessSupervisorOptions {
  logger: PluginLogger;
  /** Resolves Gatoway core's built entry point. Defaults to `locateCoreEntryPoint`. */
  locateEntryPoint?: () => string;
  /** Environment variables passed to the spawned child, merged over `process.env`. */
  childEnv?: NodeJS.ProcessEnv;
  /** Overridable for tests: spawns the child process for a resolved entry point path. */
  spawnChild?: (entryPointPath: string, env: NodeJS.ProcessEnv) => ChildProcess;
  /** Overridable for tests: computes the backoff delay before restart attempt N. */
  backoffMs?: (attempt: number) => number;
  /** Overridable for tests: schedules `fn` after `delayMs`, returning a cancel function. */
  scheduleRestart?: (delayMs: number, fn: () => void) => () => void;
  /** See `DEFAULT_STABLE_AFTER_MS`. */
  stableAfterMs?: number;
}

function defaultSpawnChild(entryPointPath: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [entryPointPath], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function defaultScheduleRestart(delayMs: number, fn: () => void): () => void {
  const timer = setTimeout(fn, delayMs);
  return () => clearTimeout(timer);
}

/**
 * Spawns Gatoway core as a genuine OS child process on `start()` and supervises it,
 * restarting it with a backoff delay if it exits unexpectedly (design.md D2,
 * ARCHITECTURE.md AD-1) — a real subprocess, not an in-process call to
 * `startGatowayCore()`, so a Gatoway core crash cannot take the Stream Deck plugin
 * down with it.
 */
export class CoreProcessSupervisor {
  private readonly logger: PluginLogger;
  private readonly locateEntryPoint: () => string;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly spawnChild: (entryPointPath: string, env: NodeJS.ProcessEnv) => ChildProcess;
  private readonly backoffMs: (attempt: number) => number;
  private readonly scheduleRestart: (delayMs: number, fn: () => void) => () => void;
  private readonly stableAfterMs: number;

  private child: ChildProcess | undefined;
  private stopping = false;
  private restartAttempt = 0;
  private spawnedAt = 0;
  private cancelPendingRestart: (() => void) | undefined;

  constructor(options: CoreProcessSupervisorOptions) {
    this.logger = options.logger;
    this.locateEntryPoint = options.locateEntryPoint ?? locateCoreEntryPoint;
    this.childEnv = options.childEnv ?? process.env;
    this.spawnChild = options.spawnChild ?? defaultSpawnChild;
    this.backoffMs = options.backoffMs ?? ((attempt) => nextBackoffDelayMs(attempt));
    this.scheduleRestart = options.scheduleRestart ?? defaultScheduleRestart;
    this.stableAfterMs = options.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS;
  }

  /** Spawns Gatoway core (tasks.md 2.2). Safe to call once per supervisor instance. */
  start(): void {
    this.stopping = false;
    this.spawnNow();
  }

  /** Stops supervising: kills the current child (if any) and cancels any pending restart. */
  stop(): void {
    this.stopping = true;
    this.cancelPendingRestart?.();
    this.cancelPendingRestart = undefined;
    this.child?.kill();
  }

  /** The current child process, if one is running. Exposed for tests/inspection only. */
  get currentChild(): ChildProcess | undefined {
    return this.child;
  }

  private spawnNow(): void {
    let entryPointPath: string;
    try {
      entryPointPath = this.locateEntryPoint();
    } catch (err) {
      // stream-deck-core-lifecycle spec: "Spawn Failure Is Reported Clearly" (tasks.md 2.5).
      this.logger.error("cannot spawn Gatoway core: failed to locate its built entry point", {
        event: "gatoway_core_spawn_failed",
        reason: "entry_point_not_found",
        error: (err as Error).message,
      });
      return;
    }

    let child: ChildProcess;
    try {
      child = this.spawnChild(entryPointPath, this.childEnv);
    } catch (err) {
      this.logger.error("cannot spawn Gatoway core: the child process could not be started", {
        event: "gatoway_core_spawn_failed",
        reason: "spawn_threw",
        error: (err as Error).message,
      });
      return;
    }

    this.child = child;
    this.spawnedAt = Date.now();
    this.logger.info("Gatoway core child process spawned", {
      event: "gatoway_core_spawned",
      pid: child.pid,
      entryPointPath,
    });

    child.once("error", (err) => {
      // A failure to actually launch the process (e.g. ENOENT for the node binary
      // itself) surfaces here rather than via 'exit'; still logged loudly per tasks.md
      // 2.5, and 'exit' typically follows so the restart path still runs.
      this.logger.error("Gatoway core child process failed", {
        event: "gatoway_core_process_error",
        error: err.message,
      });
    });

    child.once("exit", (code, signal) => {
      this.handleExit(code, signal);
    });
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = undefined;

    if (this.stopping) {
      this.logger.info("Gatoway core child process exited during planned shutdown", {
        event: "gatoway_core_exited_expected",
        code,
        signal,
      });
      return;
    }

    const uptimeMs = Date.now() - this.spawnedAt;
    if (uptimeMs >= this.stableAfterMs) {
      this.restartAttempt = 0;
    }
    this.restartAttempt += 1;

    const delayMs = this.backoffMs(this.restartAttempt);
    this.logger.warn("Gatoway core child process exited unexpectedly; restarting after backoff", {
      event: "gatoway_core_restarting",
      code,
      signal,
      attempt: this.restartAttempt,
      delayMs,
    });

    this.cancelPendingRestart = this.scheduleRestart(delayMs, () => {
      this.cancelPendingRestart = undefined;
      this.spawnNow();
    });
  }
}
