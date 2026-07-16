import type { Device } from "@elgato/streamdeck";
import type { DeviceCapacityPayload, EncoderPosition, KeypadPosition, Position } from "@gatoway/core";
import { GENERIC_DIAL_ACTION_UUID, GENERIC_KEY_ACTION_UUID } from "../actions/actionIds.js";
import { encoderPosition, keypadPosition } from "../actions/protocolPositions.js";

/**
 * Derives the ordered `device_capacity` position lists from the Elgato SDK's live
 * device/action info (extension-provided-slot-content design.md D1, tasks.md 7.1): the
 * ordered list of physical positions currently holding this plugin's own generic Key
 * action (`buttonPositions`), and the ordered list currently holding its generic Dial
 * action (`dialPositions`). Filters `Device.actions` down to just these two manifest
 * ids - any other action (a folder, a third-party action, etc.) placed on the same
 * device is not a "generic" slot Gatoway core can address, and is excluded.
 *
 * **Chosen ordering (design.md's own Risk/Trade-off note: the Elgato SDK's own
 * `actions` iterator order is not documented as stable):** keys are sorted in reading
 * order - row ascending, then column ascending within a row; dials are sorted by
 * ascending index. This is an arbitrary but fixed rule, picked so that ordinal index N
 * consistently means the same physical position across repeated reports, as long as
 * capacity hasn't actually changed - never relying on whatever order the SDK's own
 * iterator happens to yield.
 *
 * Only considers devices currently reported connected - matches "currently holding a
 * generic Key/Dial action" (a disconnected device has nothing currently placed on it,
 * from Gatoway core's point of view).
 */
export function computeDeviceCapacity(devices: Iterable<Device>): DeviceCapacityPayload {
  const buttonPositions: KeypadPosition[] = [];
  const dialPositions: EncoderPosition[] = [];

  for (const device of devices) {
    if (!device.isConnected) {
      continue;
    }
    for (const action of device.actions) {
      if (action.isKey() && action.manifestId === GENERIC_KEY_ACTION_UUID && action.coordinates) {
        buttonPositions.push(keypadPosition(action.coordinates) as KeypadPosition);
      } else if (action.isDial() && action.manifestId === GENERIC_DIAL_ACTION_UUID) {
        dialPositions.push(encoderPosition(action.coordinates) as EncoderPosition);
      }
    }
  }

  buttonPositions.sort((a, b) => a.row - b.row || a.column - b.column);
  dialPositions.sort((a, b) => a.index - b.index);

  return { buttonPositions, dialPositions };
}

/**
 * Structural equality between two `device_capacity` payloads (tasks.md 7.3: only
 * re-send when the derived lists actually changed, not on every SDK event that could
 * plausibly affect them).
 */
export function deviceCapacityEqual(a: DeviceCapacityPayload, b: DeviceCapacityPayload): boolean {
  return (
    positionListEqual(a.buttonPositions, b.buttonPositions) &&
    positionListEqual(a.dialPositions, b.dialPositions)
  );
}

/**
 * Structural (not reference) equality between two same-length `Position` lists. Each
 * `Position` is a small plain object (`{ row, column }` or `{ index }`), so a JSON
 * comparison per entry is a simple, correct way to compare both possible shapes without
 * duplicating a keypad-specific and encoder-specific comparator.
 */
function positionListEqual(a: Position[], b: Position[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => JSON.stringify(value) === JSON.stringify(b[index]));
}
