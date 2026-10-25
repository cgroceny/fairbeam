// Mesh view: the displayed bundle's original FDTD lines, diagnostic locations and rough cost.
// Instant previews can carry an older mesh; their attribution stays unavailable until rebuilt.
import { batch, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Grid3x3, X } from "lucide-solid";
import { num } from "../lib/format";
import { radioGroupKeys } from "../lib/a11y";
import { bundle, layers, meshPlane, meshHighlight, setMeshHighlight, setLayers, setMeshPlane, setSolidFade, type Axis } from "../state";
import { previewFailure } from "../runner/store";
import { engine } from "../runner/store";
import { cellsText, estimateText, estimateTime, meshStats } from "./meshStats";
import { bottleneckPlane, likelyMeshSources, meshBottlenecks, meshMatchesGeometry, type AxisBottleneck } from "./meshBottlenecks";
import { focusSimSettings } from "./simSettingsState";
import { t } from "../i18n";

export const [meshView, setMeshViewSignal] = createSignal(false);

export function setMeshView(on: boolean) {
  setMeshViewSignal(on);
  setLayers("mesh", on);
  setSolidFade(on);
  if (!on) setMeshHighlight(null);
}

export const toggleMeshView = () => setMeshView(!meshView());

/** Readout and plane controls over the 3D view while the mesh view is on. */
export function MeshViewPanel() {
  // leaving the designer ends the mesh view (Examples mode keeps its own layer toggle)
  onCleanup(() => setMeshView(false));
  // The numbers, candidate boxes and viewport layer must refer to the same displayed bundle.
  const stats = createMemo(() => meshStats(bundle()));
  const bottlenecks = createMemo(() => meshBottlenecks(bundle()));
  const carried = () => !!bundle() && !meshMatchesGeometry(bundle()!);
  const excited = () => Math.max(1, bundle()?.ports.filter(p => p.excite).length ?? 1);
  const est = () => estimateTime(bundle(), engine(), excited());
  const scale = () => bottlenecks()?.unitMm ?? 1;
  const current = () => { const h = meshHighlight(); return h?.source === bundle() ? h : null; };
  const candidates = createMemo(() => { const h = current(); return h ? likelyMeshSources(h.source, h.axis, h.index, h.intervals) : []; });
  const transformed = () => candidates().some(p => p.primitives.some(x => x.kind === "transformed" || (x.kind === "bbox" && x.transformed)));
  const jump = (a: AxisBottleneck, grading = false) => {
    const b = bundle();
    if (!b || (grading && a.ratioIndex === null)) return;
    const index = grading ? a.ratioIndex! : a.minIndex, intervals = grading ? 2 : 1;
    const sources = likelyMeshSources(b, a.axis, index, intervals);
    batch(() => {
      setLayers("mesh", true);
      setMeshPlane(bottleneckPlane(b, a.axis, sources.length === 1 ? sources[0] : undefined));
      setMeshHighlight({ source: b, axis: a.axis, index, intervals });
    });
  };
  const lines = () => bundle()?.mesh[meshPlane.axis] ?? [];
  const pick = (a: Axis) => {
    const l = bundle()?.mesh[a] ?? [];
    batch(() => { setMeshHighlight(null); setMeshPlane({ axis: a, index: Math.max(0, l.findIndex((v) => v >= 0)) }); });
  };
  return (
    <Show when={meshView()}>
      <div class="mv-panel" role="region" aria-label={t("results.mesh.title")}>
        <div class="mv-head">
          <Grid3x3 size={14} aria-hidden="true" /> {t("results.mesh.title")}
          <Show when={carried()}><span class="muted">{t(previewFailure() ? "results.mesh.stale" : "results.mesh.updating")}</span></Show>
          <button class="icon-btn icon-btn-sm" onClick={() => setMeshView(false)} aria-label={t("results.mesh.close")} title={t("results.mesh.close")}><X size={13} /></button>
        </div>
        <p class="note" data-mesh-source={bundle()?.model.id}>{t("results.mesh.shown", { name: bundle()?.name ?? "—" })}</p>
        <Show when={carried()}><p class="note" data-mesh-carried>{t("results.mesh.carried")}</p></Show>
        <Show when={stats()} fallback={<p class="note">{t("results.mesh.waiting")}</p>}>
          {(s) => (
            <>
              <dl class="kv">
                <dt>{t("results.mesh.lines")}</dt><dd class="mono">{s().lines.join(" × ")}</dd>
                <dt>{t("results.mesh.cells")}</dt><dd class="mono">{cellsText(s().cells)}</dd>
                <dt>{t("results.mesh.smallest")}</dt><dd class="mono">{num(s().minCell, 3)} mm</dd>
                <dt>{t("results.mesh.largest")}</dt><dd class="mono">{num(s().maxCell, 2)} mm</dd>
                <dt>{t("results.mesh.timestep")}</dt><dd class="mono">{num(s().dt * 1e12, 3)} ps</dd>
                <dt>{t("results.mesh.solverTime")}</dt><dd class="mono" title={est()?.basis}>{estimateText(est())}</dd>
              </dl>
              <p class="note">{t("results.mesh.estimate", { basis: est()?.basis ?? "—" })}{excited() > 1 ? t("results.mesh.portRuns", { count: excited() }) : ""}.</p>
            </>
          )}
        </Show>
        <Show when={bottlenecks()}>{(info) => <section class="mv-bottlenecks" aria-label={t("results.mesh.bottlenecks")}>
          <strong>{t("results.mesh.bottlenecks")}</strong>
          <p class="note">{t("results.mesh.sourceNote")}</p>
          <For each={info().axes}>{a => <div class="mv-bottleneck-row">
            <span class="mono">{a.axis}: {num(a.minWidth * scale(), 6)} mm</span>
            <button class="btn btn-ghost btn-sm" data-mesh-jump={a.axis} onClick={() => jump(a)}
              aria-label={t("results.mesh.showSmallestAxis", { axis: a.axis })}>{t("results.mesh.showInterval")}</button>
          </div>}</For>
          <Show when={info().worst}>{a => <div class="mv-bottleneck-row">
            <span>{t("results.mesh.worstGrading", { axis: a().axis, ratio: num(a().ratio, 3) })}</span>
            <button class="btn btn-ghost btn-sm" data-mesh-grading onClick={() => jump(a(), true)}>{t("results.mesh.showPair")}</button>
          </div>}</Show>
          <Show when={current()}>{h => <div class="stack-sm" aria-live="polite" data-mesh-highlight={`${h().axis}:${h().index}:${h().intervals}`}>
            <p class="mono">{h().axis}: {h().source.mesh[h().axis].slice(h().index, h().index + h().intervals + 1).map(x => num(x * scale(), 6)).join(" → ")} mm</p>
            <p class="note">{t("results.mesh.globalCost", { axis: h().axis, count: cellsText(info().axes.find(a => a.axis === h().axis)!.addedCellsPerLine) })}</p>
            <Show when={!carried()}><p class="note">{candidates().length ? t(candidates().length > 1 ? "results.mesh.likelyMany" : "results.mesh.likelyOne", { names: candidates().map(p => p.label ?? p.name).join(", ") }) : t("results.mesh.likelyNone")}</p>
            <p class="note">{t(transformed() ? "results.mesh.bboxTransformed" : "results.mesh.bboxOnly")}</p></Show>
            <button class="btn btn-ghost btn-sm" onClick={() => setMeshHighlight(null)}>{t("results.mesh.clearHighlight")}</button>
          </div>}</Show>
          <button class="btn btn-ghost btn-sm" data-mesh-thin-link onClick={() => focusSimSettings("mesh.thin_metal")}>{t("results.mesh.thinLink")}</button>
          <p class="note">{t("results.mesh.thinLinkNote")}</p>
        </section>}</Show>
        <div class="mv-row">
          <div class="seg seg-sm" role="radiogroup" aria-label={t("results.mesh.planeNormal")} onKeyDown={radioGroupKeys}>
            <For each={["x", "y", "z"] as Axis[]}>{(a) => (
              <button class="seg-btn" role="radio" aria-checked={meshPlane.axis === a} classList={{ active: meshPlane.axis === a }} onClick={() => pick(a)}>{a}</button>
            )}</For>
          </div>
          <input type="range" min={0} max={Math.max(0, lines().length - 1)} value={meshPlane.index} disabled={!layers.mesh || lines().length < 2}
            onInput={(e) => setMeshPlane("index", Number(e.currentTarget.value))} aria-label={t("results.mesh.planePosition")} />
        </div>
        <span class="mono muted">{meshPlane.axis} = {num(lines()[Math.min(meshPlane.index, lines().length - 1)] * scale(), 3)} mm · {t("results.mesh.lineOf", { n: Math.min(meshPlane.index + 1, lines().length), total: lines().length })}</span>
      </div>
    </Show>
  );
}
