// Touchstone v1 (.s1p) export of the excited port's S11, for import into RF tools such as scikit-rf.
//
//   ! comments (ASCII only: some importers reject other bytes)
//   # GHz S RI R 50
//   <f in GHz> <Re S11> <Im S11>

import type { Bundle } from "../types";
import { sweep } from "../lib/rf.ts";
import { sMatrix } from "../lib/sparams.ts";
import { APP_VERSION } from "../lib/appVersion.ts";

const ascii = (s: string) => s.replace(/Ω/g, "Ohm").replace(/[·•]/g, "-").replace(/[^\x20-\x7e]/g, "?");

export function touchstoneS1p(b: Bundle, exported: string = new Date().toISOString()): string | null {
  const s = sweep(b);
  if (!s) return null;
  const port = b.ports.find((p) => p.excite) ?? b.ports[0];
  const z0 = s.zRef;
  const lines = [
    `! Touchstone v1 file written by Fairbeam ${APP_VERSION}`,
    `! Project:   ${ascii(b.name)}`,
    `! Model:     ${ascii(b.model.id)}`,
    `! Simulated: ${b.created} (${ascii(b.solver.engine)}${b.generator.openems ? ` ${ascii(b.generator.openems)}` : ""}, ${ascii(b.solver.method)})`,
    `! Exported:  ${exported}`,
    port ? `! Port ${port.number}: ${port.type}, R = ${port.R} Ohm, along ${port.direction}` : "! Port 1",
    ...(port?.type === "waveguide"
      ? [`! ${ascii(port.mode ?? "TE")} waveguide port: S11 is referred to the frequency-dependent TE wave impedance`,
         "! (as is usual for waveguide ports); the R below is its band-centre value, for the header only"]
      : []),
    `! ${s.f.length} points, ${fmtF(s.f[0])} - ${fmtF(s.f[s.f.length - 1])} GHz, S11 as real/imaginary`,
    `# GHz S RI R ${num(z0)}`,
  ];
  for (let i = 0; i < s.f.length; i++) lines.push(`${fmtF(s.f[i])} ${fmtS(s.s11Re[i])} ${fmtS(s.s11Im[i])}`);
  return lines.join("\n") + "\n";
}

/**
 * N-port Touchstone v1 (.s2p, .s3p, ...) of results.sparams. 2-port data are column-wise on one line
 * (S11 S21 S12 S22), as the v1 format requires; N >= 3 row by row with at most four complex pairs
 * per line. Returns null for bundles without a complete multi-port S-matrix (every port excited),
 * or when the ports have different reference impedances (v1 allows only one; use the Python
 * `fairbeam touchstone`, which renormalises).
 */
export function touchstoneNPort(b: Bundle, exported: string = new Date().toISOString()): string | null {
  const S = sMatrix(b);
  if (!S || S.legacy || S.ports.length < 2) return null;
  const n = S.ports.length;
  for (const i of S.ports) for (const j of S.ports) if (!S.get(i, j)) return null;
  const z0 = S.zRef[0];
  if (S.zRef.some((z) => Math.abs(z - z0) > 1e-9)) return null;
  const lines = [
    `! Touchstone v1 file written by Fairbeam ${APP_VERSION}`,
    `! Project:   ${ascii(b.name)}`,
    `! Model:     ${ascii(b.model.id)}`,
    `! Simulated: ${b.created} (${ascii(b.solver.engine)}${b.generator.openems ? ` ${ascii(b.generator.openems)}` : ""}, ${ascii(b.solver.method)})`,
    `! Exported:  ${exported}`,
    `! ${n} ports (${S.ports.join(", ")}), one simulation per excited port, power-wave S-parameters`,
    `! ${S.f.length} points, ${fmtF(S.f[0])} - ${fmtF(S.f[S.f.length - 1])} GHz, real/imaginary`,
    `# GHz S RI R ${num(z0)}`,
  ];
  const pair = (i: number, j: number, k: number) => {
    const c = S.get(S.ports[i], S.ports[j])!;
    return `${fmtS(c.re[k])} ${fmtS(c.im[k])}`;
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

const fmtF = (hz: number) => (hz / 1e9).toFixed(9);
const fmtS = (v: number) => (v < 0 ? "" : " ") + v.toFixed(8);
const num = (v: number) => String(Number(v.toFixed(6)));

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
