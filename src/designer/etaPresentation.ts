import type { Eta } from "../runner/api";
import { decayEstablished } from "../runner/liveRun.ts";

/** How the dock's Run tab presents the solver's remaining-time projection.
 *
 * - Nothing until the forecast can mean something: at least three energy readings of the current port
 *   and the energy at least 10 dB below its peak (runner/liveRun.ts decayEstablished). During the
 *   excitation pulse and the start of the decay a straight-line fit jumps from minutes to seconds.
 * - Then a range of finishing times that may only narrow: each new projection tightens the range around
 *   itself. A projection outside the range (the decay changed its pace) starts a new range, so the range
 *   always holds the solver's newest projection. The raw values stay in the run detail.
 *
 * The bounds are presentation bounds around the projection, not confidence limits: wider for a
 * low-confidence fit than for a high-confidence one. */
const SPREAD: Record<string, [number, number]> = { high: [0.85, 1.25], medium: [0.7, 1.5], low: [0.5, 2] };

export interface EtaPresentationInput {
  jobId: string;
  port?: number | null;
  eta: Eta | null | undefined;
  /** the field energy readings of the current port (store.ts liveEnergy) */
  energy?: readonly { ts: number; db: number }[];
  /** the timestep the excitation pulse ends at (RunInfo.pulse_steps): before it the energy is flat, so
   * the solver's "the limit comes first" is only the pulse, not a run that will not converge */
  pulseEnd?: number;
  /** wall clock, s (defaults to now) */
  now?: number;
}

export interface EtaPresentation {
  state: "waiting" | "range" | "timestep-bound" | "converged";
  /** while waiting: for the first energy readings, or for the energy to fall far enough */
  waitingFor?: "samples" | "decay";
  basis?: Eta["basis"];
  confidence?: Eta["confidence"];
  points?: number;
  /** Raw whole-job estimate when available, otherwise the current-port estimate. */
  rawSeconds?: number;
  /** remaining time, the narrowing range of finishing times as seen now */
  rangeSeconds?: [number, number];
  /** Raw time to the active port's configured timestep limit. */
  limitSeconds?: number;
  /** Raw estimate for the current port, even when rawSeconds represents the whole job. */
  portSeconds?: number;
  /** Raw multi-port projection inputs, retained for the expandable technical detail. */
  jobSeconds?: number;
  portsRemaining?: number;
  timestep?: number;
  targetTimestep?: number;
  remainingTimesteps?: number;
}

/** One presenter per live run. The range resets with the job, the excited port, the estimate basis,
 * or a switch between a port ETA and a whole-job ETA. */
export function createEtaPresenter() {
  let identity = "";
  let range: [number, number] | null = null;
  let previous: string | null = null;

  return ({ jobId, port = null, eta, energy, pulseEnd, now = Date.now() / 1000 }: EtaPresentationInput): EtaPresentation => {
    const basis = eta?.basis;
    const jobSeconds = finiteNonnegative(eta?.job_eta_s);
    const portSeconds = finiteNonnegative(eta?.eta_s);
    const source = jobSeconds === null ? "port" : "job";
    const nextIdentity = `${jobId}|${port ?? "-"}|${basis ?? "unknown"}|${source}`;
    if (identity !== nextIdentity) {
      identity = nextIdentity;
      range = null;
      previous = null;
    }
    const rawSeconds = jobSeconds ?? portSeconds ?? undefined;
    const timestep = finiteNonnegative(eta?.timestep);
    const base: EtaPresentation = {
      state: "waiting",
      basis,
      confidence: eta?.confidence,
      points: eta?.points,
      rawSeconds,
      limitSeconds: finiteNonnegative(eta?.limit_s) ?? undefined,
      portSeconds: portSeconds ?? undefined,
      jobSeconds: jobSeconds ?? undefined,
      portsRemaining: finiteNonnegative(eta?.ports_remaining) ?? undefined,
      timestep: timestep ?? undefined,
      targetTimestep: finiteNonnegative(eta?.target_timestep) ?? undefined,
      remainingTimesteps: finiteNonnegative(eta?.remaining_timesteps) ?? undefined,
    };

    if (basis === "converged") return { ...base, state: "converged" };
    // while the pulse runs the energy cannot fall yet, and right after it the decay has only begun: "the
    // limit comes first" then says nothing about the run (it read "≤ 11 min" for a run of seconds)
    if (basis === "timestep-limit" && ((pulseEnd && (timestep ?? 0) < pulseEnd) || (energy && !decayEstablished(energy)))) return { ...base, waitingFor: "decay" };
    if (basis === "timestep-limit") return { ...base, state: "timestep-bound" };
    if (rawSeconds === undefined) return { ...base, waitingFor: "samples" };
    // energy readings the caller did not pass count as established (a server forecast alone)
    if (energy && !decayEstablished(energy)) return { ...base, waitingFor: energy.length < 2 ? "samples" : "decay" };

    // a new projection (another timestep or value) moves the range; the same one only ages it
    const key = `${timestep ?? "-"}|${rawSeconds}`;
    if (key !== previous) {
      previous = key;
      const [lo, hi] = SPREAD[eta?.confidence ?? ""] ?? SPREAD.low;
      const finish = now + rawSeconds;
      const around: [number, number] = [now + rawSeconds * lo, now + rawSeconds * hi];
      if (!range || finish < range[0] || finish > range[1]) range = around;
      else range = [Math.max(range[0], Math.min(around[0], finish)), Math.min(range[1], Math.max(around[1], finish))];
    }
    const lower = Math.max(0, range![0] - now), upper = Math.max(lower, range![1] - now);
    return { ...base, state: "range", rangeSeconds: [lower, upper] };
  };
}

function finiteNonnegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
