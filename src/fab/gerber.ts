// Gerber X2 (RS-274X with X2 attributes) writer: one file per copper layer and a board-profile
// file. mm, format 4.6 (1 nm resolution), copper as regions (G36/G37) in nesting order (dark
// outer, clear holes, dark islands …), anti-pads as clear circle flashes last.

import type { Bundle } from "../types";
import type { CopperLayer, FabModel } from "./layers.ts";
import type { Ring } from "./polygon.ts";

export interface GerberMeta {
  version: string;
  /** ISO 8601 creation date written into %TF.CreationDate */
  created: string;
}

const ascii = (s: string) => s.replace(/Ω/g, "ohm").replace(/[^\x20-\x7e]/g, "?").replace(/[*%,]/g, " ");
const c = (v: number) => String(Math.round(v * 1e6));
const xy = ([x, y]: [number, number]) => `X${c(x)}Y${c(y)}`;
const num6 = (v: number) => v.toFixed(6);

function header(b: Bundle, meta: GerberMeta, fileFunction: string, comment: string): string[] {
  return [
    `G04 ${ascii(comment)}*`,
    `G04 ${ascii(b.name)} (${ascii(b.model.id)}), Fairbeam ${ascii(meta.version)}*`,
    `%TF.GenerationSoftware,Fairbeam,Fairbeam,${ascii(meta.version)}*%`,
    `%TF.CreationDate,${meta.created}*%`,
    "%TF.SameCoordinates,Original*%",
    `%TF.FileFunction,${fileFunction}*%`,
    "%TF.FilePolarity,Positive*%",
    "%TF.Part,Single*%",
    "%FSLAX46Y46*%",
    "%MOMM*%",
    "%LPD*%",
    "G01*",
  ];
}

function region(ring: Ring): string[] {
  const out = ["G36*", `${xy(ring[0])}D02*`];
  for (let i = 1; i < ring.length; i++) out.push(`${xy(ring[i])}D01*`);
  out.push(`${xy(ring[0])}D01*`, "G37*");
  return out;
}

export function gerberCopper(b: Bundle, m: FabModel, layer: CopperLayer, meta: GerberMeta): string {
  const n = m.layers.length;
  // X2 FileFunction: Copper,L<i>,<Top|Inr|Bot>; a single layer is L1,Top
  const pos = n === 1 ? "Top" : layer.side;
  const out = header(b, meta, `Copper,L${layer.index},${pos}`, `Copper layer ${layer.name} (z = ${layer.z} mm): ${layer.parts.join(", ")}`);
  // anti-pad apertures (defined up front; attribute cleared after the definition)
  const ap = new Map<number, number>();
  let next = 10;
  if (layer.clearances.length) {
    out.push("%TA.AperFunction,AntiPad*%");
    for (const cl of layer.clearances) if (!ap.has(cl.d)) {
      ap.set(cl.d, next);
      out.push(`%ADD${next}C,${num6(cl.d)}*%`);
      next++;
    }
    out.push("%TD*%");
  }
  out.push("%TA.AperFunction,Conductor*%");
  let dark = true;
  const polarity = (d: boolean) => {
    if (d !== dark) {
      out.push(d ? "%LPD*%" : "%LPC*%");
      dark = d;
    }
  };
  for (const g of layer.regions) {
    polarity(true);
    out.push(...region(g.outer));
    if (g.holes.length) {
      polarity(false);
      for (const h of g.holes) out.push(...region(h));
    }
  }
  out.push("%TD*%");
  if (layer.clearances.length) {
    polarity(false);
    for (const cl of layer.clearances) out.push(`D${ap.get(cl.d)}*`, `${xy([cl.x, cl.y])}D03*`);
  }
  polarity(true);
  out.push("M02*");
  return out.join("\n") + "\n";
}

export function gerberProfile(b: Bundle, m: FabModel, meta: GerberMeta): string {
  const out = header(b, meta, "Profile,NP", "Board outline (substrate footprint)");
  out.push("%TA.AperFunction,Profile*%", "%ADD10C,0.100000*%", "%TD*%", "D10*");
  for (const g of m.outline) for (const r of [g.outer, ...g.holes]) {
    out.push(`${xy(r[0])}D02*`);
    for (let i = 1; i < r.length; i++) out.push(`${xy(r[i])}D01*`);
    out.push(`${xy(r[0])}D01*`);
  }
  out.push("M02*");
  return out.join("\n") + "\n";
}
