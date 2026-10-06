import { createSignal } from "solid-js";

// Choosing the throughput (MCells/s) the pre-run time estimate uses. Pure, so it can be checked in node.
export interface HostRate { mcps: number; source: "runs" | "bench"; n: number }

export function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/** The rates for a machine: its own runs first, else the benchmark table's rows of the same CPU
 * name (engine by engine), else nothing (the fixed RATES apply). Pure; used by loadHostRates. */
export function pickHostRates(
  throughput: Record<string, { mcells_s: number; runs: number }> | undefined,
  hostCpu: string | null | undefined,
  bench: { models: Record<string, { machine: string; host_cpu: string | null; engine: string; mcells_s: number | null }[]> } | null,
): Record<string, HostRate> {
  const out: Record<string, HostRate> = {};
  for (const [e, v] of Object.entries(throughput ?? {})) if (v && v.mcells_s > 0) out[e] = { mcps: v.mcells_s, source: "runs", n: v.runs };
  if (hostCpu && bench) {
    for (const e of ["cpu", "gpu"]) {
      if (out[e]) continue;
      const rows = Object.values(bench.models ?? {}).flat().filter((r) => r.engine === e && r.mcells_s && (r.host_cpu === hostCpu || r.machine === hostCpu));
      if (rows.length) out[e] = { mcps: median(rows.map((r) => r.mcells_s as number)), source: "bench", n: rows.length };
    }
  }
  return out;
}


/** This machine's throughput per engine, in MCells/s. `runs` are the machine's own past runs (server
 * health.throughput, from the run index); `bench` is the table of public/benchmarks.json for a machine
 * of the same name. Either replaces the fixed RATES in designer/meshStats.ts; neither is scaled for
 * small grids, since they are measured rates of real runs. */
export const [hostRates, setHostRates] = createSignal<Record<string, HostRate>>({});

let benchFile: Promise<any> | null = null;
/** Called with every /api/health: remembers the measured rates. The benchmark table (`benchUrl`) is
 * fetched only when an engine has no run of its own on this machine. */
export async function loadHostRates(h: { throughput?: Record<string, { mcells_s: number; runs: number }>; host_cpu?: string | null } | null, benchUrl: string) {
  const own = pickHostRates(h?.throughput, null, null);
  setHostRates(own);
  if (!h?.host_cpu || (own.cpu && own.gpu)) return;
  benchFile ??= fetch(benchUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const bench = await benchFile;
  if (bench) setHostRates(pickHostRates(h.throughput, h.host_cpu, bench));
}
