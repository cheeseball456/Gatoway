import { describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../../src/connection/connectionManager.js";
import { findCapability } from "../../src/routing/capabilityLookup.js";
import type { Logger } from "../../src/logging/logger.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe("findCapability", () => {
  it("finds a capability declared by the given connection", () => {
    const manager = new ConnectionManager(fakeLogger());
    const connection = manager.accept({ transport: "tcp", send: vi.fn(), close: vi.fn() });
    manager.setPluginInfo(connection.id, "test-app", [
      { id: "cap.one", label: "One", type: "button" },
      { id: "cap.two", label: "Two", type: "dial" },
    ]);

    expect(findCapability(connection, "cap.two")).toEqual({ id: "cap.two", label: "Two", type: "dial" });
  });

  it("returns undefined for a capability id the connection never declared", () => {
    const manager = new ConnectionManager(fakeLogger());
    const connection = manager.accept({ transport: "tcp", send: vi.fn(), close: vi.fn() });
    manager.setPluginInfo(connection.id, "test-app", [{ id: "cap.one", label: "One", type: "button" }]);

    expect(findCapability(connection, "cap.unknown")).toBeUndefined();
  });

  it("returns undefined when the connection has never declared any capabilities", () => {
    const manager = new ConnectionManager(fakeLogger());
    const connection = manager.accept({ transport: "tcp", send: vi.fn(), close: vi.fn() });

    expect(findCapability(connection, "cap.one")).toBeUndefined();
  });

  it("returns undefined for an undefined connection", () => {
    expect(findCapability(undefined, "cap.one")).toBeUndefined();
  });

  it("returns undefined for a null or undefined capability id", () => {
    const manager = new ConnectionManager(fakeLogger());
    const connection = manager.accept({ transport: "tcp", send: vi.fn(), close: vi.fn() });
    manager.setPluginInfo(connection.id, "test-app", [{ id: "cap.one", label: "One", type: "button" }]);

    expect(findCapability(connection, null)).toBeUndefined();
    expect(findCapability(connection, undefined)).toBeUndefined();
  });
});
