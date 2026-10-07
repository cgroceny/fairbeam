// Mesh numbers of the designer's current server preview and a rough solver-time estimate, for the
// mesh view, the Run dialog and the status bar. The estimate is labelled as one everywhere: the real
// number of timesteps depends on how fast the field energy decays (the antenna's Q), which is only
// known after the run.
import type { Bundle } from "../types";
import { fmt, t } from "../i18n/index.ts";
import { hostRates } from "../lib/hostRates.ts";

const C0 = 299_792_458;

/** Conservative FDTD throughput per engine (MCells/s), below what docs/BENCHMARKS.md measured:
 * the M5 Pro CPU engine with 4 threads ran the patch antenna at 318–329 MCells/s; the Metal and
 * CUDA GPU engines at 775–3050 MCells/s depending on the model size. Small grids run slower per
 * cell (threading and per-timestep overhead: 130–220 MCells/s at 0.1–0.2 M cells, about 60 at
 * 30 k), so the rate is scaled down below SMALL_GRID cells. `basis` and `small` are i18n keys of the
 * plain-language basis the UI shows; the measurements stay here, not in the user's copy. */
export const RATES: Record<string, { mcps: number; basis: string; small: string }> = {
  cpu: { mcps: 250, basis: "run.basis.cpu", small: "run.basis.cpu.small" },
  gpu: { mcps: 700, basis: "run.basis.gpu", small: "run.basis.gpu.small" },
};

const SMALL_GRID = 300_000;

/** openEMS's real timestep against the Courant estimate of the mesh report: 0.79 to 0.96 (python/fairbeam/design.py DT_SAFETY) */
const DT_SAFETY = 0.8;

/** The run length in periods of the band centre: the example antennas stopped after 7 (broadband
 * circuits) to 120 (the axial helix) periods; resonant antennas typically 20–80. */
const PERIODS: [number, number] = [15, 80];

export interface MeshStats {
  /** mesh lines per axis */
  lines: [number, number, number];
  /** cells between the lines, (nx − 1)(ny − 1)(nz − 1): the bundle's mesh.total_cells, which the
   * server's mesh-cells check and cell limit use (python/fairbeam/simulation.py to_bundle) */
  cells: number;
  /** the line product nx · ny · nz: openEMS's "FDTD cells" (its log's "FDTD simulation size:
   * 53x55x37 --> 107855 FDTD cells"), the unit of its MCells/s speed and so of the time estimate */
  nodes: number;
  /** smallest and largest cell (mm) */
  minCell: number;
  maxCell: number;
  /** FDTD timestep (s): the mesher's report, else the Courant limit of the smallest cells */
  dt: number;
}

const minStep = (a: number[]) => {
  let m = Infinity;
  for (let i = 1; i < a.length; i++) m = Math.min(m, a[i] - a[i - 1]);
  return m;
};
const maxStep = (a: number[]) => {
  let m = 0;
  for (let i = 1; i < a.length; i++) m = Math.max(m, a[i] - a[i - 1]);
  return m;
};

/** The cells of a mesh with these line counts per axis: the intervals multiplied, not the lines
 * (53 × 55 × 37 lines are 52 × 54 × 36 = 101 088 cells). */
export function meshCells(lines: readonly [number, number, number]): number {
  return lines.reduce((n, k) => n * Math.max(0, k - 1), 1);
}

/** null when the bundle has no real mesh (the empty-design stage, a first browser-built preview). */
export function meshStats(b: Bundle | null | undefined): MeshStats | null {
  const m = b?.mesh;
  if (!m || m.x.length < 3 || m.y.length < 2 || m.z.length < 2 || !m.total_cells) return null;
  const lines: [number, number, number] = [m.x.length, m.y.length, m.z.length];
  const d = [minStep(m.x), minStep(m.y), minStep(m.z)];
  const unit = b!.units?.length_m ?? 1e-3;
  const courant = 1 / (C0 * Math.sqrt(d.reduce((s, x) => s + 1 / (x * unit) ** 2, 0)));
  return {
    lines,
    cells: meshCells(lines),
    nodes: lines[0] * lines[1] * lines[2],
    minCell: m.min_cell ?? Math.min(...d),
    maxCell: m.max_cell ?? Math.max(maxStep(m.x), maxStep(m.y), maxStep(m.z)),
    dt: m.auto?.timestep_s ?? courant,
  };
}

export interface TimeEstimate {
  /** the run is expected to reach max timesteps before the fields decay (the excitation pulse and its
   * decay need more than the limit): it would not converge */
  capped: boolean;
  timesteps: [number, number];
  seconds: [number, number];
  mcps: number;
  basis: string;
}

/** Solver time range for a single-port run: FDTD cells × timesteps / throughput. Several excited
 * ports run one after the other (multiply by their number). The throughput is openEMS's MCells/s,
 * which counts the line product (MeshStats.nodes), not the displayed cells: a 53 × 55 × 37 patch
 * run reported 1480 timesteps at 28.8 MCells/s in 5.54 s = 107 855 × 1480 / 28.8e6 (with the
 * 101 088 cells it would be 5.19 s).
 *
 * `opts.maxTimesteps` is the limit the run will have, when the caller knows it better than the bundle:
 * a design's own `simulation.max_timesteps` (null or undefined: none set, the server sizes the limit
 * to the pulse and its decay, so the estimate is not capped). Without it the bundle's limit applies. */
export function estimateTime(b: Bundle | null | undefined, engine = "cpu", ports = 1, opts?: { maxTimesteps?: number | null }): TimeEstimate | null {
  const s = meshStats(b);
  if (!s || !b) return null;
  const ex = b.solver.excitation;
  const fc = (ex.f_min + ex.f_max) / 2;
  if (!(fc > 0) || !(s.dt > 0)) return null;
  const cap = (opts && "maxTimesteps" in opts ? opts.maxTimesteps : b.solver.max_timesteps) || Infinity;
  // the run cannot end before the excitation pulse does, and needs time to decay after it: the pulse
  // (10 tau, tau = 1 / (sqrt(2) pi f max / 2.76), fairbeam.excitation) at the timestep openEMS really
  // takes (0.8 to 0.96 of the Courant estimate: design.DT_SAFETY) bounds the range from below
  const pulse = ex.f_max > 0 ? 10 / (Math.SQRT2 * Math.PI * ex.f_max / 2.76) / (s.dt * DT_SAFETY) : 0;
  const raw = PERIODS.map((k, i) => Math.max(Math.round(k / (fc * s.dt)), Math.round(pulse * (i === 0 ? 1.3 : 3))));
  const ts = raw.map((n) => Math.min(cap, n)) as [number, number];
  const r = RATES[engine] ?? RATES.cpu;
  const host = hostRates()[engine === "gpu" ? "gpu" : "cpu"];
  const mcps = host ? host.mcps : r.mcps * Math.min(1, Math.max(0.25, Math.sqrt(s.nodes / SMALL_GRID)));
  const n = Math.max(1, ports);
  return {
    capped: raw[0] >= cap,
    timesteps: ts,
    seconds: ts.map((t) => (n * s.nodes * t) / (mcps * 1e6)) as [number, number],
    mcps,
    basis: host ? t(host.source === "runs" ? "run.basis.host.runs" : "run.basis.host.bench", { n: host.n, rate: Math.round(host.mcps) }) : t(mcps < r.mcps ? r.small : r.basis),
  };
}

/** "0.26 M" / "48 k" */
export function cellsText(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 2)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n);
}

/** "4 s", "1.5 min", "2.1 h" (Turkish: "1,5 dk", "2,1 sa"; decimal comma through fmt) */
export function durationText(s: number): string {
  if (s < 1) return `< 1 ${t("format.unit.s")}`;
  if (s < 90) return `${fmt.fixed(Math.round(s), 0)} ${t("format.unit.s")}`;
  if (s < 5400) return `${fmt.fixed(s / 60, s < 600 ? 1 : 0)} ${t("format.unit.min")}`;
  return `${fmt.fixed(s / 3600, 1)} ${t("format.unit.h")}`;
}

/** A short estimate label for the dialogs and mesh panel, in the selected UI language. */
export function estimateText(e: TimeEstimate | null): string {
  if (!e) return "—";
  const [a, b] = e.seconds.map(durationText);
  if (e.capped) return t("run.estimate.capped", { time: b });
  if (e.seconds[1] < 1) return t("run.estimate.lessThanSecond");
  if (e.seconds[0] < 1) return t("run.estimate.upTo", { time: b });
  return a === b ? t("run.estimate.approx", { time: a }) : t("run.estimate.range", { from: a, to: b });
}
