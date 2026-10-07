// Far-field quantities beside the stored directivity (docs/BUNDLE.md FarField): the gain and the
// realized-gain patterns, the circular-polarisation partial directivities, and the efficiencies
// (radiation, mismatch 1 − |S11|², total). The same formulas as the exporter (python/fairbeam
// simulation.py): gain = D + 10·log10(η_rad), realized gain = D + 10·log10(η_rad·(1 − |S11(f)|²)) with
// |S11|² of the driven port interpolated linearly at the far-field frequency. Pure (no Solid, no DOM),
// so scripts/check-farfield-quantities.mjs runs it on the example bundles.
import type { Bundle, EfficiencySweep, FarField, PortResult } from "../types";
import { mainBeam } from "./array.ts";
import { efficiencyWarningUi } from "./runText.ts";
import { t } from "../i18n/index.ts";

export type PatternQuantity = "directivity" | "gain" | "realized" | "rhcp" | "lhcp";
export const PATTERN_QUANTITIES: readonly PatternQuantity[] = ["directivity", "gain", "realized", "rhcp", "lhcp"];
/** The quantity's name in the UI language, read at render time (exported data use the English
 * name, tEn(`farfield.quantity.${q}`)). */
export const QUANTITY_LABEL: Record<PatternQuantity, string> = {
  get directivity() { return t("farfield.quantity.directivity"); },
  get gain() { return t("farfield.quantity.gain"); },
  get realized() { return t("farfield.quantity.realized"); },
  get rhcp() { return t("farfield.quantity.rhcp"); },
  get lhcp() { return t("farfield.quantity.lhcp"); },
};
export const isPatternQuantity = (v: unknown): v is PatternQuantity => (PATTERN_QUANTITIES as readonly unknown[]).includes(v);

export const toDb = (ratio: number) => (ratio > 0 ? 10 * Math.log10(ratio) : Number.NaN);

/** The port driven for a far-field entry: its own `port` (multi-port runs), else the excited port. */
export function drivenPort(b: Bundle, ff?: Pick<FarField, "port"> | null): number | null {
  if (ff?.port != null) return ff.port;
  const p = b.ports.find((x) => x.excite) ?? b.ports[0];
  return p ? p.number : null;
}

/** The reflection of a driven port (each driven port has its own from the run that drove it). */
export function portReflection(b: Bundle, port: number | null): PortResult | null {
  const ports = b.results?.ports ?? {};
  if (port != null && ports[String(port)]) return ports[String(port)];
  const own = drivenPort(b);
  return own != null ? ports[String(own)] ?? null : null;
}

/** Linear interpolation of ys at x (clamped to the ends); NaN samples are skipped. */
export function interpAt(xs: readonly number[], ys: readonly number[], x: number): number {
  const pts: [number, number][] = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pts.push([xs[i], ys[i]]);
  if (!pts.length || !Number.isFinite(x)) return Number.NaN;
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][0] <= x) lo = mid; else hi = mid;
  }
  const [x0, y0] = pts[lo], [x1, y1] = pts[hi];
  return x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

/** |S11|² of a port over the band (its own reflection), or null without one. */
export function reflectionPower(b: Bundle, port: number | null): { f: number[]; g2: number[] } | null {
  const pr = portReflection(b, port);
  const f = b.results?.frequency;
  if (!pr || !f) return null;
  return { f, g2: pr.s11_re.map((re, i) => re * re + pr.s11_im[i] * pr.s11_im[i]) };
}

/** Mismatch efficiency 1 − |S11|² over the band. */
export function mismatchCurve(b: Bundle, port: number | null): { f: number[]; eta: number[] } | null {
  const r = reflectionPower(b, port);
  return r ? { f: r.f, eta: r.g2.map((g) => (Number.isFinite(g) ? 1 - g : Number.NaN)) } : null;
}

/** 1 − |S11(f)|² at one frequency (|S11|² interpolated linearly, as the exporter does), or null. */
export function mismatchAt(b: Bundle, fHz: number, port: number | null): number | null {
  const r = reflectionPower(b, port);
  if (!r) return null;
  const g2 = interpAt(r.f, r.g2, fHz);
  return Number.isFinite(g2) ? 1 - g2 : null;
}

/** The entry's radiation efficiency when it is usable for gain (finite and positive), else null. */
export const radEfficiency = (ff: FarField): number | null =>
  typeof ff.rad_efficiency === "number" && Number.isFinite(ff.rad_efficiency) && ff.rad_efficiency > 0 ? ff.rad_efficiency : null;

export interface Availability { ok: boolean; reason: string }

/** Whether a quantity can be drawn for a far-field entry, and why not. */
export function quantityAvailability(b: Bundle, ff: FarField, q: PatternQuantity): Availability {
  if (q === "directivity") return { ok: true, reason: t("farfield.reason.directivity") };
  if (q === "rhcp" || q === "lhcp") return ff.cp ? { ok: true, reason: t(`farfield.reason.${q}`) } : { ok: false, reason: t("farfield.reason.noCp") };
  if (radEfficiency(ff) === null) {
    return { ok: false, reason: ff.rad_efficiency === null ? t("farfield.reason.noRadEff") : t("farfield.reason.radEffNotPositive") };
  }
  if (q === "gain") return { ok: true, reason: t("farfield.reason.gain") };
  if (mismatchAt(b, ff.f, drivenPort(b, ff)) === null) return { ok: false, reason: t("farfield.reason.noS11") };
  return { ok: true, reason: t("farfield.reason.realized") };
}

/** The quantity actually drawn: the chosen one when available, else directivity. */
export const effectiveQuantity = (b: Bundle, ff: FarField, q: PatternQuantity): PatternQuantity =>
  quantityAvailability(b, ff, q).ok ? q : "directivity";

/** The dB offset of the gain patterns from the directivity (0 for the others; null when unavailable). */
export function quantityOffsetDb(b: Bundle, ff: FarField, q: PatternQuantity): number | null {
  if (q === "directivity" || q === "rhcp" || q === "lhcp") return 0;
  const eff = radEfficiency(ff);
  if (eff === null) return null;
  if (q === "gain") return toDb(eff);
  const mis = mismatchAt(b, ff.f, drivenPort(b, ff));
  return mis !== null && mis > 0 ? toDb(eff * mis) : null;
}

/** The [theta][phi] grid (dBi) of a quantity; directivity when the quantity is unavailable. */
export function quantityGrid(b: Bundle, ff: FarField, q: PatternQuantity): number[][] {
  const eq = effectiveQuantity(b, ff, q);
  if (eq === "rhcp") return ff.cp!.rhcp_dbi;
  if (eq === "lhcp") return ff.cp!.lhcp_dbi;
  const off = quantityOffsetDb(b, ff, eq) ?? 0;
  return off === 0 ? ff.directivity_dbi : ff.directivity_dbi.map((row) => row.map((v) => v + off));
}

/** The top of the quantity's colour scale and polar axis (dBi): Dmax plus the gain offset. The
 * circular parts share Dmax as their top, so RHCP and LHCP compare on one scale. */
export function quantityMax(b: Bundle, ff: FarField, q: PatternQuantity): number {
  return ff.dmax_dbi + (quantityOffsetDb(b, ff, effectiveQuantity(b, ff, q)) ?? 0);
}

/** Largest finite value of a grid (the pattern's own maximum). */
export function gridMax(grid: readonly (readonly number[])[]): number {
  let m = -Infinity;
  for (const row of grid) for (const v of row) if (Number.isFinite(v) && v > m) m = v;
  return m;
}

export interface FarfieldSummary {
  f: number;
  /** driven port (multi-port runs), else the excited port */
  port: number | null;
  dmaxDbi: number;
  /** η_rad as stored (may be null, or above 1: unphysical, flagged) */
  radEff: number | null;
  /** 1 − |S11(f)|² of the driven port */
  mismatchEff: number | null;
  /** η_rad · (1 − |S11(f)|²) */
  totalEff: number | null;
  /** dBi: the bundle's value, else computed */
  gainDbi: number | null;
  realizedDbi: number | null;
  /** direction of the pattern maximum (degrees), and how much the directivity varies over φ on the cone
   * θ = peak.theta (dB): below OMNI_PHI_DB the pattern is omnidirectional in φ and φ names no direction */
  peak: { theta: number; phi: number; phiRippleDb: number | null };
}

/** The directivity varies by less than this over φ at the peak's θ: omnidirectional in φ (dB). */
export const OMNI_PHI_DB = 1;

/** max − min of the directivity over φ at the θ row nearest `theta` (dB), null without finite values. */
export function phiRipple(ff: Pick<FarField, "theta" | "directivity_dbi">, theta: number): number | null {
  if (!ff.theta?.length) return null;
  let k = 0;
  ff.theta.forEach((v, i) => { if (Math.abs(v - theta) < Math.abs(ff.theta[k] - theta)) k = i; });
  const row = (ff.directivity_dbi[k] ?? []).filter(Number.isFinite);
  return row.length > 1 ? Math.max(...row) - Math.min(...row) : null;
}

export function farfieldSummary(b: Bundle, ff: FarField): FarfieldSummary {
  const port = drivenPort(b, ff);
  const mis = mismatchAt(b, ff.f, port);
  const eff = radEfficiency(ff);
  const beam = mainBeam(ff.theta, ff.phi, ff.directivity_dbi, !!b.half_space);
  return {
    f: ff.f,
    port,
    dmaxDbi: ff.dmax_dbi,
    radEff: typeof ff.rad_efficiency === "number" && Number.isFinite(ff.rad_efficiency) ? ff.rad_efficiency : null,
    mismatchEff: mis,
    totalEff: eff !== null && mis !== null ? eff * mis : null,
    gainDbi: ff.gain_dbi ?? (eff !== null ? ff.dmax_dbi + toDb(eff) : null),
    realizedDbi: ff.realized_gain_dbi ?? (eff !== null && mis !== null && mis > 0 ? ff.dmax_dbi + toDb(eff * mis) : null),
    peak: { theta: beam.theta, phi: beam.phi, phiRippleDb: phiRipple(ff, beam.theta) },
  };
}

// ------------------------------------------------------------------ efficiency over the band

/** The bundle's band-wide radiation efficiency (results.efficiency, docs/BUNDLE.md#efficiency), the
 * well-formed entries only. */
export function efficiencySweeps(b: Bundle): EfficiencySweep[] {
  const list = b.results?.efficiency ?? [];
  return Array.isArray(list) ? list.filter((e) => e && Array.isArray(e.f) && Array.isArray(e.rad_efficiency) && e.f.length === e.rad_efficiency.length && e.f.length > 0) : [];
}

/** Warning text for an efficiency above 100 % (unphysical for a passive antenna), else null. */
export function overUnityWarning(eta: number | null | undefined, fHz: number): string | null {
  if (typeof eta !== "number" || !(eta > 1)) return null;
  return `radiation efficiency ${(eta * 100).toFixed(1)} % at ${(fHz / 1e9).toFixed(3)} GHz exceeds 100 %: the radiated and accepted powers come from independent numerical measurements, so gain and total efficiency are overestimated by ${(10 * Math.log10(eta)).toFixed(2)} dB.`;
}

export interface EfficiencyPoint { f: number; rad: number | null; mismatch: number | null; total: number | null; warning: string | null }

export interface PortEfficiency {
  port: number | null;
  /** mismatch efficiency 1 − |S11|² over the S11 band */
  mismatch: { f: number[]; eta: number[] } | null;
  /** band-wide radiation and total efficiency when the bundle stores it; `rad` and `total` are NaN
   * (a gap in the curve) where the bundle marks the value unreliable, which `unreliable` keeps */
  band: { f: number[]; rad: number[]; total: number[]; warnings: number; qa: string[];
    unreliable: { f: number[]; rad: number[]; total: number[] } } | null;
  /** radiation, mismatch and total efficiency at the far-field frequencies of this port */
  points: EfficiencyPoint[];
}

/** The driven ports of a run: every port with its own reflection (multi-port runs drive each), the
 * excited port first. */
export function drivenPorts(b: Bundle): number[] {
  const keys = Object.keys(b.results?.ports ?? {}).map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  const own = drivenPort(b);
  return own != null && keys.includes(own) ? [own, ...keys.filter((k) => k !== own)] : keys;
}

/** Everything the Efficiency view draws, per driven port. */
export function efficiencyData(b: Bundle): PortEfficiency[] {
  if (!b.results) return [];
  const own = drivenPort(b);
  const sweeps = efficiencySweeps(b);
  const ffs = b.results.farfield ?? [];
  return drivenPorts(b).map((port) => {
    const mine = (p: number | undefined) => (p ?? own) === port;
    const sw = sweeps.find((s) => mine(s.port));
    let band: PortEfficiency["band"] = null;
    if (sw) {
      const raw = sw.rad_efficiency.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : Number.NaN));
      const rawTotal = sw.f.map((f, i) => { const m = mismatchAt(b, f, port); return m === null || !Number.isFinite(raw[i]) ? Number.NaN : raw[i] * m; });
      const bad = sw.f.map((_, i) => Array.isArray(sw.reliable) && sw.reliable[i] === false);
      const pick = (v: number[], want: boolean) => v.map((x, i) => (bad[i] === want ? x : Number.NaN));
      const idx = bad.flatMap((u, i) => (u && Number.isFinite(raw[i]) ? [i] : []));
      const rad = pick(raw, false);
      band = { f: sw.f, rad, total: pick(rawTotal, false), warnings: rad.filter((v) => v > 1).length,
        qa: Array.isArray(sw.qa_warnings) ? sw.qa_warnings.filter((w) => typeof w === "string") : [],
        unreliable: { f: idx.map((i) => sw.f[i]), rad: idx.map((i) => raw[i]), total: idx.map((i) => rawTotal[i]) } };
    }
    const points = ffs.filter((ff) => mine(ff.port)).map((ff): EfficiencyPoint => {
      const s = farfieldSummary(b, ff);
      return { f: ff.f, rad: s.radEff, mismatch: s.mismatchEff, total: s.radEff !== null && s.mismatchEff !== null ? s.radEff * s.mismatchEff : null, warning: efficiencyWarningUi(ff) };
    });
    return { port, mismatch: mismatchCurve(b, port), band, points };
  });
}
