// Properties for the two navigation-tree items that had none: a parameter (its
// expression, evaluated value, unit and description; the same commit rules as the Parameters dock)
// and a run (its facts, verdict, headline numbers and parameters, with two shortcuts). The Inspector
// in DesignPane.tsx chooses between these and the shape inspectors.
import { createSignal, For, Show } from "solid-js";
import { ExprField } from "./DesignPane";
import { namesIn } from "./expr";
import { shown as fmtValue } from "./displayNumber.ts";
import { draft, edit, fieldId, focusPath, names } from "./store";
import { createRowEdit } from "./rowEdit";
import { showView } from "./runResults";
import { runQualityOf, runMetricsOf, designRuns } from "./runResults";
import { verdictLabel } from "./RunQualityView";
import { index } from "../state";
import { fmt, t } from "../i18n";
import { num } from "../lib/format";
import type { DesignParam } from "./types";
import { isTerminal } from "../runner/api";
import { jobs } from "../runner/store";
import { goalText } from "../runner/optimizeGoals";
import { methodName } from "./optimizationResults";
import { applyOptimizationBest, deleteOptimizationRecord, openOptimization, stopOptimization } from "./optimizationActions";

/** How many parts, ports and resistors have an expression that names the parameter. */
export function shapesUsing(key: string): number {
  const uses = (v: unknown): boolean => {
    if (typeof v === "string") return namesIn(v).has(key);
    if (Array.isArray(v)) return v.some(uses);
    if (v && typeof v === "object") return Object.values(v).some(uses);
    return false;
  };
  return [...draft.parts, ...draft.ports, ...draft.resistors].filter(uses).length;
}

export function ParamInspector(props: { i: number }) {
  const p = () => draft.params[props.i];
  const path = (key: string) => `params[${props.i}].${key}`;
  const set = (fn: (q: DesignParam) => void, key: string) => edit((d) => fn(d.params[props.i]), path(key));
  const rowEdit = createRowEdit<DesignParam>();
  const snapshot = (): DesignParam => JSON.parse(JSON.stringify(p()));
  let form!: HTMLDivElement;
  const text = (key: "unit" | "description", label: string) => (
    <label class="dz-field">
      <span class="dz-label">{label}</span>
      <input autocomplete="off" class="rp-input dz-input" id={fieldId(path(key))} value={p()[key] ?? ""}
        onInput={(e) => { const v = e.currentTarget.value; set((q) => { q[key] = v; }, key); }} />
    </label>
  );
  const evaluated = () => {
    const v = names().names[p().key];
    return v === undefined ? "—" : fmtValue(v);
  };
  const used = () => shapesUsing(p().key);
  return (
    <div class="dz-form" ref={form}
      onFocusIn={() => { if (!form.dataset.editing) { form.dataset.editing = "1"; rowEdit.begin(snapshot()); } }}
      onFocusOut={(e) => { if (!form.contains(e.relatedTarget as Node | null)) { delete form.dataset.editing; rowEdit.end(); } }}
      onInput={() => rowEdit.typed()}
      onKeyDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) return;
        if (e.key === "Escape") {
          // only what was typed since the last commit; a committed value stays
          const saved = rowEdit.cancel();
          if (saved) {
            e.preventDefault(); e.stopPropagation();
            edit((d) => { const q = d.params[props.i]; for (const k of Object.keys(q) as (keyof DesignParam)[]) delete q[k]; Object.assign(q, saved); }, path("cancel"));
            rowEdit.begin(snapshot());
          }
        } else if (e.key === "Enter" && !e.defaultPrevented && !e.isComposing) {
          e.preventDefault();
          rowEdit.commit(snapshot());
        }
      }}>
      <h3 class="dz-h">{t("props.param.title", { key: p().key })}</h3>
      <ExprField label={t("params.col.expression")} value={p().expr ?? p().default}
        path={path(p().expr !== undefined ? "expr" : "default")} unit={p().unit} newParamAt={props.i}
        onChange={(v) => set((q) => {
          if (typeof v === "number") { q.default = v; delete q.expr; }
          else { q.expr = v; delete q.default; }
        }, "value")} />
      <dl class="dz-facts">
        <dt>{t("params.col.evaluated")}</dt>
        <dd class="mono" title={names().errors[p().key]}>{evaluated()}{p().unit ? ` ${p().unit}` : ""}</dd>
      </dl>
      {text("unit", t("params.col.unit"))}
      {text("description", t("params.col.description"))}
      <p class="note">{t("props.param.usedBy", { count: used() })}</p>
      <button class="btn btn-sm" onClick={() => focusPath(path("key"))}>{t("props.param.edit")}</button>
    </div>
  );
}

const ghz = (hz: number) => `${fmt.fixed(hz / 1e9, 3)} GHz`;

export function RunInspector(props: { file: string }) {
  const entry = () => index().find((e) => e.file === props.file);
  const row = () => designRuns().find((r) => r.file === props.file);
  const m = () => runMetricsOf(props.file);
  const q = () => runQualityOf(props.file);
  const cells = () => m()?.cells ?? entry()?.cells;
  const params = () => Object.entries(entry()?.params ?? {});
  const compare = () => void import("./treeResultActions")
    .then((x) => x.addResultToComparison({ file: props.file }))
    .then(() => showView("summary", undefined, "main"))
    .catch(() => undefined);
  const facts = () => {
    const out: [string, string][] = [];
    const created = entry()?.created;
    const when = created ? new Date(created) : null;
    if (when && !Number.isNaN(+when)) out.push([t("props.run.date"), fmt.dateTime(when)]);
    if (entry()?.engine) out.push([t("props.run.engine"), entry()!.engine!]);
    if (cells()) out.push([t("props.run.cells"), fmt.int(cells()!)]);
    const x = m();
    if (x?.noResonance) out.push([t("summary.f0"), t("summary.noResonance")]);
    else if (x?.f0 != null) out.push([t("summary.f0"), ghz(x.f0)]);
    if (x?.s11MinDb != null) out.push(["|S11| min", `${fmt.fixed(x.s11MinDb, 1)} dB`]);
    if (x?.bwHz != null) out.push([t("summary.bandwidth"), `${fmt.fixed(x.bwHz / 1e6, 0)} MHz`]);
    // the same 2-decimal value as the Runs table and the far-field card (2.25 dBi)
    if (x?.farfield) out.push(["Dmax", `${num(x.farfield.dmaxDbi, 2)} dBi`]);
    if (x?.totalEff != null) out.push([t("props.run.efficiency"), t("format.percent", { value: fmt.fixed(x.totalEff * 100, 1) })]);
    return out;
  };
  return (
    <div class="dz-form">
      <h3 class="dz-h">{t("props.run.title")}</h3>
      <p class="mono" title={row()?.title}>{entry()?.name || row()?.label || props.file}</p>
      <Show when={q()}>{(v) => (
        <p class="note" data-verdict={v().verdict}>{t("props.run.verdict")}: <b>{v().verdict === "converged" ? t("props.run.converged") : verdictLabel(v())}</b></p>
      )}</Show>
      <dl class="dz-facts">
        <For each={facts()}>{([k, v]) => <><dt>{k}</dt><dd class="mono">{v}</dd></>}</For>
      </dl>
      <Show when={params().length}>
        <h4 class="dz-h">{t("props.run.params")}</h4>
        <dl class="dz-facts">
          <For each={params()}>{([k, v]) => <><dt class="mono">{k}</dt><dd class="mono">{typeof v === "number" ? fmt.num(v, 4) : String(v)}</dd></>}</For>
        </dl>
      </Show>
      <div class="cluster-sm">
        <button class="btn btn-sm" onClick={() => showView("summary", undefined, "main")}>{t("props.run.openSummary")}</button>
        <button class="btn btn-sm" onClick={compare}>{t("props.run.showComparison")}</button>
      </div>
    </div>
  );
}

/** An optimization record: method, goals, bounds, iterations, the best value and point,
 * with the same commands as its tree node's menu. */
export function OptimizationInspector(props: { id: string }) {
  const job = () => jobs().find((j) => j.id === props.id);
  const stats = () => (job()?.stats ?? {}) as { evaluations?: number; max_evals?: number; best_cost?: number; best_params?: Record<string, number> | null; best_file?: string };
  const [note, setNote] = createSignal("");
  const running = () => !!job() && !isTerminal(job()!.status);
  const done = (p: Promise<string>) => void p.then(setNote);
  return (
    <Show when={job()} fallback={<p class="muted">{t("tree.note.optimizationGone")}</p>}>{(j) => (
      <div class="dz-form">
        <h3 class="dz-h">{t("optTree.props.title")}</h3>
        <dl class="dz-facts">
          <dt>{t("opt.method")}</dt><dd>{methodName(j().optimize?.method)}</dd>
          <dt>{t("optTree.props.status")}</dt><dd>{t(`optTree.status.${j().status}`)}</dd>
          <dt>{t("optTree.props.iterations")}</dt><dd class="mono">{stats().evaluations ?? 0}/{stats().max_evals ?? j().optimize?.max_evals ?? "?"}</dd>
          <Show when={stats().best_cost != null}><dt>{t("optTree.props.bestValue")}</dt><dd class="mono">{fmt.num(stats().best_cost!, 4)}</dd></Show>
        </dl>
        <h4 class="dz-h">{t("optTree.props.goals")}</h4>
        <ul class="dz-facts-list">
          <For each={j().optimize?.goals ?? []}>{(g) => <li class="mono">{goalText(g)}</li>}</For>
        </ul>
        <h4 class="dz-h">{t("optTree.props.bounds")}</h4>
        <dl class="dz-facts">
          <For each={j().optimize?.vary ?? []}>{(v) => <><dt class="mono">{v.key}</dt><dd class="mono">{fmt.num(v.min, 4)} … {fmt.num(v.max, 4)}</dd></>}</For>
        </dl>
        <Show when={stats().best_params}>{(best) => (<>
          <h4 class="dz-h">{t("optTree.props.bestParams")}</h4>
          <dl class="dz-facts">
            <For each={Object.entries(best())}>{([k, v]) => <><dt class="mono">{k}</dt><dd class="mono">{fmt.num(v, 4)}</dd></>}</For>
          </dl>
        </>)}</Show>
        <div class="cluster-sm">
          <button class="btn btn-sm" onClick={() => openOptimization(j())}>{t("optTree.menu.open")}</button>
          <Show when={stats().best_file}>
            <button class="btn btn-sm" onClick={() => done(applyOptimizationBest(j()))}>{t("optTree.menu.apply")}</button>
          </Show>
          <Show when={running()}>
            <button class="btn btn-sm" onClick={() => done(stopOptimization(j()))}>{t("optTree.menu.stop")}</button>
          </Show>
          <Show when={!running()}>
            <button class="btn btn-sm" onClick={() => done(deleteOptimizationRecord(j()))}>{t("optTree.menu.delete")}</button>
          </Show>
        </div>
        <p class="note" role="status">{note()}</p>
      </div>
    )}</Show>
  );
}
