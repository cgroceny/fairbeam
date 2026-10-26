// An array feed belongs to one result and frequency. No viewer/Designer globals here.
import { batch, createComputed, createMemo, createSignal, on, type Accessor } from "solid-js";
import type { Bundle } from "../types";
import { arrayFarField, mainBeam, portCentre, steeringPhases, uniformWeights, type Weight } from "./array.ts";
import { elementPatterns, elementPatternsAt } from "./sparams.ts";

export type ScanPlane = 0 | 90;
export function arrayAxisPhi(b: Bundle | null, ports: number[]): ScanPlane {
  if (!b || ports.length < 2) return 0;
  const pts = ports.map(p => portCentre(b, p)).filter((p): p is NonNullable<typeof p> => !!p);
  const span = (i: number) => Math.max(...pts.map(p => p[i])) - Math.min(...pts.map(p => p[i]));
  return span(1) > span(0) * 1.2 ? 90 : 0;
}

/** Call inside the owner's Solid root. Null source invalidates the feed synchronously; changing
 * the source object, identity or selected frequency starts with uniform weights. */
export function createArraySession(readSource: Accessor<Bundle | null>, readFrequency: Accessor<number | undefined>,
  options: { identity?: Accessor<unknown>; comparing?: Accessor<boolean>; minElements?: number } = {}) {
  // Accessors may depend on whole focus/tab objects. A view-only change must not reset
  // the feed when those accessors still resolve to the same result and frequency.
  const source = createMemo(readSource), frequency = createMemo(readFrequency);
  const identity = createMemo(() => options.identity?.());
  const minElements = options.minElements ?? 1;
  const [weights, setWeights] = createSignal<Map<number, Weight>>(new Map());
  const [active, setActive] = createSignal(true);
  const [scanTheta, setScanTheta] = createSignal(0);
  const [scanPhi, setScanPhi] = createSignal<ScanPlane>(0);
  const sets = createMemo(() => elementPatterns(source()).filter(set => set.elements.length >= minElements));
  const set = createMemo(() => {
    const selected = frequency() === undefined ? sets()[0] ?? null : elementPatternsAt(source(), frequency()!);
    return selected && selected.elements.length >= minElements ? selected : null;
  });
  const reset = () => batch(() => {
    const ports = set()?.elements.map(e => e.port) ?? [];
    setWeights(uniformWeights(ports)); setActive(true); setScanTheta(0); setScanPhi(arrayAxisPhi(source(), ports));
  });
  const selectedFrequency = createMemo(() => set()?.f);
  createComputed(on([source, identity, selectedFrequency], reset));
  const steered = createMemo(() => { const b = source(), s = set(); return b && s ? arrayFarField(b, s, weights()) : null; });
  const beam = createMemo(() => { const f = steered(); return f ? mainBeam(f.theta, f.phi, f.directivity_dbi, !!source()?.half_space) : null; });
  const override = () => active() && !options.comparing?.() ? steered() : null;
  const steer = (theta0: number, phi0: ScanPlane) => {
    const b = source(), s = set();
    if (!b || !s || !Number.isFinite(theta0)) return;
    const ports = s.elements.map(e => e.port);
    const phases = steeringPhases(b, ports, s.f, Math.abs(theta0), theta0 < 0 ? phi0 + 180 : phi0);
    const next = new Map(weights());
    for (const p of ports) next.set(p, { ampDb: next.get(p)?.ampDb ?? 0, phaseDeg: Math.round(phases.get(p) ?? 0) });
    batch(() => { setScanTheta(theta0); setScanPhi(phi0); setWeights(next); setActive(true); });
  };
  return { source, sets, set, hasArray: () => !!set(), weights, setWeights, active, setActive,
    scanTheta, setScanTheta, scanPhi, setScanPhi, steered, beam, override, steer, reset };
}
export type ArraySession = ReturnType<typeof createArraySession>;

/** Capture a feed and its exact stored frequency together before asynchronous exports. */
export function snapshotArrayFeed(session: ArraySession, b: Bundle) {
  const set = session.set();
  if (session.source() !== b || !set || !session.weights().size) return null;
  return { frequencyHz: set.f, weights: new Map([...session.weights()].map(([port, weight]) => [port, { ...weight }])) };
}
