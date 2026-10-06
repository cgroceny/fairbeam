// CSV exports (RFC 4180, comma separated, "." decimal point, header row, LF line ends).

import type { Bundle, FarField, Signals } from "../types";
import { sweep } from "../lib/rf.ts";
import { magDb, pairLabel, phaseDeg, sMatrix } from "../lib/sparams.ts";
import { activeReflection, gammaDb, type Weight } from "../lib/array.ts";

const cell = (v: string | number | boolean | null | undefined): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : v > 0 ? "inf" : v < 0 ? "-inf" : "nan";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(header: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  return [header.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\n") + "\n";
}

const r = (v: number, d: number) => Number(v.toFixed(d));

export function sweepCsv(b: Bundle): string | null {
  const s = sweep(b);
  if (!s) return null;
  return toCsv(
    ["f_GHz", "s11_dB", "s11_re", "s11_im", "vswr", "zin_re", "zin_im"],
    s.f.map((f, i) => [r(f / 1e9, 9), r(s.s11Db[i], 4), s.s11Re[i], s.s11Im[i], Number.isFinite(s.vswr[i]) ? r(s.vswr[i], 4) : Infinity, s.zRe[i], s.zIm[i]]),
  );
}

/** Long format: one row per (θ, φ) sample; with circular-polarisation data also the RHCP / LHCP
 * partial directivities and the axial ratio (IEEE convention, as in a "circular" far-field output). */
export function patternCsv(ff: FarField): string {
  const rows: number[][] = [];
  const cp = ff.cp;
  ff.theta.forEach((t, i) => ff.phi.forEach((p, j) => rows.push(cp
    ? [t, p, ff.directivity_dbi[i][j], cp.rhcp_dbi[i][j], cp.lhcp_dbi[i][j], cp.axial_ratio_db[i][j]]
    : [t, p, ff.directivity_dbi[i][j]])));
  const header = ["theta_deg", "phi_deg", "directivity_dBi", ...(cp ? ["rhcp_dBi", "lhcp_dBi", "axial_ratio_dB"] : [])];
  return toCsv(header, rows);
}

export function bandsCsv(b: Bundle): string {
  return toCsv(
    ["f_lo_GHz", "f_hi_GHz", "f_center_GHz", "s11_min_dB", "fractional_bw", "bandwidth_MHz", "edge_lo", "edge_hi"],
    (b.results?.bands ?? []).map((x) => [r(x.f_lo / 1e9, 6), r(x.f_hi / 1e9, 6), r(x.f_center / 1e9, 6), x.s11_min_db, x.fractional_bw, r((x.f_hi - x.f_lo) / 1e6, 3), x.edge_lo, x.edge_hi]),
  );
}

export function farfieldCsv(b: Bundle): string {
  const ffs = b.results?.farfield ?? [];
  const cp = ffs.some((f) => f.cp);
  const ports = ffs.some((f) => f.port != null);
  return toCsv(
    [...(ports ? ["port"] : []), "f_GHz", "dmax_dBi", "gain_dBi", "realized_gain_dBi", "rad_efficiency", "prad_W", "pacc_W", "mirror_planes",
      ...(cp ? ["rhcp_boresight_dBi", "lhcp_boresight_dBi", "axial_ratio_boresight_dB", "axial_ratio_peak_dB"] : [])],
    ffs.map((f) => [...(ports ? [f.port ?? null] : []), r(f.f / 1e9, 6), f.dmax_dbi, f.gain_dbi ?? null, f.realized_gain_dbi ?? null, f.rad_efficiency, f.prad_w, f.pacc_w, f.mirror_planes ?? null,
      ...(cp ? [f.cp?.boresight.rhcp_dbi ?? null, f.cp?.boresight.lhcp_dbi ?? null, f.cp?.boresight.axial_ratio_db ?? null, f.cp?.peak.axial_ratio_db ?? null] : [])]),
  );
}

export function signalsCsv(b: Bundle): string | null {
  const s = b.results?.signals;
  if (!s || !("time_ns" in s)) return null;
  const g = s as Signals;
  return toCsv(
    ["time_ns", "u_inc_V", "u_ref_V", "u_tot_V", "i_tot_scaled_V"],
    g.time_ns.map((t, i) => [t, g.u_inc[i], g.u_ref[i], g.u_tot[i], g.i_tot_scaled[i]]),
  );
}

/** Every stored S_ij of an N-port matrix: dB, phase and re/im per frequency (null for 1-port bundles). */
export function sparamsCsv(b: Bundle): string | null {
  const S = sMatrix(b);
  if (!S || S.ports.length < 2) return null;
  const cols = S.pairs.map((p) => ({ label: pairLabel(p), c: S.get(p[0], p[1])! }));
  const db = cols.map((x) => magDb(x.c));
  const ph = cols.map((x) => phaseDeg(x.c));
  const header = ["f_GHz", ...cols.flatMap((x) => [`${x.label}_dB`, `${x.label}_deg`, `${x.label}_re`, `${x.label}_im`])];
  return toCsv(header, S.f.map((f, k) => [r(f / 1e9, 9), ...cols.flatMap((x, i) => [r(db[i][k], 4), r(ph[i][k], 3), x.c.re[k], x.c.im[k]])]));
}

/** Array excitation: per port amplitude/phase and the resulting active reflection at fHz. */
export function arrayWeightsCsv(b: Bundle, weights: Map<number, Weight>, fHz: number): string {
  const S = sMatrix(b);
  const g = S ? activeReflection(S, weights, fHz) : new Map();
  return toCsv(
    ["port", "amplitude_dB", "phase_deg", "f_GHz", "active_gamma_dB", "active_gamma_re", "active_gamma_im"],
    [...weights].map(([p, w]) => {
      const x = g.get(p);
      return [p, w.ampDb, w.phaseDeg, r(fHz / 1e9, 6), x ? r(gammaDb(x), 3) : null, x ? r(x[0], 6) : null, x ? r(x[1], 6) : null];
    }),
  );
}

/** Minimal CSV reader for the checks (no quoted newlines needed for these files). */
export function parseCsv(text: string): string[][] {
  return text
    .split("\n")
    .filter((l) => l.length)
    .map((l) => {
      const out: string[] = [];
      let cur = "";
      let q = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (q) {
          if (c === '"' && l[i + 1] === '"') {
            cur += '"';
            i++;
          } else if (c === '"') q = false;
          else cur += c;
        } else if (c === '"') q = true;
        else if (c === ",") {
          out.push(cur);
          cur = "";
        } else cur += c;
      }
      out.push(cur);
      return out;
    });
}
