// The y axes of the S-parameter quantities (charts/plotQuantities.ts) in every result view: the range,
// the reference lines and the phase ticks. Pure, so scripts/check-markers.mjs runs it.
import type { PlotQuantity } from "./plotQuantities.ts";

/** The phase axis: every 90°, thinned to every 180° on a short pane (LineChart yTickValues). */
export const PHASE_TICKS = [-180, -90, 0, 90, 180];

const finite = (ss: readonly { y: readonly number[] }[]) => ss.flatMap((s) => s.y.filter(Number.isFinite));

/** The y range of a quantity: |S|² in dB from −30 dB (lower when the data go lower) to 0 dB, or above
 * 0 dB when the data exceed it (an unphysical part stays visible); the phase from −180° to 180°; the
 * others from their data (undefined). */
export function quantityDomain(g: Pick<PlotQuantity, "key"> & { series: readonly { y: readonly number[] }[] }): [number, number] | undefined {
  if (g.key === "phase") return [-180, 180];
  if (g.key !== "db") return undefined;
  const ys = finite(g.series);
  const lo = Math.min(-30, Math.floor(Math.min(...ys, 0) / 5) * 5);
  const hi = Math.max(0, Math.ceil(Math.max(...ys, 0) / 5) * 5);
  return [lo, hi];
}

/** The reference lines of a quantity: −10 dB for a reflection (and 0 dB when the axis reaches above it),
 * the zero line of the phase. */
export function quantityLines(g: Pick<PlotQuantity, "key" | "kind"> & { series: readonly { y: readonly number[] }[] }): { y: number; label: string }[] {
  if (g.key === "phase") return [{ y: 0, label: "" }];
  if (g.key !== "db") return [];
  const above = (quantityDomain(g)?.[1] ?? 0) > 0;
  return [...(g.kind === "reflection" ? [{ y: -10, label: "−10 dB" }] : []), ...(above ? [{ y: 0, label: "0 dB" }] : [])];
}
