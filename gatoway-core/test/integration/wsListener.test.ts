import { createServer, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import WebSocket from "ws";
import { ConnectionManager } from "../../src/connection/connectionManager.js";
import { startWsListener, type WsListenerHandle } from "../../src/connection/wsListener.js";
import { encodeMessage } from "../../src/protocol/envelope.js";

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

function silentLogger() {
  return pino({ level: "silent" });
}

const ALLOWED_ORIGIN = "chrome-extension://known-xdender-id";

describe("WebSocket listener (integration)", () => {
  let handle: WsListenerHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("binds only to IPv4 loopback, not 0.0.0.0 (tasks.md 6.4, AD-4 v1.1)", async () => {
    const port = await findFreePort();
    const manager = new ConnectionManager(silentLogger());
    handle = await startWsListener({
      port,
      manager,
      logger: silentLogger(),
      allowedOrigins: [ALLOWED_ORIGIN],
    });

    expect(handle.addresses).toHaveLength(1);
    expect(handle.addresses[0]?.address).toBe("127.0.0.1");
    for (const bound of handle.addresses) {
      expect(bound.address).not.toBe("0.0.0.0");
      expect(bound.address).not.toBe("::");
    }
  });

  it("completes the upgrade and authenticates when Origin is allowlisted", async () => {
    const port = await findFreePort();
    const manager = new ConnectionManager(silentLogger());
    handle = await startWsListener({
      port,
      manager,
      logger: silentLogger(),
      allowedOrigins: [ALLOWED_ORIGIN],
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ALLOWED_ORIGIN });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0]?.state).toBe("authenticated");

    const ackPromise = new Promise<Record<string, unknown>>((resolve) => {
      ws.on("message", (data) => resolve(JSON.parse(data.toString())));
    });
    ws.send(
      encodeMessage({
        type: "register",
        payload: { pluginType: "xdesign" },
      }),
    );
    const ack = await ackPromise;
    expect((ack.payload as { status: string }).status).toBe("ok");

    ws.close();
  });

  it("completes the upgrade when Origin matches a wildcard allowlist entry (wildcard-origin-allowlist)", async () => {
    const port = await findFreePort();
    const manager = new ConnectionManager(silentLogger());
    handle = await startWsListener({
      port,
      manager,
      logger: silentLogger(),
      allowedOrigins: ["moz-extension://*"],
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "moz-extension://some-per-install-uuid" });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });

    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0]?.state).toBe("authenticated");

    ws.close();
  });

  it("refuses the upgrade when Origin is not allowlisted", async () => {
    const port = await findFreePort();
    const manager = new ConnectionManager(silentLogger());
    handle = await startWsListener({
      port,
      manager,
      logger: silentLogger(),
      allowedOrigins: [ALLOWED_ORIGIN],
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "chrome-extension://not-allowed" });
    const failure = await new Promise<{ type: string }>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve({ type: `status:${res.statusCode}` }));
      ws.on("error", () => resolve({ type: "error" }));
      ws.on("open", () => resolve({ type: "open" }));
    });

    expect(failure.type).not.toBe("open");
    expect(manager.list()).toHaveLength(0);
  });
});
