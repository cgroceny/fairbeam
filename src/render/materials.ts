// How each material of a design looks in a render, as plain data.
//
// Both render engines read this table: the in-app one (src/render/scene.ts, three.js
// MeshPhysicalMaterial) and the Blender one (a Python mirror of the same numbers). Every field maps
// to one Principled BSDF input of Blender 4.x, so the two stay consistent:
//
//   baseColor    -> Base Color (sRGB hex)
//   metallic     -> Metallic
//   roughness    -> Roughness
//   transmission -> Transmission Weight (0 = opaque, 1 = clear glass)
//   ior          -> IOR
//   opacity      -> Alpha
//   coat         -> Coat Weight (a clear lacquer layer on top; solder mask is glossy)
//   coatRoughness-> Coat Roughness
//   attenuation  -> Volume absorption: the tint of light passing through, as a colour and the
//                   distance (in multiples of the part's thickness) over which it reaches that colour
//
// This file has no three.js and no DOM, so scripts/check-render.mjs loads it into Node.
import type { Part } from "../types";

export type MaterialClass =
  | "copper" | "gold" | "silver" | "tin" | "nickel" | "aluminium" | "brass" | "steel"
  | "fr4" | "solder-mask" | "ptfe" | "ceramic" | "dielectric"
  | "sma-body" | "sma-nut" | "sma-dielectric" | "sma-pin" | "smd-body" | "smd-cap" | "marker";

export interface MaterialLook {
  id: MaterialClass;
  label: string;
  kind: "metal" | "dielectric";
  baseColor: string;
  metallic: number;
  roughness: number;
  transmission: number;
  ior: number;
  opacity: number;
  coat: number;
  coatRoughness: number;
  /** tint of light through the volume (dielectrics with transmission); null for none */
  attenuation: { color: string; thicknessMultiple: number } | null;
}

const metal = (id: MaterialClass, label: string, baseColor: string, roughness: number): MaterialLook =>
  ({ id, label, kind: "metal", baseColor, metallic: 1, roughness, transmission: 0, ior: 1.45, opacity: 1, coat: 0, coatRoughness: 0, attenuation: null });
const dielectric = (id: MaterialClass, label: string, baseColor: string, roughness: number, extra: Partial<MaterialLook> = {}): MaterialLook =>
  ({ id, label, kind: "dielectric", baseColor, metallic: 0, roughness, transmission: 0, ior: 1.5, opacity: 1, coat: 0, coatRoughness: 0, attenuation: null, ...extra });

/** The whole table. Colours follow docs/RENDER-SPEC: copper #B87333, gold #D4AF37, ... */
export const MATERIAL_LOOKS: Record<MaterialClass, MaterialLook> = {
  // ---- metals: fully metallic, only colour and roughness differ
  copper: metal("copper", "Copper", "#B87333", 0.25),
  gold: metal("gold", "Gold", "#D4AF37", 0.2),
  silver: metal("silver", "Silver", "#C8C8C8", 0.2),
  tin: metal("tin", "Tin", "#C8C8C8", 0.2),
  nickel: metal("nickel", "Nickel", "#C8C8C8", 0.2),
  aluminium: metal("aluminium", "Aluminium", "#D0D3D4", 0.35),
  brass: metal("brass", "Brass", "#C8A24A", 0.3),
  steel: metal("steel", "Steel", "#9A9DA1", 0.35),
  // ---- dielectrics
  // bare FR-4 laminate: translucent yellow-green resin and glass, slightly rough
  fr4: dielectric("fr4", "FR-4 laminate", "#C9C46A", 0.5, { transmission: 0.3, attenuation: { color: "#B9B455", thicknessMultiple: 3 } }),
  // the classic green solder mask over FR-4 (render option "Solder mask: green"): opaque and glossy
  "solder-mask": dielectric("solder-mask", "FR-4 with green solder mask", "#1B6B38", 0.32, { coat: 0.6, coatRoughness: 0.15 }),
  // Rogers, Taconic, PTFE: off-white to cream
  ptfe: dielectric("ptfe", "PTFE / Rogers laminate", "#EDE6D6", 0.6),
  ceramic: dielectric("ceramic", "Alumina / ceramic", "#F1F0EC", 0.4, { coat: 0.15, coatRoughness: 0.3 }),
  // anything else: neutral grey-beige, slightly translucent
  dielectric: dielectric("dielectric", "Dielectric", "#BDB6A8", 0.55, { transmission: 0.12 }),
  // ---- connector and component parts (src/render/ports.ts)
  "sma-body": metal("sma-body", "SMA gold-plated body", "#D4AF37", 0.22),
  "sma-nut": metal("sma-nut", "SMA hex nut", "#C8C8C8", 0.28),
  "sma-dielectric": dielectric("sma-dielectric", "SMA PTFE ring", "#F4F1EA", 0.5),
  "sma-pin": metal("sma-pin", "SMA centre pin", "#D4AF37", 0.18),
  "smd-body": dielectric("smd-body", "SMD body", "#1B1B1D", 0.45, { coat: 0.2, coatRoughness: 0.35 }),
  "smd-cap": metal("smd-cap", "SMD end cap (tin)", "#C8C8C8", 0.3),
  // the red port marker: a small glossy bead or rod
  marker: dielectric("marker", "Port marker", "#D3201F", 0.15, { coat: 1, coatRoughness: 0.05 }),
};

/** What the renderer needs to know about one part: from the bundle, plus the design's material name
 *  when the bundle is a live preview of a design (the bundle itself does not carry it). */
export interface RenderPartInfo {
  /** the design material's name or library id ("copper", "FR4", "RO4003C"), when known */
  materialName?: string;
  /** the material library entry the design's material was copied from ("fr4", "ro4003c", "pec") */
  library?: string;
  /** the part's own name and label also carry a hint ("Copper trace", "FR4 board") */
  partName?: string;
  kind: "metal" | "dielectric" | "other";
  eps_r?: number;
  tan_d?: number | null;
  /** S/m of a lossy metal; undefined for a perfect conductor */
  conductivity?: number;
  /** the part's (or its material's) own colour: wins over the table, keeps the metallic finish */
  color?: string;
  /** a vacuum carver: never rendered */
  void?: boolean;
}

/** Part info from a bundle part alone (no material name). `names` adds what the design knows. */
export function partInfo(part: Part, names?: { materialName?: string; library?: string }): RenderPartInfo {
  const metalPart = part.type === "Metal" || part.type === "ConductingSheet" || !!part.conductor;
  return {
    materialName: names?.materialName,
    library: names?.library,
    partName: [part.label, part.name].filter(Boolean).join(" "),
    kind: part.void ? "other" : metalPart ? "metal" : part.type === "Material" ? "dielectric" : "other",
    eps_r: part.material?.eps_r,
    tan_d: part.material?.tan_d,
    conductivity: part.conductor?.conductivity,
    color: /^#[0-9a-fA-F]{6}$/.test(part.color ?? "") ? part.color!.toLowerCase() : undefined,
    void: part.void,
  };
}

// name hints, case-insensitive; the first match wins
const METAL_NAMES: [RegExp, MaterialClass][] = [
  [/\b(copper|cu)\b|copper|^cu[\s_-]|[\s_-]cu$/i, "copper"],
  [/\b(gold|au)\b|gold|enig/i, "gold"],
  [/\b(silver|ag)\b|silver/i, "silver"],
  [/alumin(i)?um|\bal\b|\bal[\s_-]/i, "aluminium"],
  [/brass/i, "brass"],
  [/\btin\b|solder/i, "tin"],
  [/nickel|\bni\b/i, "nickel"],
  [/steel|\binox\b|stainless/i, "steel"],
];
const DIELECTRIC_NAMES: [RegExp, MaterialClass][] = [
  [/fr[\s_-]?4|g10|glass[\s_-]?epoxy|epoxy|laminate|pcb|substrate[\s_-]?fr/i, "fr4"],
  [/rogers|ro[\s_-]?4\d{3}|ro[\s_-]?3\d{3}|rt[\s_-]?5880|rt[\s_-]?6\d{3}|duroid|taconic|tly|rf[\s_-]?35|ptfe|teflon/i, "ptfe"],
  [/alumina|al2o3|ceramic|aln|sapphire/i, "ceramic"],
];
const AIR_NAMES = /^(air|vacuum|free[\s_-]?space|void)$/i;

/** The conductivity (S/m) a metal class stands for, to tell metals apart when the name does not. */
const CONDUCTIVITY: [number, MaterialClass][] = [
  [6.3e7, "silver"], [5.8e7, "copper"], [4.1e7, "gold"], [3.5e7, "aluminium"], [1.5e7, "brass"], [1.0e7, "steel"],
];

/** The look class of a part's material, or null for a part that is not drawn (air, vacuum, a cut-out). */
export function materialClass(info: RenderPartInfo, solderMask: "none" | "green" = "none"): MaterialClass | null {
  if (info.void || info.kind === "other") return null;
  const materialHints = [info.materialName, info.library].filter((s): s is string => !!s);
  const hints = [...materialHints, info.partName].filter((s): s is string => !!s);
  if (info.kind === "metal") {
    for (const text of hints) for (const [re, id] of METAL_NAMES) if (re.test(text)) return id;
    const sigma = info.conductivity;
    if (sigma && sigma > 0) {
      // the nearest known conductor within +-25 %, else copper
      const [rel, id] = CONDUCTIVITY.map(([s, c]) => [Math.abs(sigma - s) / s, c] as const).sort((a, b) => a[0] - b[0])[0];
      if (rel < 0.25) return id;
    }
    return "copper"; // PEC or an unknown metal
  }
  if (materialHints.some((n) => AIR_NAMES.test(n.trim()))) return null;
  const eps = info.eps_r;
  if (eps !== undefined && eps <= 1.0001 && !(info.tan_d && info.tan_d > 0)) return null; // air and vacuum
  // the design's material name first, then the part's own name only when no material name is known
  // a PCB laminate (FR-4, Rogers, Taconic...) can carry the green solder mask; a block of PTFE cannot
  const masked = (id: MaterialClass, text: string): MaterialClass => (solderMask === "green" && (id === "fr4" || (id === "ptfe" && !/ptfe|teflon/i.test(text))) ? "solder-mask" : id);
  const texts = materialHints.length ? materialHints : hints;
  for (const text of texts) for (const [re, id] of DIELECTRIC_NAMES) if (re.test(text)) return masked(id, text);
  if (eps !== undefined) {
    if (eps >= 4.0 && eps <= 4.9 && (info.tan_d ?? 0.02) >= 0.008) return masked("fr4", "");
    if (eps >= 8.5 && eps <= 11) return "ceramic";
    if (eps >= 2.0 && eps <= 3.8) return masked("ptfe", "");
  }
  return "dielectric";
}

/** The final look of a part: the table entry, with the part's own colour laid over a metal or a
 *  dielectric. A colour override keeps the material's finish (metallic stays metallic) but drops the
 *  laminate translucency tint, which would otherwise mix with it. */
export function lookFor(info: RenderPartInfo, solderMask: "none" | "green" = "none"): MaterialLook | null {
  const id = materialClass(info, solderMask);
  if (!id) return null;
  const look = MATERIAL_LOOKS[id];
  if (!info.color) return look;
  return { ...look, baseColor: info.color, attenuation: look.attenuation ? { ...look.attenuation, color: info.color } : null };
}
