// Touchstone v1 and v2 reader for any port count (.s1p … .sNp, .ts). python/fairbeam/touchstone.py
// implements the same rules with the same messages; both are checked against
// examples/import-fixtures/touchstone/expected.json.
//
// - Option line "# <unit> <parameter> <format> R <ref>" (any order, any case, the first one counts;
//   defaults GHz S MA R 50). Units Hz/kHz/MHz/GHz(/THz), formats RI/MA/DB.
// - Y and Z are converted to S (v1: normalised to R; v2: in siemens/ohms); H and G are refused.
// - Data may wrap onto continuation lines anywhere; "!" starts a comment anywhere. 2-port data are
//   S11 S21 S12 S22 (v1, v2 "21_12") or S11 S12 S21 S22 (v2 "12_21"); N ≥ 3 row by row.
// - A 2-port frequency that is not above the previous one starts the noise block (v1), as does
//   [Noise Data] (v2); noise parameters are counted and skipped.
// - v2 keywords: [Version], [Number of Ports], [Two-Port Data Order], [Number of Frequencies],
//   [Matrix Format] Full/Lower/Upper (mirrored to the full matrix), [Reference] (per-port values;
//   different ones are renormalised to the option line's R, so the result has a single z0),
//   [Network Data], [Noise Data], [Begin/End Information] (skipped), [End] (stops reading).
// Renormalisation to another (equal, real) reference: S' = (S − ρI)(I − ρS)⁻¹, ρ = (R' − R)/(R' + R).

import { normalise, toNumber } from "./text.ts";
// thrown errors are shown in the UI (translated); warnings become reference notes, which go into
// exported reports and packages, so they stay English
import { t as msg } from "../i18n/index.ts";

export interface NPortData {
  ports: number;
  /** Hz */
  f: number[];
  /** reference impedance of the data, Ω */
  z0: number;
  /** s[i][j] = { re, im } over f, zero-based port indices (always S-parameters) */
  s: { re: number[]; im: number[] }[][];
  /** the file's frequency unit */
  unit: string;
  format: string;
  /** parameter as written in the file (S, Y or Z; Y and Z are converted to S) */
  parameter: string;
  version: 1 | 2;
  noiseFrequencies: number;
  warnings: string[];
}

const UNITS: Record<string, number> = { HZ: 1, KHZ: 1e3, MHZ: 1e6, GHZ: 1e9, THZ: 1e12 };
const UNIT_NAMES: Record<string, string> = { HZ: "Hz", KHZ: "kHz", MHZ: "MHz", GHZ: "GHz", THZ: "THz" };

type C = [number, number];
const cadd = (a: C, b: C): C => [a[0] + b[0], a[1] + b[1]];
const cmul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const csub = (a: C, b: C): C => [a[0] - b[0], a[1] - b[1]];
const cdiv = (a: C, b: C): C => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const cscale = (a: C, k: number): C => [a[0] * k, a[1] * k];
const matmul = (a: C[][], b: C[][]): C[][] =>
  a.map((row) => b[0].map((_, j) => row.reduce<C>((acc, x, m) => cadd(acc, cmul(x, b[m][j])), [0, 0])));
const eye = (n: number): C[][] => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? [1, 0] : [0, 0]) as C));

export function portsFromName(name: string): number | null {
  const m = /\.s(\d+)p$/i.exec(name.trim());
  return m ? Number(m[1]) : null;
}

function numbers(raw: string, line: string): number[] {
  const vals = line.split(/[\s,]+/).filter(Boolean).map((x) => toNumber(x));
  if (vals.some((v) => !Number.isFinite(v))) throw new Error(msg("import.ts.notNumber", { text: raw.trim() }));
  return vals;
}

/**
 * Parse Touchstone v1/v2 text. The port count comes from [Number of Ports], else the `.sNp`
 * suffix of `fileName`, else the first data line (3 numbers: 1 port, 9: 2 ports).
 */
export function parseTouchstoneN(text: string, fileName = ""): NPortData {
  const warnings: string[] = [];
  let unit = "GHZ";
  let param = "S";
  let format = "MA";
  let rOpt = 50;
  let option = false;
  let version: 1 | 2 = 1;
  let portsKw: number | null = null;
  let order: string | null = null;
  let nFreq: number | null = null;
  let matrix = "FULL";
  let reference: number[] | null = null;
  let refOpen = false;
  let section: "network" | "noise" | "info" = "network";
  const net: { raw: string; vals: number[] }[] = [];
  let noise: { raw: string; vals: number[] }[] = [];
  for (const raw of normalise(text)) {
    const line = raw.split("!")[0].trim();
    if (!line) continue;
    if (section === "info") {
      if (/^\[\s*end\s+information\s*\]/i.test(line)) section = "network";
      continue;
    }
    if (line.startsWith("[")) {
      const m = /^\[([^\]]*)\]\s*(.*)$/.exec(line);
      if (!m) throw new Error(msg("import.ts.badKeyword", { line }));
      const kw = m[1].toLowerCase().split(/\s+/).filter(Boolean).join(" ");
      const arg = m[2].trim();
      refOpen = false;
      if (kw === "version") {
        if (!/^2(\.\d+)?$/.test(arg)) throw new Error(msg("import.ts.version", { value: arg }));
        version = 2;
      } else if (kw === "number of ports") {
        if (!/^\d+$/.test(arg) || Number(arg) < 1) throw new Error(msg("import.ts.badPorts", { value: arg }));
        portsKw = Number(arg);
      } else if (kw === "two-port data order") {
        if (arg !== "12_21" && arg !== "21_12") throw new Error(msg("import.ts.badOrder", { value: arg }));
        order = arg;
      } else if (kw === "number of frequencies") {
        if (!/^\d+$/.test(arg)) throw new Error(msg("import.ts.badFrequencies", { value: arg }));
        nFreq = Number(arg);
      } else if (kw === "matrix format") {
        if (!["FULL", "LOWER", "UPPER"].includes(arg.toUpperCase())) throw new Error(msg("import.ts.badMatrix", { value: arg }));
        matrix = arg.toUpperCase();
      } else if (kw === "reference") {
        if (portsKw === null) throw new Error(msg("import.ts.referenceOrder"));
        reference = arg ? numbers(raw, arg) : [];
        refOpen = reference.length < portsKw;
      } else if (kw === "network data") section = "network";
      else if (kw === "noise data") section = "noise";
      else if (kw === "begin information") section = "info";
      else if (kw === "end") break;
      else if (kw === "mixed-mode order") throw new Error(msg("import.ts.mixedMode"));
      else if (kw !== "number of noise frequencies") warnings.push(`Touchstone 2 keyword ignored: [${m[1].trim()}]`);
      continue;
    }
    if (line.startsWith("#")) {
      if (option) continue; // only the first option line counts
      option = true;
      const t = line.slice(1).trim().toUpperCase().split(/\s+/);
      for (let i = 0; i < t.length; i++) {
        if (t[i] in UNITS) unit = t[i];
        else if (["S", "Y", "Z", "H", "G"].includes(t[i])) param = t[i];
        else if (["RI", "MA", "DB"].includes(t[i])) format = t[i];
        else if (t[i] === "R") rOpt = i + 1 < t.length ? toNumber(t[++i]) : NaN;
      }
      if (param === "H" || param === "G") throw new Error(msg("import.ts.parameter", { param }));
      if (!Number.isFinite(rOpt) || rOpt <= 0) throw new Error(msg("import.ts.badOptionZ"));
      continue;
    }
    const vals = numbers(raw, line);
    if (refOpen) {
      reference!.push(...vals);
      refOpen = reference!.length < portsKw!;
    } else if (section === "noise") noise.push({ raw, vals });
    else net.push({ raw, vals });
  }
  if (!option) warnings.push("No option line: assumed # GHz S MA R 50");
  if (!net.length) throw new Error(msg("import.ts.noData"));

  const fromName = portsFromName(fileName);
  let N = portsKw ?? fromName ?? 0;
  if (portsKw && fromName && portsKw !== fromName) warnings.push(`[Number of Ports] ${portsKw} overrides the file name's ${fromName}`);
  if (!N) {
    N = net[0].vals.length === 3 ? 1 : net[0].vals.length === 9 ? 2 : 0;
    if (!N) throw new Error(msg("import.ts.portCount"));
    warnings.push(`Port count inferred from the data: ${N}`);
  }

  const count = matrix === "FULL" ? N * N : (N * (N + 1)) / 2;
  const per = 1 + 2 * count;
  const recs: number[][] = [];
  let cur: number[] = [];
  let total = 0;
  for (let idx = 0; idx < net.length; idx++) {
    const { vals } = net[idx];
    if (!cur.length && recs.length && vals[0] <= recs[recs.length - 1][0]) {
      const rest = net.slice(idx);
      if (N !== 2 || rest.some((r) => r.vals.length !== 5)) throw new Error(msg("import.ts.notIncreasing"));
      noise = [...rest, ...noise]; // v1: a 2-port frequency that drops back starts the noise block
      break;
    }
    total += vals.length;
    cur.push(...vals);
    while (cur.length >= per) {
      recs.push(cur.slice(0, per));
      cur = cur.slice(per);
    }
  }
  if (cur.length || !recs.length) throw new Error(msg("import.ts.notFit", { ports: N, total, per }));
  for (const r of noise) if (r.vals.length !== 5) throw new Error(msg("import.ts.noise", { text: r.raw.trim() }));
  if (noise.length) warnings.push(`Noise parameters ignored (${noise.length} frequencies)`);
  if (nFreq !== null && nFreq !== recs.length) throw new Error(msg("import.ts.frequencyCount", { expected: nFreq, found: recs.length }));

  const nf = recs.length;
  const f = recs.map((r) => r[0] * UNITS[unit]);
  for (let k = 1; k < nf; k++) if (f[k] <= f[k - 1]) throw new Error(msg("import.ts.notIncreasing"));
  // (i, j) of each stored value
  const idx: [number, number][] = [];
  if (matrix === "FULL") {
    if (N === 2 && order === null && version === 2) warnings.push("[Two-Port Data Order] missing in a version 2 file: assumed 21_12");
    const colMajor = N === 2 && (order ?? "21_12") === "21_12"; // S11 S21 S12 S22
    for (let q = 0; q < N * N; q++) idx.push(colMajor ? [q % 2, Math.floor(q / 2)] : [Math.floor(q / N), q % N]);
  } else {
    for (let i = 0; i < N; i++) for (let j = matrix === "LOWER" ? 0 : i; j < (matrix === "LOWER" ? i + 1 : N); j++) idx.push([i, j]);
  }
  let mats: C[][][] = recs.map((r) => {
    const m: C[][] = Array.from({ length: N }, () => Array.from({ length: N }, () => [0, 0] as C));
    idx.forEach(([i, j], q) => {
      const a = r[1 + 2 * q];
      const b = r[2 + 2 * q];
      let v: C;
      if (format === "RI") v = [a, b];
      else {
        const mag = format === "DB" ? Math.pow(10, a / 20) : a;
        const ang = (b * Math.PI) / 180;
        v = [mag * Math.cos(ang), mag * Math.sin(ang)];
      }
      m[i][j] = v;
      if (matrix !== "FULL") m[j][i] = v;
    });
    return m;
  });

  if (reference && reference.length !== N) throw new Error(msg("import.ts.referenceCount", { ports: N, found: reference.length }));
  const zp = reference ?? new Array<number>(N).fill(rOpt);
  if (zp.some((z) => !Number.isFinite(z) || z <= 0)) throw new Error(msg("import.ts.badReferenceZ"));
  const z0 = zp.every((z) => Math.abs(z - zp[0]) < 1e-12) ? zp[0] : rOpt;
  if (param === "S") {
    if (zp.some((z) => Math.abs(z - z0) > 1e-12)) {
      mats = mats.map((m) => renormalisePorts(m, zp, z0));
      warnings.push(`Per-port references ${zp.map((z) => `${z}`).join(", ")} ohm renormalised to ${z0} ohm`);
    }
  } else {
    // v1 stores Y and Z normalised to R; v2 in siemens and ohms
    const k = (version === 1 ? (param === "Z" ? rOpt : 1 / rOpt) : 1) * (param === "Z" ? 1 / z0 : z0);
    const I = eye(N);
    mats = mats.map((m) => {
      const x = m.map((row) => row.map((v) => cscale(v, k)));
      const plus = x.map((row, i) => row.map((v, j) => cadd(I[i][j], v)));
      const minus = x.map((row, i) => row.map((v, j) => (param === "Z" ? csub(v, I[i][j]) : csub(I[i][j], v))));
      let inv: C[][];
      try {
        inv = cinv(plus);
      } catch {
        throw new Error(msg("import.ts.singular", { param }));
      }
      // (x ∓ I) and (x + I)⁻¹ commute: S = (x + I)⁻¹ (x − I) for Z, (I + y)⁻¹ (I − y) for Y
      return matmul(inv, minus);
    });
    warnings.push(`${param}-parameters converted to S (reference ${z0} ohm)`);
  }
  const s = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => ({ re: mats.map((m) => m[i][j][0]), im: mats.map((m) => m[i][j][1]) })),
  );
  return { ports: N, f, z0, s, unit: UNIT_NAMES[unit], format, parameter: param, version, noiseFrequencies: noise.length, warnings };
}

/** Inverse of a complex matrix (Gauss–Jordan with partial pivoting). */
export function cinv(m: C[][]): C[][] {
  const n = m.length;
  const a = m.map((row, i) => [...row.map((x) => [...x] as C), ...Array.from({ length: n }, (_, j) => (i === j ? [1, 0] : [0, 0]) as C)]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.hypot(...a[r][c]) > Math.hypot(...a[p][c])) p = r;
    if (Math.hypot(...a[p][c]) < 1e-15) throw new Error(msg("import.ts.singularRenorm"));
    [a[c], a[p]] = [a[p], a[c]];
    const piv = a[c][c];
    for (let j = 0; j < 2 * n; j++) a[c][j] = cdiv(a[c][j], piv);
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c];
      for (let j = 0; j < 2 * n; j++) a[r][j] = csub(a[r][j], cmul(f, a[c][j]));
    }
  }
  return a.map((row) => row.slice(n));
}

/**
 * One S-matrix from per-port (real) references `zOld` to a common `zNew` (power waves):
 * S' = C (S − G)(I − G S)⁻¹ C⁻¹, G_i = (Z' − Z_i)/(Z' + Z_i), C_i = (Z_i + Z')/(2√(Z_i Z')).
 */
function renormalisePorts(S: C[][], zOld: number[], zNew: number): C[][] {
  const n = S.length;
  const g = zOld.map((z) => (zNew - z) / (zNew + z));
  const c = zOld.map((z) => (z + zNew) / (2 * Math.sqrt(z * zNew)));
  const A = S.map((row, i) => row.map((x, j) => (i === j ? csub(x, [g[i], 0]) : x)));
  const B = S.map((row, i) => row.map((x, j) => csub(i === j ? [1, 0] : [0, 0], cscale(x, g[i]))));
  const M = matmul(A, cinv(B));
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => cscale(M[i][j], c[i] / c[j])));
}

/** S-parameters referred to a new (common, real) reference impedance. */
export function renormalise(d: NPortData, z1: number): NPortData {
  if (Math.abs(z1 - d.z0) < 1e-9) return d;
  const N = d.ports;
  const rho = (z1 - d.z0) / (z1 + d.z0);
  const out = Array.from({ length: N }, () => Array.from({ length: N }, () => ({ re: new Array<number>(d.f.length), im: new Array<number>(d.f.length) })));
  for (let k = 0; k < d.f.length; k++) {
    const S: C[][] = d.s.map((row) => row.map((c) => [c.re[k], c.im[k]] as C));
    const A = S.map((row, i) => row.map((x, j) => (i === j ? csub(x, [rho, 0]) : x)));
    const B = S.map((row, i) => row.map((x, j) => csub(i === j ? [1, 0] : [0, 0], cmul([rho, 0], x))));
    const Bi = cinv(B);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      let acc: C = [0, 0];
      for (let m = 0; m < N; m++) {
        const p = cmul(A[i][m], Bi[m][j]);
        acc = [acc[0] + p[0], acc[1] + p[1]];
      }
      out[i][j].re[k] = acc[0];
      out[i][j].im[k] = acc[1];
    }
  }
  return { ...d, s: out, z0: z1 };
}
