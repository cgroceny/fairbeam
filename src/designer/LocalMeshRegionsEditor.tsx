import { For, Show } from "solid-js";
import { Plus, Trash2 } from "lucide-solid";
import { ExprField } from "./DesignPane";
import { draft, edit, fieldId, issues } from "./store";
import { draftPreview, meshFreshness } from "../runner/store";
import { LOCAL_MESH_REGIONS_MAX, newLocalMeshRegion } from "./localMeshRegions";
import LocalMeshRegionReport from "./LocalMeshRegionReport";
import type { LocalMeshRegion } from "./types";
import { t } from "../i18n";
import { checkTitle } from "./checkText";
import type { Expr } from "./types";

/** Inactive manual settings are stored expressions, not evaluated simulation inputs. */
function RegionExpr(props: { label: string; value: Expr; path: string; compact?: boolean; unit?: string; onChange: (value: Expr) => void }) {
  return <Show when={draft.mesh.mode === "manual"} fallback={<ExprField {...props} />}>
    <label class="dz-field"><span class="dz-label">{props.label}{props.unit ? ` ${props.unit}` : ""}</span>
      <input id={fieldId(props.path)} class="rp-input dz-input mono" autocomplete="off" value={String(props.value)}
        aria-invalid={issues()[props.path]?.severity === "error"}
        aria-describedby={issues()[props.path] ? `${fieldId(props.path)}-message` : undefined}
        onInput={event => {
          const text = event.currentTarget.value.trim();
          props.onChange(text !== "" && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text) ? Number(text) : text);
        }} />
      <Show when={issues()[props.path]}>{issue => <span id={`${fieldId(props.path)}-message`} class="dz-value dz-bad">{checkTitle(issue())}</span>}</Show>
    </label>
  </Show>;
}

export default function LocalMeshRegionsEditor() {
  const regions = () => draft.mesh.local_regions ?? [];
  const add = () => {
    if (regions().length >= LOCAL_MESH_REGIONS_MAX) return;
    const region = newLocalMeshRegion(regions(), t("localMesh.defaultName", { n: regions().length + 1 }),
      meshFreshness() === "current" ? draftPreview()?.domain : undefined);
    edit(d => { d.mesh.local_regions = [...(d.mesh.local_regions ?? []), region]; }, "local-mesh-add");
  };
  const update = (id: string, change: (region: LocalMeshRegion) => void, key: string) => edit(d => {
    const region = d.mesh.local_regions?.find(region => region.id === id); if (region) change(region);
  }, `local-mesh-${id}-${key}`);
  const remove = (id: string) => edit(d => {
    const next = d.mesh.local_regions?.filter(region => region.id !== id) ?? [];
    if (next.length) d.mesh.local_regions = next; else delete d.mesh.local_regions;
  }, "local-mesh-remove");
  const issue = (path: string) => <Show when={issues()[path]}>{value =>
    <span id={`${fieldId(path)}-message`} class="dz-value dz-bad">{checkTitle(value())}</span>}</Show>;
  return <div class="stack ss-field-planes" id={fieldId("mesh.local_regions")} data-local-mesh-editor>
    <strong>{t("localMesh.title")}</strong>
    <p class="note">{t("localMesh.worldNote")} {t("localMesh.tensorNote")}</p>
    <Show when={draft.mesh.mode === "manual"}><p class="note" data-local-mesh-inactive>{t("localMesh.manual")}</p></Show>
    <For each={regions().map(region => region.id)}>{id => {
      const index = () => regions().findIndex(region => region.id === id), region = () => regions()[index()];
      const path = (field = "") => `mesh.local_regions[${index()}]${field ? `.${field}` : ""}`;
      return <fieldset class="ss-field-plane" data-local-mesh-edit={id}>
        <legend>{t("localMesh.region", { n: index() + 1 })}</legend>
        <label class="dz-field"><span class="dz-label">{t("localMesh.name")}</span>
          <input class="rp-input dz-input" id={fieldId(path("name"))} value={region().name} autocomplete="off"
            aria-invalid={issues()[path("name")]?.severity === "error"}
            aria-describedby={issues()[path("name")] ? `${fieldId(path("name"))}-message` : undefined}
            onInput={event => update(id, r => { r.name = event.currentTarget.value; }, "name")} />
          {issue(path("name"))}
        </label>
        <For each={["start", "stop"] as const}>{end => <fieldset class="dz-vec">
          <legend class="dz-label">{t(`localMesh.${end}`)} <span class="dz-unit">mm</span></legend>
          <div class="dz-vec-row"><For each={[0, 1, 2]}>{k => <RegionExpr compact label={["X", "Y", "Z"][k]}
            value={region()[end][k]} path={`${path(end)}[${k}]`}
            onChange={value => update(id, r => { r[end][k] = value; }, `${end}-${k}`)} />}</For></div>
          {issue(path(end))}
        </fieldset>}</For>
        <RegionExpr label={t("localMesh.cellSize")} unit="mm" value={region().cell_size} path={path("cell_size")}
          onChange={value => update(id, r => { r.cell_size = value; }, "cell-size")} />
        {issue(path("id"))}{issue(path())}
        <button type="button" class="btn btn-ghost btn-sm" aria-label={t("localMesh.remove", { name: region().name })}
          onClick={() => remove(id)}><Trash2 size={12} aria-hidden="true" /> {t("common.remove")}</button>
      </fieldset>;
    }}</For>
    {issue("mesh.local_regions")}
    <div><button type="button" class="btn btn-ghost btn-sm" data-local-mesh-add onClick={add}
      disabled={regions().length >= LOCAL_MESH_REGIONS_MAX} title={t("localMesh.limitRegions", { max: LOCAL_MESH_REGIONS_MAX })}>
      <Plus size={12} aria-hidden="true" /> {t("localMesh.add")}</button></div>
    <LocalMeshRegionReport bundle={draftPreview()} current={meshFreshness() === "current" && draft.mesh.mode !== "manual"}
      requested={regions().length > 0 && draft.mesh.mode !== "manual"} />
  </div>;
}
