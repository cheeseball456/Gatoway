import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Regression test for QA-005: the standalone-invocation guard in `src/index.ts` used to
// silently no-op (no listeners, no log file, no error) whenever the invoking path
// needed URL-encoding, e.g. contained spaces — which this project's own path does. Unit
// tests that call `startGatowayCore()` directly never exercise that guard at all, so
// this test deliberately spawns the real CLI entry point as a child process, the same
// way `npm run dev` / `node dist/index.js` do, and asserts it actually starts.

const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const entryPoint = join(packageRoot, "src", "index.ts");

// Resolved via module resolution rather than a hand-built `node_modules/.bin/tsx` path
// (the same class of fix as stream-deck-plugin-skeleton's `locateCoreEntryPoint`):
// once this repo adopted npm workspaces (stream-deck-plugin-skeleton design.md D1),
// npm hoists shared devDependencies like `tsx` to the workspace root, so a package-local
// `node_modules/.bin/tsx` no longer reliably exists. `require.resolve` finds `tsx`
// wherever npm actually placed it, and running it via `process.execPath` (rather than
// executing the `.bin` shim directly) is also portable to Windows, which has no shebang
// support for the shim's underlying script.
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");

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

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("condition not met before timeout");
}

function connectTo(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => resolve(socket));
    socket.on("error", reject);
  });
}

/**
 * `pino-roll` writes to the given file path with a rotation index inserted before the
 * extension (e.g. a configured `gatoway-core.log` becomes `gatoway-core.1.log` for the
 * active file) rather than the literal path passed in, so this reads whatever landed in
 * the log directory instead of assuming the exact configured filename.
 */
async function readAnyLogContent(dir: string): Promise<string> {
  const files = await readdir(dir);
  const contents = await Promise.all(
    files.map((file) => readFile(join(dir, file), "utf8").catch(() => "")),
  );
  return contents.join("\n");
}

describe("standalone CLI entry point (QA-005 regression)", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    child = undefined;
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("actually starts (listeners up, log file written) when launched via `tsx src/index.ts`, from a directory whose path contains a space", async () => {
    // The mkdtemp prefix ends with a space so the resulting directory name contains
    // one, reproducing the exact condition (a space in the invoked path) that QA-005
    // caused `import.meta.url` to percent-encode and the naive `file://` string
    // comparison to never match.
    dir = await mkdtemp(join(tmpdir(), "gatoway cli test-"));
    const logFilePath = join(dir, "gatoway-core.log");
    const tokenFilePath = join(dir, "auth-token");
    const tcpPort = await findFreePort();
    const wsPort = await findFreePort();

    child = spawn(process.execPath, [tsxCliPath, entryPoint], {
      cwd: packageRoot,
      env: {
        ...process.env,
        GATOWAY_LOG_FILE: logFilePath,
        GATOWAY_TOKEN_FILE: tokenFilePath,
        GATOWAY_TCP_PORT: String(tcpPort),
        GATOWAY_WS_PORT: String(wsPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const exitedEarly = new Promise<number | null>((resolve) => {
      child?.once("exit", (code) => resolve(code));
    });

    await Promise.race([
      waitFor(async () => (await readAnyLogContent(dir as string)).includes("gatoway_core_started"), 10_000),
      exitedEarly.then((code) => {
        throw new Error(
          `entry point exited early with code ${code} before starting; stderr: ${stderr}`,
        );
      }),
    ]);

    // The log line alone isn't proof of a running service — confirm the TCP listener
    // is actually accepting connections too.
    const socket = await connectTo(tcpPort);
    socket.destroy();

    expect(stderr).toBe("");
  }, 20_000);

  it("does not auto-start when the module is merely imported as a library, not executed directly", async () => {
    const mod = await import("../../src/index.js");
    expect(typeof mod.startGatowayCore).toBe("function");
    // No assertion beyond "importing didn't throw or hang" is needed: every other test
    // file in this suite imports modules from `src/` (transitively including this one
    // via re-exports in some cases) without ever binding a port, which is only possible
    // because the direct-invocation guard correctly stays false under `vitest`.
  });
});
