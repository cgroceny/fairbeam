// Beam-steering state shared by the Array panel, the 3D view, the Pattern tab and the exports:
// port weights, whether the steered pattern replaces the stored one, and the derived pattern.

import { batch, createMemo, createRoot, createSignal, on, createEffect } from "solid-js";
import { bundle, farfieldIndex } from "../state";
import { comparing } from "../compare/store";
import type { Bundle, FarField } from "../types";
import { arrayFarField, mainBeam, portCentre, steeringPhases, uniformWeights, type Beam, type Weight } from "./array";
import { elementPatterns, elementPatternsAt, type ElementPatternSet } from "./sparams";

export const [arrayWeights, setArrayWeights] = createSignal<Map<number, Weight>>(new Map());
/** show the steered pattern in the 3D view and the Pattern tab (false: the selected element's) */
export const [arrayActive, setArrayActive] = createSignal(true);
/** beam direction of the last steer: scan angle θ0 (signed, in the scan plane) and plane φ0 */
export const [scanTheta, setScanTheta] = createSignal(0);
export const [scanPhi, setScanPhi] = createSignal<ScanPlane>(0);
/** scan planes offered: xz (φ = 0°) and yz (φ = 90°) */
export type ScanPlane = 0 | 90;

/**
 * Azimuth of the array axis in degrees (0 = along x, 90 = along y), from the spread of the port
 * centres: the plane a linear array scans in. 0 for a single port or a square layout.
 */
export function arrayAxisPhi(b: Bundle | null, ports: number[]): ScanPlane {
  if (!b || ports.length < 2) return 0;
  const pts = ports.map((p) => portCentre(b, p)).filter((c): c is NonNullable<typeof c> => !!c);
  const span = (i: number) => Math.max(...pts.map((c) => c[i])) - Math.min(...pts.map((c) => c[i]));
  return span(1) > span(0) * 1.2 ? 90 : 0;
}

interface Derived {
  /** element patterns at the selected far-field frequency */
  set: () => ElementPatternSet | null;
  /** any element patterns in the bundle */
  hasArray: () => boolean;
  steered: () => FarField | null;
  beam: () => Beam | null;
}

const derived: Derived = createRoot(() => {
  const hasArray = createMemo(() => elementPatterns(bundle()).length > 0);
  const set = createMemo(() => {
    const b = bundle();
    const list = b?.results?.farfield ?? [];
    const ff = list[Math.min(farfieldIndex(), list.length - 1)];
    const all = elementPatterns(b);
    if (!all.length) return null;
    return ff ? elementPatternsAt(b, ff.f) : all[0];
  });
  // uniform weights for every element port whenever the project changes
  createEffect(on(bundle, () => {
    const s = elementPatterns(bundle())[0];
    const ports = s ? s.elements.map((e) => e.port) : [];
    setArrayWeights(uniformWeights(ports));
    setArrayActive(true);
    setScanTheta(0);
    setScanPhi(arrayAxisPhi(bundle(), ports));
  }));
  const steered = createMemo(() => {
    const b = bundle();
    const s = set();
    return b && s ? arrayFarField(b, s, arrayWeights()) : null;
  });
  const beam = createMemo(() => {
    const f = steered();
    return f ? mainBeam(f.theta, f.phi, f.directivity_dbi, !!bundle()?.half_space) : null;
  });
  return { set, hasArray, steered, beam };
});

export const arraySet = derived.set;
export const hasArray = derived.hasArray;
export const steeredFarField = derived.steered;
export const steeredBeam = derived.beam;

/** The pattern the viewer should show instead of the stored far field, or null. */
// (not while comparing: the comparison is of stored patterns, one per project)
export const farfieldOverride = () => (arrayActive() && !comparing() ? derived.steered() : null);

/**
 * Steer the main beam: progressive phases towards the signed scan angle θ0 in the plane φ0
 * (negative θ0 = the other side of the zenith, φ0 + 180°). Amplitudes are kept.
 */
export function steer(theta0: number, phi0: ScanPlane) {
  const b = bundle();
  const s = derived.set();
  if (!b || !s) return;
  const ports = s.elements.map((e) => e.port);
  const ph = steeringPhases(b, ports, s.f, Math.abs(theta0), theta0 < 0 ? phi0 + 180 : phi0);
  const next = new Map(arrayWeights());
  for (const p of ports) next.set(p, { ampDb: next.get(p)?.ampDb ?? 0, phaseDeg: Math.round(ph.get(p) ?? 0) });
  batch(() => {
    setScanTheta(theta0);
    setScanPhi(phi0);
    setArrayWeights(next);
    setArrayActive(true);
  });
}
