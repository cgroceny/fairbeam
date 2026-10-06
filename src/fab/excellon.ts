// Excellon drill file (metric, absolute, decimal coordinates) with a tool table and X2-style
// attribute comments, as KiCad writes them. One file for plated and one for non-plated holes.

import type { Bundle } from "../types";
import type { Drill, FabModel } from "./layers.ts";

const f3 = (v: number) => v.toFixed(3);

export function excellon(b: Bundle, m: FabModel, plated: boolean, meta: { version: string; created: string }): string | null {
  const holes = m.drills.filter((d) => d.plated === plated);
  if (!holes.length) return null;
  const n = Math.max(1, m.layers.length);
  const tools: number[] = [...new Set(holes.map((d) => Math.round(d.d * 1000) / 1000))].sort((a, c) => a - c);
  const out = [
    "M48",
    `; DRILL file {Fairbeam ${meta.version}} date ${meta.created}`,
    `; ${b.name.replace(/[^\x20-\x7e]/g, "?")} (${b.model.id})`,
    "; FORMAT={-:-/ absolute / metric / decimal}",
    `; #@! TF.CreationDate,${meta.created}`,
    `; #@! TF.GenerationSoftware,Fairbeam,Fairbeam,${meta.version}`,
    `; #@! TF.FileFunction,${plated ? "Plated" : "NonPlated"},1,${n},${plated ? "PTH" : "NPTH"}`,
    "FMAT,2",
    "METRIC",
  ];
  tools.forEach((d, i) => {
    const kinds = new Set(holes.filter((h) => Math.abs(h.d - d) < 1e-6).map((h: Drill) => h.kind));
    out.push(`; #@! TA.AperFunction,${plated ? "Plated,PTH" : "NonPlated,NPTH"},${kinds.has("via") && !kinds.has("probe") ? "ViaDrill" : "ComponentDrill"}`);
    out.push(`T${i + 1}C${f3(d)}`);
  });
  out.push("%", "G90", "G05");
  tools.forEach((d, i) => {
    out.push(`T${i + 1}`);
    for (const h of holes.filter((x) => Math.abs(x.d - d) < 1e-6)) out.push(`X${f3(h.x)}Y${f3(h.y)}`);
  });
  out.push("M30");
  return out.join("\n") + "\n";
}
