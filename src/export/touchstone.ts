import { portProcessingInfo } from "../lib/portProcessingMetadata.ts";
// Touchstone v1 (.s1p) export of the excited port's S11, for import into RF tools such as scikit-rf.
//
//   ! comments (ASCII only: some importers reject other bytes)
//   # GHz S RI R 50
//   <f in GHz> <Re S11> <Im S11>

import type { Bundle } from "../types";
import { sweep } from "../lib/rf.ts";
import { hasSParameterPhase, physicalPortNumber, sMatrix } from "../lib/sparams.ts";
import { APP_VERSION } from "../lib/appVersion.ts";
import { renormalisePorts } from "../import/touchstone.ts";

const ascii = (s: string) => s.replace(/Ω/g, "Ohm").replace(/[·•]/g, "-").replace(/[^\x20-\x7e]/g, "?");
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const samples = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(x => typeof x === "number" && Number.isFinite(x));
const frequencies = (f: number[]) => f.length > 0 && f.every((v, i) => Number.isFinite(v) && v >= 0 && (!i || v > f[i - 1]));
const portIds = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(x => Number.isSafeInteger(x) && x > 0) && new Set(v).size === n;

function portReferences(b: Bundle, physical: number, scalar: number, count: number): number[] | null {
  const pr = b.results?.ports[String(physical)];
  if (pr && Object.hasOwn(pr, "z_ref_f")) {
    const refs = pr.z_ref_f;
    return samples(refs, count) && refs.every(positive) ? refs : null;
  }
  if (b.ports.some(p => p.number === physical && p.type === "waveguide")) return null;
  return positive(scalar) ? Array(count).fill(scalar) : null;
}

export function touchstoneS1p(b: Bundle, exported: string = new Date().toISOString()): string | null {
  if (!hasSParameterPhase(b)) return null;
  const port = b.ports.find((p) => p.excite) ?? b.ports[0];
  const pr = port ? b.results?.ports?.[String(port.number)] : undefined;
  if (!port || !pr) return null;
  const s = sweep(b);
  if (!s) return null;
  const z0 = s.zRef;
  if (!positive(z0) || !frequencies(s.f) || !samples(s.s11Re, s.f.length) || !samples(s.s11Im, s.f.length)) return null;
  const refs = portReferences(b, port.number, z0, s.f.length);
  if (!refs) return null;
  const converted = refs.map((old, k): [number, number] => {
    if (old === z0) return [s.s11Re[k], s.s11Im[k]];
    const scale = Math.max(old, z0);
    const g = (z0 / scale - old / scale) / (z0 / scale + old / scale);
    const re = s.s11Re[k], im = s.s11Im[k];
    const dr = 1 - g * re, di = -g * im, d = dr * dr + di * di;
    return [((re - g) * dr + im * di) / d, (im * dr - (re - g) * di) / d];
  });
  if (!converted.flat().every(Number.isFinite)) return null;
  const lines = [
    `! Touchstone v1 file written by Fairbeam ${APP_VERSION}`,
    `! Project:   ${ascii(b.name)}`,
    `! Model:     ${ascii(b.model.id)}`,
    `! Simulated: ${b.created} (${ascii(b.solver.engine)}${b.generator.openems ? ` ${ascii(b.generator.openems)}` : ""}, ${ascii(b.solver.method)})`,
    `! Exported:  ${exported}`,
    ...(portProcessingInfo(b) ? [`! ${ascii(portProcessingInfo(b)!.description)}`] : []),
    port ? `! Port ${port.number}: ${port.type}, ${portProcessingInfo(b) ? "original model R" : "R"} = ${port.R} Ohm, along ${port.direction}` : "! Port 1",
    ...(Object.hasOwn(pr, "z_ref_f")
      ? ["! S11 renormalised from the per-frequency real port reference to the fixed R below"]
      : []),
    `! ${s.f.length} points, ${fmtF(s.f[0])} - ${fmtF(s.f[s.f.length - 1])} GHz, S11 as real/imaginary`,
    `# GHz S RI R ${num(z0)}`,
  ];
  for (let i = 0; i < s.f.length; i++) lines.push(`${fmtF(s.f[i])} ${fmtS(converted[i][0])} ${fmtS(converted[i][1])}`);
  return lines.join("\n") + "\n";
}

/**
 * N-port Touchstone v1 (.s2p, .s3p, ...) of results.sparams. 2-port data are column-wise on one line
 * (S11 S21 S12 S22), as the v1 format requires; N >= 3 row by row with at most four complex pairs
 * per line. Returns null for bundles without a complete multi-port S-matrix (every port excited),
 * or when actual real port references are missing/invalid. Data are renormalised to the first
 * port's scalar reference; frequency-dependent and unequal references use the full power-wave transform.
 */
export function touchstoneNPort(b: Bundle, exported: string = new Date().toISOString()): string | null {
  if (!hasSParameterPhase(b)) return null;
  const S = sMatrix(b);
  if (!S || S.legacy || S.ports.length < 2) return null;
  const n = S.ports.length;
  const raw = b.results!.sparams as unknown as Record<string, unknown>;
  // sMatrix is intentionally permissive for display. Export must not inherit guessed 50-ohm
  // references, inferred port identities or a fallback after malformed metadata.
  if (!raw || !portIds(raw.ports, n) || raw.ports.some((p, i) => p !== i + 1) || !frequencies(S.f)) return null;
  const referenceKey = ["z_ref", "zref", "z0"].find(key => Object.hasOwn(raw, key));
  if (!referenceKey) return null;
  const value = raw[referenceKey];
  const scalar = positive(value) ? Array(n).fill(value) as number[] : samples(value, n) && value.every(positive) ? value : null;
  if (!scalar) return null;
  const physical = Object.hasOwn(raw, "port_numbers") ? raw.port_numbers : raw.ports;
  if (!portIds(physical, n)) return null;
  const mapped = new Set(physical.map(String));
  if (Object.entries(b.results!.ports).some(([key, pr]) => Object.hasOwn(pr, "z_ref_f") && !mapped.has(key)) ||
      b.ports.some(p => p.type === "waveguide" && !mapped.has(String(p.number)))) return null;
  // Both summaries are written identically by the producer; compare them, not the vector
  // with its rounded summary. A mismatch cannot tell us which data were renormalized.
  if (physical.some((p, i) => {
    const pr = b.results!.ports[String(p)];
    return pr && Object.hasOwn(pr, "z_ref_f") && (!positive(pr.z_ref) || pr.z_ref !== scalar[i]);
  })) return null;
  const refs = physical.map((p, i) => portReferences(b, p, scalar[i], S.f.length));
  if (refs.some(r => r === null)) return null;
  for (const i of S.ports) for (const j of S.ports) {
    const c = S.get(i, j);
    if (!c || !samples(c.re, S.f.length) || !samples(c.im, S.f.length)) return null;
  }
  const z0 = scalar[0];
  let matrices: [number, number][][][];
  try {
    matrices = S.f.map((_, k) => {
      const m = S.ports.map(i => S.ports.map(j => [S.get(i, j)!.re[k], S.get(i, j)!.im[k]] as [number, number]));
      const old = refs.map(r => r![k]);
      return old.every(z => z === z0) ? m : renormalisePorts(m, old, z0);
    });
  } catch { return null; }
  if (!matrices.flat(3).every(Number.isFinite)) return null;
  const lines = [
    `! Touchstone v1 file written by Fairbeam ${APP_VERSION}`,
    `! Project:   ${ascii(b.name)}`,
    `! Model:     ${ascii(b.model.id)}`,
    `! Simulated: ${b.created} (${ascii(b.solver.engine)}${b.generator.openems ? ` ${ascii(b.generator.openems)}` : ""}, ${ascii(b.solver.method)})`,
    `! Exported:  ${exported}`,
    ...(portProcessingInfo(b) ? [`! ${ascii(portProcessingInfo(b)!.description)}`] : []),
    `! ${n} matrix ports (${S.ports.join(", ")}), one simulation per excited port, power-wave S-parameters`,
    `! Matrix index -> model port: ${S.ports.map(p => `${p} -> ${physicalPortNumber(S, p) ?? "unknown (invalid mapping)"}`).join(", ")}`,
    "! S-matrix renormalised to the fixed real R below using the actual per-port references",
    `! ${S.f.length} points, ${fmtF(S.f[0])} - ${fmtF(S.f[S.f.length - 1])} GHz, real/imaginary`,
    `# GHz S RI R ${num(z0)}`,
  ];
  const pair = (i: number, j: number, k: number) => {
    const c = matrices[k][i][j];
    return `${fmtS(c[0])} ${fmtS(c[1])}`;
  };
  for (let k = 0; k < S.f.length; k++) {
    const fs = fmtF(S.f[k]);
    if (n === 2) {
      lines.push(`${fs} ${pair(0, 0, k)} ${pair(1, 0, k)} ${pair(0, 1, k)} ${pair(1, 1, k)}`);
      continue;
    }
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < n; c += 4) {
        const cells: string[] = [];
        for (let j = c; j < Math.min(n, c + 4); j++) cells.push(pair(i, j, k));
        lines.push(`${i === 0 && c === 0 ? fs : " ".repeat(fs.length)} ${cells.join(" ")}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

/** Minimal Touchstone v1 N-port reader: [f in Hz, S[k][i][j] as [re, im]]. */
export function parseTouchstoneNPort(text: string, n: number): { z0: number; f: number[]; s: [number, number][][][] } {
  let unit = "GHZ";
  let format = "MA";
  let z0 = 50;
  const mult: Record<string, number> = { HZ: 1, KHZ: 1e3, MHZ: 1e6, GHZ: 1e9 };
  const tok: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.split("!")[0].trim();
    if (!t) continue;
    if (t.startsWith("#")) {
      const h = t.slice(1).trim().toUpperCase().split(/\s+/);
      for (let i = 0; i < h.length; i++) {
        if (h[i] in mult) unit = h[i];
        else if (["RI", "MA", "DB"].includes(h[i])) format = h[i];
        else if (h[i] === "R") z0 = Number(h[++i]);
      }
      continue;
    }
    for (const v of t.split(/\s+/)) tok.push(Number(v));
  }
  const rec = 1 + 2 * n * n;
  if (tok.length % rec) throw new Error(`${tok.length} numbers is not a multiple of ${rec}`);
  const f: number[] = [];
  const s: [number, number][][][] = [];
  for (let r = 0; r < tok.length; r += rec) {
    f.push(tok[r] * mult[unit]);
    const m: [number, number][][] = Array.from({ length: n }, () => new Array(n));
    for (let q = 0; q < n * n; q++) {
      const a = tok[r + 1 + 2 * q];
      const c = tok[r + 2 + 2 * q];
      let v: [number, number];
      if (format === "RI") v = [a, c];
      else {
        const mag = format === "DB" ? Math.pow(10, a / 20) : a;
        v = [mag * Math.cos((c * Math.PI) / 180), mag * Math.sin((c * Math.PI) / 180)];
      }
      // 2-port files are column-wise (S11 S21 S12 S22), N >= 3 row-wise
      const [i, j] = n === 2 ? [q % 2, Math.floor(q / 2)] : [Math.floor(q / n), q % n];
      m[i][j] = v;
    }
    s.push(m);
  }
  return { z0, f, s };
}

// Data interchange must not inherit display rounding: fixed GHz decimals can merge a narrow
// frequency grid, and fixed S decimals can turn a small but nonzero response into zero.
const fmtF = (hz: number) => (hz / 1e9).toPrecision(17);
const fmtS = (v: number) => (v < 0 ? "" : " ") + v.toPrecision(17);
const num = (v: number) => String(v);

export interface Touchstone {
  unit: string;
  parameter: string;
  format: string;
  z0: number;
  /** frequency in Hz, complex values as [re, im] */
  f: number[];
  re: number[];
  im: number[];
}

/** Minimal Touchstone v1 one-port reader (RI, MA, DB), used by the export checks. */
export function parseTouchstone(text: string): Touchstone {
  let unit = "GHZ";
  let parameter = "S";
  let format = "MA";
  let z0 = 50;
  const f: number[] = [];
  const re: number[] = [];
  const im: number[] = [];
  const mult: Record<string, number> = { HZ: 1, KHZ: 1e3, MHZ: 1e6, GHZ: 1e9 };
  for (const raw of text.split(/\r?\n/)) {
    const lineText = raw.split("!")[0].trim();
    if (!lineText) continue;
    if (lineText.startsWith("#")) {
      const t = lineText.slice(1).trim().toUpperCase().split(/\s+/);
      for (let i = 0; i < t.length; i++) {
        if (t[i] in mult) unit = t[i];
        else if (["S", "Y", "Z", "H", "G"].includes(t[i])) parameter = t[i];
        else if (["RI", "MA", "DB"].includes(t[i])) format = t[i];
        else if (t[i] === "R") z0 = Number(t[++i]);
      }
      continue;
    }
    const v = lineText.split(/\s+/).map(Number);
    if (v.length < 3 || v.some((x) => !Number.isFinite(x))) throw new Error(`Bad Touchstone data line: ${raw}`);
    f.push(v[0] * mult[unit]);
    if (format === "RI") {
      re.push(v[1]);
      im.push(v[2]);
    } else {
      const mag = format === "DB" ? Math.pow(10, v[1] / 20) : v[1];
      const ang = (v[2] * Math.PI) / 180;
      re.push(mag * Math.cos(ang));
      im.push(mag * Math.sin(ang));
    }
  }
  return { unit, parameter, format, z0, f, re, im };
}
