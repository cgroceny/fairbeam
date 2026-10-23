// Stored samples only: no resampling, hidden NF2FF pass, or reconstructed missing gain/CP.
import type { Bundle, EfficiencySweep, FarField, RadiationSweep } from "../types";
import { axialRatioReadouts } from "./circular.ts";

export const RADIATION_QUANTITIES = ["d_peak_dbi", "d_boresight_dbi", "gain_peak_dbi", "gain_boresight_dbi", "realized_peak_dbi", "realized_boresight_dbi", "ar_peak_db", "ar_boresight_db"] as const;
export type RadiationQuantity = typeof RADIATION_QUANTITIES[number];
export const isRadiationQuantity = (q: unknown): q is RadiationQuantity => (RADIATION_QUANTITIES as readonly unknown[]).includes(q);
export const radiationUnit = (q: RadiationQuantity) => q.startsWith("ar_") ? "dB" : "dBi";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const value = (v: unknown): number | null => finite(v) ? v : null;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const axis = (a: unknown, lo: number, hi = Infinity): a is number[] => Array.isArray(a) && a.length > 0 && a.every((v, i) => finite(v) && v >= lo && v <= hi && (!i || v > a[i - 1]));

/** An invalid alignment/provenance record is rejected whole; legacy efficiency is untouched. */
export function validRadiationSweep(s: unknown): s is EfficiencySweep & { radiation: RadiationSweep } {
  if (!obj(s) || !axis(s.f, Number.MIN_VALUE) || !obj(s.radiation)) return false;
  const r = s.radiation, n = s.f.length;
  const column = (v: unknown) => Array.isArray(v) && v.length === n && v.every(x => x === null || finite(x));
  if (r.source !== "band-efficiency-nf2ff" || !axis(r.theta, 0, 180) || !axis(r.phi, 0, 360) || typeof r.cp_requested !== "boolean" || r.ar_mask_db !== 20) return false;
  if (![...RADIATION_QUANTITIES.filter(k => !k.startsWith("ar_")), "mismatch_efficiency", "peak_theta_deg", "peak_phi_deg"].every(k => column(r[k]))) return false;
  for (const key of ["ar_peak_db", "ar_boresight_db"]) {
    if (r.cp_requested ? !column(r[key]) : r[key] !== undefined) return false;
    if (Array.isArray(r[key]) && !r[key].every(v => v === null || (finite(v) && v >= 0 && v <= 60))) return false;
  }
  return true;
}

export type RadiationReliability = "accepted-power-pass" | "unreliable" | "unassessed";
export interface RadiationSample {
  port: number | null; f: number;
  source: "band-efficiency-nf2ff" | "stored-pattern";
  reliability: RadiationReliability; paccError: number | null;
  theta: number | null; phi: number | null;
  thetaAxis: number[]; phiAxis: number[]; cpRequested: boolean;
  radiationEfficiency: number | null; mismatchEfficiency: number | null;
  raw: Record<RadiationQuantity, number | null>;
  values: Record<RadiationQuantity, number | null>;
}
const ownPort = (b: Bundle) => (b.ports.find(p => p.excite) ?? b.ports[0])?.number ?? null;
const physicalPort = (p: unknown, fallback: number | null) => p === undefined ? fallback : finite(p) && Number.isInteger(p) && p > 0 ? p : null;
const emptyValues = (): Record<RadiationQuantity, number | null> => Object.fromEntries(RADIATION_QUANTITIES.map(q => [q, null])) as Record<RadiationQuantity, number | null>;

function reliability(s: EfficiencySweep, i: number): RadiationReliability {
  const n = s.f.length;
  const flags = Array.isArray(s.reliable) && s.reliable.length === n && s.reliable.every(v => typeof v === "boolean");
  const errors = Array.isArray(s.pacc_error) && s.pacc_error.length === n;
  const err = errors ? value(s.pacc_error![i]) : null;
  if (flags && s.reliable![i] === false) return "unreliable";
  if (err !== null && (err < 0 || err > 0.1)) return "unreliable";
  if (!Array.isArray(s.pacc_w) || s.pacc_w.length !== n || !finite(s.pacc_w[i]) || s.pacc_w[i] <= 0) return "unreliable";
  return flags && errors && err !== null && s.reliable![i] ? "accepted-power-pass" : "unassessed";
}

/** Physical port IDs never become dense array indices. Multiple sweeps remain separate. */
export function radiationBands(b: Bundle): { port: number | null; sweep: EfficiencySweep & { radiation: RadiationSweep }; samples: RadiationSample[] }[] {
  const sweeps: unknown[] = Array.isArray(b.results?.efficiency) ? b.results.efficiency : [];
  return sweeps.filter(validRadiationSweep).map(s => ({ port: physicalPort(s.port, ownPort(b)), sweep: s, samples: s.f.map((f, i) => {
    const status = reliability(s, i), raw = emptyValues(), values = emptyValues();
    for (const q of RADIATION_QUANTITIES) {
      raw[q] = value(s.radiation[q]?.[i]);
      if (status === "accepted-power-pass") values[q] = raw[q];
    }
    if (!s.radiation.theta.some(t => Math.abs(t) < 1e-9)) {
      for (const q of RADIATION_QUANTITIES) if (q.includes("boresight")) values[q] = null;
    }
    if (raw.d_peak_dbi === null) values.ar_peak_db = values.ar_boresight_db = null;
    // Backend already masks before decimal rounding. Allow only floating-point
    // subtraction noise at the exact 20 dB boundary when reading stored scalars.
    else if (raw.d_boresight_dbi === null || raw.d_boresight_dbi + 20 < raw.d_peak_dbi - 1e-9 || !s.radiation.theta.some(t => Math.abs(t) < 1e-9)) values.ar_boresight_db = null;
    return { port: physicalPort(s.port, ownPort(b)), f, source: "band-efficiency-nf2ff", reliability: status, paccError: value(s.pacc_error?.[i]), theta: value(s.radiation.peak_theta_deg[i]), phi: value(s.radiation.peak_phi_deg[i]), thetaAxis: s.radiation.theta, phiAxis: s.radiation.phi, cpRequested: s.radiation.cp_requested, radiationEfficiency: value(s.rad_efficiency?.[i]), mismatchEfficiency: value(s.radiation.mismatch_efficiency[i]), raw, values };
  }) }));
}

/** Detailed stored patterns are separately labelled points. No inferred/interpolated efficiencies. */
export function radiationPatternPoints(b: Bundle): RadiationSample[] {
  return (b.results?.farfield ?? []).filter(ff => finite(ff.f) && ff.f > 0).map((ff: FarField) => {
    const raw = emptyValues(), ar = axialRatioReadouts(ff);
    raw.d_peak_dbi = value(ff.dmax_dbi);
    raw.gain_peak_dbi = value(ff.gain_dbi);
    raw.realized_peak_dbi = value(ff.realized_gain_dbi);
    const pole = ff.theta.findIndex(x => finite(x) && Math.abs(x) <= 1e-9);
    raw.d_boresight_dbi = pole >= 0 ? value(ff.directivity_dbi[pole]?.[0]) : null;
    // Apply only the offset present in THIS stored pattern. Missing scalars stay missing.
    for (const [peak, bore] of [["gain_peak_dbi", "gain_boresight_dbi"], ["realized_peak_dbi", "realized_boresight_dbi"]] as const) {
      if (raw[peak] !== null && raw.d_peak_dbi !== null && raw.d_boresight_dbi !== null) raw[bore] = raw.d_boresight_dbi + raw[peak] - raw.d_peak_dbi;
    }
    raw.ar_peak_db = ar.peak; raw.ar_boresight_db = ar.boresight;
    let theta: number | null = null, phi: number | null = null, best = -Infinity;
    ff.directivity_dbi.forEach((row, i) => row.forEach((d, j) => { if (finite(d) && d > best) { best = d; theta = value(ff.theta[i]); phi = value(ff.phi[j]); } }));
    return { port: physicalPort(ff.port, ownPort(b)), f: ff.f, source: "stored-pattern", reliability: "unassessed", paccError: null, theta, phi, thetaAxis: ff.theta, phiAxis: ff.phi, cpRequested: !!ff.cp, radiationEfficiency: value(ff.rad_efficiency), mismatchEfficiency: null, raw, values: { ...raw } };
  });
}

/** Passing SAMPLES, not an interpolated/converged bandwidth. Gaps split intervals. */
export function sampledArIntervals(samples: RadiationSample[], q: "ar_peak_db" | "ar_boresight_db") {
  const ranges: { lo: number; hi: number; count: number; left: "edge" | "gap" | "above"; right: "edge" | "gap" | "above" }[] = [];
  const passing = (i: number) => samples[i]?.values[q] !== null && finite(samples[i]?.values[q]) && samples[i].values[q]! <= 3;
  const boundary = (i: number): "edge" | "gap" | "above" => i < 0 || i >= samples.length ? "edge" : !finite(samples[i].values[q]) ? "gap" : "above";
  for (let i = 0; i < samples.length; i++) if (passing(i)) {
    const start = i;
    while (i + 1 < samples.length && passing(i + 1)) i++;
    ranges.push({ lo: samples[start].f, hi: samples[i].f, count: i - start + 1, left: boundary(start - 1), right: boundary(i + 1) });
  }
  return ranges;
}

/** Plot and CSV share exact values. Raw rejected values are separate audit columns. */
export function radiationTable(b: Bundle, quantities: readonly RadiationQuantity[] = RADIATION_QUANTITIES) {
  const samples = [...radiationBands(b).flatMap(d => d.samples), ...radiationPatternPoints(b)];
  return {
    header: ["Port", "f (GHz)", "Source", "Accepted-power status", "Pacc relative error", "Sampled peak theta (deg)", "Sampled peak phi (deg)", "theta axis (deg)", "phi axis (deg)", "CP requested/present", "AR mask below Dmax (dB)", "Radiation efficiency (ratio)", "Same-pass mismatch efficiency (ratio)", ...quantities.flatMap(q => [`${q} (${radiationUnit(q)})`, `${q} raw (${radiationUnit(q)})`])],
    rows: samples.map(s => [s.port, s.f / 1e9, s.source, s.reliability, s.paccError, s.theta, s.phi, s.thetaAxis.join(";"), s.phiAxis.join(";"), String(s.cpRequested), 20, s.radiationEfficiency, s.mismatchEfficiency, ...quantities.flatMap(q => [s.values[q], s.raw[q]])] as (string | number | null)[]),
  };
}
