// Matched (-10 dB) bands as the result tables and the example picker show them. A band's centre is the
// middle of its edges, (f_lo + f_hi) / 2; the frequency of the |S11| minimum inside it (the bundle's
// f_center) is the band's best match, a column of its own. A band that runs into the edge of the
// simulated range continues past it: its width is a lower bound ("≥"), the edge it touches is marked
// "≤" (low) or "≥" (high), and its centre moves the same way. Pure, so scripts/check-run-summary.mjs
// runs it.
import type { Band, ProjectIndexEntry } from "../types";

/** The middle of a band's edges (Hz). */
export const bandCentre = (b: Pick<Band, "f_lo" | "f_hi">) => (b.f_lo + b.f_hi) / 2;

/** The band touches the simulated range at either end. */
export const bandOpen = (b: Pick<Band, "edge_lo" | "edge_hi">) => !!(b.edge_lo || b.edge_hi);

/** The mark of a value bounded by the simulated range: the low edge "≤", the high edge "≥", joined to
 * its number by a no-break space (a narrow column never puts the mark on a line of its own). */
const NB = "\u00a0";
const at = (open: boolean, mark: "≤" | "≥") => (open ? `${mark}${NB}` : "");

export interface BandTexts {
  /** the middle of the edges, "≤" / "≥" when only one edge is open (it moves that way) */
  centre: string;
  /** the frequency of the |S11| minimum */
  best: string;
  /** "2.098–2.287", "≤ 0.200–2.172", "0.737–≥ 1.050" */
  range: string;
  /** the -10 dB width in MHz and as a percentage of the centre: lower bounds ("≥") for an open band */
  bwMhz: string;
  percent: string;
  open: boolean;
}

/** A band's table cells; `ghz` formats a frequency in Hz (as GHz, without the unit), `fixed` a number. */
export function bandTexts(b: Band, ghz: (hz: number) => string, fixed: (v: number, digits: number) => string): BandTexts {
  const open = bandOpen(b);
  const centre = bandCentre(b);
  const lower = at(open, "≥");
  return {
    centre: `${at(b.edge_lo && !b.edge_hi, "≤")}${at(b.edge_hi && !b.edge_lo, "≥")}${ghz(centre)}`,
    best: ghz(b.f_center),
    range: `${at(b.edge_lo, "≤")}${ghz(b.f_lo)}–${at(b.edge_hi, "≥")}${ghz(b.f_hi)}`,
    bwMhz: `${lower}${fixed((b.f_hi - b.f_lo) / 1e6, 0)}`,
    percent: `${lower}${fixed(((b.f_hi - b.f_lo) / centre) * 100, 1)}`,
    open,
  };
}

/** What the project index keeps of a band (GHz), for the picker's secondary line (newer indexes only). */
export type IndexBand = NonNullable<ProjectIndexEntry["band_ranges"]>[number];

/** The picker's band text: a closed band by its centre ("2.43"), an open one by its range with "≥"
 * (the band covers at least that range: "≥ 8–12"); `ghz` formats a frequency in GHz. Falls back to the
 * index's band list (|S11| minima) for an older index. */
export function pickerBands(p: Pick<ProjectIndexEntry, "bands" | "band_ranges">, ghz: (f: number) => string): string[] {
  const ranges = (p.band_ranges ?? []).filter((r) => Number.isFinite(r?.lo) && Number.isFinite(r?.hi) && r.hi >= r.lo && r.lo > 0);
  if (ranges.length) return ranges.map((r) => (r.edge_lo || r.edge_hi ? `${at(true, "≥")}${ghz(r.lo)}–${ghz(r.hi)}` : ghz((r.lo + r.hi) / 2)));
  return (p.bands ?? []).filter((f) => Number.isFinite(f) && f > 0).map(ghz);
}
