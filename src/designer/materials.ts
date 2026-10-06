// The material library for the designer's "Material library" dialog: nominal values of common
// antenna materials with their source. The same list as python/fairbeam/materials.py (LIBRARY);
// python/tests/fixtures/material_library.json pins both (scripts/check-designer.mjs checks this
// one). Adding a library material copies its values into the design, so a design stays
// self-contained. tan_d_freq is in GHz; null means the band centre.
import type { DesignMaterial } from "./types.ts";

export interface LibraryMaterial {
  id: string;
  /** the design material name the dialog proposes */
  name: string;
  label: string;
  kind: "metal" | "dielectric";
  eps_r?: number;
  tan_d?: number;
  tan_d_freq?: number | null;
  /** source and caveats */
  note: string;
}

export const MATERIAL_LIBRARY: LibraryMaterial[] = [
  { id: "pec", name: "copper", label: "PEC (copper)", kind: "metal", note: "Perfect electric conductor (openEMS metal). Copper's finite conductivity (5.8e7 S/m) and surface roughness are not modeled; the conductor loss of printed antennas is small." },
  { id: "fr4", name: "FR4", label: "FR4", kind: "dielectric", eps_r: 4.3, tan_d: 0.02, tan_d_freq: 1, note: "Generic glass-epoxy laminate. εr 4.2–4.7 and tan δ 0.015–0.025 vary with the resin content, the supplier and the frequency: use your laminate's datasheet." },
  { id: "ro4003c", name: "RO4003C", label: "Rogers RO4003C", kind: "dielectric", eps_r: 3.38, tan_d: 0.0027, tan_d_freq: 10, note: "Rogers RO4003C datasheet: process εr 3.38 ± 0.05 and tan δ 0.0027 at 10 GHz, 23 °C (Rogers recommends the design εr 3.55 for circuit design)." },
  { id: "ro4350b", name: "RO4350B", label: "Rogers RO4350B", kind: "dielectric", eps_r: 3.48, tan_d: 0.0037, tan_d_freq: 10, note: "Rogers RO4350B datasheet: process εr 3.48 ± 0.05 and tan δ 0.0037 at 10 GHz, 23 °C (design εr 3.66)." },
  { id: "rt5880", name: "RT5880", label: "Rogers RT/duroid 5880", kind: "dielectric", eps_r: 2.2, tan_d: 0.0009, tan_d_freq: 10, note: "Rogers RT/duroid 5880 datasheet: εr 2.20 ± 0.02 and tan δ 0.0009 at 10 GHz." },
  { id: "tly5", name: "TLY-5", label: "Taconic TLY-5", kind: "dielectric", eps_r: 2.2, tan_d: 0.0009, tan_d_freq: 10, note: "Taconic (AGC) TLY-5 datasheet: εr 2.20 ± 0.02 and tan δ 0.0009 at 10 GHz." },
  { id: "alumina", name: "alumina", label: "Alumina 99.5 %", kind: "dielectric", eps_r: 9.8, tan_d: 0.0001, tan_d_freq: 10, note: "Typical of 99.5 % alumina thin-film substrates (εr 9.7–9.9, tan δ about 0.0001 at microwave frequencies); check the supplier's value." },
  { id: "ptfe", name: "PTFE", label: "PTFE (Teflon)", kind: "dielectric", eps_r: 2.1, tan_d: 0.0002, tan_d_freq: 10, note: "Bulk PTFE, typical: εr 2.0–2.1, tan δ 0.0001–0.0003 from 1 to 10 GHz." },
  { id: "air", name: "air", label: "Air / vacuum", kind: "dielectric", eps_r: 1, tan_d: 0, tan_d_freq: null, note: "Free space. The background is vacuum already; use it with a higher priority to cut an air gap or a hole out of another dielectric." },
];

/** A design material with a copy of the entry's values (python: materials.design_material). */
export function designMaterial(m: LibraryMaterial, name = m.name): DesignMaterial {
  const out: DesignMaterial = { name, kind: m.kind };
  if (m.kind === "dielectric") {
    out.eps_r = m.eps_r;
    out.tan_d = m.tan_d;
    if (m.tan_d_freq !== null && m.tan_d_freq !== undefined) out.tan_d_freq = m.tan_d_freq;
  }
  out.library = m.id;
  return out;
}

/** Conductivity presets of the metal material editor (S/m, room temperature, bulk values); PEC is
 * no conductivity. docs/DESIGNER.md#materials-and-parts. */
export const CONDUCTOR_PRESETS: { id: string; label: string; sigma: number | null }[] = [
  { id: "pec", label: "PEC (perfect conductor)", sigma: null },
  { id: "copper", label: "Copper, 5.8e7 S/m", sigma: 5.8e7 },
  { id: "aluminium", label: "Aluminium, 3.5e7 S/m", sigma: 3.5e7 },
  { id: "gold", label: "Gold, 4.1e7 S/m", sigma: 4.1e7 },
  { id: "custom", label: "Other (the value below)", sigma: null },
];

/** The preset a metal's conductivity field matches: pec when empty, custom for any other value. */
export function conductorPreset(sigma: DesignMaterial["conductivity"]): string {
  if (sigma === undefined || sigma === null || (typeof sigma === "string" && !sigma.trim())) return "pec";
  const v = typeof sigma === "number" ? sigma : Number(sigma.trim());
  return CONDUCTOR_PRESETS.find((p) => p.sigma !== null && p.sigma === v)?.id ?? "custom";
}
