/** Saved requirement masks. Pure, SDK/DOM-free; Python parity is fairbeam.requirements.
 * Goals reuse the optimizer grammar, units and interpolation conventions. A metric verdict is
 * not a convergence certificate. Callers must bind the saved requirement snapshot and any mesh
 * study to the immutable source ID of the evaluated result (never the current editor state).
 */
import type { OptGoal, GoalKind } from '../runner/api.ts';
import type { Bundle } from '../types.ts';
import { portProcessingInfo } from './portProcessingMetadata.ts';

export const REQUIREMENTS_SCHEMA = 'fairbeam.requirements/1';
export const REQUIREMENT_LIMIT = 64;
export const F0_TOLERANCE_PCT = 0.25; // Existing optimizer default; conversion must retain it.
export const REQUIREMENT_KINDS: readonly GoalKind[] = ['f0', 's11_max', 'bw_min', 'dmax_min', 'sij_max', 'sij_min', 'match_all', 'realized_gain_min', 'efficiency_min'];
const BAND = ['s11_max', 'sij_max', 'sij_min', 'match_all'];
const PAIR = ['sij_max', 'sij_min'];
const FREQ = [...BAND, 'dmax_min', 'realized_gain_min', 'efficiency_min'];
export interface Requirement { id: string; label?: string; goal: OptGoal }
export interface RequirementSet { schema: typeof REQUIREMENTS_SCHEMA; items: Requirement[] }
export type RequirementVerdict = 'pass' | 'fail' | 'unknown';
export type Qualification = 'converged' | 'not-converged' | 'unknown' | 'suspicious';
export interface RequirementContext {
  sourceId?: string;
  snapshotSourceId?: string;
  /** The caller verifies study membership/content before supplying this evidence. */
  mesh?: { sourceId: string; studyId: string; status: 'converged' | 'not-converged' };
}
export interface RequirementValue {
  id: string; metric: RequirementVerdict; value: number | null; reason: string | null;
  unit: 'GHz' | 'MHz' | 'dB' | 'dBi' | '%'; method: string | null;
  samples: number; frequenciesHz: number[];
  sources: { ports: [number, number]; reciprocal: boolean }[];
  lowerBound: boolean;
}
export interface RequirementEvaluation {
  schema: 'fairbeam.requirement-evaluation/1'; sourceId: string | null;
  requirements: RequirementSet | null; status: RequirementVerdict; metric: RequirementVerdict;
  energy: Qualification; mesh: Qualification; reason: string | null; items: RequirementValue[];
}
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positiveId = (v: unknown): v is number => number(v) && Number.isSafeInteger(v) && v > 0;
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && Array.from(v).length <= 256;
const only = (v: Obj, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const vector = (v: unknown, n?: number): v is number[] => Array.isArray(v) && (n === undefined || v.length === n) && v.every(number);
const ids = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.length <= 64 && v.every(positiveId) && new Set(v).size === v.length;
const unit = (g: OptGoal): RequirementValue['unit'] => g.kind === 'f0' ? 'GHz' : g.kind === 'bw_min' ? 'MHz' : g.kind === 'efficiency_min' ? '%' : ['dmax_min', 'realized_gain_min'].includes(g.kind) ? 'dBi' : 'dB';
const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-9)); // optimizer's -180 dB numeric floor

/** Refuse invalid fields instead of coercing booleans/strings, dropping ports or sorting a band. */
export function validateRequirements(value: unknown): { ok: true; value: RequirementSet } | { ok: false; reason: string } {
  const s = obj(value);
  if (!only(s, ['schema', 'items']) || s.schema !== REQUIREMENTS_SCHEMA || !Array.isArray(s.items) || s.items.length > REQUIREMENT_LIMIT) return { ok: false, reason: 'requirements-schema' };
  const seen = new Set<string>(), items: Requirement[] = [];
  for (const raw of s.items) {
    const r = obj(raw), g = obj(r.goal), k = g.kind as GoalKind;
    if (!only(r, ['id', 'label', 'goal']) || typeof r.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(r.id) || seen.has(r.id) || (r.label !== undefined && (typeof r.label !== 'string' || Array.from(r.label).length > 160))) return { ok: false, reason: 'requirement-id' };
    if (!only(g, ['kind', 'target', 'at', 'at_hi', 'weight', 'ports']) || !REQUIREMENT_KINDS.includes(k) || !number(g.target) || (g.weight !== undefined && (!number(g.weight) || g.weight <= 0))) return { ok: false, reason: 'requirement-goal' };
    if (FREQ.includes(k) ? !number(g.at) || g.at <= 0 || !Number.isFinite(g.at * 1e9) : g.at != null) return { ok: false, reason: 'requirement-frequency' };
    if (g.at_hi != null && (!BAND.includes(k) || !number(g.at_hi) || !Number.isFinite(g.at_hi * 1e9) || !number(g.at) || g.at_hi <= g.at)) return { ok: false, reason: 'requirement-band' };
    if (PAIR.includes(k) ? !Array.isArray(g.ports) || g.ports.length !== 2 || !g.ports.every(positiveId) : g.ports != null) return { ok: false, reason: 'requirement-ports' };
    if ((['f0', 'bw_min'].includes(k) && g.target <= 0) || (['s11_max', 'sij_max', 'match_all'].includes(k) && g.target >= 0) || (k === 'sij_min' && g.target > 0) || (k === 'efficiency_min' && !(g.target > 0 && g.target <= 100))) return { ok: false, reason: 'requirement-target' };
    seen.add(r.id);
    items.push({ id: r.id, ...(r.label !== undefined ? { label: r.label as string } : {}), goal: { ...g, ...(Array.isArray(g.ports) ? { ports: [...g.ports] } : {}) } as unknown as OptGoal });
  }
  return { ok: true, value: { schema: REQUIREMENTS_SCHEMA, items } };
}

/** Numbers, bands, weights and physical port IDs are copied without text formatting/rounding.
 * Conversion preserves the objective, not the stricter requirements qualification/admission.
 */
export function requirementsToGoals(value: unknown) {
  const v = validateRequirements(value);
  return v.ok ? { ok: true as const, goals: v.value.items.map(r => r.goal), f0TolerancePct: F0_TOLERANCE_PCT,
    qualificationRequired: true as const, admission: 'requirements-stricter-than-optimizer' as const } : v;
}

interface Spectrum { f: number[]; numbers: number[]; indices: number[]; entries: Obj; primary: number | null; legacy: boolean }
function spectrum(bundle: unknown): Spectrum | null {
  const b = obj(bundle), r = obj(b.results), f = r.frequency;
  if (!vector(f) || f.length < 2 || f.length > 1_000_000 || f.some((x, i) => x <= 0 || (i > 0 && x <= f[i - 1]))) return null;
  // Session transformed/modal data have a different physical-port/reference contract.
  if (b.port_processing != null || r.port_processing != null || portProcessingInfo(b as unknown as Bundle)) return null;
  const physical = list(b.ports).map(p => obj(p).number);
  if (!ids(physical) || f.length * physical.length > 2_000_000) return null;
  const excited = list(b.ports).filter(p => obj(p).excite === true).map(p => obj(p).number as number);
  const primary = excited.length === 1 ? excited[0] : physical.length === 1 ? physical[0] : null;
  const sp = obj(r.sparams);
  if (r.sparams != null) {
    const ix = sp.ports, ns = sp.port_numbers ?? ix;
    if (!ids(ix) || !ids(ns) || ix.length !== ns.length || (sp.port_numbers !== undefined && ix.some((v, i) => v !== i + 1)) || ns.length !== physical.length || !physical.every(p => ns.includes(p)) || !Object.keys(obj(sp.s)).length) return null;
    return { f, numbers: ns, indices: ix, entries: obj(sp.s), primary, legacy: false };
  }
  // A legacy result only supplies each explicitly stored diagonal, never a missing transmission.
  const entries: Obj = {};
  for (const p of physical) {
    const pr = obj(obj(r.ports)[String(p)]);
    if (Object.keys(pr).length) entries[`${p},${p}`] = { re: pr.s11_re, im: pr.s11_im };
  }
  return { f, numbers: physical, indices: physical, entries, primary, legacy: true };
}
function column(s: Spectrum, i: number, j: number) {
  const a = s.numbers.indexOf(i), b = s.numbers.indexOf(j);
  if (a < 0 || b < 0) return null;
  let key = `${s.indices[a]},${s.indices[b]}`, reciprocal = false;
  if (!(key in s.entries) && a !== b) { key = `${s.indices[b]},${s.indices[a]}`; reciprocal = true; }
  const c = obj(s.entries[key]);
  if (!vector(c.re, s.f.length) || !vector(c.im, s.f.length)) return null;
  const imaginary = c.im;
  const magnitude = c.re.map((v, k) => Math.hypot(v, imaginary[k]));
  return magnitude.every(Number.isFinite) ? { magnitude, reciprocal, re: c.re, im: c.im } : null;
}
function interp(f: number[], v: number[], at: number): number {
  if (at < f[0] || at > f[f.length - 1]) return NaN;
  let lo = 0, hi = f.length - 1;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (f[mid] < at) lo = mid + 1; else hi = mid; }
  const k = lo;
  if (k === 0 || f[k] === at) return v[k];
  return v[k - 1] + (v[k] - v[k - 1]) * ((at - f[k - 1]) / (f[k] - f[k - 1]));
}
function blank(r: Requirement, reason: string): RequirementValue {
  return { id: r.id, metric: 'unknown', value: null, reason, unit: unit(r.goal), method: null, samples: 0, frequenciesHz: [], sources: [], lowerBound: false };
}
function finish(r: Requirement, value: number, detail: Partial<RequirementValue>): RequirementValue {
  if (!Number.isFinite(value)) return blank(r, 'invalid-data');
  if (r.goal.kind === 'f0' && !Number.isFinite(100 * (value - r.goal.target) / r.goal.target)) return blank(r, 'invalid-data');
  const g = r.goal, met = g.kind === 'f0' ? Math.abs(100 * (value - g.target) / g.target) <= F0_TOLERANCE_PCT : ['s11_max', 'sij_max', 'match_all'].includes(g.kind) ? value <= g.target : value >= g.target;
  return { ...blank(r, ''), metric: met ? 'pass' : 'fail', value, reason: null, ...detail };
}

function sMetric(r: Requirement, s: Spectrum): RequirementValue {
  const g = r.goal, lo = g.at! * 1e9, hi = (g.at_hi ?? g.at)! * 1e9;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < s.f[0] || hi > s.f[s.f.length - 1]) return blank(r, 'incomplete-band');
  const pairs = PAIR.includes(g.kind) ? [g.ports!] : g.kind === 'match_all' ? s.numbers.map(n => [n, n] as [number, number]) : s.primary !== null ? [[s.primary, s.primary] as [number, number]] : [];
  if (!pairs.length) return blank(r, 'missing-driven-port');
  const x = lo === hi ? [lo] : [lo, ...s.f.filter(f => f > lo && f < hi), hi];
  const values: number[] = [], sources: RequirementValue['sources'] = [];
  for (const [i, j] of pairs) {
    const c = column(s, i, j);
    if (!c) return blank(r, 'missing-or-invalid-trace');
    const data = g.kind === 's11_max' ? c.magnitude.map(db) : c.magnitude;
    for (const f of x) { const v = interp(s.f, data, f); values.push(g.kind === 's11_max' ? v : db(v)); }
    sources.push({ ports: [i, j], reciprocal: c.reciprocal });
  }
  const worst = values.reduce((a, b) => g.kind === 'sij_min' ? Math.min(a, b) : Math.max(a, b));
  return finish(r, worst, { method: g.kind === 's11_max' ? 'sampled-db-interpolation' : 'sampled-magnitude-interpolation', samples: values.length, frequenciesHz: x, sources });
}

function resonanceMetric(r: Requirement, b: Obj, s: Spectrum): RequirementValue {
  if (s.primary === null) return blank(r, 'missing-driven-port');
  const c = column(s, s.primary, s.primary);
  if (!c) return blank(r, 'missing-or-invalid-trace');
  // study._matched_bands uses the writer's -300 dB floor for locating band minima.
  const d = c.magnitude.map(v => 20 * Math.log10(Math.max(v, 1e-15))), threshold = obj(b.results).s11_band_db ?? -10;
  // bw_min is the optimizer's -10 dB bandwidth, never an arbitrary plot threshold.
  if (threshold !== -10) return blank(r, 'unsupported-band-threshold');
  const begin = d.findIndex(x => x < -10);
  const detail = { samples: s.f.length, frequenciesHz: [s.f[0], s.f[s.f.length - 1]], sources: [{ ports: [s.primary, s.primary] as [number, number], reciprocal: false }] };
  if (begin >= 0) {
    let end = begin;
    while (end + 1 < d.length && d[end + 1] < -10) end++;
    let peak = begin;
    for (let i = begin + 1; i <= end; i++) if (d[i] < d[peak]) peak = i;
    const lowerBound = begin === 0 || end === d.length - 1;
    if (r.goal.kind === 'bw_min') {
      const out = finish(r, (s.f[end] - s.f[begin]) / 1e6, { ...detail, method: 'sampled-minus10db-width', lowerBound });
      // A lower bound below the target cannot establish failure of the actual bandwidth.
      return lowerBound && out.metric === 'fail' ? { ...out, metric: 'unknown', reason: 'open-band-lower-bound' } : out;
    }
    return finish(r, s.f[peak] / 1e9, { ...detail, method: 'first-matched-band-sampled-minimum' });
  }
  if (r.goal.kind === 'bw_min') return finish(r, 0, { ...detail, method: 'no-sampled-minus10db-band' });
  // Optimizer priority: first matched band, first upward Im(Z) zero, sampled |S| minimum.
  // Never infer reactance from imported magnitude-only data.
  const pr = obj(obj(obj(b.results).ports)[String(s.primary)]);
  let reactance: number[] | null = null;
  if (obj(b.reference).phaseKnown !== false) {
    if (s.legacy && vector(pr.zin_im, s.f.length)) reactance = pr.zin_im;
    else if (!s.legacy) {
      const z = pr.z_ref_f ?? pr.z_ref;
      const refs = number(z) ? s.f.map(() => z) : vector(z, s.f.length) ? z : null;
      if (refs?.every(v => v > 0)) {
        const x = c.re.map((re, k) => 2 * refs[k] * c.im[k] / ((1 - re) ** 2 + c.im[k] ** 2));
        if (x.every(Number.isFinite)) reactance = x;
      }
    }
  }
  if (reactance) for (let i = 0; i < reactance.length - 1; i++) if (reactance[i] < 0 && reactance[i + 1] >= 0) {
    const f = s.f[i] - reactance[i] * (s.f[i + 1] - s.f[i]) / (reactance[i + 1] - reactance[i]);
    return finish(r, f / 1e9, { ...detail, method: 'first-upward-reactance-zero' });
  }
  const k = c.magnitude.reduce((best, v, i) => v < c.magnitude[best] ? i : best, 0);
  return finish(r, s.f[k] / 1e9, { ...detail, method: 'sampled-reflection-minimum' });
}

function energyQualification(b: Obj): Qualification {
  const run = obj(b.run);
  if (run.converged === false || run.hit_timestep_limit === true || list(run.port_runs).some(p => obj(p).converged === false)) return 'not-converged';
  if (run.converged !== true || (run.hit_timestep_limit !== undefined && typeof run.hit_timestep_limit !== 'boolean') || (run.port_runs !== undefined && !Array.isArray(run.port_runs)) || list(run.port_runs).some(p => obj(p).converged !== true)) return 'unknown';
  const res = obj(b.results), qa = obj(obj(res.sparams).qa);
  if ((qa.passive !== undefined && typeof qa.passive !== 'boolean') || list(res.farfield).some(p => { const w = obj(p).qa_warnings; return w !== undefined && (!Array.isArray(w) || w.some(v => typeof v !== 'string')); })) return 'unknown';
  if (qa.passive === false || list(res.farfield).some(p => { const f = obj(p); return list(f.qa_warnings).length > 0 || (number(f.rad_efficiency) && f.rad_efficiency > 1.05); })) return 'suspicious';
  const s = spectrum(b);
  if (s && s.numbers.length > 1) {
    const sp = obj(res.sparams), stored = list(run.port_runs).map(p => obj(p).port);
    const expected = s.legacy ? s.primary === null ? [] : [s.primary] : sp.complete === true ? s.numbers : ids(sp.excited) && sp.excited.every(p => s.indices.includes(p)) ? sp.excited.map(p => s.numbers[s.indices.indexOf(p)]) : [];
    if (!expected.length || (expected.length > 1 && !stored.length) || (stored.length && (!ids(stored) || stored.some(p => !s.numbers.includes(p)) || expected.some(p => !stored.includes(p))))) return 'unknown';
  }
  if (s) for (const p of s.numbers) {
    const c = column(s, p, p);
    if (c && (c.magnitude.some(v => db(v) > 0.1) || c.magnitude.every(v => db(v) >= -0.5))) return 'suspicious'; // runQuality.ts tolerances
  }
  return 'converged';
}

function radiationMetric(r: Requirement, b: Obj, s: Spectrum): RequirementValue {
  if (s.primary === null) return blank(r, 'missing-driven-port');
  const target = r.goal.at!, res = obj(b.results);
  const candidates = list(res.farfield).map(obj).filter(ff => number(ff.f) && (ff.port ?? s.primary) === s.primary && Math.abs(ff.f / 1e9 - target) <= Math.max(1e-12, 1e-9 * Math.max(Math.abs(ff.f / 1e9), Math.abs(target))));
  if (candidates.length !== 1) return blank(r, 'missing-exact-field');
  const ff = candidates[0], f = ff.f as number;
  if (f < s.f[0] || f > s.f[s.f.length - 1] || energyQualification(b) !== 'converged') return blank(r, 'unqualified-field');
  const detail = { method: 'stored-frequency-field', samples: 1, frequenciesHz: [f] };
  if (r.goal.kind === 'dmax_min') return number(ff.dmax_dbi) ? finish(r, ff.dmax_dbi, detail) : blank(r, 'invalid-data');
  const end = obj(b.solver).end_criteria_db, eff = ff.rad_efficiency, pacc = ff.pacc_w, prad = ff.prad_w;
  if (!number(end) || end > -60 || !number(eff) || eff < 0 || eff > 1 || !number(pacc) || pacc <= 0 || !number(prad) || prad < 0 || prad / pacc > 1 || Math.abs(eff - prad / pacc) > 0.000050000001 || list(ff.qa_warnings).length) return blank(r, 'unqualified-field-power');
  if (r.goal.kind === 'efficiency_min') return finish(r, 100 * eff, detail);
  // Same scalar-power convention as optimize.radiation_metric; use the stored driven-wave
  // reflection here, not a postprocessed/renormalized matrix or a second mismatch correction.
  const pr = obj(obj(res.ports)[String(s.primary)]);
  if (!vector(pr.s11_re, s.f.length) || !vector(pr.s11_im, s.f.length) || !number(ff.dmax_dbi) || !number(ff.realized_gain_dbi) || eff <= 0) return blank(r, 'unqualified-field-power');
  const imaginary = pr.s11_im;
  const reflected = pr.s11_re.map((v, k) => v * v + imaginary[k] ** 2);
  const accepted = 1 - interp(s.f, reflected, f);
  if (!(accepted > 0) || !Number.isFinite(accepted)) return blank(r, 'unqualified-field-power');
  const expected = ff.dmax_dbi + 10 * Math.log10(prad / pacc * accepted);
  // Writer precision: 0.001 dB for D and G, 0.0001 for serialized efficiency.
  if (Math.abs(ff.realized_gain_dbi - expected) > 0.0010000001) return blank(r, 'unqualified-field-power');
  return finish(r, ff.realized_gain_dbi, detail);
}

const aggregate = (items: RequirementValue[]): RequirementVerdict => !items.length || items.some(x => x.metric === 'unknown') ? 'unknown' : items.some(x => x.metric === 'fail') ? 'fail' : 'pass';
export function evaluateRequirements(value: unknown, bundle: unknown, context: RequirementContext = {}): RequirementEvaluation {
  const parsed = validateRequirements(value), b = obj(bundle), s = spectrum(b);
  const ctx = obj(context), m = obj(ctx.mesh);
  const sourceId = text(ctx.sourceId) ? ctx.sourceId : null;
  const bound = sourceId !== null && ctx.snapshotSourceId === sourceId;
  const energy = energyQualification(b);
  const mesh: Qualification = bound && m.sourceId === sourceId && text(m.studyId) && (m.status === 'converged' || m.status === 'not-converged') ? m.status : 'unknown';
  const reason = !parsed.ok ? parsed.reason : !bound ? 'source-mismatch' : !s ? 'invalid-spectrum' : !parsed.value.items.length ? 'no-requirements' : s.f.length * s.numbers.length * parsed.value.items.length > 2_000_000 ? 'work-limit' : null;
  const items = parsed.ok ? parsed.value.items.map(r => {
    if (reason) return blank(r, reason);
    if (BAND.includes(r.goal.kind)) return sMetric(r, s!);
    if (['f0', 'bw_min'].includes(r.goal.kind)) return resonanceMetric(r, b, s!);
    return radiationMetric(r, b, s!);
  }) : [];
  const metric = aggregate(items);
  return { schema: 'fairbeam.requirement-evaluation/1', sourceId, requirements: parsed.ok ? parsed.value : null,
    status: energy === 'converged' && mesh === 'converged' ? metric : 'unknown', metric, energy, mesh,
    reason: reason ?? (energy !== 'converged' ? 'energy-unqualified' : mesh !== 'converged' ? 'mesh-unqualified' : null), items };
}

/** Plot only the requested mask span. A point is a point, not a whole-chart horizontal line.
 * Matching a displayed trace to these PHYSICAL ports is the chart adapter's responsibility.
 */
export function requirementSegments(value: unknown) {
  const p = validateRequirements(value);
  return p.ok ? p.value.items.filter(r => BAND.includes(r.goal.kind)).map(r => ({ id: r.id, kind: r.goal.kind,
    ports: r.goal.ports ? [...r.goal.ports] as [number, number] : null,
    fromHz: r.goal.at! * 1e9, toHz: (r.goal.at_hi ?? r.goal.at)! * 1e9,
    valueDb: r.goal.target, direction: r.goal.kind === 'sij_min' ? 'min' as const : 'max' as const })) : [];
}
