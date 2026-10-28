// Existing Simulation surface extension: warm paper, copper primary action, Plex controls.
// Capability check and bounded setup on the left; research-only history/results on the right.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { unwrap } from "solid-js/store";
import { CircleAlert, CircleCheck, FlaskConical, Play, RefreshCw, Square, X } from "lucide-solid";
import { api, isTerminal, type ElmerRuntime, type Job, type ResearchResult, type ResearchBackend } from "../runner/api";
import { researchResultsOnly, researchInitialBackend, researchPath, rememberResearchPath, researchSelectedId, setResearchOpen, setResearchSelectedId } from "../runner/researchState";
import { StatusBadge } from "../runner/status";
import { draft, file } from "./store";
import { useModal } from "../lib/dialog";
import { parseNumber } from "../lib/numberField";
import { saveDownload, downloadFailedMessage } from "../lib/download";
import { downloadToast, showToast } from "../lib/toast";
import { fmt, locale, t } from "../i18n";
import NumberField from "../components/NumberField";
import LineChart, { type Series } from "../charts/LineChart";
import ElmerAntennaResults from "./ElmerAntennaResults";
import "../styles/research.css";

type Backend = ResearchBackend;
const name = (backend: Backend) => t(`research.backend.${backend}`);
const jobName = (job: Job) => job.research?.settings.analysis === "driven" ? (job.name || t("elmerAntenna.option")) : job.research?.settings.closed_pec ? (job.name || t("elmerDesign.option")) : name(job.research?.backend ?? "periodic");
const db = (re: number, im: number) => 20 * Math.log10(Math.max(1e-15, Math.hypot(re, im)));
const PHASE_LABELS: Record<string, string> = { building: "research.phase.building", simulating: "research.phase.simulating", results_exported: "research.phase.exported", validating: "research.phase.validating" };

function PeriodicResults(props: { result: ResearchResult }) {
  const series = createMemo<Series[]>(() => ["11", "21"].map((port, i) => {
    const r = props.result;
    const re = port === "11" ? r.s11_real : r.s21_real;
    const im = port === "11" ? r.s11_imag : r.s21_imag;
    return { id: `research-s${port}`, label: `S${port}`, color: `--al-series-${i + 1}`, x: r.frequency_hz.map(f => f / 1e9), y: r.frequency_hz.map((_, k) => db(re?.[k] ?? NaN, im?.[k] ?? NaN)) };
  }));
  return <div class="stack">
    <p class="note">{t(props.result.backend === "stock" ? "research.stock.resultNote" : "research.periodic.resultNote")}</p>
    <div class="research-chart"><LineChart series={series()} xLabel={t("research.frequency")} yLabel={t("research.magnitude")} ariaLabel={t("research.periodic.chart")} /></div>
    <details><summary>{t("research.table")}</summary>
      <div class="research-table" tabindex="0" role="region" aria-label={t("research.table")}>
        <table class="table"><caption>{t("research.periodic.chart")}</caption>
          <thead><tr><th>{t("research.frequency")}</th><th class="num">S11 <span class="th-unit">dB</span></th><th class="num">S21 <span class="th-unit">dB</span></th></tr></thead>
          <tbody><For each={props.result.frequency_hz}>{(f, i) => <tr><td class="num">{fmt.fixed(f / 1e9, 4)}</td><td class="num">{fmt.fixed(series()[0].y[i()], 3)}</td><td class="num">{fmt.fixed(series()[1].y[i()], 3)}</td></tr>}</For></tbody>
        </table>
      </div>
    </details>
  </div>;
}
function StockResults(props: { result: ResearchResult }) {
  const phase = createMemo<Series[]>(() => [{ id: "stock-reflection-phase", label: t("research.stock.phase"), color: "--al-series-1",
    x: props.result.frequency_hz.map(f => f / 1e9), y: props.result.reflection_phase_deg?.map(v => v ?? NaN) ?? [] }]);
  const value = (v: number | null | undefined) => v == null ? "—" : fmt.fixed(v, 5);
  const exportResult = async (kind: "csv" | "json") => {
    const filename = `stock-cell.${kind}`;
    try {
      const r = props.result, m = r.material;
      const csv = ["frequency_hz,s11_real,s11_imag,s21_real,s21_imag,reflection_phase_deg,nrw_reliable,eps_real,eps_imag,mu_real,mu_imag",
        ...r.frequency_hz.map((f, i) => [f, r.s11_real?.[i], r.s11_imag?.[i], r.s21_real?.[i], r.s21_imag?.[i], r.reflection_phase_deg?.[i],
          m?.reliable?.[i] ?? false, m?.eps_real?.[i], m?.eps_imag?.[i], m?.mu_real?.[i], m?.mu_imag?.[i]].map(v => v ?? "").join(","))].join("\n") + "\n";
      downloadToast(await saveDownload(filename, kind === "json" ? JSON.stringify(r, null, 2) + "\n" : csv,
        kind === "json" ? "application/json" : "text/csv;charset=utf-8"));
    } catch (error) { showToast(downloadFailedMessage(filename, error), { tone: "error" }); }
  };
  return <section class="stack" data-stock-results aria-label={t("research.stock.phase")}>
    <p class="note">{t("research.stock.phaseHint")}</p>
    <div class="research-chart"><LineChart series={phase()} xLabel={t("research.frequency")} yLabel={t("research.stock.phaseUnit")} ariaLabel={t("research.stock.phase")} /></div>
    <p class="note">{t("research.stock.nrwHint", { thickness: value(props.result.material?.thickness_mm) })}</p>
    <Show when={props.result.material?.available} fallback={<p class="note" role="status">{t("research.stock.nrwUnavailable")}</p>}>
      <details><summary>{t("research.stock.nrwTable")}</summary>
        <div class="research-table" tabindex="0" role="region" aria-label={t("research.stock.nrwTable")}><table class="table">
          <caption>{t("research.stock.nrwTable")}</caption><thead><tr><th>{t("research.frequency")}</th><th>Re(εr)</th><th>Im(εr)</th><th>Re(μr)</th><th>Im(μr)</th><th>{t("research.stock.reliable")}</th></tr></thead>
          <tbody><For each={props.result.frequency_hz}>{(f, i) => <tr><td>{fmt.fixed(f / 1e9, 4)}</td>
            <For each={["eps_real", "eps_imag", "mu_real", "mu_imag"] as const}>{key => <td class="num">{value(props.result.material?.[key]?.[i()])}</td>}</For>
            <td>{t(props.result.material?.reliable?.[i()] ? "research.stock.reliableYes" : "research.stock.reliableNo")}</td></tr>}</For></tbody>
        </table></div>
      </details>
    </Show>
    <div class="cluster"><button type="button" class="btn btn-ghost btn-sm" onClick={() => void exportResult("csv")}>{t("research.stock.csv")}</button>
      <button type="button" class="btn btn-ghost btn-sm" onClick={() => void exportResult("json")}>{t("research.stock.json")}</button></div>
  </section>;
}

function ResearchResults(props: { job: Job }) {
  return <Show when={props.job.result}>{r => <div class="stack-lg">
    <Show when={r().status !== "results_validated"}><p class="status-block status-warn"><CircleAlert size={14} />{t(r().schema === "fairbeam.elmer-driven-result/1" ? "elmerAntenna.qa" : r().backend === "stock" && r().status === "results_exported" ? "research.stock.qa" : "research.qaUnvalidated")}</p></Show>
    <Show when={r().schema !== "fairbeam.elmer-driven-result/1"} fallback={<ElmerAntennaResults result={r()} />}>
    <Show when={props.job.research?.backend === "periodic" || props.job.research?.backend === "stock"} fallback={<>
      <p class="note">{t(r().schema === "fairbeam.elmer-design-result/1" ? "elmerDesign.resultHint" : "research.elmer.resultNote")}</p>
      <Show when={r().schema !== "fairbeam.elmer-design-result/1"}>
      <dl class="kv">
        <dt>{t("research.elmer.mode")}</dt><dd>{r().mode1?.family ?? "—"}</dd>
        <dt>{t("research.elmer.analytic")}</dt><dd>{fmt.fixed((r().mode1?.analytic_frequency_hz ?? NaN) / 1e9, 6)} GHz</dd>
        <dt>{t("research.elmer.error")}</dt><dd>{fmt.fixed((r().mode1?.relative_frequency_error ?? NaN) * 100, 3)} %</dd>
        <dt>{t("research.elmer.correlation")}</dt><dd>{fmt.fixed(r().mode1?.complex_field_shape_correlation ?? NaN, 4)}</dd>
      </dl>
      </Show>
      <table class="table"><caption>{t("research.elmer.frequencies")}</caption><thead><tr><th>{t("research.elmer.modeIndex")}</th><th class="num">{t("research.frequency")}</th></tr></thead><tbody>
        <For each={r().frequency_hz}>{(f, i) => <tr><td>{fmt.int(i() + 1)}</td><td class="num">{fmt.fixed(f / 1e9, 6)}</td></tr>}</For>
      </tbody></table>
    </>}><PeriodicResults result={r()} /><Show when={props.job.research?.backend === "stock"}><StockResults result={r()} /></Show></Show>
    </Show>
    <details><summary>{t("research.provenance")}</summary><pre class="code research-json">{JSON.stringify({ research: props.job.research, result: r() }, null, 2)}</pre></details>
  </div>}</Show>;
}

export default function ResearchDialog() {
  let box: HTMLDivElement | undefined;
  let first: HTMLSelectElement | undefined;
  const close = () => setResearchOpen(false);
  useModal(() => box, close, () => first);
  const [backend, setBackend] = createSignal<Backend>(researchInitialBackend());
  const [path, setPath] = createSignal(researchPath(researchInitialBackend()));
  const [capability, setCapability] = createSignal<{ available: boolean; reason?: string } | null>(null);
  const [operation, setOperation] = createSignal<"probe" | "submit" | "cancel" | null>(null);
  const [error, setError] = createSignal("");
  const openGuide = (event: MouseEvent) => {
    const native = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (command: string, args: { link: string }) => Promise<unknown> } }).__TAURI_INTERNALS__;
    if (!native) return;
    event.preventDefault();
    void native.invoke("open_external_link", { link: locale() === "tr" ? "research-tr" : "research" }).catch(e => setError(t("about.error.openLink", { error: String(e) })));
  };
  const [historyError, setHistoryError] = createSignal("");
  const [runs, setRuns] = createSignal<Job[]>([]);
  const [selected, setSelected] = createSignal<Job | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [useDesign, setUseDesign] = createSignal(false);
  const [mesh, setMesh] = createSignal(0.025);
  const [cpw, setCpw] = createSignal(20);
  const [nrw, setNrw] = createSignal(false), [nrwFloor, setNrwFloor] = createSignal(.3);
  // Keep text while editing: NumberField preserves intermediate '-' / exponent text when its
  // value is empty. Parsing only for validation/submission keeps blanks invalid, never zero.
  const [pxText, setPx] = createSignal("6"), [pyText, setPy] = createSignal("6");
  const [frontText, setFront] = createSignal("0"), [backText, setBack] = createSignal("10");
  const [fminText, setFmin] = createSignal("1"), [fmaxText, setFmax] = createSignal("10");
  const px = () => parseNumber(pxText()) ?? NaN, py = () => parseNumber(pyText()) ?? NaN;
  const front = () => parseNumber(frontText()) ?? NaN, back = () => parseNumber(backText()) ?? NaN;
  const fmin = () => parseNumber(fminText()) ?? NaN, fmax = () => parseNumber(fmaxText()) ?? NaN;
  const controller = new AbortController();
  let alive = true, refreshing = false, probeVersion = 0, detailVersion = 0;
  const invalid = () => backend() !== "elmer" && (![px(), py(), front(), back(), fmin(), fmax()].every(Number.isFinite) || px() <= 0 || py() <= 0 || px() > 1000 || py() > 1000 || front() > back() || ((!useDesign() || backend() === "stock" && nrw()) && front() === back()) || fmin() < 0.001 || fmax() > 1000 || fmin() >= fmax() || fmax() / fmin() > 100);
  // the optional managed Elmer package (Windows): status, one-click install with progress
  const [runtime, setRuntime] = createSignal<ElmerRuntime | null>(null);
  let runtimeTimer: ReturnType<typeof setInterval> | undefined;
  const stopRuntimePoll = () => { if (runtimeTimer) clearInterval(runtimeTimer); runtimeTimer = undefined; };
  const loadRuntime = async () => {
    try {
      const status = await api.elmerRuntime(controller.signal);
      if (!alive) return;
      const finished = runtime()?.state === "downloading" || runtime()?.state === "unpacking";
      setRuntime(status);
      if (status.state !== "downloading" && status.state !== "unpacking") {
        stopRuntimePoll();
        if (finished && status.installed && backend() === "elmer") { setPath(""); void probe(); }
      }
    } catch { if (alive) setRuntime(null); }
  };
  const installRuntime = async () => {
    setError("");
    try {
      setRuntime(await api.elmerInstall(controller.signal));
      stopRuntimePoll();
      runtimeTimer = setInterval(() => void loadRuntime(), 600);
    } catch (e) { if (alive) setError((e as Error).message); }
  };
  onCleanup(stopRuntimePoll);
  const changeBackend = (value: Backend) => { probeVersion++; setBackend(value); setPath(researchPath(value)); setCapability(null); setError(""); if (value === "elmer") void loadRuntime(); };
  const choose = async (id: string) => {
    const ticket = ++detailVersion;
    setResearchSelectedId(id);
    setSelected(null);
    try {
      const job = await api.researchRun(id, controller.signal);
      if (alive && ticket === detailVersion) setSelected(job);
    } catch (e) { if (alive && ticket === detailVersion) setHistoryError((e as Error).message); }
  };
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    let detailTicket: number | undefined;
    try {
      const response = await api.researchRuns(controller.signal);
      if (!alive) return;
      setRuns(response.runs);
      setHistoryError("");
      const previousId = researchSelectedId();
      const id = response.runs.some(job => job.id === previousId) ? previousId : response.runs[0]?.id;
      if (id) {
        detailTicket = ++detailVersion;
        if (id !== previousId) setSelected(null);
        setResearchSelectedId(id);
        const job = await api.researchRun(id, controller.signal);
        if (alive && detailTicket === detailVersion) setSelected(job);
      } else {
        detailVersion++;
        setResearchSelectedId(null);
        setSelected(null);
      }
    } catch (e) {
      if (alive && (detailTicket === undefined || detailTicket === detailVersion)) {
        if (detailTicket !== undefined) setSelected(null);
        setHistoryError((e as Error).message);
      }
    }
    finally { refreshing = false; if (alive) setLoading(false); }
  };
  onMount(() => { void refresh(); if (backend() === "elmer") void loadRuntime(); const timer = setInterval(() => void refresh(), 2500); onCleanup(() => clearInterval(timer)); });
  onCleanup(() => { alive = false; probeVersion++; detailVersion++; controller.abort(); });
  const probe = async () => {
    const ticket = ++probeVersion;
    setOperation("probe"); setError(""); setCapability(null);
    try {
      const result = await api.researchProbe(backend(), path().trim(), controller.signal);
      if (alive && ticket === probeVersion) { setCapability(result); if (result.available) rememberResearchPath(backend(), path().trim()); }
    } catch (e) { if (alive && ticket === probeVersion) setError((e as Error).message); }
    finally { if (alive) setOperation(null); }
  };
  const submit = async (event: Event) => {
    event.preventDefault();
    if (operation() || !capability()?.available || invalid()) return;
    setOperation("submit"); setError("");
    try {
      const settings = backend() === "elmer" ? { mesh_size: mesh() } : { period_x_mm: px(), period_y_mm: py(), front_mm: front(), back_mm: back(), f_min_hz: fmin() * 1e9, f_max_hz: fmax() * 1e9, cpw: cpw(), ...(!useDesign() ? { fixture: "slab" } : {}), ...(backend() === "stock" ? { nrw: nrw(), nrw_sin_floor: nrwFloor() } : {}) };
      const job = await api.researchStart({ backend: backend(), path: path().trim(), settings, ...(backend() !== "elmer" && useDesign() ? { design: structuredClone(unwrap(draft)) } : {}) }, controller.signal);
      if (alive) { detailVersion++; setResearchSelectedId(job.id); setSelected(job); setRuns([job, ...runs().filter(j => j.id !== job.id)]); }
    } catch (e) { if (alive) setError((e as Error).message); }
    finally { if (alive) setOperation(null); }
  };
  const cancel = async () => {
    const id = selected()?.id;
    if (!id || operation()) return;
    setOperation("cancel"); setError("");
    try { const job = await api.researchCancel(id, controller.signal); if (alive && researchSelectedId() === id) { detailVersion++; setSelected(job); } }
    catch (e) { if (alive) setError((e as Error).message); }
    finally { if (alive) setOperation(null); }
  };

  return <div class="scrim" onPointerDown={e => e.target === e.currentTarget && close()}>
    <div class="dialog research-dialog" role="dialog" aria-modal="true" aria-labelledby="research-title" aria-describedby="research-description" tabindex="-1" ref={box}>
      <div class="dialog-head"><div><h2 id="research-title">{t(researchResultsOnly() ? "research.history" : "research.title")}</h2><p id="research-description" class="muted">{t(researchResultsOnly() ? (selected()?.research?.settings.analysis === "driven" ? "elmerAntenna.resultHint" : "elmerDesign.resultHint") : "research.description")}</p></div><button class="icon-btn" aria-label={t("common.close")} onClick={close}><X /></button></div>
      <div class="dialog-body research-body" style={researchResultsOnly() ? { "grid-template-columns": "minmax(0, 1fr)" } : undefined}>
        <Show when={!researchResultsOnly()}>
        <form id="research-form" class="research-options stack-lg" onSubmit={submit}>
          <label class="dz-field"><span class="dz-label">{t("research.backend")}</span><select ref={first} class="rp-select dz-input" value={backend()} disabled={!!operation()} onChange={e => changeBackend(e.currentTarget.value as Backend)}><option value="periodic">{name("periodic")}</option><option value="stock">{name("stock")}</option><option value="elmer">{name("elmer")}</option></select></label>
          <p class="note">{t(`research.${backend()}.scope`, { x: fmt.fixed(0.10, 2), y: fmt.fixed(0.05, 2), z: fmt.fixed(0.20, 2) })}</p>
          <div class="stack research-guide">
            <p class="note">{t(`research.${backend()}.setup`)}</p>
            <details><summary>{t("research.howTo")}</summary><ol>
              <li>{t(`research.${backend()}.step1`)}</li>
              <li>{t(`research.${backend()}.step2`, { mesh: fmt.num(0.025), fineMesh: fmt.num(0.0125, 4) })}</li>
              <li>{t("research.step3")}</li>
            </ol><a href={`https://fairbeam.org/docs/${locale() === "tr" ? "tr/" : ""}experimental-solvers.html`} target="_blank" rel="noopener noreferrer" onClick={openGuide}>{t("research.guide")}</a></details>
          </div>
          <label class="dz-field"><span class="dz-label">{t(backend() !== "elmer" ? "research.path.executable" : "research.path.install")}</span><input class="rp-input dz-input mono" autocomplete="off" spellcheck={false} value={path()} disabled={!!operation()} onInput={e => { probeVersion++; setPath(e.currentTarget.value); setCapability(null); }} /><span class="note">{t(`research.${backend()}.pathHint`)}</span></label>
          <Show when={backend() === "elmer" && runtime()?.supported && runtime()}>{rt => <div class="status-block research-runtime" role="status">
            <Show when={rt().installed} fallback={<Show when={rt().state === "downloading" || rt().state === "unpacking"} fallback={<>
              <span>{t("research.elmer.runtime.missing", { version: rt().version, size: fmt.fixed(rt().size / 1048576, 0) })}<Show when={rt().state === "failed" && rt().error}><br />{rt().error}</Show></span>
              <button type="button" class="btn btn-ghost" disabled={!!operation()} onClick={() => void installRuntime()}>{t("research.elmer.runtime.install")}</button>
            </>}>
              <span>{t(rt().state === "unpacking" ? "research.elmer.runtime.unpacking" : "research.elmer.runtime.downloading", { percent: fmt.int(Math.floor(100 * rt().received / Math.max(1, rt().total))) })}</span>
              <progress max={rt().total} value={rt().received} aria-label={t("research.elmer.runtime.progress")} />
            </Show>}>
              <CircleCheck size={14} /><span>{t("research.elmer.runtime.installed", { version: rt().version })}</span>
            </Show>
            <span class="note">{t("research.elmer.runtime.license")}</span>
          </div>}</Show>
          <button type="button" class="btn btn-ghost" disabled={!!operation()} onClick={probe}><RefreshCw size={14} />{t(operation() === "probe" ? "research.probing" : "research.probe")}</button>
          <Show when={capability()}>{c => <div class="status-block" classList={{ "status-good": c().available, "status-warn": !c().available }} role="status"><Show when={c().available} fallback={<CircleAlert size={14} />}><CircleCheck size={14} /></Show><span>{t(c().available ? "research.available" : "research.unavailable")}<Show when={c().reason}><br />{c().reason}</Show></span></div>}</Show>
          <Show when={backend() !== "elmer"} fallback={<label class="dz-field"><span class="dz-label">{t("research.elmer.mesh")}</span><select class="rp-select dz-input mono" value={mesh()} onChange={e => setMesh(Number(e.currentTarget.value))}><option value="0.025">0.025 m</option><option value="0.0125">0.0125 m</option></select></label>}>
            <label class="dz-field"><span class="dz-label">{t("research.source")}</span><select class="rp-select dz-input" value={useDesign() ? "design" : "fixture"} onChange={e => setUseDesign(e.currentTarget.value === "design")}><option value="fixture">{t("research.fixture")}</option><option value="design" disabled={!file()}>{t("research.currentDesign")}</option></select><span class="note">{t(useDesign() ? (backend() === "stock" ? "research.stock.designHint" : "research.designHint") : "research.fixtureHint")}</span></label>
            <div class="research-settings">
              <For each={[
                { key: "periodX", value: pxText, set: setPx }, { key: "periodY", value: pyText, set: setPy },
                { key: "front", value: frontText, set: setFront }, { key: "back", value: backText, set: setBack },
                { key: "fmin", value: fminText, set: setFmin }, { key: "fmax", value: fmaxText, set: setFmax },
              ]}>{field => <label class="dz-field"><span class="dz-label">{t(backend() === "stock" && (field.key === "periodX" || field.key === "periodY") ? `research.stock.${field.key}` : `research.${field.key}`)}</span><NumberField class="rp-input dz-input mono" required min={field.key === "front" || field.key === "back" ? undefined : "0.001"} max={field.key === "front" || field.key === "back" ? undefined : "1000"} value={field.value()} aria-invalid={parseNumber(field.value()) === null} onInput={e => field.set(e.currentTarget.value)} /></label>}</For>
            </div>
            <label class="dz-field"><span class="dz-label">{t("research.cpw")}</span><select class="rp-select dz-input mono" value={cpw()} onChange={e => setCpw(Number(e.currentTarget.value))}><option>20</option><option>30</option><option>40</option></select></label>
            <Show when={backend() === "stock"}>
              <label class="cluster"><input data-stock-nrw type="checkbox" checked={nrw()} onChange={e => setNrw(e.currentTarget.checked)} /><span>{t("research.stock.nrw")}</span></label>
              <p class="note">{t("research.stock.nrwSetup")}</p>
              <Show when={nrw()}><label class="dz-field"><span class="dz-label">{t("research.stock.sinFloor")}</span>
                <select class="rp-select dz-input mono" value={nrwFloor()} onChange={e => setNrwFloor(Number(e.currentTarget.value))}><option value="0.3">0.3</option><option value="0.5">0.5</option></select></label></Show>
            </Show>
            <Show when={invalid()}><p class="note" role="alert">{t("research.invalid", { fmin: fmt.num(0.001) })}</p></Show>
          </Show>
          <Show when={error()}><div class="status-block status-critical" role="alert"><CircleAlert size={14} /><span>{error()}</span></div></Show>
        </form>
        </Show>
        <section class="research-results stack-lg" aria-label={t("research.history")} tabindex="0">
          <div class="cluster"><h3>{t("research.history")}</h3><button class="btn btn-ghost btn-sm push" onClick={() => void refresh()}><RefreshCw size={14} />{t("research.refresh")}</button></div>
          <Show when={historyError()}><p class="status-block status-critical" role="alert"><CircleAlert size={14} />{historyError()}</p></Show>
          <Show when={runs().length} fallback={<p class="muted" role="status">{t(loading() ? "research.loading" : "research.empty")}</p>}>
            <label class="dz-field"><span class="dz-label">{t("research.selectRun")}</span><select class="rp-select dz-input" value={researchSelectedId() ?? ""} onChange={e => void choose(e.currentTarget.value)}><For each={runs()}>{job => <option value={job.id}>{jobName(job)} · {job.created_iso ?? job.id} · {t(`progress.status.${job.status}`)}</option>}</For></select></label>
          </Show>
          <Show when={selected()}>{job => <>
            <div class="cluster" aria-live="polite"><StatusBadge status={job().status} /><span>{jobName(job())}</span><Show when={!isTerminal(job().status)}><button class="btn btn-ghost btn-sm push" disabled={!!operation()} onClick={cancel}><Square size={14} />{t(operation() === "cancel" ? "research.cancelling" : "research.cancel")}</button></Show></div>
            <Show when={!isTerminal(job().status)}><p class="note" aria-live="polite"><Show when={PHASE_LABELS[job().phase]}><strong>{t(PHASE_LABELS[job().phase])}. </strong></Show>{t(job().status === "queued" ? "research.queued" : "research.running")}</p></Show>
            <Show when={job().error}><p class="status-block status-critical" role="alert"><CircleAlert size={14} /><span>{job().error}</span></p></Show>
            <ResearchResults job={job()} />
            <Show when={job().status === "done" && !job().result}><p class="note">{t("research.missingResult")}</p></Show>
          </>}</Show>
        </section>
      </div>
      <div class="dialog-foot"><p class="note">{t("research.closeHint")}</p><div class="dialog-actions"><button class="btn btn-ghost" onClick={close}>{t("common.close")}</button><Show when={!researchResultsOnly()}><button class="btn btn-primary" type="submit" form="research-form" disabled={!!operation() || !capability()?.available || invalid()}><Show when={operation() === "submit"} fallback={<Play size={14} />}><FlaskConical size={14} /></Show>{t(operation() === "submit" ? "research.submitting" : "research.start")}</button></Show></div></div>
    </div>
  </div>;
}
