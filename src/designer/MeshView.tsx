// Mesh view in the designer: the FDTD mesh lines of the current server preview on
// one plane (the viewer's mesh-plane layer), the solids faded, and the mesh numbers with a rough
// solver-time estimate. The numbers come from the server preview, the same mesher the run uses.
import { createSignal, For, onCleanup, Show } from "solid-js";
import { Grid3x3, X } from "lucide-solid";
import { num } from "../lib/format";
import { radioGroupKeys } from "../lib/a11y";
import { bundle, layers, meshPlane, setLayers, setMeshPlane, setSolidFade, type Axis } from "../state";
import { previewState } from "../runner/store";
import { engine } from "../runner/store";
import { cellsText, estimateText, estimateTime, meshStats } from "./meshStats";
import { draft } from "./store";
import { t } from "../i18n";

export const [meshView, setMeshViewSignal] = createSignal(false);

export function setMeshView(on: boolean) {
  setMeshViewSignal(on);
  setLayers("mesh", on);
  setSolidFade(on);
}

export const toggleMeshView = () => setMeshView(!meshView());

/** Readout and plane controls over the 3D view while the mesh view is on. */
export function MeshViewPanel() {
  // leaving the designer ends the mesh view (Examples mode keeps its own layer toggle)
  onCleanup(() => setMeshView(false));
  const stats = () => meshStats(bundle());
  const excited = () => Math.max(1, (draft.ports ?? []).filter((p) => p.excite !== false).length);
  const est = () => estimateTime(bundle(), engine(), excited());
  const lines = () => bundle()?.mesh[meshPlane.axis] ?? [];
  const pick = (a: Axis) => {
    const l = bundle()?.mesh[a] ?? [];
    setMeshPlane({ axis: a, index: Math.max(0, l.findIndex((v) => v >= 0)) });
  };
  return (
    <Show when={meshView()}>
      <div class="mv-panel" role="region" aria-label={t("results.mesh.title")}>
        <div class="mv-head">
          <Grid3x3 size={14} aria-hidden="true" /> {t("results.mesh.title")}
          <Show when={previewState() === "loading"}><span class="muted">{t("results.mesh.updating")}</span></Show>
          <button class="icon-btn icon-btn-sm" onClick={() => setMeshView(false)} aria-label={t("results.mesh.close")} title={t("results.mesh.close")}><X size={13} /></button>
        </div>
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
        <div class="mv-row">
          <div class="seg seg-sm" role="radiogroup" aria-label={t("results.mesh.planeNormal")} onKeyDown={radioGroupKeys}>
            <For each={["x", "y", "z"] as Axis[]}>{(a) => (
              <button class="seg-btn" role="radio" aria-checked={meshPlane.axis === a} classList={{ active: meshPlane.axis === a }} onClick={() => pick(a)}>{a}</button>
            )}</For>
          </div>
          <input type="range" min={0} max={Math.max(0, lines().length - 1)} value={meshPlane.index} disabled={!layers.mesh || lines().length < 2}
            onInput={(e) => setMeshPlane("index", Number(e.currentTarget.value))} aria-label={t("results.mesh.planePosition")} />
        </div>
        <span class="mono muted">{meshPlane.axis} = {num(lines()[Math.min(meshPlane.index, lines().length - 1)], 3)} mm · {t("results.mesh.lineOf", { n: meshPlane.index + 1, total: lines().length })}</span>
      </div>
    </Show>
  );
}
