import { describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../../src/connection/connectionManager.js";
import type { Logger } from "../../src/logging/logger.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe("ConnectionManager", () => {
  it("assigns a unique connection ID and starts in the authenticating state", () => {
    const manager = new ConnectionManager(fakeLogger());
    const connection = manager.accept({ transport: "tcp", send: vi.fn(), close: vi.fn() });

    expect(connection.id).toBeTruthy();
    expect(connection.state).toBe("authenticating");
    expect(manager.get(connection.id)).toBe(connection);
  });

  it("assigns distinct connection IDs to two connections declaring the same plugin type", () => {
    const manager = new ConnectionManager(fakeLogger());
    const a = manager.accept({ transport: "tcp", send: vi.fn(), close: vi.fn() });
    const b = manager.accept({ transport: "tcp", send: vi.fn(), close: vi.fn() });

    manager.setPluginInfo(a.id, "lightroom", { buttons: [], dials: [] });
    manager.setPluginInfo(b.id, "lightroom", { buttons: [], dials: [] });

    expect(a.id).not.toBe(b.id);
    expect(manager.list().map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("walks a preAuthenticated connection straight to authenticated", () => {
    const manager = new ConnectionManager(fakeLogger());
    const connection = manager.accept({
      transport: "websocket",
      preAuthenticated: true,
      send: vi.fn(),
      close: vi.fn(),
    });

    expect(connection.state).toBe("authenticated");
  });

  it("only allows forward transitions in the fixed order", () => {
    const manager = new ConnectionManager(fakeLogger());
    const connection = manager.accept({ transport: "tcp", send: vi.fn(), close: vi.fn() });

    expect(() => manager.transition(connection.id, "connected")).toThrow();
    expect(() => manager.transition(connection.id, "disconnected")).toThrow();

    manager.transition(connection.id, "authenticated");
    expect(connection.state).toBe("authenticated");
  });

  it("removes a connection from tracking on disconnect", () => {
    const manager = new ConnectionManager(fakeLogger());
    const connection = manager.accept({ transport: "tcp", send: vi.fn(), close: vi.fn() });
    manager.transition(connection.id, "authenticated");

    manager.disconnect(connection.id, "test");

    expect(manager.get(connection.id)).toBeUndefined();
    expect(manager.list()).toHaveLength(0);
  });
});
