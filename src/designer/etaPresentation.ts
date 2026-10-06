import type { Eta } from "../runner/api";

/** Keep the display envelope tied to real recent solver projections. These are presentation bounds,
 * not confidence limits: keep at most four observations, clip stale low/high projections to half or
 * twice the current raw projection, and always include the newest raw projection (especially when it
 * gets worse). The raw ETA remains available in the run detail. */
const HISTORY_SIZE = 4;
const MIN_RANGE_FACTOR = 0.5;
const MAX_RANGE_FACTOR = 2;
/** Ease downwards by 35%, but cap its lag at the smaller of 15% or 3 seconds. */
const DECREASE_BLEND = 0.35;
const MAX_LAG_FACTOR = 0.15;
const MAX_LAG_SECONDS = 3;

export interface EtaPresentationInput {
  jobId: string;
  port?: number | null;
  eta: Eta | null | undefined;
}

export interface EtaPresentation {
  state: "waiting" | "early" | "range" | "timestep-bound" | "converged";
  basis?: Eta["basis"];
  confidence?: Eta["confidence"];
  points?: number;
  /** Raw whole-job estimate when available, otherwise the current-port estimate. */
  rawSeconds?: number;
  /** A smoothed display value; never lower than the raw value when the solver projection worsens. */
  displaySeconds?: number;
  /** A bounded envelope of recent projections, not a statistical confidence interval. */
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

type Projection = { timestep: number | null; seconds: number };

/** One presenter per live run. Forecast smoothing and range history reset with the job, excited
 * port, estimate basis, or switch between a port ETA and a whole-job ETA. */
export function createEtaPresenter() {
  let identity = "";
  let previousTimestep: number | null = null;
  let previousRaw: number | null = null;
  let smoothed: number | null = null;
  let history: Projection[] = [];

  return ({ jobId, port = null, eta }: EtaPresentationInput): EtaPresentation => {
    const basis = eta?.basis;
    const jobSeconds = finiteNonnegative(eta?.job_eta_s);
    const portSeconds = finiteNonnegative(eta?.eta_s);
    const source = jobSeconds === null ? "port" : "job";
    const nextIdentity = `${jobId}|${port ?? "-"}|${basis ?? "unknown"}|${source}`;
    if (identity !== nextIdentity) {
      identity = nextIdentity;
      previousTimestep = null;
      previousRaw = null;
      smoothed = null;
      history = [];
    }

    const rawSeconds = jobSeconds ?? portSeconds ?? undefined;
    const timestep = finiteNonnegative(eta?.timestep);
    if (rawSeconds !== undefined && (timestep !== previousTimestep || rawSeconds !== previousRaw)) {
      if (smoothed === null || rawSeconds >= smoothed || (previousRaw !== null && rawSeconds > previousRaw)) {
        // A slower/worsening projection is shown immediately; smoothing never conceals it.
        smoothed = rawSeconds;
      } else {
        const blended = smoothed + (rawSeconds - smoothed) * DECREASE_BLEND;
        const maxLag = Math.min(MAX_LAG_SECONDS, rawSeconds * MAX_LAG_FACTOR);
        smoothed = Math.max(rawSeconds, Math.min(blended, rawSeconds + maxLag));
      }
      history.push({ timestep, seconds: rawSeconds });
      if (history.length > HISTORY_SIZE) history = history.slice(-HISTORY_SIZE);
      previousTimestep = timestep;
      previousRaw = rawSeconds;
    }

    const base: EtaPresentation = {
      state: "waiting",
      basis,
      confidence: eta?.confidence,
      points: eta?.points,
      rawSeconds,
      displaySeconds: smoothed ?? rawSeconds,
      limitSeconds: finiteNonnegative(eta?.limit_s) ?? undefined,
      portSeconds: portSeconds ?? undefined,
      jobSeconds: jobSeconds ?? undefined,
      portsRemaining: finiteNonnegative(eta?.ports_remaining) ?? undefined,
      timestep: timestep ?? undefined,
      targetTimestep: finiteNonnegative(eta?.target_timestep) ?? undefined,
      remainingTimesteps: finiteNonnegative(eta?.remaining_timesteps) ?? undefined,
    };

    if (basis === "converged") return { ...base, state: "converged" };
    if (basis === "timestep-limit") return { ...base, state: "timestep-bound" };
    if (rawSeconds === undefined) return base;

    // Two samples produce a rough point estimate. Wait for at least three before showing a range.
    if ((eta?.points ?? 0) < 3 || history.length < 3 || (eta?.confidence !== "medium" && eta?.confidence !== "high")) {
      return { ...base, state: "early" };
    }

    const observed = history.map((p) => p.seconds);
    if (smoothed !== null) observed.push(smoothed);
    const lower = Math.max(rawSeconds * MIN_RANGE_FACTOR, Math.min(rawSeconds, ...observed));
    const upper = Math.max(rawSeconds, Math.min(rawSeconds * MAX_RANGE_FACTOR, Math.max(...observed)));
    return { ...base, state: "range", rangeSeconds: [lower, upper] };
  };
}

function finiteNonnegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
