// Simulation settings › Monitors › Field planes: E/H field maps on cut planes (monitors.field_planes,
// python/fairbeam/field_planes.py). A list of rows (quantity, component, normal, position,
// frequencies) with add and remove; the checks (checks.ts field-plane, design_checks.py
// field-plane-position) show under each field.
import { createSignal, For, Show } from "solid-js";
import { Layers2, Plus, Trash2 } from "lucide-solid";
import { bundle } from "../state";
import { ExprField } from "./DesignPane";
import { FIELD_PLANE_FREQS_MAX, FIELD_PLANES_MAX } from "./checks";
import { draft, edit, fieldId, issues, names } from "./store";
import { tryEvaluate } from "./expr";
import type { Design, DesignFieldPlane, Expr } from "./types";
import { t } from "../i18n";

type WithPlanes = Design & { monitors?: { field_planes?: DesignFieldPlane[] } };

export const fieldPlanes = (): DesignFieldPlane[] => (draft as WithPlanes).monitors?.field_planes ?? [];

/** Replace the list (the monitors object is dropped when it gets empty). */
export function setFieldPlanes(v: DesignFieldPlane[], key = "field-planes") {
  edit((x) => {
    const w = x as WithPlanes;
    if (v.length) w.monitors = { ...(w.monitors ?? {}), field_planes: v };
    else if (w.monitors) {
      delete w.monitors.field_planes;
      if (!Object.keys(w.monitors).length) delete w.monitors;
    }
  }, key);
}

const toExpr = (text: string): Expr => {
  const v = text.trim();
  return v !== "" && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v) ? Number(v) : v;
};

/** A new plane: E normal to z, 1 mm above the top of the model (the preview's parts), at the
 * far-field frequencies (else the band centre). */
export function defaultFieldPlane(): DesignFieldPlane {
  const d = draft as WithPlanes;
  const n = names().names;
  const ff = d.far_field.enabled ? (d.far_field.frequencies ?? []).slice(0, FIELD_PLANE_FREQS_MAX) : [];
  let freqs: Expr[] = [...ff];
  if (!freqs.length) {
    const lo = tryEvaluate(d.simulation.f_min, n).value, hi = tryEvaluate(d.simulation.f_max, n).value;
    freqs = lo !== undefined && hi !== undefined && hi > 0 ? [Number(((lo + hi) / 2).toPrecision(4))] : [];
  }
  const tops = (bundle()?.parts ?? []).map((p) => p.bbox?.[1]?.[2]).filter((z): z is number => typeof z === "number" && Number.isFinite(z));
  const position = tops.length ? Number((Math.max(...tops) + 1).toPrecision(4)) : 1;
  return { quantity: "E", normal: "z", position, frequencies: freqs };
}

export function addFieldPlane() {
  if (fieldPlanes().length >= FIELD_PLANES_MAX) return;
  setFieldPlanes([...fieldPlanes(), defaultFieldPlane()], "field-plane-add");
}

function Frequencies(props: { k: number; value: Expr[] }) {
  const path = () => `monitors.field_planes[${props.k}].frequencies`;
  const [text, setText] = createSignal<string | null>(null);
  const bad = () => [issues()[path()], ...props.value.map((_, j) => issues()[`${path()}[${j}]`])].filter(Boolean);
  const set = (v: Expr[]) => setFieldPlanes(fieldPlanes().map((p, i) => (i === props.k ? { ...p, frequencies: v } : p)), `field-plane-${props.k}-f`);
  return (
    <label class="dz-field">
      <span class="dz-label">{t("fieldPlanes.frequencies")} <span class="dz-unit">{t("fieldPlanes.frequencies.hint", { max: FIELD_PLANE_FREQS_MAX })}</span></span>
      <input autocomplete="off" id={fieldId(path())} class="rp-input dz-input mono" type="text" spellcheck={false} placeholder="e.g. f0"
        value={text() ?? props.value.map(String).join(", ")} aria-invalid={bad().some((i) => i!.severity === "error")}
        onInput={(e) => { setText(e.currentTarget.value); set(e.currentTarget.value.split(",").map((x) => x.trim()).filter(Boolean).map(toExpr)); }}
        onBlur={() => setText(null)} />
      <For each={bad()}>{(i) => <span class="dz-value" classList={{ "dz-bad": i!.severity === "error", "dz-warn": i!.severity === "warning" }}>{i!.message}</span>}</For>
    </label>
  );
}

export default function FieldPlanesEditor() {
  const update = (k: number, patch: Partial<DesignFieldPlane>, key: string) =>
    setFieldPlanes(fieldPlanes().map((p, i) => (i === k ? { ...p, ...patch } : p)), `field-plane-${k}-${key}`);
  const remove = (k: number) => setFieldPlanes(fieldPlanes().filter((_, i) => i !== k), "field-plane-remove");
  return (
    <div class="stack ss-field-planes" id={fieldId("monitors.field_planes")}>
      <div class="dz-label"><Layers2 size={11} aria-hidden="true" /> {t("fieldPlanes.title")} <span class="dz-unit">{t("fieldPlanes.hint")}</span></div>
      <For each={fieldPlanes()}>{(pl, k) => (
        <fieldset class="ss-field-plane" aria-label={t("fieldPlanes.plane", { n: k() + 1 })}>
          <div class="ss-row">
            <label class="dz-field">
              <span class="dz-label">{t("fieldPlanes.quantity")}</span>
              <select class="rp-input dz-input" id={fieldId(`monitors.field_planes[${k()}].quantity`)}
                value={`${pl.quantity}:${pl.component ?? "abs"}`}
                onChange={(e) => {
                  const [q, c] = e.currentTarget.value.split(":");
                  update(k(), { quantity: q === "H" ? "H" : "E", component: c === "abs" ? undefined : (c as "x" | "y" | "z") }, "q");
                }}>
                <For each={["E", "H"]}>{(q) => <For each={["abs", "x", "y", "z"]}>{(c) =>
                  <option value={`${q}:${c}`}>{c === "abs" ? `|${q}| (${t(q === "H" ? "tree.result.hField" : "tree.result.eField")})` : `|${q}${c}|`}</option>}</For>}</For>
              </select>
            </label>
            <label class="dz-field">
              <span class="dz-label">{t("props.poly.normal")}</span>
              <select class="rp-input dz-input" value={pl.normal} onChange={(e) => update(k(), { normal: e.currentTarget.value as "x" | "y" | "z" }, "n")}>
                <option value="x">{t("fieldPlanes.normal.x")}</option><option value="y">{t("fieldPlanes.normal.y")}</option><option value="z">{t("fieldPlanes.normal.z")}</option>
              </select>
            </label>
          </div>
          <div class="ss-row">
            <ExprField label={t("fieldPlanes.position", { axis: pl.normal })} unit="mm" value={pl.position} path={`monitors.field_planes[${k()}].position`}
              onChange={(v) => update(k(), { position: v }, "pos")} />
            <Frequencies k={k()} value={pl.frequencies ?? []} />
          </div>
          <button type="button" class="btn btn-sm" onClick={() => remove(k())} aria-label={t("fieldPlanes.remove", { n: k() + 1 })}>
            <Trash2 size={12} aria-hidden="true" /> {t("common.remove")}
          </button>
        </fieldset>
      )}</For>
      <Show when={issues()["monitors.field_planes"]}>{(i) => <span class="dz-value dz-bad">{i().message}</span>}</Show>
      <div>
        <button type="button" class="btn btn-ghost btn-sm" disabled={fieldPlanes().length >= FIELD_PLANES_MAX} onClick={addFieldPlane}
          title={fieldPlanes().length >= FIELD_PLANES_MAX ? t("fieldPlanes.max", { max: FIELD_PLANES_MAX }) : t("fieldPlanes.add.title")}>
          <Plus size={12} aria-hidden="true" /> {t("fieldPlanes.add")}
        </button>
      </div>
      <p class="note">{t("fieldPlanes.note1")} {t("fieldPlanes.note2")}</p>
    </div>
  );
}
