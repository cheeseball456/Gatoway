import { describe, expect, it } from "vitest";
import { DeviceType, type Device } from "@elgato/streamdeck";
import { computeDeviceCapacity, deviceCapacityEqual } from "../../src/coreClient/deviceCapacity.js";

function fakeDevice(
  isConnected: boolean,
  size: { rows: number; columns: number },
  type: DeviceType,
): Device {
  return { isConnected, size, type } as unknown as Device;
}

describe("computeDeviceCapacity", () => {
  it("returns empty lists when there are no devices", () => {
    expect(computeDeviceCapacity([])).toEqual({ buttonPositions: [], dialPositions: [] });
  });

  it("derives the full button grid from Device.size, in reading order, for a device type with no dials", () => {
    // Stream Deck XL: 32 keys in an 8 x 4 layout, no dials.
    const device = fakeDevice(true, { rows: 4, columns: 8 }, DeviceType.StreamDeckXL);

    const capacity = computeDeviceCapacity([device]);

    expect(capacity.buttonPositions).toHaveLength(32);
    expect(capacity.buttonPositions[0]).toEqual({ row: 0, column: 0 });
    expect(capacity.buttonPositions[1]).toEqual({ row: 0, column: 1 });
    expect(capacity.buttonPositions[7]).toEqual({ row: 0, column: 7 });
    expect(capacity.buttonPositions[8]).toEqual({ row: 1, column: 0 });
    expect(capacity.buttonPositions[31]).toEqual({ row: 3, column: 7 });
    expect(capacity.dialPositions).toEqual([]);
  });

  it("derives both the button grid and the dial count for a Stream Deck+ (4 x 2 keys, 4 dials)", () => {
    const device = fakeDevice(true, { rows: 2, columns: 4 }, DeviceType.StreamDeckPlus);

    const capacity = computeDeviceCapacity([device]);

    expect(capacity.buttonPositions).toEqual([
      { row: 0, column: 0 },
      { row: 0, column: 1 },
      { row: 0, column: 2 },
      { row: 0, column: 3 },
      { row: 1, column: 0 },
      { row: 1, column: 1 },
      { row: 1, column: 2 },
      { row: 1, column: 3 },
    ]);
    expect(capacity.dialPositions).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }]);
  });

  it("derives 2 dials for a Stream Deck Studio", () => {
    const device = fakeDevice(true, { rows: 2, columns: 16 }, DeviceType.StreamDeckStudio);

    const capacity = computeDeviceCapacity([device]);

    expect(capacity.dialPositions).toEqual([{ index: 0 }, { index: 1 }]);
  });

  it("derives 6 dials for a Stream Deck + XL", () => {
    const device = fakeDevice(true, { rows: 4, columns: 9 }, DeviceType.StreamDeckPlusXL);

    const capacity = computeDeviceCapacity([device]);

    expect(capacity.dialPositions).toEqual([
      { index: 0 },
      { index: 1 },
      { index: 2 },
      { index: 3 },
      { index: 4 },
      { index: 5 },
    ]);
  });

  it("derives 2 dials for a Galleon 100 SD", () => {
    const device = fakeDevice(true, { rows: 4, columns: 3 }, DeviceType.Galleon100SD);

    const capacity = computeDeviceCapacity([device]);

    expect(capacity.dialPositions).toEqual([{ index: 0 }, { index: 1 }]);
  });

  it("ignores a disconnected device entirely", () => {
    const device = fakeDevice(false, { rows: 2, columns: 4 }, DeviceType.StreamDeckPlus);

    expect(computeDeviceCapacity([device])).toEqual({ buttonPositions: [], dialPositions: [] });
  });

  it("derives capacity purely from size/type regardless of what actions (if any) are placed", () => {
    // A plain Stream Deck has no dials and a fixed 5 x 3 grid - unaffected by whether
    // this plugin's own generic Key action has actually been placed on any of its 15
    // physical keys (design.md D1/AD-9, amended v1.7 for QA-020: capacity is not
    // derived from Device.actions at all anymore).
    const device = fakeDevice(true, { rows: 3, columns: 5 }, DeviceType.StreamDeck);

    const capacity = computeDeviceCapacity([device]);

    expect(capacity.buttonPositions).toHaveLength(15);
    expect(capacity.dialPositions).toEqual([]);
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
