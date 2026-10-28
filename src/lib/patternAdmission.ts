// Strict admission for quantitative calculations. The permissive legacy display
// reader remains available in sparams.ts; it must not supply nearby-frequency or
// partially decoded fields as exact matched-wave measurement evidence.
import type { Bundle, Vec3 } from "../types";
import { decodeF32Grid, decodeI16Grid, ENC_F32, ENC_I16, type ElementPatternSet } from "./sparams.ts";
import { portProcessingInfo } from "./portProcessingMetadata.ts";

export const MATCHED_PATTERN_NORMALIZATION = "far-field E (V/m) at radius_m per unit incident power wave a = 1 sqrt(W) at the port (a = U_inc / sqrt(Z_ref), peak phasor); all other incident waves zero; F = E A^-1";
const keys = ["e_theta_re", "e_theta_im", "e_phi_re", "e_phi_im"] as const;
type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const vector = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(finite);
const positiveInteger = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v > 0;
const increasing = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every((x, i) => finite(x) && (i === 0 || x > v[i - 1]));
const boundaryFaces = ["x-", "x+", "y-", "y+", "z-", "z+"] as const;

/** Match simulation.mirror_planes: one image plane per axis, even with two mirror
 * faces. Unknown/missing boundary metadata cannot establish an unmirrored field. */
function mirrorCount(boundaries: unknown): number | null {
  if (!obj(boundaries)) return null;
  const faces = boundaryFaces.map(key => {
    const v = boundaries[key];
    const name = typeof v === "string" ? v.toUpperCase()
      : typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3 ? String(v) : "";
    if (["PEC", "PMC", "0", "1"].includes(name)) return true;
    if (["MUR", "PML", "2", "3"].includes(name) || /^PML_[1-9]\d*$/.test(name)) return false;
    return null;
  });
  if (faces.some(v => v === null)) return null;
  return [0, 2, 4].reduce((sum, axis) => sum + Number(faces[axis] || faces[axis + 1]), 0);
}

/** Python round(float, 6), including exact binary ties-to-even. Math.round and
 * toFixed disagree at values such as 0.0078125; an epsilon would admit a different
 * writer position. Scale the exact binary fraction before rounding the integer. */
function writerPositionCoordinate(v: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(v));
  const bits = view.getBigUint64(0), exponent = Number((bits >> 52n) & 0x7ffn);
  const significand = (bits & ((1n << 52n) - 1n)) | (exponent ? 1n << 52n : 0n);
  const shift = (exponent || 1) - 1075;
  if (shift >= 0) return v;
  const numerator = significand * 1_000_000n, denominator = 1n << BigInt(-shift);
  let rounded = numerator / denominator;
  const twiceRemainder = 2n * (numerator % denominator);
  if (twiceRemainder > denominator || twiceRemainder === denominator && rounded % 2n !== 0n) rounded++;
  return Number(`${v < 0 ? "-" : ""}${rounded}e-6`);
}

export type PatternAdmission = {
  ok: true;
  set: ElementPatternSet;
  radiusM: number;
  mirrorPlanes: number;
  phaseCenter: Vec3;
  positions: Map<number, Vec3>;
} | { ok: false; reason: "missing" | "basis" | "metadata" | "grid" | "frequency" | "ports" | "fields" | "budget" };

/** Exact stored frequency and physical ports; no interpolation, guessed basis,
 * repaired payload, default radius or dropped failed port. This admits data, not
 * solver convergence or physical accuracy. Consumers decide mirror support. */
export function strictElementPatternsAt(b: Bundle | null | undefined, f: number): PatternAdmission {
  const raw: unknown = b?.results?.element_patterns;
  if (!obj(raw)) return { ok: false, reason: "missing" };
  if (portProcessingInfo(b) || raw.basis !== "matched-incident-waves" || raw.normalization !== MATCHED_PATTERN_NORMALIZATION)
    return { ok: false, reason: "basis" };
  if (!finite(raw.radius_m) || raw.radius_m <= 0 || !vector(raw.phase_center) ||
      !finite(raw.mirror_planes) || !Number.isInteger(raw.mirror_planes) || raw.mirror_planes < 0 || raw.mirror_planes > 3 ||
      !positiveInteger(raw.decimation) || ![ENC_I16, ENC_F32].includes(String(raw.encoding)))
    return { ok: false, reason: "metadata" };
  // Both writers retain the resolved phase center in model units, not metres.
  // A missing center/unit or repaired '?' boundary is not quantitative evidence.
  if (!b || !finite(b.units?.length_m) || b.units.length_m <= 0 || !vector(b.nf2ff_center) ||
      !raw.phase_center.every((v, i) => v === b.nf2ff_center![i]) || mirrorCount(b.solver?.boundaries) !== raw.mirror_planes)
    return { ok: false, reason: "metadata" };
  const { theta, phi, frequencies, shape, ports } = raw;
  if (!increasing(theta) || theta.length < 2 || theta[0] !== 0 || theta.at(-1)! > 180 ||
      ![90, 180].includes(theta.at(-1)!) || !increasing(phi) || phi.length < 3 || phi[0] < 0 || phi.at(-1)! >= 360 ||
      !Array.isArray(shape) || shape.length !== 2 || shape[0] !== theta.length || shape[1] !== phi.length)
    return { ok: false, reason: "grid" };
  if (theta.at(-1) === 90 && raw.mirror_planes === 0) return { ok: false, reason: "grid" };
  const waveFrequencies = b.results?.frequency;
  if (!increasing(frequencies) || frequencies[0] <= 0 || !finite(f) || !frequencies.includes(f) ||
      !increasing(waveFrequencies) || waveFrequencies[0] <= 0 ||
      frequencies.some(v => v < waveFrequencies[0] || v > waveFrequencies.at(-1)!))
    return { ok: false, reason: "frequency" };
  if (!Array.isArray(ports) || ports.length === 0 || !b || !Array.isArray(b.ports)) return { ok: false, reason: "ports" };
  // Bound allocations before decoding attacker-controlled base64 or array sizes.
  const cells = theta.length * phi.length;
  if (cells > 262_144 || frequencies.length > 64 || ports.length > 64 || cells * ports.length * frequencies.length > 8_000_000)
    return { ok: false, reason: "budget" };
  if (!b.ports.every(p => obj(p) && positiveInteger(p.number) && vector(p.start) && vector(p.stop)))
    return { ok: false, reason: "ports" };
  const physical = b.ports.map(p => p.number);
  if (physical.length !== ports.length || !physical.every(positiveInteger) || new Set(physical).size !== physical.length)
    return { ok: false, reason: "ports" };
  const entries: Obj[] = [];
  const positions = new Map<number, Vec3>();
  const modelPositions = new Map<number, Vec3>();
  for (const port of b.ports) {
    const midpoint = port.start.map((v, i) => (v + port.stop[i]) / 2);
    if (!midpoint.every(finite)) return { ok: false, reason: "ports" };
    modelPositions.set(port.number, midpoint.map(writerPositionCoordinate) as Vec3);
  }
  for (const port of ports) {
    if (!obj(port) || !positiveInteger(port.port) || !physical.includes(port.port) || positions.has(port.port) || !vector(port.position))
      return { ok: false, reason: "ports" };
    const expectedPosition = modelPositions.get(port.port)!;
    if (!port.position.every((v, i) => v === expectedPosition[i])) return { ok: false, reason: "ports" };
    if (!Array.isArray(port.fields) || port.fields.length !== frequencies.length ||
        !port.fields.every((entry, i) => obj(entry) && entry.f === frequencies[i]))
      return { ok: false, reason: "frequency" };
    positions.set(port.port, [...port.position] as Vec3);
    entries.push(port);
  }
  const k = frequencies.indexOf(f), elements: ElementPatternSet["elements"] = [];
  const bytes = cells * (raw.encoding === ENC_I16 ? 2 : 4), textLength = 4 * Math.ceil(bytes / 3);
  for (const port of entries) {
    const entry = (port.fields as Obj[])[k];
    if (raw.encoding === ENC_I16 && (!finite(entry.scale) || entry.scale < 0)) return { ok: false, reason: "fields" };
    const grids: number[][][] = [];
    for (const key of keys) {
      const text = entry[key];
      if (typeof text !== "string" || text.length !== textLength || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))
        return { ok: false, reason: "fields" };
      const grid = raw.encoding === ENC_I16 ? decodeI16Grid(text, theta.length, phi.length, entry.scale as number)
        : decodeF32Grid(text, theta.length, phi.length);
      if (!grid || !grid.every(row => row.every(value => finite(value) && (raw.encoding !== ENC_I16 || Math.abs(value) <= (entry.scale as number)))))
        return { ok: false, reason: "fields" };
      grids.push(grid);
    }
    elements.push({ port: port.port as number, eThetaRe: grids[0], eThetaIm: grids[1], ePhiRe: grids[2], ePhiIm: grids[3] });
  }
  return { ok: true, set: { f, theta: [...theta], phi: [...phi], elements: elements.sort((a, c) => a.port - c.port) },
    radiusM: raw.radius_m, mirrorPlanes: raw.mirror_planes, phaseCenter: [...raw.phase_center] as Vec3, positions };
}
