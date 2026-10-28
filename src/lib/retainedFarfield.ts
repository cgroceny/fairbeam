import type { FarfieldCapability, FarfieldRequest, Job } from "../runner/api";

/** Imported files can share a server basename; only project loads may address local jobs. */
export function retainedViewerFile(file: string, origin: string): string | undefined {
  return origin === "project" && file ? file : undefined;
}

/** Local jobs in the current workspace are the only source of transform authority. */
export function retainedSourceJob(file: string | undefined, jobs: readonly Job[], sameScope: boolean): Job | undefined {
  if (!file || !sameScope) return undefined;
  const shown = jobs.find(j => j.bundle === file && j.status === "done");
  const source = shown?.kind === "postprocess" ? jobs.find(j => j.id === shown.postprocess?.source_job_id && j.status === "done") : shown;
  return source && (source.kind === "run" || !source.kind) && source.retained_nf2ff ? source : undefined;
}

export function farfieldRequest(text: string, theta: number, phi: number, capability: FarfieldCapability | undefined):
  { request: FarfieldRequest; error?: never } | { request?: never; error: string } {
  if (!capability?.available) return { error: "nf2ff.unavailable" };
  const tokens = text.split(",").map(x => x.trim());
  const decimal = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  const frequencies = tokens.map(x => Number(x) * 1e9);
  if (!tokens.length || tokens.length > Math.min(16, capability.max_frequencies) || tokens.some(x => !decimal.test(x))
      || frequencies.some(x => !Number.isFinite(x) || x <= 0) || new Set(frequencies).size !== frequencies.length)
    return { error: "nf2ff.badFrequencies" };
  if (![theta, phi].every(x => Number.isFinite(x) && x >= .25 && x <= 90)) return { error: "nf2ff.badSteps" };
  const cells = (Math.ceil(180 / theta) + 1) * Math.ceil(360 / phi);
  if (cells > Math.min(65536, capability.max_cells_per_frequency) || cells * frequencies.length > Math.min(262144, capability.max_total_cells_per_port))
    return { error: "nf2ff.budget" };
  for (const port of capability.ports) {
    if (frequencies.some(f => f < port.band_hz[0] || f > port.band_hz[1])) return { error: "nf2ff.outsideBand" };
    if (port.domain === "FD" && frequencies.some(f => !port.recorded_frequencies_hz.includes(f))) return { error: "nf2ff.fdOnly" };
  }
  return { request: { frequencies_hz: frequencies, theta_step: theta, phi_step: phi } };
}
