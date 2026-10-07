// Fabrication file set for a printed design: Gerber X2 per copper layer, a board-profile Gerber,
// Excellon drill files, DXF R12 per layer and a README.txt with the stack-up and the caveats.
// Paths are relative to the package's fab/ folder. Pure TS (Node + browser).

import { withoutVoids } from "../lib/voidParts.ts";
import type { Bundle } from "../types";
import { fabModel, type FabModel, type FabOptions } from "./layers.ts";
import { gerberCopper, gerberProfile } from "./gerber.ts";
import { excellon } from "./excellon.ts";
import { dxf, regionRings } from "./dxf.ts";
import { regionArea } from "./polygon.ts";
import { APP_VERSION } from "../lib/appVersion.ts";

export { fabModel, DEFAULT_FAB_OPTIONS, type FabModel, type FabOptions } from "./layers.ts";

/** Fairbeam version written into the X2 GenerationSoftware attribute, the drill header and the README: the
 * running app's (package.json), which generates the files now, whatever build wrote the bundle */
export const FAB_VERSION = APP_VERSION;

export interface FabFile {
  path: string;
  description: string;
  data: string;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_") || "board";
const r3 = (v: number) => Number(v.toFixed(3));
const r4 = (v: number) => Number(v.toFixed(4));

/** ISO 8601 with the local offset, e.g. 2026-09-25T14:03:00+02:00 */
export function isoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const s = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${s}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

/** Stable file names of the set (without the fab/ prefix). */
export function fabNames(b: Bundle, m: FabModel) {
  const id = safe(b.model.id);
  return {
    copper: (layer: string) => `${id}-${layer}.gbr`,
    profile: `${id}-Edge_Cuts.gbr`,
    pth: `${id}-PTH.drl`,
    npth: `${id}-NPTH.drl`,
    dxf: (layer: string) => `${id}-${layer}.dxf`,
    layers: m.layers.map((l) => l.name),
  };
}

export function fabFiles(bundle: Bundle, opt: Partial<FabOptions> = {}, now: Date | string = new Date()): { model: FabModel; files: FabFile[] } {
  const b = withoutVoids(bundle);
  const m = fabModel(b, opt);
  if (!m.available) return { model: m, files: [] };
  const meta = { version: FAB_VERSION, created: typeof now === "string" ? now : isoLocal(now) };
  const n = fabNames(b, m);
  const files: FabFile[] = [];
  const drillCircles = m.drills.map((d) => ({ x: d.x, y: d.y, r: d.d / 2 }));
  for (const l of m.layers) {
    files.push({ path: n.copper(l.name), description: `Gerber X2, copper ${l.name} (L${l.index}, ${l.side === "Top" ? "top" : l.side === "Bot" ? "bottom" : "inner"}): ${l.parts.join(", ")}`, data: gerberCopper(b, m, l, meta) });
  }
  files.push({ path: n.profile, description: "Gerber X2, board outline (Profile / Edge.Cuts / GKO)", data: gerberProfile(b, m, meta) });
  const pth = excellon(b, m, true, meta);
  if (pth) files.push({ path: n.pth, description: `Excellon drill, plated holes (${m.drills.filter((d) => d.plated).length})`, data: pth });
  const npth = excellon(b, m, false, meta);
  if (npth) files.push({ path: n.npth, description: "Excellon drill, non-plated holes", data: npth });
  for (const l of m.layers) {
    files.push({
      path: n.dxf(l.name),
      description: `DXF R12, ${l.name} copper outlines (closed polylines; holes as inner polylines), anti-pads and drills as circles`,
      data: dxf([
        { name: l.name, color: l.side === "Top" ? 1 : l.side === "Bot" ? 5 : 3, rings: regionRings(l.regions), circles: [] },
        ...(l.clearances.length ? [{ name: `${l.name}_Antipad`, color: 2, rings: [], circles: l.clearances.map((c) => ({ x: c.x, y: c.y, r: c.d / 2 })) }] : []),
        ...(drillCircles.length ? [{ name: "Drill", color: 7, rings: [], circles: drillCircles }] : []),
      ]),
    });
  }
  files.push({
    path: n.dxf("Edge_Cuts"),
    description: "DXF R12, board outline and drills",
    data: dxf([
      { name: "Edge_Cuts", color: 7, rings: regionRings(m.outline), circles: [] },
      ...(drillCircles.length ? [{ name: "Drill", color: 7, rings: [], circles: drillCircles }] : []),
    ]),
  });
  files.unshift({ path: "README.txt", description: "Fabrication notes: stack-up, board size, layers, drills, connectors, caveats", data: fabReadme(b, m, files, meta.created) });
  return { model: m, files };
}

export function fabReadme(b: Bundle, m: FabModel, files: FabFile[], created: string): string {
  const [x0, y0, x1, y1] = m.board;
  const L: string[] = [];
  const h = (t: string) => L.push("", t, "-".repeat(t.length));
  L.push(`Fabrication files (preview): ${b.name}`, `Model ${b.model.id}, exported ${created} by Fairbeam ${FAB_VERSION}`);
  L.push("", "READ THIS FIRST", "These files are generated from the simulation model. The simulation treats copper as a", "zero-thickness perfect conductor. Clearances, minimum track/gap, tolerances, the connector", "footprint and the stack-up must be checked by you against your fab's rules. Open every", "file in a Gerber viewer (e.g. KiCad GerbView) before ordering. No solder mask, silkscreen", "or paste layers are generated.");
  h("Board");
  L.push(`Outline:       ${r3(x1 - x0)} x ${r3(y1 - y0)} mm (x ${r3(x0)} … ${r3(x1)}, y ${r3(y0)} … ${r3(y1)}; model coordinates, mm)`);
  L.push(`Outline area:  ${r3(m.outline.reduce((s, g) => s + regionArea(g), 0))} mm²`);
  L.push(`Copper layers: ${m.layers.length}`);
  h("Stack-up (top to bottom)");
  const cu = m.options.copperUm;
  const slabs = [...m.slabs].sort((a, c) => c.z1 - a.z1);
  const zs = [...new Set(slabs.flatMap((s) => [r4(s.z1), r4(s.z0)]))].sort((a, c) => c - a);
  for (const z of zs) {
    const l = m.layers.find((k) => Math.abs(k.z - z) < 1e-4);
    L.push(l ? `  ${l.name.padEnd(8)} copper, ${cu} µm assumed (simulated as 0 µm PEC), z = ${z} mm` : `  (no copper at z = ${z} mm)`);
    const s = slabs.find((k) => Math.abs(k.z1 - z) < 1e-4);
    if (s) L.push(`  ${"".padEnd(8)} ${s.name}: εr = ${s.epsR ?? "?"}${s.tanD !== null && s.tanD !== undefined ? `, tan δ = ${s.tanD}` : ""}, thickness ${r4(s.z1 - s.z0)} mm`);
  }
  L.push(`Total dielectric thickness: ${r4(zs[0] - zs[zs.length - 1])} mm (order the nearest standard thickness and re-simulate if it differs).`);
  h("Copper");
  for (const l of m.layers) {
    const a = l.regions.reduce((s, g) => s + regionArea(g), 0);
    L.push(`  ${l.name}: ${l.regions.length} region(s), ${r3(a)} mm² of copper (${l.parts.join(", ")})${l.clearances.length ? `, ${l.clearances.length} anti-pad(s)` : ""}`);
  }
  h("Drills");
  if (!m.drills.length) L.push("  none");
  for (const d of m.drills) L.push(`  ${d.kind === "probe" ? `P${d.port} probe feed` : "via"}: Ø ${d.d} mm ${d.plated ? "plated" : "non-plated"} at (${d.x}, ${d.y}) mm, ${d.from} → ${d.to}`);
  if (m.edgePorts.length) {
    h("Edge connectors");
    for (const e of m.edgePorts) L.push(`  P${e.number}: ${e.edge} edge at (${e.x}, ${e.y}) mm, ${e.width} mm wide line on ${e.layer}, ${e.R} Ω`);
  }
  if (m.components.length) {
    h("Components (not in the Gerbers)");
    for (const k of m.components) L.push(`  ${k.label}: ${k.value} ${k.type} on ${k.layer} at (${k.x}, ${k.y}) mm, pad gap ${k.span} mm`);
  }
  if (m.notes.length || m.warnings.length) {
    h("Notes");
    for (const t of m.notes) L.push(`  - ${t}`);
    for (const t of m.warnings) L.push(`  - Warning: ${t}`);
  }
  h("Files");
  L.push("  Gerber: RS-274X with X2 attributes, mm, format 4.6, copper as regions (G36/G37).");
  L.push("  Protel-style names if your fab asks: F_Cu = .GTL, B_Cu = .GBL, Edge_Cuts = .GKO, drill = .TXT/.DRL.");
  for (const f of files) L.push(`  ${f.path.padEnd(28)} ${f.description}`);
  L.push("  README.txt                   this file");
  return L.join("\n") + "\n";
}
