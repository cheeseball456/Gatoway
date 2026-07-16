import { DeviceType, type Device } from "@elgato/streamdeck";
import type { DeviceCapacityPayload, EncoderPosition, KeypadPosition, Position } from "@gatoway/core";

/**
 * Dial count per `DeviceType` (extension-provided-slot-content design.md D1, tasks.md
 * 10.5): the Elgato SDK exposes no runtime field for this - `Device.size` gives only
 * the button grid ("Number of action slots, excluding dials / touchscreens" - the
 * SDK's own `DeviceInfo.size` doc comment, `@elgato/streamdeck/dist/api/device.d.ts`),
 * and dial count only appears in prose within the `DeviceType` enum's own doc comments
 * (`@elgato/schemas/dist/streamdeck/plugins/index.d.ts`). Every entry below was
 * verified, one by one, directly against that enum's doc comments on 2026-07-16 - not
 * guessed or assumed complete from memory:
 *
 * - `StreamDeck` (0): "comprised of 15 customizable LCD keys in a 5 x 3 layout" - no
 *   dials mentioned.
 * - `StreamDeckMini` (1): "6 customizable LCD keys in a 3 x 2 layout" - no dials.
 * - `StreamDeckXL` (2): "32 customizable LCD keys in an 8 x 4 layout" - no dials.
 * - `StreamDeckMobile` (3): "for iOS and Android" - no dials.
 * - `CorsairGKeys` (4): "available on select Corsair keyboards" - no dials.
 * - `StreamDeckPedal` (5): "comprised of 3 customizable pedals" - no dials.
 * - `CorsairVoyager` (6): "10 buttons in a horizontal line above the keyboard" - no dials.
 * - `StreamDeckPlus` (7): "8 customizable LCD keys in a 4 x 2 layout, a touch strip,
 *   and **4 dials**."
 * - `SCUFController` (8): "SCUF controller G keys" - no dials.
 * - `StreamDeckNeo` (9): "8 customizable LCD keys in a 4 x 2 layout, an info bar, and 2
 *   touch points for page navigation" - touch points, not dials.
 * - `StreamDeckStudio` (10): "32 customizable LCD keys in a 16 x 2 layout, and **2
 *   dials (1 on either side)**."
 * - `VirtualStreamDeck` (11): "1 to 64 action (on-screen) on a scalable canvas, with a
 *   maximum layout of 8 x 8" - no dials.
 * - `Galleon100SD` (12): "12 customizable LCD keys in a 3 x 4 layout, an LCD screen,
 *   and **2 dials**."
 * - `StreamDeckPlusXL` (13): "36 customizable LCD keys in a 9 x 4 layout, a touch
 *   strip, and **6 dials**."
 *
 * [Risk, design.md] If Elgato ships a new `DeviceType` this mapping doesn't yet know
 * about, `dialCountForDeviceType` silently falls back to 0 dials until this mapping is
 * updated - not a blocker today (only Stream Deck+ is in active use), but worth
 * revisiting whenever `@elgato/schemas` adds a new `DeviceType` entry.
 */
const DIAL_COUNT_BY_DEVICE_TYPE: Record<DeviceType, number> = {
  [DeviceType.StreamDeck]: 0,
  [DeviceType.StreamDeckMini]: 0,
  [DeviceType.StreamDeckXL]: 0,
  [DeviceType.StreamDeckMobile]: 0,
  [DeviceType.CorsairGKeys]: 0,
  [DeviceType.StreamDeckPedal]: 0,
  [DeviceType.CorsairVoyager]: 0,
  [DeviceType.StreamDeckPlus]: 4,
  [DeviceType.SCUFController]: 0,
  [DeviceType.StreamDeckNeo]: 0,
  [DeviceType.StreamDeckStudio]: 2,
  [DeviceType.VirtualStreamDeck]: 0,
  [DeviceType.Galleon100SD]: 2,
  [DeviceType.StreamDeckPlusXL]: 6,
};

/** Dial count for a `DeviceType`; unknown future values fall back to 0 (documented risk above). */
function dialCountForDeviceType(type: DeviceType): number {
  return DIAL_COUNT_BY_DEVICE_TYPE[type] ?? 0;
}

/**
 * Derives the ordered `device_capacity` position lists from the connected device's
 * fixed physical hardware facts (`Device.size`/`Device.type`) - amended v1.7 for
 * QA-020, superseding the original placement-derived version (which filtered
 * `Device.actions` down to currently-placed generic Key/Dial actions). Physical
 * capacity is a static property of the device model, not a function of what a user has
 * gotten around to placing, so this derivation no longer needs to inspect `actions` at
 * all.
 *
 * **Order (unchanged rule, design.md's own Risk/Trade-off note):** keys are generated
 * in reading order - row ascending, then column ascending within a row - directly from
 * the nested nothing-to-sort nested loop below; dials are generated in ascending index
 * order. This is what makes label N ("B" + (N+1) / "D" + (N+1)) consistently mean the
 * same physical position across repeated reports, as long as the connected device
 * itself hasn't changed.
 *
 * Only considers devices currently reported connected. Assumes (per design.md's own
 * Non-Goals: "does not preclude, does not build") that at most one device is connected
 * at a time - if multiple were ever connected simultaneously, their position lists
 * would be concatenated with no per-device offset, which is out of scope for this
 * change.
 */
export function computeDeviceCapacity(devices: Iterable<Device>): DeviceCapacityPayload {
  const buttonPositions: KeypadPosition[] = [];
  const dialPositions: EncoderPosition[] = [];

  for (const device of devices) {
    if (!device.isConnected) {
      continue;
    }

    const { rows, columns } = device.size;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        buttonPositions.push({ row, column });
      }
    }

    const dialCount = dialCountForDeviceType(device.type);
    for (let index = 0; index < dialCount; index++) {
      dialPositions.push({ index });
    }
  }

  return { buttonPositions, dialPositions };
}

/**
 * Structural equality between two `device_capacity` payloads (design.md D1, amended
 * v1.7): only re-send when the derived lists actually changed, i.e. the connected
 * device itself changed - not on every SDK device event that could plausibly fire
 * without an actual change.
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
