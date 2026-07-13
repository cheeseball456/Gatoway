import { createServer, type AddressInfo } from "node:net";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import { ConnectionManager } from "../../src/connection/connectionManager.js";
import { startTcpListener, type TcpListenerHandle } from "../../src/connection/tcpListener.js";
import { encodeMessage } from "../../src/protocol/envelope.js";
import { encodeNdjsonLine, NdjsonDecoder } from "../../src/protocol/tcpFraming.js";

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

function connectTo(port: number, host = "127.0.0.1"): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, host, () => resolve(socket));
    socket.on("error", reject);
  });
}

function readOneMessage(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const decoder = new NdjsonDecoder();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      const lines = decoder.push(chunk);
      if (lines.length > 0) {
        resolve(JSON.parse(lines[0] as string));
      }
    });
  });
}

describe("TCP listener (integration)", () => {
  let handle: TcpListenerHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("binds only to loopback addresses, not 0.0.0.0 (tasks.md 6.4)", async () => {
    const port = await findFreePort();
    const manager = new ConnectionManager(silentLogger());
    handle = await startTcpListener({ port, manager, logger: silentLogger(), currentToken: "secret" });

    expect(handle.addresses).toHaveLength(2);
    const boundAddresses = handle.addresses.map((a) => a.address).sort();
    expect(boundAddresses).toEqual(["127.0.0.1", "::1"].sort());
    for (const bound of handle.addresses) {
      expect(bound.address).not.toBe("0.0.0.0");
      expect(bound.address).not.toBe("::");
    }

    // A direct loopback connection should succeed.
    const socket = await connectTo(port);
    socket.destroy();
  });

  it("authenticates a connection presenting the valid token", async () => {
    const port = await findFreePort();
    const manager = new ConnectionManager(silentLogger());
    handle = await startTcpListener({ port, manager, logger: silentLogger(), currentToken: "the-real-token" });

    const socket = await connectTo(port);
    const responsePromise = readOneMessage(socket);
    socket.write(
      encodeNdjsonLine(
        encodeMessage({
          type: "register",
          payload: { pluginType: "lightroom", capabilities: [], token: "the-real-token" },
        }),
      ),
    );

    const response = await responsePromise;
    expect((response.payload as { status: string }).status).toBe("ok");

    const [connection] = manager.list();
    expect(connection?.state).toBe("authenticated");
    socket.destroy();
  });

  it("rejects and closes a connection presenting an invalid token", async () => {
    const port = await findFreePort();
    const manager = new ConnectionManager(silentLogger());
    handle = await startTcpListener({ port, manager, logger: silentLogger(), currentToken: "the-real-token" });

    const socket = await connectTo(port);
    const responsePromise = readOneMessage(socket);
    const closePromise = new Promise<void>((resolve) => socket.on("close", () => resolve()));

    socket.write(
      encodeNdjsonLine(
        encodeMessage({
          type: "register",
          payload: { pluginType: "lightroom", capabilities: [], token: "wrong-token" },
        }),
      ),
    );

    const response = await responsePromise;
    expect((response.payload as { status: string }).status).toBe("rejected");

    await closePromise;
    expect(manager.list()).toHaveLength(0);
  });
});
