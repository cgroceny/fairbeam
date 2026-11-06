import { fmt } from "../i18n/index.ts";
import { num } from "../lib/format.ts";
import { displayUnits, LENGTH_UNITS, type LengthUnit } from "../lib/displayUnits.ts";

const lengthUnit = (): LengthUnit => displayUnits().length;

/** Round down to a readable 1/2/5 step in the caller's units. */
export function niceLength(x: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}

/** Display conversion only: the camera, picked points and WCS stay in model coordinates. The
 * readouts use the chosen length unit (src/lib/displayUnits.ts). */
export function viewportScaleBar(worldPerPx: number, toMm: number, unit: LengthUnit = lengthUnit()): { px: number; label: string } {
  const perPx = worldPerPx * toMm / LENGTH_UNITS[unit];
  const len = niceLength(perPx * 110);
  const px = Math.round((len / perPx) * 2) / 2;
  return { px, label: `${fmt.num(len, 6)} ${unit}` };
}

export function viewportCoordinates(point: readonly number[], toMm: number, local = false, unit: LengthUnit = lengthUnit()): string {
  const axes = local ? ["u", "v", "w"] : ["x", "y", "z"];
  const k = toMm / LENGTH_UNITS[unit];
  return axes.map((axis, i) => `${axis} ${num(point[i] * k, 2)}`).join(" · ") + ` ${unit}`;
}

export function viewportMeasurement(distance: number, toMm: number, unit: LengthUnit = lengthUnit()): string {
  return `${fmt.fixed(distance * toMm / LENGTH_UNITS[unit], 3)} ${unit}`;
}
