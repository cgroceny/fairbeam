/** Read-only, real-reference power-wave postprocessing. exp(+j omega t) convention.
 * Matched lossless feeds are removed at their ORIGINAL reference before renormalization.
 * This is not launch calibration, a dispersive line model or mixed-mode conversion. */
import type { Band, Bundle, PortResult } from "../types.ts";
import { renormalisePorts } from "../import/touchstone.ts";
import { hasSParameterPhase, magDb, physicalPortNumber, sMatrix, zFromGamma } from "./sparams.ts";
import { originalPortResult, registerPortProjection, type PortProcessingSettings } from "./portProcessingMetadata.ts";

type C = [number, number];
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
export type PortProcessingError = "phase" | "matrix" | "mapping" | "reference" | "frequency" | "settings" | "noSamples";
export function portProcessingEligibility(b: Bundle): { error: PortProcessingError | null; physicalPorts: number[]; references: number[] } {
  const fail = (error: PortProcessingError) => ({ error, physicalPorts: [], references: [] });
  if (!hasSParameterPhase(b)) return fail("phase");
  const m = sMatrix(b), r = b.results;
  if (!m || !r || !m.ports.length || (m.legacy && (m.ports.length !== 1 || Object.hasOwn(r, "sparams"))) ||
      m.ports.some(i => m.ports.some(j => !m.get(i, j)))) return fail("matrix");
  if (!m.f.length || m.f.some((f, k) => !Number.isFinite(f) || f < 0 || (k > 0 && f <= m.f[k - 1]))) return fail("frequency");
  const physical = m.ports.map(p => physicalPortNumber(m, p));
  if (physical.some(p => p === null || !Number.isSafeInteger(p) || p! <= 0) || new Set(physical).size !== m.ports.length ||
      b.ports.length !== m.ports.length || physical.some(p => b.ports.filter(x => x.number === p).length !== 1)) return fail("mapping");
  // Never accept sMatrix's display-only fallback to guessed reference values.
  const raw = r.sparams as unknown as Record<string, unknown> | undefined;
  if (!m.legacy) {
    if (raw?.complete === false) return fail("matrix");
    if (!Array.isArray(raw?.ports) || raw.ports.length !== m.ports.length || raw.ports.some((p, i) => p !== i + 1)) return fail("mapping");
    const value = raw?.z_ref ?? raw?.zref ?? raw?.z0;
    if (!(positive(value) || (Array.isArray(value) && value.length === m.ports.length && value.every(positive)))) return fail("reference");
  }
  if (m.zRef.length !== m.ports.length || m.zRef.some(z => !positive(z)) || physical.some((p, i) => {
    const pr = r.ports[String(p)], model = b.ports.find(x => x.number === p)!;
    return !pr || !positive(pr.z_ref) || pr.z_ref !== m.zRef[i] || Object.hasOwn(pr, "z_ref_f") || model.type === "waveguide" ||
      (model.reference_impedance && (model.reference_impedance.imag !== 0 || model.reference_impedance.real !== pr.z_ref));
  })) return fail("reference");
  return { error: null, physicalPorts: physical as number[], references: [...m.zRef] };
}

/** Contiguous sampled bands. Never bridge missing data or invent a crossing frequency. */
function matchedBands(f: number[], db: number[], threshold: number): Band[] {
  const bands: Band[] = [];
  for (let i = 0; i < f.length; i++) {
    if (!(db[i] < threshold)) continue;
    const first = i;
    let best = i;
    while (i + 1 < f.length && db[i + 1] < threshold) { i++; if (db[i] < db[best]) best = i; }
    const centre = (f[first] + f[i]) / 2;
    bands.push({ f_lo: f[first], f_hi: f[i], f_center: f[best], s11_min_db: db[best],
      fractional_bw: centre > 0 ? (f[i] - f[first]) / centre : NaN,
      edge_lo: first === 0 || !Number.isFinite(db[first - 1]), edge_hi: i === f.length - 1 || !Number.isFinite(db[i + 1]) });
  }
  return bands;
}

export function postprocessPorts(input: Bundle, settings: PortProcessingSettings): { bundle: Bundle | null; error: PortProcessingError | null } {
  const source = originalPortResult(input), eligible = portProcessingEligibility(source);
  const fail = (error: PortProcessingError) => ({ bundle: null, error });
  if (eligible.error) return fail(eligible.error);
  const m = sMatrix(source)!, r = source.results!, count = m.f.length;
  const ids = eligible.physicalPorts;
  if (!positive(settings.referenceOhm) || !settings.delayPs || typeof settings.delayPs !== "object" ||
      Object.keys(settings.delayPs).some(key => !ids.includes(Number(key)) || String(Number(key)) !== key) ||
      ids.some(id => typeof settings.delayPs[id] !== "number" || !Number.isFinite(settings.delayPs[id]))) return fail("settings");
  const delays = ids.map(id => settings.delayPs[id] * 1e-12);
  // Avoid phase arguments whose floating-point precision would materially destroy phase.
  if (delays.some(d => !Number.isFinite(d) || Math.abs(2 * Math.PI * m.f[count - 1] * d) > 1e6)) return fail("settings");
  const changed = m.zRef.some(z => z !== settings.referenceOhm) || delays.some(d => d !== 0);
  if (!changed) return { bundle: source, error: null };
  const table = Object.fromEntries(m.ports.flatMap((_, i) => m.ports.map((__, j) => [`${i + 1},${j + 1}`, { re: new Array<number>(count).fill(NaN), im: new Array<number>(count).fill(NaN) }])));
  let missingSamples = 0;
  m.f.forEach((f, k) => {
    let matrix: C[][] = m.ports.map((i, a) => m.ports.map((j, b) => {
      const v = m.get(i, j)!, phase = 2 * Math.PI * f * (delays[a] + delays[b]);
      const c = Math.cos(phase), s = Math.sin(phase);
      return [v.re[k] * c - v.im[k] * s, v.re[k] * s + v.im[k] * c];
    }));
    // Renormalization couples all entries; one unknown entry makes this entire sample unknown.
    if (!matrix.flat(2).every(Number.isFinite)) { missingSamples++; return; }
    try { if (m.zRef.some(z => z !== settings.referenceOhm)) matrix = renormalisePorts(matrix, m.zRef, settings.referenceOhm); }
    catch { missingSamples++; return; }
    if (!matrix.flat(2).every(Number.isFinite)) { missingSamples++; return; }
    matrix.forEach((row, i) => row.forEach((v, j) => { table[`${i + 1},${j + 1}`].re[k] = v[0]; table[`${i + 1},${j + 1}`].im[k] = v[1]; }));
  });
  if (missingSamples === count) return fail("noSamples");
  const ports: Record<string, PortResult> = {};
  ids.forEach((id, i) => {
    const g = table[`${i + 1},${i + 1}`], z = zFromGamma(g, settings.referenceOhm);
    ports[String(id)] = { s11_re: g.re, s11_im: g.im, zin_re: z.re, zin_im: z.im, z_ref: settings.referenceOhm };
  });
  const excited = source.ports.find(p => p.excite) ?? source.ports[0];
  const threshold = Number.isFinite(r.s11_band_db) ? r.s11_band_db! : -10;
  const bundle: Bundle = { ...source, results: { ...r, ports,
    sparams: { ports: ids.map((_, i) => i + 1), port_numbers: [...ids], z_ref: ids.map(() => settings.referenceOhm),
      excited: source.ports.filter(p => p.excite).map(p => ids.indexOf(p.number) + 1), s: table,
      complete: true, method: "view-only matched feed removal then real power-wave renormalization",
      qa: { reciprocity_max: null, reciprocity_pairs: {}, column_power_max: {}, column_power_min: {},
        passivity_max: null, passive: null, passive_tol: 0, passivity_method: "not recomputed for this view" } },
    bands: matchedBands(m.f, magDb({ re: ports[String(excited.number)].s11_re, im: ports[String(excited.number)].s11_im }), threshold) } };
  const ownSettings = { referenceOhm: settings.referenceOhm, delayPs: { ...settings.delayPs } };
  const description = `Postprocessed: ideal matched lossless feed removal first, then real power-wave renormalization; source references ${ids.map((id, i) => `P${id}=${m.zRef[i]} ohm`).join(", ")}; target=${settings.referenceOhm} ohm; removed one-way delay ${ids.map(id => `P${id}=${settings.delayPs[id]} ps`).join(", ")}; exp(+j omega t); missing matrix samples=${missingSamples}/${count}. Raw radiation, power and solver evidence unchanged; no launch calibration or mixed-mode conversion.`;
  registerPortProjection(bundle, { source, settings: ownSettings, physicalPorts: [...ids], sourceReferences: [...m.zRef], missingSamples, description });
  return { bundle, error: null };
}
