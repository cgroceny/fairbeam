import type { FarField, RunStats } from "../types";
import { numPlain as num } from "./format.ts"; // report text (PDF / Markdown): the decimal point in every UI language

export interface FinalEnergy {
  /** dB; an upper bound when `bound` */
  db: number | null;
  bound: boolean;
  /** timestep the value refers to */
  timestep: number | null;
}

/** Final field energy of a run. openEMS logs the energy only every ~4 s of wall time (the GPU engine
 * every few thousand timesteps), so the last logged sample can predate the stop. A converged run
 * stopped because the energy reached the end criterion, so its final energy is then only known to be
 * at most the criterion. Bundles written before the parser knew this carry that stale sample as
 * `final_energy_db`; it is recognised here from `energy_trace` and the timestep count. */
export function finalEnergy(run: RunStats, criterionDb: number): FinalEnergy {
  const ts = run.timesteps ?? null;
  const last = run.energy_trace.at(-1);
  const e = run.final_energy_db;
  if (typeof e === "number") {
    const stale = run.converged && !run.hit_timestep_limit && last !== undefined && ts !== null && last.timestep < ts && e > criterionDb;
    return stale ? { db: criterionDb, bound: true, timestep: ts } : { db: e, bound: false, timestep: last?.timestep ?? ts };
  }
  if (typeof run.final_energy_bound_db === "number") return { db: run.final_energy_bound_db, bound: true, timestep: ts };
  return run.converged ? { db: criterionDb, bound: true, timestep: ts } : { db: null, bound: false, timestep: last?.timestep ?? null };
}

/** "≤ −60.0 dB at timestep 10,800" / "−65.9 dB at timestep 10,842" */
export function energyText(e: FinalEnergy): string {
  if (e.db === null) return "unknown";
  const at = e.timestep !== null ? ` at timestep ${e.timestep.toLocaleString("en-US")}` : "";
  return `${e.bound ? "≤ " : ""}${num(e.db, 1)} dB${at}`;
}

/** What the bundle says about the limits of a run, for {@link convergenceText}'s explanation. */
export interface RunLimits {
  /** solver.max_timesteps */
  maxTimesteps?: number;
  /** mesh.min_cell (mm) */
  minCell?: number;
}

/** One-sentence run outcome, shared by the Run panel and the reports. A run stopped at the timestep
 * limit also gets its likely cause: an excitation pulse that took most of the limit (a tiny timestep
 * from the smallest cell, typically thin metal), or fields that decay slowly. */
export function convergenceText(run: RunStats, criterionDb: number, limits: RunLimits = {}): string {
  const e = finalEnergy(run, criterionDb);
  if (run.converged)
    return e.bound && e.db === criterionDb
      ? `Converged: field energy reached the end criterion, ${energyText(e)}.`
      : `Converged: field energy ${energyText(e)} (≤ ${num(criterionDb, 0)} dB criterion).`;
  const text = `Not converged: stopped${run.hit_timestep_limit ? " at the timestep limit" : ""}; last logged field energy ${energyText(e)} (criterion ${num(criterionDb, 0)} dB).`;
  if (!run.hit_timestep_limit) return text;
  const limit = limits.maxTimesteps ?? run.timesteps;
  const pulse = run.excitation_timesteps;
  if (pulse && limit && pulse >= limit / 2) {
    const dt = run.timestep_s ? ` at a timestep of ${num(run.timestep_s * 1e15, 0)} fs` : "";
    const cell = limits.minCell ? `, set by the smallest cell (${num(limits.minCell, 3)} mm)` : "";
    const took = pulse >= limit
      ? `needs ${pulse.toLocaleString("en-US")} timesteps${dt}${cell}, more than the limit of ${limit.toLocaleString("en-US")}`
      : `took ${pulse.toLocaleString("en-US")} of the ${limit.toLocaleString("en-US")} timesteps${dt}${cell}`;
    return `${text} The excitation pulse alone ${took}, so the fields had no time to decay. Model thin metal as sheets, coarsen the finest detail, or raise max timesteps.`;
  }
  // bundles from before excitation_timesteps was recorded keep their old text
  if (!pulse) return text;
  return `${text} The fields were still decaying: a strongly resonant structure or a feed that barely couples rings for long. Raise max timesteps, or check the feed.`;
}

/** QA note for an unphysical radiation efficiency (> 100 %), or null. Newer bundles carry the
 * exporter's own note (`qa_warnings`); older ones are checked here. */
/** A lossless model's power-balance note: its radiation efficiency is 1 by construction and the
 * measured Prad / Pacc (rad_efficiency_raw) is within the tolerance. Information, not a warning:
 * the server prints it as a note too. */
export const losslessNote = (ff: Pick<FarField, "rad_efficiency" | "rad_efficiency_raw" | "qa_warnings">) =>
  ff.rad_efficiency === 1 && typeof ff.rad_efficiency_raw === "number" && !!ff.qa_warnings?.length;

export function efficiencyWarning(ff: FarField): string | null {
  if (ff.qa_warnings?.length) return ff.qa_warnings[0];
  const eff = ff.rad_efficiency;
  if (eff === null || !(eff > 1)) return null;
  return `radiation efficiency ${num(eff * 100, 1)} % at ${num(ff.f / 1e9, 3)} GHz exceeds 100 %: the power radiated through the NF2FF box is ${num((eff - 1) * 100, 1)} % above the port's accepted power, so gain and realized gain are overestimated by ${num(10 * Math.log10(eff), 2)} dB.`;
}
