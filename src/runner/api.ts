// Client for the local run server (`fairbeam serve`, python/fairbeam/server.py), reached through
// the Vite dev proxy at /api. Every call fails soft: the viewer works without the server.
import type { Bundle } from "../types";
import type { Design } from "../designer/types";
import type { Check as DesignCheck } from "../designer/checks";
import type { ConvergenceStudy } from "../designer/convergence";
import type { TemplateKey } from "../designer/templates";
import { t } from "../i18n/index.ts";

export interface Preflight { level: "ok" | "warn" | "refuse" | "unknown"; messages: string[]; estimate_bytes: number | null; free_bytes: number | null }
/** threads 0 is Auto in the UI; the server takes "auto" */
const withThreads = <T extends { threads: number }>(b: T) => ({ ...b, threads: b.threads === 0 ? "auto" : b.threads });

export interface Health {
  ok: boolean;
  api: number;
  fairbeam: string;
  openems: string | null;
  csxcad: string | null;
  python: string;
  cpu_count: number;
  default_threads: number;
  /** FDTD engines for `fairbeam run --engine`: always "cpu", "gpu" with the Metal/CUDA build */
  engines?: string[];
  python_executable?: string;
  models_dir: string;
  /** Opaque canonical models-directory identity, returned by current servers. */
  backup_scope?: string;
  projects_dir: string;
  jobs_dir: string;
  /** the server's run queue: the running job, how many wait, a counter bumped on every change (a run
   * added, started, ended or removed, whoever submitted it) and the `fairbeam run` processes started
   * outside the server (a terminal) that use the CPU; version and external are absent on older servers */
  queue: { running: string | null; queued: number; version?: number; external?: number };
  /** physical cores (Auto uses these, not the hyperthreads) */
  physical_cores?: number;
  host_cpu?: string | null;
  /** median MCells/s of this machine's past runs per engine, from the run index */
  throughput?: Record<string, { mcells_s: number; runs: number }>;
  /** memory available now, null when the OS does not say */
  memory_free_bytes?: number | null;
  /** true when the desktop app started the server: external links then go through openFeedback */
  desktop?: boolean;
}

export interface ParamSpec {
  key: string;
  default: number | string | boolean;
  label: string;
  unit: string;
  description: string;
  minimum: number | null;
  maximum: number | null;
  type: "int" | "float" | "str" | "bool";
}

export interface DesignFile {
  id: string;
  file: string;
  design: Design;
  hash: string;
  readonly: boolean;
  /** Captured with this file response; do not substitute a later health response. */
  backup_scope?: string;
}

export interface PythonDesignSource {
  /** Existing saved Python model whose source should be converted and linked to the Design. */
  source_model: string;
  /** Model identity used for the resulting Design. */
  model?: Design["model"];
}

export interface ModelEntry {
  key: string;
  /** File modification time in Unix seconds; absent on older servers. */
  modified?: number;
  file: string;
  model?: { id: string; name: string; description?: string; reference?: string };
  params?: ParamSpec[];
  error?: string;
  traceback?: string;
  /** error position in the model file (load errors) */
  location?: ErrorLocation | null;
  /** module docstring (templates) */
  doc?: string;
  /** bundled example: read-only in the editor */
  readonly?: boolean;
  /** "design": a *.design.json made in the designer; "python" (or absent): a model file */
  kind?: "design" | "python";
  /** Saved Python model that was converted into this Design, if it still represents that source. */
  python_source_model?: string;
}

export interface ErrorLocation {
  /** design files: the JSON path of the field, e.g. "parts[0].primitives[1].stop[2]" */
  path?: string;
  line?: number;
  column?: number | null;
  end_line?: number | null;
  text?: string | null;
  function?: string;
}

/** Result of loading and building a saved model file in the preview worker. */
/** What a CST macro import made and every note about it (python/fairbeam/cst_import.py import_cst). */
export interface CstImportReport {
  created: { kind: "parameter" | "material" | "part" | "port" | "resistor"; name: string; detail: string }[];
  /** refused: not imported; warning: imported with a change; info: ignored settings and defaults */
  notes: {
    severity: "refused" | "warning" | "info"; where: string; line: number; message: string;
    /** the message in Turkish, when the server words it in both languages */
    message_tr?: string;
    /** "missing": fairbeam's own CST export left it out; "exporter": another note it wrote into the macro */
    kind?: "missing" | "exporter";
    /** identical rows merged: how many there were, and the line of each */
    count?: number; lines?: number[];
  }[];
  counts: Record<"parameter" | "material" | "part" | "port" | "resistor", number>;
  refused: number;
  warnings: number;
  history_items: number;
  suggested_name: string;
}

/** A layer of the imported PCB files and the role it was given (python/fairbeam/pcb_import.py report["detected"]). */
export interface PcbLayer {
  source: string;
  layer: string;
  kind: "dxf" | "gerber" | "drill";
  /** null: the name gives no hint and nothing was mapped, so the layer is not used */
  role: PcbRole | "drill" | null;
  /** why: "layer name", "Gerber file function", "Excellon file", "layer map <key>", "the only layer with outlines" */
  because: string;
  outlines: number;
  holes: number;
  entities: number;
}
export type PcbRole = "top_copper" | "bottom_copper" | "outline" | "ignore";

/** What a PCB artwork import made and every note about it (pcb_import.py import_pcb). */
export interface PcbImportReport {
  created: { kind: "material" | "part"; name: string; detail: string }[];
  /** refused first, then warnings, then info */
  notes: { severity: "refused" | "warning" | "info"; where: string; line: number; message: string; count?: number; lines?: number[] }[];
  counts: Record<"material" | "part" | "polygon" | "hole" | "via" | "port", number>;
  refused: number;
  warnings: number;
  layers: { source: string; layer: string; role: string; because: string }[];
  detected: PcbLayer[];
  /** what was added to the file coordinates to centre the board (mm) */
  offset: [number, number];
  chord_tol: number;
  suggested_name: string;
}

/** The options of a PCB import (POST /api/import/pcb): absent means the importer's default. */
export interface PcbOptions {
  layer_map?: Record<string, PcbRole>;
  substrate?: string;
  thickness?: number;
  eps_r?: number;
  tan_d?: number;
  f0?: number;
  units?: "auto" | "mm" | "inch";
  chord_tol?: number;
  margin?: number;
  origin?: "center" | "keep";
}
export interface PcbFile { name: string; content_base64: string }

export interface Validation {
  valid: boolean;
  model?: ModelEntry;
  build_s?: number;
  error?: { message: string; stage: "load" | "build"; location?: ErrorLocation | null; traceback?: string };
  /** design files: fairbeam.design_checks results (errors block a save) */
  checks?: DesignCheck[];
}

export interface ModelSource {
  id: string;
  file: string;
  source: string;
  hash: string;
  readonly: boolean;
}

export interface ModelVersion {
  version: string;
  saved: number;
  bytes: number;
  lines: number;
  hash: string;
}

export type ParamValue = number | string | boolean;

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";
export type Phase = "queued" | "building" | "setup" | "running" | "postprocessing" | "exporting" | JobStatus;

export interface Eta {
  estimate: true;
  end_db: number;
  points: number;
  timestep: number;
  eta_s?: number | null;
  limit_s?: number | null;
  remaining_timesteps?: number;
  target_timestep?: number;
  basis?: "converged" | "energy-fit" | "energy-anchor" | "timestep-limit";
  confidence?: "high" | "medium" | "low" | "bound";
  /** multi-port runs: remaining time of the whole job (this port + the ports still to run) */
  job_eta_s?: number;
  ports_remaining?: number;
}

export interface ProgressEvent {
  type: "progress";
  timestep: number;
  speed_mcs: number;
  s_per_ts: number | null;
  solver_clock_s: number | null;
  energy_db?: number | null;
  energy_fraction?: number;
  timestep_fraction?: number;
  eta: Eta | null;
  /** multi-port runs: openEMS run k of n (port p) */
  port_run?: number;
  port_total?: number;
  port?: number;
}

export interface RunStats {
  timesteps?: number;
  solver_time_s?: number;
  speed_mcells_s?: number;
  converged?: boolean;
  final_energy_db?: number;
  /** instead of final_energy_db when openEMS logged no energy line: the energy is at most this (dB) */
  final_energy_bound_db?: number;
  hit_timestep_limit?: boolean;
  bands?: { f_lo_ghz: number; f_hi_ghz: number; s11_min_db: number; f_center_ghz: number }[];
  farfield?: { f_ghz: number; dmax_dbi: number; rad_efficiency?: number | null }[];
}

export interface RunInfo {
  label?: string;
  /** from the run's own settings line; replaces the requested criterion */
  end_criteria_db?: number;
  engine?: string;
  threads?: number;
  openems?: string;
  grid?: [number, number, number];
  cells?: number;
  dt_s?: number;
  nyquist_timesteps?: number;
  /** the timestep the excitation pulse ends at: the energy stays flat until then */
  pulse_steps?: number;
  max_timesteps?: number;
  port_run?: number;
  port_total?: number;
  port?: number;
}

/** Every event carries seq (1, 2, ...), at (Unix time, s) and t (seconds since the job started, or since it was queued before it started). */
export type JobEvent = { seq: number; at: number; t: number } & (
  | { type: "status"; status: JobStatus; error?: string; exit_code?: number | null; bundle?: string | null; duration_s?: number | null; stderr_tail?: string[]; pid?: number; command?: string[] }
  | { type: "phase"; phase: Phase }
  | { type: "log"; stream: "stdout" | "stderr"; line: string }
  | ({ type: "info" } & RunInfo)
  | ProgressEvent
  | ({ type: "stats" } & RunStats)
  | { type: "result"; bundle: string; path: string }
  | { type: "error"; message: string }
  | ({ type: "opt_start" } & { name: string; file: string; max_evals: number })
  | ({ type: "opt_eval" } & OptEval & { best_index: number; best_cost: number; max_evals: number; evaluations?: number; best_params?: Record<string, number>; best_file?: string | null; elapsed_s?: number; eta_s?: number })
  | ({ type: "opt_done" } & OptDone)
);

export interface SweepAxis {
  key: string;
  values: number[];
}

/** Sweep membership of a job (POST /api/sweeps tags every job it creates). */
export interface JobSweep {
  id: string;
  name: string;
  index: number;
  total: number;
  values: Record<string, number>;
  axes: SweepAxis[];
  sequence_index?: number;
  sequence_name?: string;
  /** "convergence": a mesh convergence study (POST /api/convergence); verdict and total once it closes */
  kind?: "convergence";
  verdict?: string;
  converged_at?: number | null;
  reason?: string;
}

/** One axis as sent to the server: explicit values or a linear range. */
export type SweepAxisRequest = { key: string; values: number[] } | { key: string; start: number; stop: number; steps: number };

/** Single-port goals, and multi-port goals on results.sparams (sij_max, sij_min, match_all). */
export type GoalKind = "f0" | "s11_max" | "bw_min" | "dmax_min" | "sij_max" | "sij_min" | "match_all";
export interface OptGoal {
  kind: GoalKind;
  target: number;
  at?: number | null;
  weight?: number;
  /** [i, j] for sij_max / sij_min: |S_ij|, receiving port i, driven port j */
  ports?: [number, number] | null;
}
export interface OptVary {
  key: string;
  min: number;
  max: number;
  start?: number | null;
}
/** Metrics of one optimization evaluation (python/fairbeam/optimize.py bundle_metrics). */
export interface OptMetrics {
  f0_ghz: number | null;
  f0_source: "band" | "reactance" | "s11_min" | null;
  s11_f0_db?: number;
  s11_min_db: number | null;
  bw_mhz: number | null;
  s11_at: Record<string, number>;
  dmax_at: Record<string, number>;
  /** "i,j@f" -> |S_ij| dB (null when neither column was driven) */
  sij_at?: Record<string, number | null>;
  /** "f" -> worst |S_ii| and every port's value (null when a port was not driven) */
  match_all_at?: Record<string, { max: number; ports: Record<string, number | null> } | null>;
  wall_time_s?: number;
  engine?: string;
}
export interface OptEval {
  index: number;
  params: Record<string, number>;
  metrics: OptMetrics;
  cost: number;
  met: boolean;
  error?: string;
  /** not simulated: why the design checks refused the candidate (python/fairbeam/optimize.py precheck) */
  skipped?: string;
  goals?: { goal: string; kind: GoalKind; value: number | null; cost: number; met: boolean }[];
  file: string | null;
  wall_time_s: number;
}
export interface OptDone {
  name: string;
  file: string;
  reason: string;
  method: string;
  evaluations: number;
  best: OptEval | null;
  start: OptEval | null;
  wall_time_s: number;
}

export interface Job {
  id: string;
  /** "run" (fairbeam run) or "optimize" (fairbeam optimize) */
  kind?: "run" | "optimize";
  optimize?: { vary: OptVary[]; goals: OptGoal[]; max_evals: number; method: string; excite?: string } | null;
  /** display name given by the user (the bundle file name is its slug, `name`) */
  label: string | null;
  sweep: JobSweep | null;
  model: string;
  model_id: string | null;
  params: Record<string, ParamValue>;
  overrides: Record<string, string>;
  threads: number;
  name: string | null;
  status: JobStatus;
  phase: Phase;
  created: number;
  started: number | null;
  finished: number | null;
  created_iso: string | null;
  duration_s: number | null;
  exit_code: number | null;
  bundle: string | null;
  error: string | null;
  /** the effective end criterion: the requested one, then the run's own settings line; null while a
   * run that keeps the model's default has not reported it yet */
  end_criteria_db: number | null;
  /** `end_criteria_db` of the request (passed on as `--end-db`); null/absent: the model's default */
  requested_end_criteria_db?: number | null;
  engine: string | null;
  /** frequency points of the run (`fairbeam run --points`); null: the default (801) */
  points?: number | null;
  /** a design's automatic mesh density for this run (`fairbeam run --mesh-density`); null: the design's own */
  mesh_density?: number | null;
  last_progress: ProgressEvent | null;
  stats: RunStats;
  info: RunInfo;
}

export interface PreviewResult {
  model: string;
  params: Record<string, ParamValue>;
  overrides: Record<string, string>;
  build_s: number;
  elapsed_s: number;
  bundle: Bundle;
  /** design previews: fairbeam.design_checks results */
  checks?: DesignCheck[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public fields: Record<string, string> = {},
    /** the full error body (e.g. current_hash on a save conflict) */
    public data: Record<string, unknown> = {},
    /** the technical side of a generic failure ("HTTP 500 · POST /api/runs"), for a Details disclosure
     * next to the human message; empty when the server gave its own message */
    public detail = "",
  ) {
    super(message);
  }
}

/** Called after a request failed in a way that may mean the server is gone (no answer, or a 5xx):
 * the run store looks at /api/health again, so "Server online" does not go stale. */
let failureHook: (() => void) | null = null;
export function onApiFailure(hook: () => void) { failureHook = hook; }

async function call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`/api${path}`, {
      method,
      signal,
      cache: "no-store",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    if (path !== "/health") failureHook?.();
    throw new ApiError(t("common.serverUnreachable"), 0);
  }
  const text = await r.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // the Vite proxy answers 500/502 with plain text when `fairbeam serve` is not running
    if (path !== "/health" && (!r.ok || r.status >= 500)) failureHook?.();
    throw new ApiError(r.ok ? t("api.badResponse") : t("common.serverUnreachable"), r.ok ? r.status : 0);
  }
  if (!r.ok) {
    const d = (data ?? {}) as { error?: string; fields?: Record<string, string> };
    if (path !== "/health" && r.status >= 500) failureHook?.();
    // the server's own message is shown as it is; a bare failure gets a human sentence, and the
    // status and path go to a Details disclosure instead of standing alone ("HTTP 500")
    throw new ApiError(d.error ?? t("api.serverError"), r.status, d.fields ?? {}, (data ?? {}) as Record<string, unknown>,
      d.error ? "" : `HTTP ${r.status} · ${method} /api${path}`);
  }
  return data as T;
}

export const api = {
  previewExampleConversion: (body: { from: string; project?: string }, signal?: AbortSignal) =>
    call<{ source_cells: number | null; design_cells: number | null; within_tolerance: boolean | null; params_carried?: number; params_total?: number; params_partial?: string[]; expressions?: number }>("POST", "/examples/conversion-preview", body, signal),
  copyExample: (body: { from: string; id: string; name: string; project?: string }) =>
    call<{ id: string; kind: "design"; validation: Validation }>("POST", "/examples/copy", body),
  health: (signal?: AbortSignal) => call<Health>("GET", "/health", undefined, signal),
  /** open an issue form of the public tracker in the system browser (desktop app; the server accepts only those URLs) */
  openFeedback: (url: string) => call<{ opened: boolean }>("POST", "/open-feedback", { url }),
  models: () => call<{ models: ModelEntry[] }>("GET", "/models").then((d) => d.models),
  preview: (model: string, params: Record<string, ParamValue>, signal?: AbortSignal) =>
    call<PreviewResult>("POST", "/preview", { model, params }, signal),
  runs: () => call<{ runs: Job[] }>("GET", "/runs").then((d) => d.runs),
  submit: (body: { model: string; params: Record<string, ParamValue>; threads: number; engine?: string; name?: string; end_criteria_db?: number; points?: number; cells?: number }) =>
    call<Job>("POST", "/runs", withThreads(body)),
  /** memory / CPU check of a planned run; level "unknown" means it could not be checked */
  preflight: (body: { cells?: number; engine?: string }) => call<Preflight>("POST", "/preflight", body),
  cancel: (id: string) => call<Job>("POST", `/runs/${encodeURIComponent(id)}/cancel`, {}),
  /** cancel every queued run; the running one keeps running (stop it with cancel) */
  clearQueue: () => call<{ cancelled: string[]; runs: Job[] }>("POST", "/queue/clear", {}),
  submitOptimization: (body: { model: string; params: Record<string, ParamValue>; threads: number; engine?: string; name?: string; vary: OptVary[]; goals: OptGoal[]; max_evals: number; cells?: number; method?: string; excite?: string }) =>
    call<Job>("POST", "/optimizations", withThreads(body)),
  saveOptimizationBest: (id: string) => call<{ file: string }>("POST", `/optimizations/${encodeURIComponent(id)}/save-best`, {}),
  submitSweep: (body: { model: string; params: Record<string, ParamValue>; threads: number; engine?: string; name?: string; end_criteria_db?: number; sweep?: SweepAxisRequest[]; cells?: number; sequences?: { name: string; sweep: SweepAxisRequest[] }[] }) =>
    call<{ sweep: { id: string; name: string; axes: SweepAxis[]; total: number }; runs: Job[] }>("POST", "/sweeps", withThreads(body)),
  cancelSweep: (id: string) => call<{ runs: Job[] }>("POST", `/sweeps/${encodeURIComponent(id)}/cancel`, {}),
  /** a mesh convergence study of a saved design; stop it with cancelSweep(study.id) */
  submitConvergence: (body: { model: string; params: Record<string, ParamValue>; threads: number; engine?: string; name?: string; densities: number[]; cells?: number; tolerances: { f_pct: number; s11_db: number; dmax_db: number }; max_runs: number }) =>
    call<{ study: ConvergenceStudy; runs: Job[] }>("POST", "/convergence", withThreads(body)),
  convergence: (id: string) => call<ConvergenceStudy>("GET", `/convergence/${encodeURIComponent(id)}`),
  deleteRun: (id: string, deleteBundle: boolean) =>
    call<{ deleted: string; bundle_deleted: string | null }>("POST", `/runs/${encodeURIComponent(id)}/delete`, { delete_bundle: deleteBundle }),
  templates: () => call<{ templates: ModelEntry[] }>("GET", "/templates").then((d) => d.templates),
  createModel: (body: { id: string; name?: string; template?: string; from?: string }) =>
    call<ModelSource & { validation: Validation }>("POST", "/models", body),
  modelSource: (id: string) => call<ModelSource>("GET", `/models/${encodeURIComponent(id)}/source`),
  saveSource: (id: string, source: string, baseHash: string) =>
    call<{ id: string; hash: string; backup: string | null; validation: Validation }>("PUT", `/models/${encodeURIComponent(id)}/source`, { source, base_hash: baseHash }),
  modelHistory: (id: string) => call<{ versions: ModelVersion[] }>("GET", `/models/${encodeURIComponent(id)}/history`).then((d) => d.versions),
  modelVersion: (id: string, version: string) =>
    call<{ id: string; version: string; source: string; hash: string }>("GET", `/models/${encodeURIComponent(id)}/history/${encodeURIComponent(version)}`),
  createDesign: (body: { id: string; name?: string; from?: string; template?: TemplateKey; python?: PythonDesignSource; cst?: { source: string; filename?: string };
    pcb?: { files: PcbFile[]; options?: PcbOptions }; design?: Design }) =>
    call<DesignFile & { validation: Validation; import_report?: CstImportReport | PcbImportReport }>("POST", "/designs", body),
  /** PCB artwork (DXF, Gerber, Excellon) read as a design, not saved (python/fairbeam/pcb_import.py): the import report,
   * its layers with their roles and the design checks. A 422 for files without copper carries `data.layers` too. */
  importPcb: (body: { files: PcbFile[]; options?: PcbOptions; name?: string }, signal?: AbortSignal) =>
    call<{ design: Design; report: PcbImportReport; layers: PcbLayer[]; checks: DesignCheck[] }>("POST", "/import/pcb", body, signal),
  /** a CST-compatible VBA macro (`source`) read as a design, not saved (python/fairbeam/cst_import.py): the import report
   * and the design checks */
  importCst: (body: { source: string; filename?: string; name?: string }) =>
    call<{ design: Design; report: CstImportReport; checks: DesignCheck[] }>("POST", "/import/cst", body),
  design: (id: string) => call<DesignFile>("GET", `/designs/${encodeURIComponent(id)}`),
  saveDesign: (id: string, design: Design, baseHash: string, scope?: string) =>
    call<{ id: string; hash: string; backup: string | null; backup_scope?: string; validation: Validation }>("PUT", `/designs/${encodeURIComponent(id)}`, { design, base_hash: baseHash, backup_scope: scope }),
  renameDesign: (id: string, name: string, baseHash: string, scope?: string) => call<{ id: string; file: string; name: string; previous_name: string; hash: string; backup_scope?: string }>("POST", `/designs/${encodeURIComponent(id)}/rename`, { name, base_hash: baseHash, backup_scope: scope }),
  designLocation: (id: string) => call<{ id: string; path: string }>("GET", `/designs/${encodeURIComponent(id)}/location`),
  designPython: (id: string) => call<{ id: string; source: string }>("GET", `/designs/${encodeURIComponent(id)}/python`),
  /** a model script built into a design, never solved (python/fairbeam/python_design.py); a 422 carries `data.line` and `data.timeout` */
  designFromPython: (source: string, model?: Design["model"]) =>
    call<{ design: Design; python: string; normalized: boolean; output: string }>("POST", "/design/from-python", { source, model }),
  /** moves the file into the design's history folder (recoverable) */
  deleteDesign: (id: string, scope?: string) => call<{ id: string; file: string; moved_to: string; backup_scope?: string }>("POST", `/designs/${encodeURIComponent(id)}/delete`, { backup_scope: scope }),
  /** the user's material library ("My materials", python/fairbeam/usermaterials.py); entries are validated by the server, bad ones come back in `skipped` */
  userMaterials: () => call<{ materials: unknown[]; skipped: string[]; file: string }>("GET", "/materials/user"),
  saveUserMaterials: (materials: unknown[]) => call<{ materials: unknown[]; skipped: string[]; file: string }>("PUT", "/materials/user", { materials }),
  previewDesign: (design: Design, params: Record<string, ParamValue>, signal?: AbortSignal) =>
    call<PreviewResult>("POST", "/preview", { design, params }, signal),
  logUrl: (id: string) => `/api/runs/${encodeURIComponent(id)}/log`,
  eventsUrl: (id: string) => `/api/runs/${encodeURIComponent(id)}/events`,
};

export const TERMINAL: JobStatus[] = ["done", "failed", "cancelled", "interrupted"];
export const isTerminal = (s: JobStatus) => TERMINAL.includes(s);
