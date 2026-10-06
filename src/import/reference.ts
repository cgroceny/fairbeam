// Reference data (Touchstone, CSV) turned into a minimal project bundle, so the comparison
// machinery (src/compare/**) can overlay it like a pinned project. S-parameter files set the
// frequency sweep; importing several files into one reference merges them (one trace, one colour).

import type { Band, Bundle } from "../types";
import { sweep } from "../lib/rf.ts";
import { parseCurves, type Curve } from "./curves.ts";
import { parseTouchstoneN, portsFromName, renormalise } from "./touchstone.ts";
// thrown errors are shown in the UI (translated); notes go into the reference, which is stored and
// exported (reports, packages), so they stay English
import { t as msg } from "../i18n/index.ts";

export type ReferenceKind = "touchstone" | "csv";

export interface ReferenceMeta {
  /** trace label, e.g. "Reference: patch.s1p" */
  label: string;
  files: string[];
  source: "Touchstone" | "CSV";
  /** false when only |S11| is known (no phase): no Smith chart or impedance */
  phaseKnown: boolean;
  /** reference impedance the S-parameters now refer to */
  zRef: number | null;
  notes: string[];
  raw: { name: string; text: string }[];
}

export type RefBundle = Bundle & { reference: ReferenceMeta };

export const isReference = (b: Bundle | null | undefined): b is RefBundle => !!b && "reference" in b && !!(b as RefBundle).reference;

export function detectKind(name: string, text: string): ReferenceKind {
  // .sNp / .ts name, a Touchstone 2 [Version] line, or an option line made only of option tokens
  // ("# GHz S MA R 50", "# S RI R 50"; not a comment such as "# S parameters")
  if (portsFromName(name) || /\.ts$/i.test(name.trim()) || /^\s*\[version\]/im.test(text)) return "touchstone";
  if (/^\s*#(?:\s*(?:thz|ghz|mhz|khz|hz|[syzhg]|ri|ma|db|r\s+[-+\d.eE]+)(?=\s|$|!))+\s*(?:!.*)?$/im.test(text)) return "touchstone";
  return "csv";
}

function emptyReference(project: Bundle | null, name: string, source: ReferenceMeta["source"]): RefBundle {
  return {
    schema: "fairbeam.project/1",
    generator: { name: "reference", version: "", openems: null, csxcad: null, python: "" },
    created: "",
    name: `Reference: ${name}`,
    model: { id: `reference:${name}`, name: `Reference ${name}`, description: "Imported reference data", params: [] },
    units: { length: "mm", length_m: 1e-3, frequency: "Hz" },
    solver: project?.solver ?? ({} as Bundle["solver"]),
    parts: [],
    ports: [{ number: 1, type: "lumped", R: 50, direction: "z", start: [0, 0, 0], stop: [0, 0, 0], excite: true }],
    half_space: project?.half_space ?? null,
    mesh: { x: [], y: [], z: [], cells: [0, 0, 0], total_cells: 0, min_cell: 0, max_cell: 0 },
    domain: { min: [0, 0, 0], max: [0, 0, 0] },
    nf2ff_box: null,
    nf2ff_center: null,
    focus: null,
    run: null,
    // an empty port result keeps sweep() non-null for a reference without an S-parameter sweep
    results: { frequency: [], ports: { 1: { s11_re: [], s11_im: [], zin_re: [], zin_im: [], z_ref: 50 } }, bands: [], farfield: [], signals: {} },
    reference: { label: `Reference: ${name}`, files: [name], source, phaseKnown: true, zRef: null, notes: [], raw: [] },
  } as unknown as RefBundle;
}

/** Contiguous |S11| < −10 dB bands (same rule as the Python side). */
export function bandsOf(f: number[], db: number[]): Band[] {
  const out: Band[] = [];
  let i = 0;
  while (i < f.length) {
    if (!(db[i] < -10)) {
      i++;
      continue;
    }
    let j = i;
    let k = i;
    while (j + 1 < f.length && db[j + 1] < -10) {
      j++;
      if (db[j] < db[k]) k = j;
    }
    out.push({ f_lo: f[i], f_hi: f[j], f_center: f[k], s11_min_db: db[k], fractional_bw: (f[j] - f[i]) / f[k], edge_lo: i === 0, edge_hi: j === f.length - 1 });
    i = j + 1;
  }
  return out;
}

function setSweep(ref: RefBundle, f: number[], re: number[], im: number[], zRef: number, phaseKnown: boolean) {
  const r = ref.results!;
  r.frequency = f;
  const z = re.map((g, k) => {
    if (!phaseKnown) return [NaN, NaN];
    const gi = im[k];
    const dr = 1 - g;
    const den = dr * dr + gi * gi || 1e-30;
    return [(zRef * ((1 + g) * dr - gi * gi)) / den, (zRef * (gi * dr + (1 + g) * gi)) / den];
  });
  r.ports = { 1: { s11_re: re, s11_im: im, zin_re: z.map((x) => x[0]), zin_im: z.map((x) => x[1]), z_ref: zRef } };
  r.bands = bandsOf(f, re.map((g, k) => 10 * Math.log10(Math.max(1e-30, g * g + im[k] * im[k]))));
  ref.ports[0].R = zRef;
  ref.reference.phaseKnown = phaseKnown;
  ref.reference.zRef = zRef;
}

const projectZ = (project: Bundle | null) => (project ? sweep(project)?.zRef ?? 50 : 50);

/** Two frequencies are "the same sample" within this relative tolerance: both blocks of one
 * file come from one sweep and agree to printing precision (7 significant digits ≈ 1e-7). */
export const GRID_RTOL = 1e-6;

const ghz = (f: number) => `${+(f / 1e9).toPrecision(7)} GHz`;

/** Why two curves cannot be combined sample by sample, or null when their frequency grids match
 * (same length, every frequency equal within GRID_RTOL). Pairing by row index alone would move
 * one curve's values onto the other's frequencies. */
export function gridMismatch(a: number[], b: number[]): string | null {
  const n = Math.min(a.length, b.length);
  for (let k = 0; k < n; k++) {
    if (Math.abs(a[k] - b[k]) > GRID_RTOL * Math.max(Math.abs(a[k]), Math.abs(b[k]), 1)) return msg("import.grid.point", { point: k + 1, a: ghz(a[k]), b: ghz(b[k]) });
  }
  if (a.length !== b.length) return msg("import.grid.length", { a: a.length, b: b.length });
  return null;
}

/** i18n keys of the curve roles named in the grid error */
const ROLE: Record<Curve["quantity"], string> = { db: "import.role.db", linear: "import.role.linear", phase: "import.role.phase", re: "import.role.re", im: "import.role.im", complex: "import.role.complex" };

/** Throws when two curves that must be combined sample by sample use different frequency grids. */
function requireSameGrid(x: Curve, y: Curve) {
  const why = gridMismatch(x.f, y.f);
  if (why) {
    throw new Error(msg("import.error.grid", { roleA: msg(ROLE[x.quantity]), a: x.name, roleB: msg(ROLE[y.quantity]), b: y.name, why }));
  }
}

function fromCurves(ref: RefBundle, curves: Curve[], project: Bundle | null, sourceLabel: string) {
  const s11 = curves.filter((c) => !c.pair || (c.pair[0] === 1 && c.pair[1] === 1));
  const pick = s11.length ? s11 : curves;
  const byQ = (q: Curve["quantity"]) => pick.find((c) => c.quantity === q);
  const z0 = projectZ(project);
  const cplx = byQ("complex");
  const re = byQ("re");
  const im = byQ("im");
  const db = byQ("db");
  const lin = byQ("linear");
  const ph = byQ("phase");
  const notes = ref.reference.notes;
  if (cplx) setSweep(ref, cplx.f, cplx.y, cplx.y2!, z0, true);
  else if (re && im) {
    requireSameGrid(re, im);
    setSweep(ref, re.f, re.y, im.y, z0, true);
  } else if ((db || lin) && ph) {
    // matched by frequency, not by row: a magnitude at 2 GHz must never land on a phase at 3 GHz
    requireSameGrid((db ?? lin)!, ph);
    const m = db ? db.y.map((v) => Math.pow(10, v / 20)) : lin!.y;
    const a = ph.y.map((d) => (d * Math.PI) / 180);
    setSweep(ref, ph.f, m.map((x, k) => x * Math.cos(a[k])), m.map((x, k) => x * Math.sin(a[k])), z0, true);
  } else if (db || lin) {
    const c = (db ?? lin)!;
    const m = db ? c.y.map((v) => Math.pow(10, v / 20)) : c.y;
    setSweep(ref, c.f, m, m.map(() => 0), z0, false);
    notes.push(`${sourceLabel}: magnitude only (no phase), so no Smith chart or impedance; reference impedance assumed ${z0} Ω as in the project`);
  } else throw new Error(msg("import.error.noS11"));
  if (curves.length > 1) notes.push(`${sourceLabel}: ${curves.length} curves in the file, used ${pick.map((c) => c.name).join(" + ")}`);
}

/**
 * Parse one reference file and add it to `existing` (or start a new reference). S-parameters
 * are renormalised to the project's port reference impedance when the file uses another one.
 */
export function importReference(name: string, text: string, project: Bundle | null, existing?: RefBundle | null): RefBundle {
  if (/^\s*<(!doctype|html|\?xml)/i.test(text)) throw new Error(msg("import.error.html"));
  if (/^\s*\{/.test(text)) throw new Error(msg("import.error.json"));
  const kind = detectKind(name, text);
  const source: ReferenceMeta["source"] = kind === "touchstone" ? "Touchstone" : "CSV";
  const ref = existing ? (structuredClone(existing) as RefBundle) : emptyReference(project, name, source);
  if (existing) {
    ref.reference.files = [...ref.reference.files, name];
    ref.reference.label = `${ref.reference.label.split(":")[0]}: ${ref.reference.files.join(" + ")}`;
    ref.name = ref.reference.label;
  }
  ref.reference.raw.push({ name, text });
  const notes = ref.reference.notes;
  if (kind === "touchstone") {
    let d = parseTouchstoneN(text, name);
    notes.push(...d.warnings.map((w) => `${name}: ${w}`));
    const z0 = projectZ(project);
    if (Math.abs(d.z0 - z0) > 1e-9) {
      notes.push(`${name}: renormalised from ${d.z0} Ω to the project's ${z0} Ω`);
      d = renormalise(d, z0);
    }
    setSweep(ref, d.f, d.s[0][0].re, d.s[0][0].im, d.z0, true);
    if (d.ports > 1) {
      const s: Record<string, { re: number[]; im: number[] }> = {};
      d.s.forEach((row, i) => row.forEach((c, j) => (s[`${i + 1},${j + 1}`] = c)));
      (ref.results as unknown as Record<string, unknown>).sparams = { ports: d.s.map((_, i) => i + 1), z_ref: d.s.map(() => d.z0), excited: [1], s };
      notes.push(`${name}: ${d.ports}-port data; the comparison uses S11`);
    }
    notes.push(`${name}: Touchstone, ${d.f.length} points, ${d.format} format, ${d.unit}`);
  } else {
    const { curves, warnings } = parseCurves(text, { guessUnit: true });
    notes.push(...warnings.map((w) => `${name}: ${w}`));
    fromCurves(ref, curves, project, name);
    notes.push(`${name}: CSV curve, ${ref.results!.frequency.length} points`);
  }
  return ref;
}
