import { For, onMount, Show } from "solid-js";
import { CircleAlert, LoaderCircle, Plus, Target, X } from "lucide-solid";
import { seconds } from "../lib/format";
import { radioGroupKeys } from "../lib/a11y";
import type { GoalKind } from "./api";
import {
  addGoal,
  addVary,
  drivenPorts,
  ensureOptimizeForm,
  excite,
  GOAL_PRESETS,
  goals,
  lastEvalSeconds,
  MAX_OPT_EVALS,
  canAddVary,
  maxEvals,
  method,
  modelPorts,
  nextGoalKind,
  optEngine,
  optErrors,
  optPlan,
  perPortSeconds,
  presetOf,
  removeGoal,
  removeVary,
  setExcite,
  setGoalKind,
  setGoals,
  setMaxEvals,
  setMethod,
  setOptEngine,
  setVary,
  setVaryKey,
  startOptimize,
  vary,
} from "./optimize";
import { health, meshSource, runName, setRunName, specs, submitError, submitting, threads, setThreads } from "./store";
import { t } from "../i18n";
import NumberField from "../components/NumberField";
import { PreflightNote } from "../designer/PreflightNote";
import { meshStats } from "../designer/meshStats";

/** The target field's label: an i18n key, or a symbol that stays as it is */
const TARGET_LABEL: Record<GoalKind, string> = {
  f0: "opt.target.frequency",
  s11_max: "|S11| ≤",
  bw_min: "opt.target.atLeast",
  dmax_min: "opt.target.atLeast",
  match_all: "opt.target.everySii",
  sij_max: "|Sij| ≤",
  sij_min: "|Sij| ≥",
};
const targetLabel = (kind: GoalKind) => (TARGET_LABEL[kind].startsWith("opt.") ? t(TARGET_LABEL[kind]) : TARGET_LABEL[kind]);

/** One line on what a method is for: the tooltip of the Method field and of each option, and the
 * hint under the field (for the method in use). */
const METHOD_TITLE: Record<string, string> = {
  secant: "opt.method.secant.title",
  "nelder-mead": "opt.method.nelderMead.title",
  bayesian: "opt.method.bayesian.title",
  "cma-es": "opt.method.cmaEs.title",
  "particle-swarm": "opt.method.particleSwarm.title",
  genetic: "opt.method.genetic.title",
  "trust-region": "opt.method.trustRegion.title",
};
const methodTitle = (m: string) => (METHOD_TITLE[m] ? t(METHOD_TITLE[m]) : "");

/** Run panel "Optimize" mode: parameters to vary, goals, engine and budget. */
export default function OptimizePanel(props: { onStarted?: (job: import("./api").Job) => void } = {}) {
  onMount(ensureOptimizeForm);
  const numeric = () => specs().filter((s) => s.type === "int" || s.type === "float");
  const engines = () => health()?.engines ?? ["cpu"];
  const cpuOptions = () => Array.from({ length: health()?.cpu_count ?? 1 }, (_, i) => i + 1);
  const err = (k: string) => optErrors()[k] ?? optPlan().errors[k];
  const multi = () => (modelPorts()?.length ?? 1) > 1;
  const nDriven = () => Math.max(1, drivenPorts()?.length ?? 1);
  const estimate = () => {
    const s = lastEvalSeconds();
    return s ? s * maxEvals() : null;
  };

  return (
    <div class="stack op-form">
      <div class="op-block stack-sm">
        <div class="op-head">
          <span class="op-title">{t("opt.vary")}</span>
          <span class="note op-hint">{t("opt.vary.hint")}</span>
        </div>
        <For each={vary}>
          {(v, i) => {
            const spec = () => specs().find((s) => s.key === v.key);
            const id = (k: string) => `op-vary-${i()}-${k}`;
            return (
              <fieldset class="op-row">
                <legend class="visually-hidden">{t("opt.varyLegend", { n: i() + 1 })}</legend>
                <select class="rp-select rp-select-sm op-grow" aria-label={t("opt.parameterN", { n: i() + 1 })} value={v.key} onChange={(e) => setVaryKey(i(), e.currentTarget.value)}>
                  <For each={numeric()}>
                    {(s) => <option value={s.key} disabled={s.key !== v.key && vary.some((x) => x.key === s.key)}>{s.label} ({s.key})</option>}
                  </For>
                </select>
                <div class="op-range">
                  <label class="rp-mini" for={id("start")}>
                    <span>{t("opt.start")}{spec()?.unit ? ` (${spec()!.unit})` : ""}</span>
                    <NumberField id={id("start")} class="rp-input" step="any" value={v.start} onInput={(e) => setVary(i(), "start", e.currentTarget.value)} />
                  </label>
                  <label class="rp-mini" for={id("min")}>
                    <span>{t("opt.min")}{spec()?.unit ? ` (${spec()!.unit})` : ""}</span>
                    <NumberField id={id("min")} class="rp-input" step="any" min={spec()?.minimum ?? undefined} max={spec()?.maximum ?? undefined}
                      value={v.min} onInput={(e) => setVary(i(), "min", e.currentTarget.value)} />
                  </label>
                  <label class="rp-mini" for={id("max")}>
                    <span>{t("opt.max")}{spec()?.unit ? ` (${spec()!.unit})` : ""}</span>
                    <NumberField id={id("max")} class="rp-input" step="any" min={spec()?.minimum ?? undefined} max={spec()?.maximum ?? undefined}
                      value={v.max} onInput={(e) => setVary(i(), "max", e.currentTarget.value)} />
                  </label>
                  <button class="icon-btn icon-btn-sm op-remove" onClick={() => removeVary(i())} disabled={vary.length === 1} aria-label={t("opt.removeVary", { key: v.key })} title={t("common.remove")}>
                    <X size={14} />
                  </button>
                </div>
                <Show when={err(`vary.${i()}`)}>
                  <p class="rp-error" role="alert"><CircleAlert size={12} aria-hidden="true" /> {err(`vary.${i()}`)}</p>
                </Show>
              </fieldset>
            );
          }}
        </For>
        <Show when={canAddVary()}>
          <div class="cluster-sm">
            <button class="btn btn-ghost btn-sm" onClick={addVary}><Plus size={14} aria-hidden="true" /> {t("opt.addParameter")}</button>
          </div>
        </Show>
      </div>

      <div class="op-block stack-sm">
        <div class="op-head">
          <span class="op-title">{t("opt.goals")}</span>
          <span class="note op-hint">{t("opt.goals.hint")}</span>
        </div>
        <For each={goals}>
          {(g, i) => {
            const preset = () => presetOf(g.kind);
            const id = (k: string) => `op-goal-${i()}-${k}`;
            const nPorts = () => modelPorts()?.length ?? null;
            return (
              <fieldset class="op-row">
                <legend class="visually-hidden">{t("opt.goalN", { n: i() + 1 })}</legend>
                <select class="rp-select rp-select-sm op-grow" aria-label={t("opt.goalN", { n: i() + 1 })} value={g.kind}
                  onChange={(e) => setGoalKind(i(), e.currentTarget.value as GoalKind)}>
                  <optgroup label={t("opt.group.antenna")}>
                    <For each={GOAL_PRESETS.filter((p) => !p.multi)}>{(p) => <option value={p.kind}>{t(p.label)}</option>}</For>
                  </optgroup>
                  <optgroup label={t("opt.group.multi")}>
                    <For each={GOAL_PRESETS.filter((p) => p.multi)}>
                      {(p) => <option value={p.kind} disabled={nPorts() === 1 && p.pair}>{t(p.label)}</option>}
                    </For>
                  </optgroup>
                </select>
                <Show when={preset().pair}>
                  <div class="cluster-sm op-pair" role="group" aria-label={t("opt.portPair", { n: i() + 1 })}>
                    <label class="rp-inline-field" for={id("i")}>
                      <span>{t("opt.portI")}</span>
                      <NumberField id={id("i")} class="rp-input op-port" step="1" min="1" max={nPorts() ?? undefined} value={g.i}
                        onInput={(e) => setGoals(i(), "i", e.currentTarget.value)} />
                    </label>
                    <label class="rp-inline-field" for={id("j")}>
                      <span>{t("opt.portJ")}</span>
                      <NumberField id={id("j")} class="rp-input op-port" step="1" min="1" max={nPorts() ?? undefined} value={g.j}
                        onInput={(e) => setGoals(i(), "j", e.currentTarget.value)} />
                    </label>
                  </div>
                </Show>
                <div class="op-goal">
                  <label class="rp-mini" for={id("target")}>
                    <span>{preset().pair && g.i && g.j ? `|S${g.i}${g.j}| ${g.kind === "sij_max" ? "≤" : "≥"}` : targetLabel(g.kind)} ({preset().unit})</span>
                    <NumberField id={id("target")} class="rp-input" step="any" value={g.target} onInput={(e) => setGoals(i(), "target", e.currentTarget.value)} />
                  </label>
                  <Show when={preset().needsAt}>
                    <label class="rp-mini" for={id("at")}>
                      <span>{t("opt.at")}</span>
                      <NumberField id={id("at")} class="rp-input" step="any" min="0" value={g.at} onInput={(e) => setGoals(i(), "at", e.currentTarget.value)} />
                    </label>
                  </Show>
                  <label class="rp-mini op-weight" for={id("w")}>
                    <span>{t("opt.weight")}</span>
                    <NumberField id={id("w")} class="rp-input" step="any" min="0" value={g.weight} onInput={(e) => setGoals(i(), "weight", e.currentTarget.value)} />
                  </label>
                  <button class="icon-btn icon-btn-sm op-remove" onClick={() => removeGoal(i())} disabled={goals.length === 1} aria-label={t("opt.removeGoal", { goal: t(preset().label) })} title={t("common.remove")}>
                    <X size={14} />
                  </button>
                </div>
                <p class="rp-hint op-row-hint">{t(preset().hint)}</p>
                <Show when={err(`goals.${i()}`)}>
                  <p class="rp-error" role="alert"><CircleAlert size={12} aria-hidden="true" /> {err(`goals.${i()}`)}</p>
                </Show>
              </fieldset>
            );
          }}
        </For>
        <Show when={goals.length < 4}>
          <div class="cluster-sm">
            <button class="btn btn-ghost btn-sm" onClick={() => addGoal(nextGoalKind())}>
              <Plus size={14} aria-hidden="true" /> {t("opt.addGoal")}
            </button>
          </div>
        </Show>
        <Show when={multi()}>
          <div class="cluster-sm op-excite">
            <span class="rp-small">{t("opt.drivenPorts")}</span>
            <div class="seg seg-sm" role="radiogroup" aria-label={t("opt.drivenPortsAria")} onKeyDown={radioGroupKeys}>
              <button class="seg-btn" role="radio" aria-checked={excite() === "auto"} tabindex={excite() === "auto" ? 0 : -1} onClick={() => setExcite("auto")}
                title={t("opt.excite.auto.title")}>{t("opt.excite.auto")}</button>
              <button class="seg-btn" role="radio" aria-checked={excite() === "all"} tabindex={excite() === "all" ? 0 : -1} onClick={() => setExcite("all")}
                title={t("opt.excite.all.title")}>{t("opt.excite.all")}</button>
            </div>
            <span class="rp-small mono">
              {drivenPorts()?.join(", ") ?? "—"}
              <span class="muted"> · {t("opt.runsPerEval", { count: nDriven() })}</span>
            </span>
          </div>
        </Show>
      </div>

      <div class="cluster">
        <label class="rp-inline-field">
          <span>{t("opt.maxEvals")}</span>
          <NumberField class="rp-input op-evals" min="1" max={MAX_OPT_EVALS} step="1" value={maxEvals()}
            onInput={(e) => setMaxEvals(Math.round(Number(e.currentTarget.value)))} aria-invalid={!!err("max_evals")} />
        </label>
        <Show when={engines().length > 1}>
          <div class="seg seg-sm" role="radiogroup" aria-label={t("run.engine")} onKeyDown={radioGroupKeys}>
            <For each={engines()}>
              {(e) => <button class="seg-btn" role="radio" aria-checked={optEngine() === e} tabindex={optEngine() === e ? 0 : -1} onClick={() => setOptEngine(e)}>{e.toUpperCase()}</button>}
            </For>
          </div>
        </Show>
        <Show when={optEngine() !== "gpu"}>
          <label class="rp-inline-field">
            <span>{t("run.threads")}</span>
            <select class="rp-select rp-select-sm" value={threads()} onChange={(e) => setThreads(Number(e.currentTarget.value))}>
              <option value={0}>{t("run.threads.auto")} ({health()?.default_threads ?? 1})</option>
              <For each={cpuOptions()}>{(n) => <option value={n}>{n}</option>}</For>
            </select>
          </label>
        </Show>
        <Show when={optEngine() === "gpu"}>
          <span class="note">{t("run.gpuNote")}</span>
        </Show>
        <label class="rp-inline-field" title={methodTitle(optPlan().method)}>
          <span>{t("opt.method")}</span>
          <select class="rp-select rp-select-sm" aria-describedby="op-method-hint" value={method()} onChange={(e) => setMethod(e.currentTarget.value as import("./optimize").OptimizeMethod)}>
            <option value="auto" title={t("opt.method.auto.title")}>{t("opt.method.auto", { method: optPlan().method })}</option>
            <option value="secant" title={methodTitle("secant")} disabled={!(vary.length === 1 && goals.some((g) => g.kind === "f0"))}>{t("opt.method.secant")}</option>
            <option value="nelder-mead" title={methodTitle("nelder-mead")}>Nelder–Mead</option>
            <option value="bayesian" title={methodTitle("bayesian")}>{t("opt.method.bayesian")}</option>
            <option value="cma-es" title={methodTitle("cma-es")}>CMA-ES</option>
            <option value="particle-swarm" title={methodTitle("particle-swarm")}>{t("opt.method.particleSwarm")}</option>
            <option value="genetic" title={methodTitle("genetic")}>{t("opt.method.genetic")}</option>
            <option value="trust-region" title={methodTitle("trust-region")}>{t("opt.method.trustRegion")}</option>
          </select>
        </label>
      </div>
      <p class="rp-hint" id="op-method-hint">{methodTitle(optPlan().method)}</p>
      <Show when={err("max_evals")}>
        <p class="rp-error" role="alert"><CircleAlert size={12} aria-hidden="true" /> {err("max_evals")}</p>
      </Show>
      <p class="note">
        {nDriven() > 1 ? t("opt.note.evalMulti", { n: nDriven() }) : t("opt.note.eval")}
        <Show when={estimate()} fallback={<> {t("opt.note.noEstimate")}</>}>
          {" "}{t("opt.note.atMost")} <span class="mono">{seconds(estimate()!)}</span>
          <Show when={nDriven() > 1} fallback={<> {t("opt.note.basis", { evals: maxEvals(), time: seconds(lastEvalSeconds()!) })}</>}>
            {" "}{t("opt.note.basisMulti", { evals: maxEvals(), ports: nDriven(), time: seconds(perPortSeconds()!) })}
          </Show>
        </Show>
      </p>
      <label class="rp-mini" for="op-name">
        <span>{t("opt.name")} <span class="muted">{t("opt.name.optional")}</span></span>
        <input autocomplete="off" id="op-name" class="rp-input rp-input-text" type="text" maxlength="80" value={runName()} placeholder={t("opt.name.placeholder")} onInput={(e) => setRunName(e.currentTarget.value)} />
      </label>
      <PreflightNote cells={meshStats(meshSource())?.nodes} engine={optEngine() || "cpu"} />
      <Show when={submitError()}>
        <p class="status-block status-critical" role="alert"><CircleAlert size={14} aria-hidden="true" /> <span>{submitError()}</span></p>
      </Show>
      <button class="btn btn-primary rp-start-btn" onClick={async () => { const job = await startOptimize(); if (job) props.onStarted?.(job); }} disabled={submitting() || !optPlan().ok}>
        <Show when={submitting()} fallback={<Target size={14} aria-hidden="true" />}>
          <LoaderCircle size={14} class="rs-spin" aria-hidden="true" />
        </Show>
        {t("opt.startButton", { n: maxEvals() * nDriven() })}
      </button>
    </div>
  );
}
