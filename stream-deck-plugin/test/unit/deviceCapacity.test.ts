import { describe, expect, it } from "vitest";
import type { Device } from "@elgato/streamdeck";
import { GENERIC_DIAL_ACTION_UUID, GENERIC_KEY_ACTION_UUID } from "../../src/actions/actionIds.js";
import { computeDeviceCapacity, deviceCapacityEqual } from "../../src/coreClient/deviceCapacity.js";

interface FakeAction {
  isKey(): boolean;
  isDial(): boolean;
  manifestId: string;
  coordinates: { row: number; column: number };
}

function fakeKeyAction(manifestId: string, row: number, column: number): FakeAction {
  return {
    isKey: () => true,
    isDial: () => false,
    manifestId,
    coordinates: { row, column },
  };
}

function fakeDialAction(manifestId: string, index: number): FakeAction {
  return {
    isKey: () => false,
    isDial: () => true,
    manifestId,
    coordinates: { row: 0, column: index },
  };
}

function fakeDevice(isConnected: boolean, actions: FakeAction[]): Device {
  return {
    isConnected,
    actions: actions[Symbol.iterator](),
  } as unknown as Device;
}

describe("computeDeviceCapacity", () => {
  it("returns empty lists when there are no devices", () => {
    expect(computeDeviceCapacity([])).toEqual({ buttonPositions: [], dialPositions: [] });
  });

  it("collects only this plugin's own generic Key/Dial actions, ignoring other actions on the same device", () => {
    const device = fakeDevice(true, [
      fakeKeyAction(GENERIC_KEY_ACTION_UUID, 0, 0),
      fakeKeyAction("com.other.action", 0, 1),
      fakeDialAction(GENERIC_DIAL_ACTION_UUID, 0),
      fakeDialAction("com.other.dial", 1),
    ]);

    const capacity = computeDeviceCapacity([device]);

    expect(capacity).toEqual({
      buttonPositions: [{ row: 0, column: 0 }],
      dialPositions: [{ index: 0 }],
    });
  });

  it("ignores actions on a disconnected device", () => {
    const device = fakeDevice(false, [fakeKeyAction(GENERIC_KEY_ACTION_UUID, 0, 0)]);

    expect(computeDeviceCapacity([device])).toEqual({ buttonPositions: [], dialPositions: [] });
  });

  it("sorts keys in reading order (row ascending, then column ascending), independent of iterator order", () => {
    const device = fakeDevice(true, [
      fakeKeyAction(GENERIC_KEY_ACTION_UUID, 1, 0),
      fakeKeyAction(GENERIC_KEY_ACTION_UUID, 0, 1),
      fakeKeyAction(GENERIC_KEY_ACTION_UUID, 0, 0),
    ]);

    const capacity = computeDeviceCapacity([device]);

    expect(capacity.buttonPositions).toEqual([
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 1, column: 0 },
    ]);
  });

  it("sorts dials by ascending index, independent of iterator order", () => {
    const device = fakeDevice(true, [
      fakeDialAction(GENERIC_DIAL_ACTION_UUID, 2),
      fakeDialAction(GENERIC_DIAL_ACTION_UUID, 0),
      fakeDialAction(GENERIC_DIAL_ACTION_UUID, 1),
    ]);

    const capacity = computeDeviceCapacity([device]);

    expect(capacity.dialPositions).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }]);
  });
});

describe("deviceCapacityEqual", () => {
  it("treats two structurally identical reports as equal", () => {
    const a = { buttonPositions: [{ row: 0, column: 0 }], dialPositions: [{ index: 0 }] };
    const b = { buttonPositions: [{ row: 0, column: 0 }], dialPositions: [{ index: 0 }] };
    expect(deviceCapacityEqual(a, b)).toBe(true);
  });

  it("treats reports with a different button count as unequal", () => {
    const a = { buttonPositions: [{ row: 0, column: 0 }], dialPositions: [] };
    const b = { buttonPositions: [], dialPositions: [] };
    expect(deviceCapacityEqual(a, b)).toBe(false);
  });

  it("treats reports with the same count but different positions as unequal", () => {
    const a = { buttonPositions: [{ row: 0, column: 0 }], dialPositions: [] };
    const b = { buttonPositions: [{ row: 0, column: 1 }], dialPositions: [] };
    expect(deviceCapacityEqual(a, b)).toBe(false);
  });

  it("treats reports with a different dial count as unequal", () => {
    const a = { buttonPositions: [], dialPositions: [{ index: 0 }] };
    const b = { buttonPositions: [], dialPositions: [{ index: 0 }, { index: 1 }] };
    expect(deviceCapacityEqual(a, b)).toBe(false);
  });
});
