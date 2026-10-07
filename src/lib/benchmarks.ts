import type { Bundle, Vec3 } from "../types";
import { fmt } from "../i18n/index.ts";

/** One measured run of an example model (public/benchmarks.json, written by scripts/build-benchmarks.mjs). */
export interface BenchRow {
  machine: string;
  /** `run.host.cpu` of the measuring machine, to recognise the open bundle's own run */
  host_cpu: string | null;
  engine: "cpu" | "gpu";
  backend?: "Metal" | "CUDA";
  /** null for the GPU engine */
  threads: number | null;
  /** the run used all threads (`threads` is then the machine's logical thread count) */
  all_threads?: boolean;
  /** one entry per port run; null when the source does not state it */
  timesteps: number[] | null;
  /** summed over all port runs */
  solver_s: number;
  mcells_s: number | null;
  /** the parameters that differ from the model's defaults; {} = default parameters */
  params: Record<string, number | string>;
  grid: Vec3 | null;
  date?: string;
  source: string;
  note?: string;
}

export interface BenchFile {
  schema: string;
  models: Record<string, BenchRow[]>;
}

export interface BenchView {
  rows: { row: BenchRow; self: boolean }[];
  /** the open bundle's run when no listed row is that run */
  thisRun: BenchRow | null;
  /** set when the rows were measured with other parameters than the open bundle's */
  paramNote: string | null;
  /** set when some rows were measured on a different grid */
  meshNote: string | null;
}

const sameValue = (a: unknown, b: unknown) => a === b || (a !== "" && b !== "" && Number(a) === Number(b) && Number.isFinite(Number(a)));

function sameParams(a: Record<string, unknown>, b: Record<string, unknown>) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b && sameValue(a[k], b[k]));
}

/** The bundle's parameter values that differ from the model's defaults. */
export function changedParams(b: Bundle): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const p of b.model.params ?? []) if (p.value !== undefined && !sameValue(p.value, p.default)) out[p.key] = p.value;
  return out;
}

const gridText = (g: readonly number[]) => g.join(" × ");

/** "Metal", "CUDA" or null (and the CUDA card), from the GPU engine's log line
 * "Create FDTD engine (GPU, backend: CUDA (…))". */
function gpuBackend(log: string[]): { backend: "Metal" | "CUDA" | null; device: string | null } {
  for (const line of [...log].reverse()) {
    const m = /backend:\s*(Metal|CUDA)\b(?:\s*\(([^)]+)\))?/i.exec(line);
    // a Metal device is the host's own chip; a CUDA device is a separate card worth naming
    if (m) return m[1].toUpperCase() === "CUDA" ? { backend: "CUDA", device: m[2] ?? null } : { backend: "Metal", device: null };
  }
  return { backend: null, device: null };
}

/** The open bundle's run in the same shape as a measured row. */
export function runRow(b: Bundle): BenchRow | null {
  const r = b.run;
  if (!r) return null;
  const ports = r.port_runs ?? [];
  const engine = r.engine ?? "cpu";
  const host = r.host?.cpu ?? r.host?.machine ?? "this machine";
  const gpu = engine === "gpu" ? gpuBackend(r.log_tail ?? []) : { backend: null, device: null };
  const backend = gpu.backend ?? (engine === "gpu" && r.host?.os === "Darwin" ? "Metal" : null);
  const solver = ports.length ? ports.reduce((s, p) => s + (p.solver_time_s ?? 0), 0) : r.solver_time_s;
  if (solver === undefined || !Number.isFinite(solver)) return null;
  return {
    machine: gpu.device ? `${gpu.device} (on ${host})` : host,
    host_cpu: r.host?.cpu ?? null,
    engine,
    ...(backend ? { backend } : {}),
    threads: engine === "gpu" ? null : r.threads || null,
    ...(engine !== "gpu" && !r.threads ? { all_threads: true } : {}),
    timesteps: ports.length ? ports.map((p) => p.timesteps ?? 0) : r.timesteps ? [r.timesteps] : null,
    solver_s: solver,
    mcells_s: r.speed_mcells_s ?? null,
    params: changedParams(b),
    grid: r.grid ?? null,
    source: "open bundle",
  };
}

/** A listed row is the open bundle's own run: same machine, engine, threads, timesteps and solver time. */
function isSelf(row: BenchRow, run: BenchRow) {
  if (!run.host_cpu || row.host_cpu !== run.host_cpu || row.engine !== run.engine) return false;
  if (row.engine === "cpu" && row.threads !== run.threads && !(row.all_threads && run.all_threads)) return false;
  if (!row.timesteps || !run.timesteps || row.timesteps.join() !== run.timesteps.join()) return false;
  return Math.abs(row.solver_s - run.solver_s) <= 0.01 * run.solver_s + 0.01;
}

/**
 * What the Run section shows for the open bundle: the measured rows of its model, like with like.
 * Rows measured with the bundle's own parameters when there are any, else those with the default
 * parameters (with a note), else all rows. Null when the model has no measurement.
 */
export function benchView(file: BenchFile | null | undefined, b: Bundle): BenchView | null {
  const all = file?.models?.[b.model.id];
  if (!Array.isArray(all) || !all.length) return null;
  const changed = changedParams(b);
  let rows = all.filter((r) => sameParams(r.params ?? {}, changed));
  let paramNote: string | null = null;
  if (!rows.length) {
    const defaults = all.filter((r) => !Object.keys(r.params ?? {}).length);
    rows = defaults.length ? defaults : all;
    const list = Object.entries(changed).map(([k, v]) => `${k} = ${v}`).join(", ");
    paramNote = defaults.length
      ? `Measured with the default parameters${list ? `; this one uses ${list}` : ""}.`
      : "Measured with other parameters than this one's.";
  }
  const run = runRow(b);
  const marked = rows.map((row) => ({ row, self: !!run && isSelf(row, run) }));
  const thisRun = run && !marked.some((m) => m.self) ? run : null;
  const grid = b.run?.grid ?? ([b.mesh.x.length, b.mesh.y.length, b.mesh.z.length] as Vec3);
  const other = paramNote ? [] : rows.filter((r) => r.grid && r.grid.join() !== grid.join());
  const meshNote = other.length
    ? `${other.length === rows.length ? "Measured" : "Some rows were measured"} on a different grid (${[...new Set(other.map((r) => gridText(r.grid!)))].join(", ")}); this one: ${gridText(grid)}.`
    : null;
  return { rows: marked, thisRun, paramNote, meshNote };
}

/** A machine name for the narrow table (the full name is in rowTitle): without vendor prefixes and
 * "12-Core Processor" / "CPU @ 3.60GHz" suffixes. "AMD Ryzen 9 7900X 12-Core Processor" → "Ryzen 9 7900X". */
export function shortMachine(name: string): string {
  const s = name
    .replace(/\((R|TM)\)/gi, "")
    .replace(/\b(AMD|Intel|NVIDIA|GeForce)\s+/gi, "")
    .replace(/\s+\d+-Core Processor\b/i, "")
    .replace(/\s+CPU\s*@.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return s || name;
}

/** "CPU · 4", "CPU · 24", "GPU": the engine as the UI names it everywhere (projectLabels.ts
 * engineName); the GPU backend (CUDA, Metal) is in the row's title (rowTitle). */
export function engineText(r: BenchRow): string {
  if (r.engine === "gpu") return "GPU";
  return r.threads ? `CPU · ${r.threads}` : "CPU · all";
}

/** Timesteps of the port runs: "12,628", or "18,055–21,352" when they differ; "—" when not recorded.
 * The count of port runs is in rowTitle. */
export function timestepsText(ts: number[] | null): string {
  if (!ts?.length) return "—";
  const f = (n: number) => fmt.int(n);
  const lo = Math.min(...ts);
  const hi = Math.max(...ts);
  return lo === hi ? f(lo) : `${f(lo)}–${f(hi)}`;
}

/** Tooltip for a row: engine in words, port runs, parameters, grid, source. */
export function rowTitle(r: BenchRow): string {
  const threads = r.all_threads ? (r.threads ? `all ${r.threads} threads` : "all threads") : `${r.threads} threads`;
  const engine = r.engine === "gpu" ? (r.backend ? `${r.backend} GPU engine` : "GPU engine") : `CPU engine, ${threads}`;
  const parts = [`${r.machine}: ${engine}`];
  if (r.timesteps && r.timesteps.length > 1) parts.push(`${r.timesteps.length} port runs: ${r.timesteps.map((t) => t.toLocaleString("en-US")).join(", ")} timesteps`);
  const params = Object.entries(r.params ?? {});
  parts.push(params.length ? params.map(([k, v]) => `${k} = ${v}`).join(", ") : "default parameters");
  if (r.grid) parts.push(`grid ${gridText(r.grid)}`);
  if (r.note) parts.push(r.note);
  parts.push(r.date ? `${r.source}, ${r.date}` : r.source);
  return parts.join("\n");
}
