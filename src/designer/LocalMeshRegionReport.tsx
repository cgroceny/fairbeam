import { createMemo, For, Show } from "solid-js";
import type { Bundle } from "../types";
import { decimalComma, fmt, t } from "../i18n";
import { modelToMm } from "../lib/modelUnits";
import { localMeshReport } from "./localMeshReport";

/** Read-only evidence of this exact bundle, reused by the draft settings and displayed mesh. */
export default function LocalMeshRegionReport(props: { bundle: Bundle | null | undefined; current?: boolean; requested?: boolean }) {
  const report = createMemo(() => props.current !== false ? localMeshReport(props.bundle) : null);
  const unit = () => modelToMm(props.bundle);
  const scalar = (value: number) => {
    const text = String(Number(value.toPrecision(6)));
    return (decimalComma() ? text.replace(".", ",") : text).replace(/^-/, "−");
  };
  const coords = (values: readonly number[]) => values.map(value => scalar(value * unit())).join(decimalComma() ? "; " : ", ");
  return <Show when={report()} fallback={<Show when={props.requested || props.bundle?.mesh.auto?.local_refinement}>
    <p class="note" data-local-mesh-unavailable>{t("localMesh.reportUnavailable")}</p>
  </Show>}>{r => <details class="rdk-details" data-local-mesh-report data-local-mesh-source={props.bundle?.model.id}>
    <summary>{t("localMesh.report", { count: r().regions.length })}</summary>
    <p class="note">{t("localMesh.insertionStage")}</p>
    <dl class="kv">
      <dt>{t("localMesh.before")}</dt><dd class="mono" data-local-mesh-before>{fmt.int(r().insertion.before.total_cells)}</dd>
      <dt>{t("localMesh.after")}</dt><dd class="mono" data-local-mesh-after>{fmt.int(r().insertion.after.total_cells)}</dd>
      <dt>{t("localMesh.added")}</dt><dd class="mono">{fmt.int(r().insertion.added_cells)} · {fmt.num(r().insertion.ratio, 4)}×</dd>
      <dt>{t("localMesh.finalCells")}</dt><dd class="mono" data-local-mesh-final>{fmt.int(r().final.total_cells)}</dd>
      <dt>{t("localMesh.finalCfl")}</dt><dd class="mono">{scalar(r().final.timestep_s * 1e12)} ps</dd>
      <dt>{t("localMesh.limit")}</dt><dd class="mono">{fmt.int(r().cell_limit)}</dd>
      <dt>{t("localMesh.grading")}</dt><dd class="mono">{fmt.num(r().grading.insertion_max_ratio, 5)} / {fmt.num(r().grading.admission_ceiling, 5)}</dd>
      <dt>{t("localMesh.finalGrading")}</dt><dd class="mono">{fmt.num(r().grading.final_max_ratio, 5)}</dd>
    </dl>
    <p class="note">{t("localMesh.finalStage")} {t("localMesh.gradingNote")}</p>
    <For each={r().regions}>{region => <details data-local-mesh-region={region.id}>
      <summary>{region.name}</summary><dl class="kv">
        <dt>{t("localMesh.start")}</dt><dd class="mono">{coords(region.start)} mm</dd>
        <dt>{t("localMesh.stop")}</dt><dd class="mono">{coords(region.stop)} mm</dd>
        <dt>{t("localMesh.cellSize")}</dt><dd class="mono">{scalar(region.cell_size * unit())} mm</dd>
        <dt>{t("localMesh.measured")}</dt><dd class="mono">{coords(region.max_width)} mm</dd>
      </dl>
    </details>}</For>
    <p class="note">{t("localMesh.precision")}</p>
  </details>}</Show>;
}
