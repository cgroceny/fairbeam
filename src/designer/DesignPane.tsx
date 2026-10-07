// The designer's inspector for the selected item, the Checks list and the value fields the other
// panels reuse (the navigation tree is NavTree.tsx). Shapes are presented the way a simple-modelling dialog does (a brick by its min/max
// per axis, a cylinder by axis, centre, radii and range, "transform with copies" on a part). Every
// value field takes a number or an expression over the parameters and shows its value as you type;
// the geometry preview in the 3D view follows the unsaved draft.
import { createEffect, createSignal, createUniqueId, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Box, CircleAlert, CircleCheck, Cone, Info, MousePointer2, Scissors, Spline, Torus, CopyPlus, Cylinder, FlipHorizontal2, Globe, Hexagon, Plus, Trash2, Triangle, TriangleAlert } from "lucide-solid";
import { setSimSettingsOpen, setSimSettingsSection } from "../runner/designRun";
import { radioGroupKeys } from "../lib/a11y";
import { tryEvaluate } from "./expr";
import { shown as fmt } from "./displayNumber.ts";
import { InlineParam } from "./dialogs/NewParamDialog";
import { CONDUCTOR_PRESETS, conductorPreset, MATERIAL_LIBRARY } from "./materials";
import "../styles/designer-model.css";
import type { AxisCylinder, Axis, CircleCut, ConePrimitive, DesignPrimitive, Expr, PointsCylinder, PolygonCut, PolyhedronPrimitive, RectCut, TorusPrimitive, Vec3, WirePrimitive } from "./types";
import {
  addPort, addPrimitiveToPart, addTransform, applyFix, checks, copyCount, draft, edit, fieldId, focusPath, issues, names, removeTransform,
  selection, serverErrors, setSelection, type ShapeKind, toAxisCylinder, unknownNames, setPortType,
  addCut, addPolygonCut, addRoundCut, removeCut, setColors,
} from "./store";
import { type Check, wgCutoffGHz, wgMode } from "./checks";
import { checkExplain, checkFixLabel, checkMessage, checkTitle } from "./checkText";
import { checkAction } from "./checkActions";
import { resolveColor, themeColor } from "./colors";
import { pathText } from "./pathText";
import { latestPickedPoint } from "./pointTools";
import { deleteVertex, insertVertexAt, pickedVertex, pickVertex, toggleVertexEdit, vertexTarget } from "./vertexEdit";
import { edgeMidpoint, isVertexPrimitive } from "./vertexModel";
import { saveDesignMaterial } from "./userMaterialsStore";
import { conductorLabel, libraryLabel, libraryNote, materialKindLabel } from "./MaterialLibrary";
import { hasKey, localeTag, t } from "../i18n";
import NumberField from "../components/NumberField";
import { OptimizationInspector, ParamInspector, RunInspector } from "./PropsExtras";
import { resultFocus } from "./resultFocus";
import { isReservedName } from "../lib/legacy";
import { restoreBooleanPart } from "./booleanUi";

const AXES: Axis[] = ["x", "y", "z"];
const BOUNDARIES = ["MUR", "PML_8", "PEC", "PMC"];
const SIDES = ["x−", "x+", "y−", "y+", "z−", "z+"];
// labels are i18n keys (t(s.label) where shown)
export const SHAPES: { kind: ShapeKind; label: string; icon: typeof Box }[] = [
  { kind: "box", label: "props.shape.box", icon: Box },
  { kind: "cylinder", label: "props.shape.cylinder", icon: Cylinder },
  { kind: "sphere", label: "props.shape.sphere", icon: Globe },
  { kind: "polygon", label: "props.shape.polygon", icon: Triangle },
  { kind: "linpoly", label: "props.shape.linpoly", icon: Hexagon },
  { kind: "cone", label: "props.shape.cone", icon: Cone },
  { kind: "torus", label: "props.shape.torus", icon: Torus },
  { kind: "wire", label: "props.shape.wire", icon: Spline },
];
/** "Tube" for a cylinder with an inner radius (other than a literal 0) */
export const kindLabel = (pr: DesignPrimitive | DesignPrimitive["kind"]) => {
  if (typeof pr !== "string" && pr.kind === "cylinder" && pr.inner_radius !== undefined && pr.inner_radius !== 0 && pr.inner_radius !== "0" && pr.inner_radius !== "") return t("props.shape.tube");
  const k = typeof pr === "string" ? pr : pr.kind;
  if (k === "polyhedron") return t("props.shape.polyhedron");
  const label = SHAPES.find((s) => s.kind === k)?.label;
  return label ? t(label) : k;
};
/** in-plane axes of an axis, in CSXCAD's order (a cylinder's centre, a polygon's points) */
const planeAxes = (n: Axis): [Axis, Axis] => { const i = AXES.indexOf(n); return [AXES[(i + 1) % 3], AXES[(i + 2) % 3]]; };

/** "12.5" -> 12.5, anything else stays an expression */
const toExpr = (text: string): Expr => {
  const v = text.trim();
  return v !== "" && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v) ? Number(v) : text;
};

// Inline offers are coordinated by unknown name, while each field keeps its own offer intent. A
// name shared by several fields is offered once, in the field that claimed it last (focus, blur,
// Enter), so the Create input sits under the field the user is in and Tab reaches it.
type ParamOffer = { id: string; active: boolean; keys: string[]; claimed: number };
const paramOffers: ParamOffer[] = [];
let offerClaims = 0;
const [paramOfferOwners, setParamOfferOwners] = createSignal<Record<string, string>>({});
function refreshParamOfferOwners() {
  const owners: Record<string, string> = Object.create(null);
  const claimed: Record<string, number> = Object.create(null);
  for (const offer of paramOffers) if (offer.active)
    for (const key of offer.keys) if (!(key in claimed) || offer.claimed > claimed[key]) { owners[key] = offer.id; claimed[key] = offer.claimed; }
  setParamOfferOwners(owners);
}

// ------------------------------------------------------------------ fields

export function ExprField(props: {
  label: string; value: Expr | undefined; path: string; unit?: string; onChange: (v: Expr) => void; compact?: boolean; optional?: boolean;
  /** offer to create parameters for unknown names (default on; off for plain numbers like limits) */
  offerParams?: boolean;
  /** where such new parameters go in the list (default: the end) */
  newParamAt?: number;
  describedBy?: string;
  /** Dialog-local validation, independent of the saved draft's field paths. */
  issue?: Check;
  /** Keep dock cells on one line; expose validation on focus or hover. */
  inline?: boolean;
}) {
  const r = () => tryEvaluate(props.value, names().names);
  const issue = () => props.issue ?? issues()[props.path];
  const bad = () => issue()?.severity === "error" || (!!r().error && !(props.optional && (props.value === "" || props.value === undefined)));
  const isNumber = () => typeof props.value === "number";
  const id = () => fieldId(props.path);
  const messageId = `${createUniqueId()}-message`;
  const detail = () => (issue() && checkMessage(issue()!)) ?? (r().error ? (props.optional && (props.value === "" || props.value === undefined) ? "" : checkMessage({ code: "expr", message: r().error! })) : isNumber() ? "" : `= ${fmt(r().value!)}`);
  const describedBy = () => [detail() ? messageId : null, props.describedBy].filter(Boolean).join(" ") || undefined;
  let input!: HTMLInputElement;
  // the text as typed while focused: "-0" stored as the number -0 would render as "0" and eat the sign
  const [text, setText] = createSignal<string | null>(null);
  const [offering, setOffering] = createSignal(false);
  const unknown = () => props.offerParams === false ? [] : unknownNames(props.value);
  const offerEntry: ParamOffer = { id: createUniqueId(), active: false, keys: [], claimed: 0 };
  paramOffers.push(offerEntry);
  // Escape dismisses the offer until the field is focused again (the blur that follows must not bring it back)
  let dismissed = false;
  const offer = () => {
    if (dismissed) return false;
    setOffering(true); offerEntry.active = true; offerEntry.claimed = ++offerClaims; refreshParamOfferOwners();
    const owners = paramOfferOwners();
    return unknown().some((key) => owners[key] === offerEntry.id);
  };
  createEffect(() => {
    offerEntry.keys = unknown();
    refreshParamOfferOwners();
  });
  onCleanup(() => {
    const i = paramOffers.indexOf(offerEntry);
    if (i >= 0) paramOffers.splice(i, 1);
    refreshParamOfferOwners();
  });
  const onBlur = () => { setText(null); offer(); };
  const onFocus = () => { dismissed = false; offer(); };
  return (
    <div class="dz-field" classList={{ "dz-compact": props.compact, "dz-inline": props.inline }}>
      <label class="dz-label" for={id()}>{props.label}{props.unit ? <span class="dz-unit"> {props.unit}</span> : null}</label>
      <input autocomplete="off" ref={input} id={id()} title={props.inline ? detail() || String(props.value ?? "") : undefined} class="rp-input dz-input mono" type="text" spellcheck={false} value={text() ?? props.value ?? ""}
        aria-invalid={bad()} aria-describedby={describedBy()} classList={{ "dz-input-warn": !bad() && issue()?.severity === "warning" }}
        onFocus={onFocus} onInput={(e) => { setText(e.currentTarget.value); props.onChange(toExpr(e.currentTarget.value)); }} onBlur={onBlur}
        onKeyDown={(e) => { if (e.key === "Enter" && offer()) e.preventDefault(); if (e.key === "Escape") { setText(null); setOffering(false); offerEntry.active = false; dismissed = true; refreshParamOfferOwners(); } }} />
      <span id={messageId} class="dz-value" classList={{ "dz-bad": bad(), "dz-warn": !bad() && issue()?.severity === "warning" }}>{detail()}</span>
      <Show when={offering()}><For each={unknown().filter((key) => paramOfferOwners()[key] === offerEntry.id)}>{(key) =>
        <InlineParam ask={{ key, unit: props.unit, insertAt: props.newParamAt }} onCreated={() => input.focus()} />
      }</For></Show>
    </div>
  );
}

/** A check that points at a whole group of fields (a vector, a polygon's points). */
function GroupIssue(props: { path: string }) {
  const issue = () => issues()[props.path];
  return <Show when={issue()}><span id={`${fieldId(props.path)}-message`} class="dz-value" classList={{ "dz-bad": issue()!.severity === "error", "dz-warn": issue()!.severity === "warning" }}>{issue()!.message}</span></Show>;
}

function VecField(props: { label: string; value: Vec3; path: string; onChange: (k: number, v: Expr) => void; onPicked?: (v: Vec3) => void; axes?: string[]; picked?: boolean }) {
  const picked = latestPickedPoint;
  const groupMessageId = () => issues()[props.path] ? `${fieldId(props.path)}-message` : undefined;
  return (
    <fieldset class="dz-vec">
      <legend class="dz-label">{props.label} <span class="dz-unit">mm</span></legend>
      <Show when={props.picked !== false ? picked() : null}>{(point) =>
        <button type="button" class="linklike" title={t("props.fillVector", { point: point().label })}
          onClick={() => props.onPicked?.([...point().point] as Vec3)}>{t("props.usePicked")}</button>
      }</Show>
      <div class="dz-vec-row">
        <For each={[0, 1, 2]}>
          {(k) => <ExprField compact label={props.axes?.[k] ?? AXES[k]} value={props.value[k]} path={`${props.path}[${k}]`} describedBy={groupMessageId()} onChange={(v) => props.onChange(k, v)} />}
        </For>
      </div>
      <GroupIssue path={props.path} />
    </fieldset>
  );
}

function TextField(props: { label: string; value: string | undefined; onChange: (v: string) => void; error?: string; mono?: boolean; placeholder?: string; id?: string; onBlur?: () => void; describedBy?: string; invalid?: boolean }) {
  const id = props.id ?? createUniqueId();
  return (
    <label class="dz-field">
      <span class="dz-label">{props.label}</span>
      <input autocomplete="off" id={id} class="rp-input dz-input" classList={{ mono: props.mono, "rp-input-text": !props.mono }} type="text" spellcheck={false} value={props.value ?? ""}
        placeholder={props.placeholder} aria-invalid={!!props.error || !!props.invalid}
        aria-describedby={[props.error ? `${id}-error` : null, props.describedBy].filter(Boolean).join(" ") || undefined}
        onInput={(e) => props.onChange(e.currentTarget.value)} onBlur={() => props.onBlur?.()} />
      <Show when={props.error}><span id={`${id}-error`} class="dz-value dz-bad">{props.error}</span></Show>
    </label>
  );
}

export function SelectField<T extends string>(props: { label: string; value: T; options: readonly T[] | { value: T; label: string }[]; onChange: (v: T) => void; id?: string }) {
  const opts = () => (props.options as (T | { value: T; label: string })[]).map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <label class="dz-field">
      <span class="dz-label">{props.label}</span>
      <select id={props.id} class="rp-select dz-input" value={props.value} onChange={(e) => props.onChange(e.currentTarget.value as T)}>
        <For each={opts()}>{(o) => <option value={o.value}>{o.label}</option>}</For>
      </select>
    </label>
  );
}

// ------------------------------------------------------------------ inspectors

function DesignInspector() {
  return (
    <div class="dz-form">
      <h3 class="dz-h">{t("props.design")}</h3>
      <TextField label={t("props.name")} value={draft.model.name} onChange={(v) => edit((d) => { d.model.name = v; }, "model.name")} />
      <label class="dz-field">
        <span class="dz-label">{t("props.description")}</span>
        <AutoGrowTextarea class="rp-input dz-input dz-autogrow" value={draft.model.description ?? ""}
          onInput={(v) => edit((d) => { d.model.description = v; }, "model.description")} />
      </label>
      <p class="note">{t("props.design.note")} <span class="mono">W/2</span> {t("props.design.noteOr")} <span class="mono">wavelength(f0)/4</span>.</p>
      <p class="note">{t("props.design.decimalNote")}</p>
      <p class="note">{[t("props.count.parts", { count: draft.parts.length }), t("props.count.ports", { count: draft.ports.length }), t("props.count.params", { count: draft.params.length })].join(", ")}.</p>
    </div>
  );
}

/** A textarea as tall as its text (up to the CSS max-height, then it scrolls): the design description
 * reads in full instead of a line and a half. */
function AutoGrowTextarea(props: { class: string; value: string; onInput: (v: string) => void }) {
  let el: HTMLTextAreaElement | undefined;
  const fit = () => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
  };
  createEffect(() => { void props.value; queueMicrotask(fit); });
  onMount(() => {
    // the properties pane can change width (resize, collapse): the wrapped text needs another height
    const ro = new ResizeObserver(fit);
    if (el) ro.observe(el);
    onCleanup(() => ro.disconnect());
  });
  return <textarea ref={el} class={props.class} rows={2} value={props.value}
    onInput={(e) => { props.onInput(e.currentTarget.value); fit(); }} />;
}

/** A display color: the native picker plus a reset to the default (theme or material) color. */
function ColorField(props: { label: string; value: string | undefined; fallback: () => string; onPick: (c: string) => void; onReset: () => void; id?: string }) {
  return (
    <div class="dz-field dz-color-field">
      <span class="dz-label">{props.label}</span>
      <div class="cluster-sm">
        <input type="color" class="dz-color-input" id={props.id} aria-label={props.label} value={props.value ?? props.fallback()}
          onInput={(e) => props.onPick(e.currentTarget.value)} />
        <span class="mono note">{props.value ?? t("props.color.default")}</span>
        <Show when={props.value}>
          <button class="btn btn-ghost btn-sm" onClick={props.onReset}>{t("props.color.reset")}</button>
        </Show>
      </div>
    </div>
  );
}


function MaterialInspector(props: { i: number }) {
  const m = () => draft.materials[props.i];
  const path = (k: string) => `materials.${m().name}.${k}`;
  const rename = (v: string) => {
    const old = m().name;
    edit((d) => {
      d.materials[props.i].name = v;
      for (const p of d.parts) if (p.material === old) p.material = v; // follow the rename
    }, `materials[${props.i}].name`);
  };
  const nameError = () => (!m().name.trim() ? t("props.error.noName") : draft.materials.some((q, j) => j !== props.i && q.name === m().name) ? t("props.error.usedTwice") : undefined);
  const set = (fn: (q: (typeof draft.materials)[number]) => void, key: string) => edit((d) => fn(d.materials[props.i]), `materials[${props.i}].${key}`);
  return (
    <div class="dz-form">
      <h3 class="dz-h">{t("props.material")}</h3>
      <TextField label={t("props.name")} value={m().name} error={nameError()} onChange={rename} />
      <SelectField label={t("props.material.kind")} value={m().kind} options={[{ value: "metal", label: t("props.material.metal") }, { value: "dielectric", label: t("props.material.dielectric") }]}
        onChange={(v) => set((q) => { q.kind = v; if (v === "dielectric") { q.eps_r ??= 4.3; q.tan_d ??= 0; } }, "kind")} />
      <Show when={m().kind === "metal"}>
        <SelectField label={t("props.material.conductor")} value={conductorPreset(m().conductivity)} options={CONDUCTOR_PRESETS.map((p) => ({ value: p.id, label: conductorLabel(p) }))}
          onChange={(v) => set((q) => { const p = CONDUCTOR_PRESETS.find((x) => x.id === v); if (!p || p.id === "custom") return; if (p.sigma === null) { delete q.conductivity; delete q.thickness; } else q.conductivity = p.sigma; }, "conductivity")} />
        <ExprField optional label={t("props.material.conductivity")} unit="S/m" value={m().conductivity ?? ""} path={path("conductivity")} onChange={(v) => set((q) => { if (v === "") { delete q.conductivity; delete q.thickness; } else q.conductivity = v; }, "conductivity")} />
        <Show when={m().conductivity !== undefined && m().conductivity !== ""}>
          <ExprField optional label={t("props.material.thickness")} unit="mm" value={m().thickness ?? ""} path={path("thickness")} onChange={(v) => set((q) => { if (v === "") delete q.thickness; else q.thickness = v; }, "thickness")} />
          <p class="note">{t("props.material.conductivityNote")}</p>
        </Show>
      </Show>
      <Show when={m().kind === "dielectric"}>
        <ExprField label={t("feed.muR")} value={m().mu_r ?? 1} path={path("mu_r")} onChange={(v) => set((q) => { q.mu_r = v; }, "mu_r")} />
        <p class="note">{t("feed.muNote")}</p>
        <ExprField label={t("props.material.epsR")} value={m().eps_r} path={path("eps_r")} onChange={(v) => set((q) => { q.eps_r = v; }, "eps_r")} />
        <ExprField label={t("props.material.tanD")} value={m().tan_d ?? 0} path={path("tan_d")} onChange={(v) => set((q) => { q.tan_d = v; }, "tan_d")} />
        <ExprField optional label={t("props.material.tanDFreq")} unit="GHz" value={m().tan_d_freq ?? ""} path={path("tan_d_freq")} onChange={(v) => set((q) => { if (v === "") delete q.tan_d_freq; else q.tan_d_freq = v; }, "tan_d_freq")} />
      </Show>
      <ColorField label={t("props.color")} value={m().color} fallback={() => themeColor(m().kind === "metal")}
        onPick={(c) => setColors("materials", [props.i], c)} onReset={() => setColors("materials", [props.i], undefined)} />
      <Show when={MATERIAL_LIBRARY.find((e) => e.id === m().library)}>
        {(e) => {
          const edited = () => e().kind !== m().kind || (e().kind === "dielectric" &&
            (m().eps_r !== e().eps_r || m().tan_d !== e().tan_d || (m().tan_d_freq ?? null) !== (e().tan_d_freq ?? null)));
          return <p class="note">{t("props.material.fromLibrary")} <b>{libraryLabel(e())}</b>{edited() ? ` ${t("props.material.editedSince")}` : ""}. {libraryNote(e())}</p>;
        }}
      </Show>
      <button class="btn btn-sm" type="button" onClick={() => void saveDesignMaterial(props.i)}>{t("userMaterials.saveTo")}</button>
      <p class="note">{t("props.material.usedBy", { count: draft.parts.filter((p) => p.material === m().name).length })}</p>
    </div>
  );
}

/** The part's component folder (components): type a path or pick an existing one. */
function ComponentField(props: { i: number }) {
  const all = () => [...new Set(draft.parts.map((p) => p.component?.trim()).filter((c): c is string => !!c))].sort();
  const id = () => fieldId(`parts[${props.i}].component`);
  const issue = () => issues()[`parts[${props.i}].component`];
  return (
    <label class="dz-field" for={id()}>
      <span class="dz-label">{t("props.component")} <span class="dz-unit">{t("props.component.hint")}</span></span>
      <input autocomplete="off" id={id()} class="rp-input dz-input mono" type="text" spellcheck={false} list="dm-components" placeholder={t("props.component.none")}
        value={draft.parts[props.i].component ?? ""} aria-invalid={issue()?.severity === "error"}
        aria-describedby={issue() ? `${id()}-message` : undefined}
        onInput={(e) => { const v = e.currentTarget.value; edit((d) => { if (v.trim()) d.parts[props.i].component = v; else delete d.parts[props.i].component; }, `parts[${props.i}].component`); }} />
      <datalist id="dm-components"><For each={all()}>{(c) => <option value={c} />}</For></datalist>
      <Show when={issue()}><span id={`${id()}-message`} class="dz-value" classList={{ "dz-bad": issue()!.severity === "error", "dz-warn": issue()!.severity === "warning" }}>{issue()!.message}</span></Show>
    </label>
  );
}

// Remember advanced disclosure for this page session, including selection changes.
const [advancedOpen, setAdvancedOpen] = createSignal(false);
function InspectorAdvanced(props: { children: JSX.Element }) {
  return <details class="dz-inspector-advanced" open={advancedOpen()} onToggle={(e) => { if (e.currentTarget.isConnected) setAdvancedOpen(e.currentTarget.open); }}>
    <summary>{t("props.advanced")}</summary>
    <div class="dz-form">{props.children}</div>
  </details>;
}
function InspectorTitle(props: { label: string; value: string | undefined; fallback: string; path: string; onChange: (value: string) => void }) {
  return <input autocomplete="off" class="rp-input dz-input dz-inspector-title" id={fieldId(props.path)} aria-label={props.label}
    type="text" value={props.value ?? ""} placeholder={props.fallback} onInput={(e) => props.onChange(e.currentTarget.value)} />;
}

function PartInspector(props: { i: number; j?: number }) {
  const p = () => draft.parts[props.i];
  const nameError = () => {
    const n = p().name;
    if (!n.trim()) return t("props.error.noName");
    if (isReservedName(n)) return t("props.error.reserved");
    if (draft.parts.some((q, j) => j !== props.i && q.name === n)) return t("props.error.usedTwice");
    return serverErrors()[`parts[${props.i}].name`];
  };
  const set = (fn: (q: (typeof draft.parts)[number]) => void, key: string) => edit((d) => fn(d.parts[props.i]), `parts[${props.i}].${key}`);
  const count = () => copyCount(p());
  return (
    <div class="dz-form">
      <h3 class="dz-h">{props.j === undefined ? t("props.part") : t("props.part.shape", { shape: kindLabel(p().primitives[props.j]) })}</h3>
      <Show when={props.j !== undefined} fallback={
        <InspectorTitle label={t("props.part.label")} value={p().label} fallback={p().name} path={`parts[${props.i}].label`} onChange={(v) => set((q) => { q.label = v || undefined; }, "label")} />
      }>
        <InspectorTitle label={t("props.shape.label")} value={p().primitives[props.j!].label} fallback={`${kindLabel(p().primitives[props.j!])} ${props.j! + 1}`}
          path={`parts[${props.i}].primitives[${props.j!}].label`}
          onChange={(v) => edit((d) => { d.parts[props.i].primitives[props.j!].label = v || undefined; }, `parts[${props.i}].primitives[${props.j!}].label`)} />
      </Show>
      <h3 class="dz-h">{t("props.geometry")}</h3>
      <Show when={p().booleanHistory}>{(h) =>
        <p class="note">{t("props.boolean", { op: hasKey(`props.boolean.op.${h().operation}`) ? t(`props.boolean.op.${h().operation}`) : h().operation, a: h().A.label || h().A.name, b: h().B.label || h().B.name })} {t(h().live ? "props.boolean.live" : "props.boolean.fixed")}{" "}
          <button type="button" class="linklike" title={t("props.boolean.restore")} onClick={() => restoreBooleanPart(props.i)}>{t("boolean.restore")}</button></p>
      }</Show>
      <For each={props.j === undefined ? p().primitives.map((_, j) => j) : [props.j]}>
        {(j) => <PrimitiveInspector i={props.i} j={j} editLabel={props.j === undefined} />}
      </For>
      <SelectField label={t("props.material")} id={fieldId(`parts[${props.i}].material`)} value={p().material} options={draft.materials.map((m) => ({ value: m.name, label: `${m.name} (${materialKindLabel(m.kind)})` }))}
        onChange={(v) => set((q) => { q.material = v; }, "material")} />
      <ColorField label={t("props.color.part")} id={fieldId(`parts[${props.i}].color`)} value={p().color}
        fallback={() => { const mt = draft.materials.find((q) => q.name === p().material); return resolveColor(undefined, mt, themeColor(mt?.kind === "metal")); }}
        onPick={(c) => setColors("parts", [props.i], c)} onReset={() => setColors("parts", [props.i], undefined)} />
      <GroupIssue path={`parts[${props.i}]`} />
      <div class="dz-sub">
        <span class="dz-label">{t("props.transforms")} <span class="dz-unit">{count() !== null && count()! > 1 ? `· ${t("props.transforms.copies", { count: count()! - 1, total: count() })}` : ""}</span></span>
        <For each={p().transforms ?? []}>
          {(tf, k) => {
            const base = () => `parts[${props.i}].transforms[${k()}]`;
            const setT = (fn: (q: NonNullable<(typeof draft.parts)[number]["transforms"]>[number]) => void, key: string) =>
              edit((d) => fn(d.parts[props.i].transforms![k()]), `${base()}.${key}`);
            return (
              <div class="dz-card">
                <div class="dz-card-head">
                  <span>{k() + 1}. {t(tf.type === "rotate" ? "props.transform.rotate" : tf.type === "move" ? "props.transform.move" : tf.type === "translate" ? "props.transform.translate" : tf.type === "scale" ? "props.transform.scale" : "props.transform.mirror")}</span>
                  <button class="icon-btn icon-btn-sm" aria-label={t("props.transform.remove", { n: k() + 1 })} title={t("common.remove")} onClick={() => removeTransform(props.i, k())}><Trash2 size={12} /></button>
                </div>
                <Show when={tf.type === "move"}>
                  <VecField label={t("props.transform.offset")} picked={false} value={(tf as { offset: Vec3 }).offset} path={`${base()}.offset`}
                    onChange={(c, v) => setT((q) => { (q as { offset: Vec3 }).offset[c] = v; }, `offset${c}`)} />
                </Show>
                <Show when={tf.type === "rotate"}>
                  <SelectField label={t("props.transform.rotationAxis")} value={(tf as { axis: Axis }).axis} options={AXES}
                    onChange={(v) => setT((q) => { (q as { axis: Axis }).axis = v; }, "axis")} />
                  <VecField label={t("props.transform.pointOnAxis")} value={(tf as { center: Vec3 }).center} path={`${base()}.center`}
                    onChange={(c, v) => setT((q) => { (q as { center: Vec3 }).center[c] = v; }, `center${c}`)}
                    onPicked={(v) => setT((q) => { (q as { center: Vec3 }).center = v; }, "center")} />
                  <ExprField label={t("props.transform.angle")} unit="°" value={(tf as { angle: Expr }).angle} path={`${base()}.angle`}
                    onChange={(v) => setT((q) => { (q as { angle: Expr }).angle = v; }, "angle")} />
                  <p class="note">{t("props.transform.angleNote")}</p>
                  <ExprField label={t("props.transform.copiesRotate")} value={(tf as { copies?: Expr }).copies ?? 0} path={`${base()}.copies`}
                    onChange={(v) => setT((q) => { (q as { copies: Expr }).copies = v; }, "copies")} />
                </Show>
                <Show when={tf.type === "scale"}>
                  <VecField label={t("props.transform.factors")} picked={false} value={(tf as { factors: Vec3 }).factors} path={`${base()}.factors`}
                    onChange={(c, v) => setT((q) => { if (q.type === "scale") q.factors[c] = v; }, `factors${c}`)} />
                  <VecField label={t("props.transform.origin")} value={(tf as { origin: Vec3 }).origin} path={`${base()}.origin`}
                    onChange={(c, v) => setT((q) => { if (q.type === "scale") q.origin[c] = v; }, `origin${c}`)}
                    onPicked={(v) => setT((q) => { if (q.type === "scale") q.origin = v; }, "origin")} />
                  <ExprField label={t("props.transform.copiesScale")} value={(tf as { copies?: Expr }).copies ?? 0} path={`${base()}.copies`}
                    onChange={(v) => setT((q) => { if (q.type === "scale") q.copies = v; }, "copies")} />
                  <p class="note">{t("props.transform.scaleNote")}</p>
                </Show>
                <Show when={tf.type === "translate" || tf.type === "mirror"}>
                <Show when={tf.type === "translate"} fallback={
                  <div class="stack-sm">
                    <SelectField label={t("props.transform.planeNormal")} value={(tf as { plane: Axis }).plane}
                      options={AXES} onChange={(v) => setT((q) => { (q as { plane: Axis }).plane = v; }, "plane")} />
                    <VecField label={t("props.transform.pointOnPlane")} value={(tf as { point?: Vec3 }).point ?? [0, 0, 0]} path={`${base()}.point`}
                      onChange={(c, v) => setT((q) => { if (q.type === "mirror") { q.point ??= [0, 0, 0]; q.point[c] = v; } }, `point${c}`)}
                      onPicked={(v) => setT((q) => { if (q.type === "mirror") q.point = v; }, "point")} />
                    <label class="dz-check dz-check-low"><input type="checkbox" checked={(tf as { keep?: boolean }).keep !== false}
                      onChange={(e) => { const c = e.currentTarget.checked; setT((q) => { (q as { keep?: boolean }).keep = c; }, "keep"); }} /> {t("props.transform.keep")}</label>
                  </div>
                }>
                  <ExprField label={t("props.transform.copiesAdded")} value={(tf as { copies: Expr }).copies} path={`${base()}.copies`}
                    onChange={(v) => setT((q) => { (q as { copies: Expr }).copies = v; }, "copies")} />
                  <VecField label={t("props.transform.step")} picked={false} value={(tf as { step: Vec3 }).step} path={`${base()}.step`}
                    onChange={(c, v) => setT((q) => { (q as { step: Vec3 }).step[c] = v; }, `step${c}`)} />
                </Show>
                </Show>
              </div>
            );
          }}
        </For>
        <div class="cluster-sm">
          <button class="btn btn-ghost btn-sm" onClick={() => addTransform(props.i, "move")}>{t("props.transform.addMove")}</button>
          <button class="btn btn-ghost btn-sm" onClick={() => addTransform(props.i, "rotate")}>{t("props.transform.addRotate")}</button>
          <button class="btn btn-ghost btn-sm" onClick={() => addTransform(props.i, "translate")} title={t("props.transform.translate.title")}>
            <CopyPlus size={13} aria-hidden="true" /> {t("props.transform.translate")}
          </button>
          <button class="btn btn-ghost btn-sm" onClick={() => addTransform(props.i, "mirror")} title={t("props.transform.mirror.title")}>
            <FlipHorizontal2 size={13} aria-hidden="true" /> {t("props.transform.mirror")}
          </button>
        </div>
        <Show when={(p().transforms ?? []).length}>
          <p class="note">{t("props.transforms.note")}</p>
        </Show>
      </div>
      <div class="dz-sub">
        <span class="dz-label">{t("props.cuts")} <span class="dz-unit">· {t("props.cuts.hint")}</span></span>
        <For each={p().cuts ?? []}>
          {(c, k) => {
            const cb = () => `parts[${props.i}].cuts[${k()}]`;
            const setC = (fn: (q: NonNullable<(typeof draft.parts)[number]["cuts"]>[number]) => void, key: string) =>
              edit((d) => fn(d.parts[props.i].cuts![k()]), `${cb()}.${key}`);
            const round = () => c.kind === "circle" ? c : null;
            const poly = () => c.kind === "polygon" ? c : null;
            const rect = () => c.kind === "circle" || c.kind === "polygon" ? null : c as RectCut;
            const normal = () => (round() ?? poly())?.normal ?? "z";
            return (
              <div class="dz-card">
                <div class="dz-card-head">
                  <span>{t(round() ? "props.cut.round" : poly() ? "props.cut.polygon" : "props.cut", { n: k() + 1 })}</span>
                  <button class="icon-btn icon-btn-sm" aria-label={t("props.cut.remove", { n: k() + 1 })} title={t("common.remove")} onClick={() => removeCut(props.i, k())}><Trash2 size={12} /></button>
                </div>
                <Show when={rect()}>{(r) =>
                  <RangeRows axes={AXES} lo={(q) => r().start[q]} hi={(q) => r().stop[q]}
                    loPath={(q) => `${cb()}.start[${q}]`} hiPath={(q) => `${cb()}.stop[${q}]`}
                    onLo={(q, v) => setC((x) => { (x as RectCut).start[q] = v; }, `start${q}`)}
                    onHi={(q, v) => setC((x) => { (x as RectCut).stop[q] = v; }, `stop${q}`)} />
                }</Show>
                <Show when={round() ?? poly()}>
                  <div class="dz-pair">
                    <SelectField label={t("props.cut.normal")} value={normal()} options={AXES}
                      onChange={(v) => setC((x) => { (x as CircleCut).normal = v; }, "normal")} />
                    <ExprField label={t("props.cut.plane", { axis: normal().toUpperCase() })} unit="mm" value={(round() ?? poly())!.elevation ?? 0} path={`${cb()}.elevation`}
                      onChange={(v) => setC((x) => { (x as CircleCut).elevation = v; }, "elevation")} />
                  </div>
                </Show>
                <Show when={round()}>{(r) =>
                  <>
                    <div class="dz-pair">
                      <For each={[0, 1]}>
                        {(q) => <ExprField label={t("props.centerAxis", { axis: planeAxes(normal())[q].toUpperCase() })} unit="mm" value={r().center[q]} path={`${cb()}.center[${q}]`}
                          onChange={(v) => setC((x) => { (x as CircleCut).center[q] = v; }, `center${q}`)} />}
                      </For>
                    </div>
                    <ExprField label={t("props.radius")} unit="mm" value={r().radius} path={`${cb()}.radius`} onChange={(v) => setC((x) => { (x as CircleCut).radius = v; }, "radius")} />
                  </>
                }</Show>
                <Show when={poly()}>{(pc) =>
                  <fieldset class="dz-vec">
                    <legend class="dz-label">{t("props.points", { axes: planeAxes(normal()).join(", ") })} <span class="dz-unit">mm</span></legend>
                    <For each={pc().points}>
                      {(pt, m) => (
                        <div class="dz-vec-row">
                          <span class="dz-unit">{m() + 1}</span>
                          <For each={[0, 1]}>
                            {(q) => <ExprField compact label={planeAxes(normal())[q]} value={pt[q]} path={`${cb()}.points[${m()}][${q}]`}
                              onChange={(v) => setC((x) => { (x as PolygonCut).points[m()][q] = v; }, `p${m()}${q}`)} />}
                          </For>
                          <button class="icon-btn icon-btn-sm" type="button" disabled={pc().points.length <= 3} aria-label={t("props.points.remove", { n: m() + 1 })} title={t("props.points.remove.title")}
                            onClick={() => edit((d) => { (d.parts[props.i].cuts![k()] as PolygonCut).points.splice(m(), 1); }, `${cb()}.points`)}><Trash2 size={12} /></button>
                        </div>
                      )}
                    </For>
                    <button class="btn btn-ghost btn-sm" type="button"
                      onClick={() => edit((d) => { const ps = (d.parts[props.i].cuts![k()] as PolygonCut).points; ps.push([...ps[ps.length - 1]] as [Expr, Expr]); }, `${cb()}.points`)}>
                      <Plus size={13} aria-hidden="true" /> {t("props.cut.addPoint")}
                    </button>
                    <GroupIssue path={`${cb()}.points`} />
                  </fieldset>
                }</Show>
                <GroupIssue path={cb()} />
              </div>
            );
          }}
        </For>
        <div class="cluster-sm">
          <button class="btn btn-ghost btn-sm" onClick={() => addCut(props.i)} title={t("props.cut.add.title")}>
            <Scissors size={13} aria-hidden="true" /> {t("props.cut.add")}
          </button>
          <button class="btn btn-ghost btn-sm" onClick={() => addRoundCut(props.i)} title={t("props.cut.addRound.title")}>
            <Scissors size={13} aria-hidden="true" /> {t("props.cut.addRound")}
          </button>
          <button class="btn btn-ghost btn-sm" onClick={() => addPolygonCut(props.i)} title={t("props.cut.addPolygon.title")}>
            <Scissors size={13} aria-hidden="true" /> {t("props.cut.addPolygon")}
          </button>
        </div>
        <Show when={(p().cuts ?? []).length}>
          <p class="note">{t("props.cuts.note")}</p>
        </Show>
      </div>
      <InspectorAdvanced>
        <For each={props.j === undefined ? p().primitives.map((_, j) => j) : [props.j]}>
          {(j) => <label class="dz-field dz-compact-row">
            <span class="dz-label">{t("props.priority")}{p().primitives.length > 1 ? ` · ${kindLabel(p().primitives[j])} ${j + 1}` : ""}</span>
            <NumberField id={fieldId(`parts[${props.i}].primitives[${j}].priority`)} class="rp-input dz-input mono" step="1" value={p().primitives[j].priority ?? ""} placeholder={t("props.priority.auto")}
              onInput={(e) => { const v = e.currentTarget.value; edit((d) => { const pr = d.parts[props.i].primitives[j]; if (v === "") delete pr.priority; else pr.priority = Math.round(Number(v)); }, `parts[${props.i}].primitives[${j}].priority`); }} />
          </label>}
        </For>
        <TextField label={t("props.name")} id={fieldId(`parts[${props.i}].name`)} mono value={p().name} error={nameError()} onChange={(v) => set((q) => { q.name = v.trim(); }, "name")} />
        <Show when={props.j !== undefined}>
          <TextField label={t("props.part.labelShort")} value={p().label} id={fieldId(`parts[${props.i}].label`)} onChange={(v) => set((q) => { q.label = v || undefined; }, "label")} />
        </Show>
        <ComponentField i={props.i} />
        <div class="dz-sub">
          <span class="dz-label">{t("props.shapes")}</span>
          <ul class="dz-shapes">
            <For each={p().primitives}>
              {(pr, j) => <li><button class="linklike" onClick={() => setSelection({ type: "primitive", i: props.i, j: j() })}>{kindLabel(pr)} {j() + 1}</button>{pr.void ? <> <span class="chip" title={t("design.void.title")}>{t("design.void.badge")}</span></> : null}</li>}
            </For>
          </ul>
          <div class="cluster-sm">
            <For each={SHAPES}>{(s) => (
              <button class="btn btn-ghost btn-sm" onClick={() => addPrimitiveToPart(props.i, s.kind)} title={t("props.part.addShape", { shape: t(s.label).toLocaleLowerCase(localeTag()) })}>
                <s.icon size={13} aria-hidden="true" /> {t(s.label)}
              </button>
            )}</For>
          </div>
        </div>
      </InspectorAdvanced>
      <p class="note">{t("props.part.note")}</p>
    </div>
  );
}

/** Min / max rows per axis, the brick dialog. */
function RangeRows(props: { axes: Axis[]; lo: (k: number) => Expr; hi: (k: number) => Expr; loPath: (k: number) => string; hiPath: (k: number) => string;
  onLo: (k: number, v: Expr) => void; onHi: (k: number, v: Expr) => void; onPickedLo?: (v: Vec3) => void; onPickedHi?: (v: Vec3) => void; idx?: (k: number) => number }) {
  const picked = latestPickedPoint;
  return (
    <>
    <Show when={props.axes.length === 3 && picked()}>{(point) =>
      <div class="dz-vec-row">
        <button type="button" class="linklike" onClick={() => props.onPickedLo?.([...point().point] as Vec3)}>
          {t("props.usePickedMin")}
        </button>
        <button type="button" class="linklike" onClick={() => props.onPickedHi?.([...point().point] as Vec3)}>
          {t("props.usePickedMax")}
        </button>
      </div>
    }</Show>
    <div class="dz-ranges">
      <For each={props.axes}>
        {(a, k) => (
          <>
            <ExprField compact label={`${a.toUpperCase()}min`} unit="mm" value={props.lo(k())} path={props.loPath(k())} onChange={(v) => props.onLo(k(), v)} />
            <ExprField compact label={`${a.toUpperCase()}max`} unit="mm" value={props.hi(k())} path={props.hiPath(k())} onChange={(v) => props.onHi(k(), v)} />
          </>
        )}
      </For>
    </div>
    </>
  );
}

/** Switch the 3D view's point handles on or off for this polygon or wire. */
function VertexEditToggle(props: { i: number; j: number }) {
  const on = () => { const vt = vertexTarget(); return !!vt && vt.i === props.i && vt.j === props.j; };
  return <div class="dz-vertex-edit">
    <button type="button" class="btn btn-ghost btn-sm" aria-pressed={on()} onClick={() => toggleVertexEdit({ i: props.i, j: props.j })}
      title={t("props.points.edit.title")}>
      <MousePointer2 size={13} aria-hidden="true" /> {t(on() ? "props.points.edit.stop" : "props.points.edit")}
    </button>
    <Show when={on()}><span class="note" role="status">{t("props.points.edit.help")}</span></Show>
  </div>;
}

/** A point row's insert (after it) and remove buttons; each is one undo step. */
function VertexRowActions(props: { i: number; j: number; k: number }) {
  const pr = () => draft.parts[props.i]?.primitives[props.j];
  const count = () => { const p = pr(); return isVertexPrimitive(p) ? p.points.length : 0; };
  const min = () => (pr()?.kind === "wire" ? 2 : 3);
  const next = () => (pr()?.kind === "wire" ? props.k + 2 : ((props.k + 1) % Math.max(1, count())) + 1);
  const midpoint = () => { const p = pr(); return isVertexPrimitive(p) ? edgeMidpoint(p, props.k, names().names) : null; };
  return <span class="dz-point-actions">
    <button class="icon-btn icon-btn-sm" type="button" disabled={!midpoint()} aria-label={t("props.points.insert", { a: props.k + 1, b: next() })} title={t("props.points.insert.title", { a: props.k + 1, b: next() })}
      onClick={() => { const mid = midpoint(); if (mid) insertVertexAt({ i: props.i, j: props.j }, props.k, mid); }}><Plus size={12} /></button>
    <button class="icon-btn icon-btn-sm" type="button" disabled={count() <= min()} aria-label={t("props.points.remove", { n: props.k + 1 })} title={t("props.points.remove.title")}
      onClick={() => deleteVertex({ i: props.i, j: props.j }, props.k)}><Trash2 size={12} /></button>
  </span>;
}

function PrimitiveInspector(props: { i: number; j: number; editLabel?: boolean }) {
  const pr = () => draft.parts[props.i].primitives[props.j];
  const base = () => `parts[${props.i}].primitives[${props.j}]`;
  const set = (fn: (q: DesignPrimitive) => void, key: string) => edit((d) => fn(d.parts[props.i].primitives[props.j]), `${base()}.${key}`);
  const [convertError, setConvertError] = createSignal<string | null>(null);
  const pointPageSize = 32;
  const [pointPage, setPointPage] = createSignal(0);
  const editingHere = () => { const vt = vertexTarget(); return !!vt && vt.i === props.i && vt.j === props.j; };
  const vertexPicked = (k: number) => editingHere() && pickedVertex() === k;
  const pickRow = (k: number) => { if (editingHere() && pickedVertex() !== k) pickVertex(k); };
  onMount(() => {
    const reveal = (event: Event) => {
      const path = (event as CustomEvent<{ path: string }>).detail?.path;
      const match = path?.match(/^parts\[(\d+)\]\.primitives\[(\d+)\]\.points\[(\d+)\](?:\[|$)/);
      if (match && Number(match[1]) === props.i && Number(match[2]) === props.j) setPointPage(Math.floor(Number(match[3]) / pointPageSize));
    };
    window.addEventListener("fairbeam:reveal-point", reveal);
    onCleanup(() => window.removeEventListener("fairbeam:reveal-point", reveal));
  });
  return (
    <div class="dz-form">
      <h3 class="dz-h">{kindLabel(pr())} {props.j + 1} <span class="muted">{t("props.shape.inPart", { part: draft.parts[props.i].name })}</span></h3>
      <Show when={props.editLabel}>
        <InspectorTitle label={t("props.shape.label")} value={pr().label} fallback={`${kindLabel(pr())} ${props.j + 1}`} path={`${base()}.label`} onChange={(v) => set((q) => { q.label = v || undefined; }, "label")} />
      </Show>
      <Show when={pr().kind === "box"}>
        {(() => {
          const box = () => pr() as { start: Vec3; stop: Vec3 };
          return (
            <>
              <RangeRows axes={AXES} lo={(k) => box().start[k]} hi={(k) => box().stop[k]}
                loPath={(k) => `${base()}.start[${k}]`} hiPath={(k) => `${base()}.stop[${k}]`}
                onLo={(k, v) => set((q) => { (q as { start: Vec3 }).start[k] = v; }, `start${k}`)}
                onHi={(k, v) => set((q) => { (q as { stop: Vec3 }).stop[k] = v; }, `stop${k}`)}
                onPickedLo={(v) => set((q) => { (q as { start: Vec3 }).start = v; }, "start")}
                onPickedHi={(v) => set((q) => { (q as { stop: Vec3 }).stop = v; }, "stop")} />
              <p class="note">{t("props.box.note")}</p>
            </>
          );
        })()}
      </Show>
      <Show when={pr().kind === "cylinder" && "axis" in pr()}>
        {(() => {
          const cyl = () => pr() as AxisCylinder;
          const inPlane = () => planeAxes(cyl().axis);
          return (
            <>
              <SelectField label={t("props.axis")} value={cyl().axis} options={AXES} onChange={(v) => set((q) => { (q as AxisCylinder).axis = v; }, "axis")} />
              <div class="dz-pair">
                <For each={[0, 1]}>
                  {(c) => <ExprField label={t("props.centerAxis", { axis: inPlane()[c].toUpperCase() })} unit="mm" value={cyl().center[c]} path={`${base()}.center[${c}]`}
                    onChange={(v) => set((q) => { (q as AxisCylinder).center[c] = v; }, `center${c}`)} />}
                </For>
              </div>
              <Show when={latestPickedPoint()}>{(point) =>
                <button type="button" class="linklike"
                  onClick={() => set((q) => { (q as AxisCylinder).center = inPlane().map((a) => point().point[AXES.indexOf(a)]) as [Expr, Expr]; }, "center")}>
                  {t("props.usePickedCenter")}
                </button>
              }</Show>
              <div class="dz-pair">
                <ExprField label={t("props.outerRadius")} unit="mm" value={cyl().radius} path={`${base()}.radius`} onChange={(v) => set((q) => { (q as AxisCylinder).radius = v; }, "radius")} />
                <ExprField label={t("props.innerRadius")} unit="mm" value={cyl().inner_radius ?? 0} path={`${base()}.inner_radius`}
                  onChange={(v) => set((q) => { (q as AxisCylinder).inner_radius = v; }, "inner_radius")} />
              </div>
              <RangeRows axes={[cyl().axis]} lo={() => cyl().range[0]} hi={() => cyl().range[1]}
                loPath={() => `${base()}.range[0]`} hiPath={() => `${base()}.range[1]`}
                onLo={(_, v) => set((q) => { (q as AxisCylinder).range[0] = v; }, "range0")}
                onHi={(_, v) => set((q) => { (q as AxisCylinder).range[1] = v; }, "range1")} />
              <Show when={latestPickedPoint()}>{(point) => <div class="dz-vec-row">
                <button type="button" class="linklike"
                    onClick={() => set((q) => { (q as AxisCylinder).range[0] = point().point[AXES.indexOf(cyl().axis)]; }, "range0")}>
                    {t("props.usePickedFor", { what: `${cyl().axis.toUpperCase()}min` })}
                </button>
                <button type="button" class="linklike"
                    onClick={() => set((q) => { (q as AxisCylinder).range[1] = point().point[AXES.indexOf(cyl().axis)]; }, "range1")}>
                    {t("props.usePickedFor", { what: `${cyl().axis.toUpperCase()}max` })}
                </button>
              </div>}</Show>
              <p class="note">{t("props.cylinder.tubeNote")}</p>
            </>
          );
        })()}
      </Show>
      <Show when={pr().kind === "cylinder" && "start" in pr()}>
        {(() => {
          const cyl = () => pr() as PointsCylinder;
          return (
            <>
              <p class="note">{t("props.cylinder.oldForm")}
                <button class="linklike" onClick={() => setConvertError(toAxisCylinder(props.i, props.j) ? null : t("props.cylinder.convertError"))}> {t("props.cylinder.convert")}</button>
              </p>
              <Show when={convertError()}><p class="dz-value dz-bad">{convertError()}</p></Show>
              <VecField label={t("props.cylinder.axisStart")} value={cyl().start} path={`${base()}.start`} onChange={(k, v) => set((q) => { (q as PointsCylinder).start[k] = v; }, `start${k}`)} onPicked={(v) => set((q) => { (q as PointsCylinder).start = v; }, "start")} />
              <VecField label={t("props.cylinder.axisStop")} value={cyl().stop} path={`${base()}.stop`} onChange={(k, v) => set((q) => { (q as PointsCylinder).stop[k] = v; }, `stop${k}`)} onPicked={(v) => set((q) => { (q as PointsCylinder).stop = v; }, "stop")} />
              <div class="dz-pair">
                <ExprField label={t("props.outerRadius")} unit="mm" value={cyl().radius} path={`${base()}.radius`} onChange={(v) => set((q) => { (q as PointsCylinder).radius = v; }, "radius")} />
                <ExprField label={t("props.innerRadius")} unit="mm" value={cyl().inner_radius ?? 0} path={`${base()}.inner_radius`}
                  onChange={(v) => set((q) => { (q as PointsCylinder).inner_radius = v; }, "inner_radius")} />
              </div>
            </>
          );
        })()}
      </Show>
      <Show when={pr().kind === "sphere"}>
        {(() => {
          const sph = () => pr() as { center: Vec3; radius: Expr };
          return (
            <>
              <VecField label={t("props.center")} value={sph().center} path={`${base()}.center`} onChange={(k, v) => set((q) => { (q as { center: Vec3 }).center[k] = v; }, `center${k}`)} onPicked={(v) => set((q) => { (q as { center: Vec3 }).center = v; }, "center")} />
              <ExprField label={t("props.radius")} unit="mm" value={sph().radius} path={`${base()}.radius`} onChange={(v) => set((q) => { (q as { radius: Expr }).radius = v; }, "radius")} />
            </>
          );
        })()}
      </Show>
      <Show when={pr().kind === "cone"}>
        {(() => {
          const cone = () => pr() as ConePrimitive;
          const inPlane = () => planeAxes(cone().axis);
          return (
            <>
              <SelectField label={t("props.axis")} value={cone().axis} options={AXES} onChange={(v) => set((q) => { (q as ConePrimitive).axis = v; }, "axis")} />
              <div class="dz-pair">
                <For each={[0, 1]}>
                  {(c) => <ExprField label={t("props.centerAxis", { axis: inPlane()[c].toUpperCase() })} unit="mm" value={cone().center[c]} path={`${base()}.center[${c}]`}
                    onChange={(v) => set((q) => { (q as ConePrimitive).center[c] = v; }, `center${c}`)} />}
                </For>
              </div>
              <div class="dz-pair">
                <ExprField label={t("props.cone.bottom", { axis: cone().axis })} unit="mm" value={cone().bottom_radius} path={`${base()}.bottom_radius`}
                  onChange={(v) => set((q) => { (q as ConePrimitive).bottom_radius = v; }, "bottom_radius")} />
                <ExprField label={t("props.cone.top", { axis: cone().axis })} unit="mm" value={cone().top_radius ?? 0} path={`${base()}.top_radius`}
                  onChange={(v) => set((q) => { (q as ConePrimitive).top_radius = v; }, "top_radius")} />
              </div>
              <RangeRows axes={[cone().axis]} lo={() => cone().range[0]} hi={() => cone().range[1]}
                loPath={() => `${base()}.range[0]`} hiPath={() => `${base()}.range[1]`}
                onLo={(_, v) => set((q) => { (q as ConePrimitive).range[0] = v; }, "range0")}
                onHi={(_, v) => set((q) => { (q as ConePrimitive).range[1] = v; }, "range1")} />
              <p class="note">{t("props.cone.note")}</p>
            </>
          );
        })()}
      </Show>
      <Show when={pr().kind === "torus"}>
        {(() => {
          const tor = () => pr() as TorusPrimitive;
          return (
            <>
              <SelectField label={t("props.axis")} value={tor().axis} options={AXES} onChange={(v) => set((q) => { (q as TorusPrimitive).axis = v; }, "axis")} />
              <VecField label={t("props.center")} value={tor().center} path={`${base()}.center`} onChange={(k, v) => set((q) => { (q as TorusPrimitive).center[k] = v; }, `center${k}`)} onPicked={(v) => set((q) => { (q as TorusPrimitive).center = v; }, "center")} />
              <div class="dz-pair">
                <ExprField label={t("props.torus.major")} unit="mm" value={tor().major_radius} path={`${base()}.major_radius`}
                  onChange={(v) => set((q) => { (q as TorusPrimitive).major_radius = v; }, "major_radius")} />
                <ExprField label={t("props.torus.minor")} unit="mm" value={tor().minor_radius} path={`${base()}.minor_radius`}
                  onChange={(v) => set((q) => { (q as TorusPrimitive).minor_radius = v; }, "minor_radius")} />
              </div>
              <p class="note">{t("props.torus.note")}</p>
            </>
          );
        })()}
      </Show>
      <Show when={pr().kind === "wire"}>
        {(() => {
          const wire = () => pr() as WirePrimitive;
          return (
            <>
              <ExprField label={t("props.wire.radius")} unit="mm" value={wire().radius} path={`${base()}.radius`} onChange={(v) => set((q) => { (q as WirePrimitive).radius = v; }, "radius")} />
              <fieldset class="dz-vec">
                <legend class="dz-label">{t("props.points", { axes: "x, y, z" })} <span class="dz-unit">mm</span></legend>
                <VertexEditToggle i={props.i} j={props.j} />
                <For each={wire().points}>
                  {(pt, k) => (
                    <div class="dz-point dm-point3" classList={{ "is-picked": vertexPicked(k()) }} onFocusIn={() => pickRow(k())}>
                      <span class="dz-idx mono">{k() + 1}</span>
                      <For each={[0, 1, 2]}>
                        {(c) => <ExprField compact label={AXES[c]} value={pt[c]} path={`${base()}.points[${k()}][${c}]`} onChange={(v) => set((q) => { (q as WirePrimitive).points[k()][c] = v; }, `p${k()}${c}`)} />}
                      </For>
                      <VertexRowActions i={props.i} j={props.j} k={k()} />
                    </div>
                  )}
                </For>
                <GroupIssue path={`${base()}.points`} />
                <button class="btn btn-ghost btn-sm" onClick={() => edit((d) => { const ps = (d.parts[props.i].primitives[props.j] as WirePrimitive).points; ps.push([...ps[ps.length - 1]] as Vec3); })}>
                  <Plus size={13} aria-hidden="true" /> {t("props.point")}
                </button>
              </fieldset>
              <p class="note">{t("props.wire.note")}</p>
            </>
          );
        })()}
      </Show>
      <Show when={pr().kind === "polyhedron"}>
        {(() => {
          const ph = () => pr() as PolyhedronPrimitive;
          const shown = () => ph().vertices.slice(0, 200);
          return (
            <>
              <p class="note">{t("props.polyhedron.summary", { vertices: ph().vertices.length, faces: ph().faces.length })}</p>
              <fieldset class="dz-vec">
                <legend class="dz-label">{t("props.polyhedron.vertices")} <span class="dz-unit">mm</span></legend>
                <For each={shown()}>
                  {(v, k) => (
                    <div class="dz-point dm-point3">
                      <span class="dz-idx mono">{k()}</span>
                      <For each={[0, 1, 2]}>{(c) => <span class="mono">{String(v[c])}</span>}</For>
                    </div>
                  )}
                </For>
                <Show when={ph().vertices.length > shown().length}><p class="note">{t("props.polyhedron.more", { n: ph().vertices.length - shown().length })}</p></Show>
              </fieldset>
              <p class="note">{t("props.polyhedron.note")}</p>
            </>
          );
        })()}
      </Show>
      <Show when={pr().kind === "polygon" || pr().kind === "linpoly"}>
        {(() => {
          const poly = () => pr() as Extract<DesignPrimitive, { kind: "polygon" | "linpoly" }>;
          return (
            <>
              <div class="dz-pair">
                <SelectField label={t("props.poly.normal")} value={poly().normal} options={AXES} onChange={(v) => set((q) => { (q as { normal: Axis }).normal = v; }, "normal")} />
                <ExprField label={t("props.poly.elevation", { axis: poly().normal })} unit="mm" value={poly().elevation} path={`${base()}.elevation`} onChange={(v) => set((q) => { (q as { elevation: Expr }).elevation = v; }, "elevation")} />
              </div>
              <Show when={pr().kind === "linpoly"}>
                <ExprField label={t("props.poly.extrusion", { axis: poly().normal })} unit="mm" value={(pr() as { length: Expr }).length} path={`${base()}.length`} onChange={(v) => set((q) => { (q as { length: Expr }).length = v; }, "length")} />
              </Show>
              <fieldset class="dz-vec">
                <legend class="dz-label">{t("props.points", { axes: planeAxes(poly().normal).join(", ") })} <span class="dz-unit">mm</span></legend>
                <VertexEditToggle i={props.i} j={props.j} />
                {(() => {
                  const points = () => poly().points;
                  const pages = () => Math.max(1, Math.ceil(points().length / pointPageSize));
                  const currentPage = () => Math.min(pointPage(), pages() - 1);
                  const start = () => currentPage() * pointPageSize;
                  const end = () => Math.min(start() + pointPageSize, points().length);
                  const goTo = (oneBased: number) => {
                    if (!Number.isFinite(oneBased)) return;
                    const index = Math.max(0, Math.min(points().length - 1, Math.floor(oneBased) - 1));
                    setPointPage(Math.floor(index / pointPageSize));
                  };
                  return <>
                    <div class="dm-point-pages" aria-label={t("props.points.pages")}>
                      <button type="button" class="btn btn-ghost btn-sm" disabled={currentPage() === 0} onClick={() => setPointPage(currentPage() - 1)}>{t("props.points.prev")}</button>
                      <span class="dm-point-range" aria-live="polite">{t("props.points.range", { range: points().length ? `${start() + 1}–${end()}` : "0", total: points().length })}</span>
                      <label class="dm-point-jump">{t("props.points.goTo")}
                        <NumberField class="rp-input dz-input mono" min="1" max={points().length} step="1" value={points().length ? start() + 1 : 1}
                          aria-label={t("props.points.goTo.label")} onChange={(e) => goTo(e.currentTarget.valueAsNumber)} onKeyDown={(e) => { if (e.key === "Enter") { goTo(e.currentTarget.valueAsNumber); e.currentTarget.blur(); } }} />
                      </label>
                      <button type="button" class="btn btn-ghost btn-sm" disabled={currentPage() >= pages() - 1} onClick={() => setPointPage(currentPage() + 1)}>{t("props.points.next")}</button>
                    </div>
                    <For each={points().slice(start(), end())}>
                  {(pt, localIndex) => {
                    const k = () => start() + localIndex();
                    return (
                    <div class="dz-point" classList={{ "is-picked": vertexPicked(k()) }} onFocusIn={() => pickRow(k())}>
                      <span class="dz-idx mono">{k() + 1}</span>
                      <ExprField compact label={planeAxes(poly().normal)[0]} value={pt[0]} path={`${base()}.points[${k()}][0]`} onChange={(v) => set((q) => { (q as { points: Expr[][] }).points[k()][0] = v; }, `p${k()}0`)} />
                      <ExprField compact label={planeAxes(poly().normal)[1]} value={pt[1]} path={`${base()}.points[${k()}][1]`} onChange={(v) => set((q) => { (q as { points: Expr[][] }).points[k()][1] = v; }, `p${k()}1`)} />
                      <VertexRowActions i={props.i} j={props.j} k={k()} />
                      <Show when={latestPickedPoint()}>{(point) =>
                        <button type="button" class="linklike" style={{ "grid-column": "2 / -1" }} aria-label={t("props.points.usePicked", { n: k() + 1 })} title={t("props.points.fill", { n: k() + 1, axes: planeAxes(poly().normal).join(", ") })}
                          onClick={() => set((q) => { (q as { points: Expr[][] }).points[k()] = planeAxes(poly().normal).map((a) => point().point[AXES.indexOf(a)]); }, `p${k()}`)}>
                          {t("props.usePicked")}
                        </button>
                      }</Show>
                    </div>
                  ); }}
                    </For>
                  </>;
                })()}
                <GroupIssue path={`${base()}.points`} />
                <button class="btn btn-ghost btn-sm" onClick={() => edit((d) => { const ps = (d.parts[props.i].primitives[props.j] as { points: Expr[][] }).points; ps.push([...ps[ps.length - 1]]); })}>
                  <Plus size={13} aria-hidden="true" /> {t("props.point")}
                </button>
              </fieldset>
            </>
          );
        })()}
      </Show>
      <GroupIssue path={base()} />
    </div>
  );
}

const WG_MODES = ["TE10", "TE20", "TE01", "TE11", "TE21", "TE30"];

/** Rectangular waveguide port fields: mode, a × b, the cut-off against the band, a fit button. */
function WaveguideFields(props: { i: number }) {
  const p = () => draft.ports[props.i];
  const base = () => `ports[${props.i}]`;
  const set = (fn: (q: (typeof draft.ports)[number]) => void, key: string) => edit((d) => fn(d.ports[props.i]), `${base()}.${key}`);
  const k = () => AXES.indexOf(p().direction);
  const across = () => planeAxes(p().direction);
  const cutoff = () => {
    const m = wgMode(p().mode ?? "TE10");
    const a = tryEvaluate(p().a, names().names).value, b = tryEvaluate(p().b, names().names).value;
    return m && a && b && a > 0 && b > 0 ? wgCutoffGHz(m[0], m[1], a, b) : null;
  };
  /** make the port box span a × b across the direction, from its start corner */
  const fit = () => set((q) => {
    const [u, v] = [(k() + 1) % 3, (k() + 2) % 3];
    q.stop[u] = typeof q.start[u] === "number" && typeof q.a === "number" ? q.start[u] + q.a : `${q.start[u]} + (${q.a})`;
    q.stop[v] = typeof q.start[v] === "number" && typeof q.b === "number" ? q.start[v] + q.b : `${q.start[v]} + (${q.b})`;
  }, "fit");
  const modes = () => (WG_MODES.includes(p().mode ?? "TE10") ? WG_MODES : [p().mode!, ...WG_MODES]);
  return (
    <>
      <div class="dz-pair">
        <ExprField label={t("props.wg.width", { axis: across()[0] })} unit="mm" value={p().a} path={`${base()}.a`} onChange={(v) => set((q) => { q.a = v; }, "a")} />
        <ExprField label={t("props.wg.height", { axis: across()[1] })} unit="mm" value={p().b} path={`${base()}.b`} onChange={(v) => set((q) => { q.b = v; }, "b")} />
      </div>
      <SelectField label={t("props.wg.mode")} id={fieldId(`${base()}.mode`)} value={p().mode ?? "TE10"} options={modes()} onChange={(v) => set((q) => { q.mode = v; }, "mode")} />
      <GroupIssue path={`${base()}.mode`} />
      <Show when={cutoff() !== null}>
        <p class="note">{t("props.wg.cutoff", { mode: p().mode ?? "TE10" })} <span class="mono">{fmt(cutoff()!)} GHz</span>. {t("props.wg.cutoffNote")}</p>
      </Show>
      <button class="linklike dm-fit" onClick={fit} title={t("props.wg.fit.title")}>{t("props.wg.fit")}</button>
    </>
  );
}

function PortInspector(props: { i: number }) {
  const p = () => draft.ports[props.i];
  const base = () => `ports[${props.i}]`;
  const set = (fn: (q: (typeof draft.ports)[number]) => void, key: string) => edit((d) => fn(d.ports[props.i]), `${base()}.${key}`);
  const numError = () => draft.ports.some((q, j) => j !== props.i && q.number === p().number) ? t("props.port.numberUnique") : undefined;
  const numberId = () => fieldId(`${base()}.number`);
  const wg = () => p().type === "waveguide";
  return (
    <div class="dz-form">
      <h3 class="dz-h">{t(wg() ? "props.port.titleWaveguide" : "props.port.titleLumped", { n: p().number })}</h3>
      <VecField label={t(wg() ? "props.port.startWaveguide" : "props.start")} value={p().start} path={`${base()}.start`} onChange={(k, v) => set((q) => { q.start[k] = v; }, `start${k}`)} onPicked={(v) => set((q) => { q.start = v; }, "start")} />
      <VecField label={t(wg() ? "props.port.stopWaveguide" : "props.stop")} value={p().stop} path={`${base()}.stop`} onChange={(k, v) => set((q) => { q.stop[k] = v; }, `stop${k}`)} onPicked={(v) => set((q) => { q.stop = v; }, "stop")} />
      <Show when={wg()}><WaveguideFields i={props.i} /></Show>
      <div class="seg seg-sm" role="radiogroup" aria-label={t("props.port.type")} onKeyDown={radioGroupKeys}>
        <button class="seg-btn" role="radio" aria-checked={!wg()} tabindex={wg() ? -1 : 0} onClick={() => setPortType(props.i, "lumped")}>{t("props.port.lumped")}</button>
        <button class="seg-btn" role="radio" aria-checked={wg()} disabled={!!p().group} title={p().group ? t("props.port.group.removeBeforeWaveguide") : undefined} tabindex={wg() ? 0 : -1} onClick={() => setPortType(props.i, "waveguide")}>{t("props.port.waveguide")}</button>
      </div>
      <div class="dz-pair">
        <label class="dz-field">
          <span class="dz-label">{t("props.port.number")}</span>
          <NumberField id={numberId()} class="rp-input dz-input mono" min="1" step="1" value={p().number} aria-invalid={!!numError()}
            aria-describedby={numError() ? `${numberId()}-error` : undefined}
            onInput={(e) => { const n = Math.max(1, Math.round(Number(e.currentTarget.value) || 1)); set((q) => { q.number = n; }, "number"); }} />
          <Show when={numError()}><span id={`${numberId()}-error`} class="dz-value dz-bad">{numError()}</span></Show>
        </label>
        <Show when={!wg()}>
          <ExprField label={t("props.port.impedance")} unit="Ω" value={p().R} path={`${base()}.R`} onChange={(v) => set((q) => { q.R = v; }, "R")} />
        </Show>
      </div>
      <Show when={!wg()}><label class="dz-check"><input type="checkbox" checked={!!p().reference_impedance} onChange={(e) => { const enabled = e.currentTarget.checked; set((q) => { if (enabled) q.reference_impedance = { real: 20, imag: -150 }; else delete q.reference_impedance; }, "reference_impedance"); }} />{t("feed.complexReference")}</label><Show when={p().reference_impedance}><ExprField label="Re Zref" unit="Ω" value={p().reference_impedance!.real} path={`${base()}.reference_impedance.real`} onChange={(v) => set((q) => { q.reference_impedance!.real = v; }, "reference_impedance.real")} /><ExprField label="Im Zref" unit="Ω" value={p().reference_impedance!.imag} path={`${base()}.reference_impedance.imag`} onChange={(v) => set((q) => { q.reference_impedance!.imag = v; }, "reference_impedance.imag")} /><p class="note">{t("feed.referenceNote")}</p></Show></Show>
      <label class="dz-check"><input id={fieldId(`${base()}.excite`)} type="checkbox" checked={p().excite !== false} onChange={(e) => { const c = e.currentTarget.checked; set((q) => { q.excite = c; }, "excite"); }} /> {t("props.port.excited")}</label>
      <SelectField label={t(wg() ? "props.port.propagation" : "props.port.current")} value={p().direction} options={AXES} onChange={(v) => set((q) => { q.direction = v; }, "direction")} />
      <Show when={!wg()}>
        <Show when={p().group}>
          <label class="dz-field"><span class="dz-label">{t("props.port.group.connection")}</span>
            <select class="rp-select dz-input" value={p().group!.connection} onChange={(e) => { const v = e.currentTarget.value as "parallel" | "series"; set((q) => { q.group!.connection = v; }, "group.connection"); }}>
              <option value="parallel">{t("props.port.group.parallel")}</option><option value="series">{t("props.port.group.series")}</option>
            </select>
          </label>
          <p class="note">{t("props.port.group.note")}</p>
          <For each={p().group?.members}>{(member, j) => {
            const path = () => `${base()}.group.members[${j()}]`;
            return <fieldset class="dz-vec">
              <legend class="dz-label">{t("props.port.group.feed", { n: j() + 2 })}</legend>
              <VecField label={t("props.start")} value={member.start} path={`${path()}.start`} onChange={(k, v) => set((q) => { q.group!.members[j()].start[k] = v; }, `group.members[${j()}].start${k}`)} onPicked={(v) => set((q) => { q.group!.members[j()].start = v; }, `group.members[${j()}].start`)} />
              <VecField label={t("props.stop")} value={member.stop} path={`${path()}.stop`} onChange={(k, v) => set((q) => { q.group!.members[j()].stop[k] = v; }, `group.members[${j()}].stop${k}`)} onPicked={(v) => set((q) => { q.group!.members[j()].stop = v; }, `group.members[${j()}].stop`)} />
              <SelectField label={t("props.port.current")} value={member.direction} options={AXES} onChange={(v) => set((q) => { q.group!.members[j()].direction = v; }, `group.members[${j()}].direction`)} />
              <SelectField label={t("props.port.group.polarity")} value={String(member.polarity ?? 1)} options={["1", "-1"]} onChange={(v) => set((q) => { q.group!.members[j()].polarity = Number(v) as 1 | -1; }, `group.members[${j()}].polarity`)} />
              <button class="btn btn-ghost btn-sm" onClick={() => set((q) => { q.group!.members.splice(j(), 1); if (!q.group!.members.length) delete q.group; }, `group.members[${j()}].remove`)}>{t("props.port.group.remove")}</button>
            </fieldset>;
          }}</For>
        </Show>
        <button class="btn btn-ghost btn-sm" disabled={(p().group?.members.length ?? 0) >= 15} onClick={() => set((q) => {
          q.group ??= { connection: "parallel", members: [] };
          q.group.members.push({ start: [...q.start], stop: [...q.stop], direction: q.direction, polarity: 1 });
        }, "group.add")}>{t("props.port.group.add")}</button>
      </Show>
      <p class="note">{t(wg() ? "props.port.noteWaveguide" : "props.port.noteLumped")}</p>
    </div>
  );
}

function ResistorInspector(props: { i: number }) {
  const r = () => draft.resistors[props.i];
  const base = () => `resistors[${props.i}]`;
  const nameError = () => {
    const n = r().name ?? "";
    if (!n.trim()) return t("props.error.noName");
    if (draft.resistors.some((q, j) => j !== props.i && q.name === n)) return t("props.error.usedTwice");
    return serverErrors()[`${base()}.name`];
  };
  const set = (fn: (q: (typeof draft.resistors)[number]) => void, key: string) => edit((d) => fn(d.resistors[props.i]), `${base()}.${key}`);
  return (
    <div class="dz-form">
      <h3 class="dz-h">{t("props.resistor")}</h3>
      <TextField label={t("props.resistor.name")} id={fieldId(`${base()}.name`)} mono value={r().name} error={nameError()} onChange={(v) => set((q) => { q.name = v; }, "name")} />
      <VecField label={t("props.start")} value={r().start} path={`${base()}.start`} onChange={(k, v) => set((q) => { q.start[k] = v; }, `start${k}`)} onPicked={(v) => set((q) => { q.start = v; }, "start")} />
      <VecField label={t("props.stop")} value={r().stop} path={`${base()}.stop`} onChange={(k, v) => set((q) => { q.stop[k] = v; }, `stop${k}`)} onPicked={(v) => set((q) => { q.stop = v; }, "stop")} />
      <p class="note">{t("feed.rlcNote")}</p><Show when={r().topology === "series" && (r().L !== undefined || r().C !== undefined)}><p class="note" role="note">{t("feed.seriesLimitation")}</p></Show>
      <For each={["R", "L", "C"] as const}>{(key) => <label class="dz-field"><span class="dz-label">{key} ({key === "R" ? "Ω" : key === "L" ? "H" : "F"})</span><input autocomplete="off" placeholder={key === "L" ? "1e-9 (1 nH)" : key === "C" ? "1e-12 (1 pF)" : undefined} class="rp-input dz-input mono" value={r()[key] ?? ""} onChange={(e) => { const v = e.currentTarget.value.trim(); set((q) => { if (v) q[key] = v; else delete q[key]; }, key); }} /></label>}</For>
      <label class="dz-field"><span class="dz-label">{t("feed.topology")}</span><select class="rp-input" value={r().topology ?? "parallel"} onChange={(e) => { const v = e.currentTarget.value as "parallel" | "series"; set((q) => { q.topology = v; }, "topology"); }}><option value="parallel">{t("feed.parallel")}</option><option value="series">{t("feed.series")}</option></select></label>
      <SelectField label={t("props.direction")} value={r().direction} options={AXES} onChange={(v) => set((q) => { q.direction = v; }, "direction")} />
    </div>
  );
}

function SimulationInspector() {
  const s = () => draft.simulation;
  const bounds = () => (typeof s().boundaries === "string" ? Array(6).fill(s().boundaries) : (s().boundaries as string[]));
  const allSame = () => bounds().every((b) => b === bounds()[0]);
  const setB = (k: number, v: string) => edit((d) => {
    const b = typeof d.simulation.boundaries === "string" ? Array(6).fill(d.simulation.boundaries) : [...d.simulation.boundaries];
    b[k] = v;
    d.simulation.boundaries = b.every((x) => x === b[0]) ? b[0] : b;
  }, `boundaries${k}`);
  const freqs = () => (draft.far_field.frequencies ?? []).map(String).join(", ");
  const frequencyIssues = () => (draft.far_field.frequencies ?? []).map((_, k) => ({
    issue: issues()[`far_field.frequencies[${k}]`],
    id: `${fieldId(`far_field.frequencies[${k}]`)}-message`,
  })).filter((item) => !!item.issue);
  // the text as typed while the field has focus (re-joining the list on every key ate the commas)
  const [freqText, setFreqText] = createSignal<string | null>(null);
  return (
    <div class="dz-form">
      <h3 class="dz-h">{t("props.sim")}</h3>
      <button class="btn btn-ghost btn-sm" onClick={() => setSimSettingsOpen(true)}>{t("props.sim.open")}</button>
      <div class="dz-pair">
        <ExprField label="f min" unit="GHz" value={s().f_min} path="simulation.f_min" onChange={(v) => edit((d) => { d.simulation.f_min = v; }, "fmin")} />
        <ExprField label="f max" unit="GHz" value={s().f_max} path="simulation.f_max" onChange={(v) => edit((d) => { d.simulation.f_max = v; }, "fmax")} />
      </div>
      <fieldset class="dz-vec">
        <legend class="dz-label">{t("props.sim.boundaries")}</legend>
        <div class="cluster-sm">
          <For each={BOUNDARIES}>{(b) => (
            <button class="btn btn-ghost btn-sm" aria-pressed={allSame() && bounds()[0] === b} onClick={() => edit((d) => { d.simulation.boundaries = b; }, "boundaries")}>{t("props.sim.allBoundaries", { b })}</button>
          )}</For>
        </div>
        <div class="dz-bounds">
          <For each={SIDES}>{(side, k) => (
            <label class="dz-field dz-compact"><span class="dz-label">{side}</span>
              <select class="rp-select dz-input" value={bounds()[k()]} onChange={(e) => setB(k(), e.currentTarget.value)}>
                <For each={BOUNDARIES}>{(b) => <option value={b}>{b}</option>}</For>
              </select>
            </label>
          )}</For>
        </div>
      </fieldset>
      <label class="dz-field">
        <span class="dz-label">{t("props.sim.end")} <span class="dz-unit">dB</span></span>
        <NumberField class="rp-input dz-input mono" max="-10" step="5" value={s().end_criteria_db ?? -60}
          onInput={(e) => { const v = Number(e.currentTarget.value); edit((d) => { d.simulation.end_criteria_db = v; }, "end"); }} />
      </label>
      <h4 class="dz-h4">{t("props.sim.mesh")}</h4>
      <Show when={!draft.mesh.mode || draft.mesh.mode === "auto"}>
      <ExprField label={t("props.sim.cpw")} value={draft.mesh.cells_per_wavelength} path="mesh.cells_per_wavelength" onChange={(v) => edit((d) => { d.mesh.cells_per_wavelength = v; }, "cpw")} />
      <InspectorAdvanced>
      <label class="dz-field dz-compact"><span class="dz-label">{t("props.sim.edgeRule")}</span><select class="rp-select dz-input" value={draft.mesh.edge_rule ?? "thirds"} onChange={(e) => edit((d) => { d.mesh.edge_rule = e.currentTarget.value === "edge" ? "edge" : undefined; }, "edge-rule")}><option value="thirds">{t("props.sim.edgeRule.thirds")}</option><option value="edge">{t("props.sim.edgeRule.edge")}</option></select></label>
      <ExprField compact label={t("props.sim.maxRatio")} value={draft.mesh.max_ratio ?? 1.4} path="mesh.max_ratio" onChange={(v) => edit((d) => { d.mesh.max_ratio = v === 1.4 ? undefined : v; }, "max-ratio")} />
      <ExprField compact optional label={t("props.sim.airCpw")} value={draft.mesh.air_cells_per_wavelength ?? ""} path="mesh.air_cells_per_wavelength" onChange={(v) => edit((d) => { d.mesh.air_cells_per_wavelength = v === "" ? null : v; }, "air-cpw")} />
      </InspectorAdvanced>
      <ExprField optional label={t("props.sim.pad")} unit="mm" value={draft.mesh.pad ?? ""} path="mesh.pad" onChange={(v) => edit((d) => { d.mesh.pad = v === "" ? null : v; }, "pad")} />
      </Show>
      <Show when={draft.mesh.mode === "manual"}><p class="note">{t("props.sim.manualLines", { x: draft.mesh.lines?.x.length ?? 0, y: draft.mesh.lines?.y.length ?? 0, z: draft.mesh.lines?.z.length ?? 0 })}</p><button class="btn btn-ghost btn-sm" onClick={() => { setSimSettingsSection("mesh"); setSimSettingsOpen(true); }}>{t("props.sim.toAuto")}</button></Show>
      <Show when={draft.mesh.mode === "design"}><button class="btn btn-ghost btn-sm" onClick={() => { setSimSettingsSection("mesh"); setSimSettingsOpen(true); }}>{t("props.sim.autoSettings")}</button></Show>
      <h4 class="dz-h4">{t("props.sim.farField")}</h4>
      <label class="dz-check"><input type="checkbox" checked={draft.far_field.enabled} onChange={(e) => { const c = e.currentTarget.checked; edit((d) => { d.far_field.enabled = c; }, "ff"); }} /> {t("props.sim.farField.compute")}</label>
      <Show when={draft.far_field.enabled}>
        <VecField label={t("props.sim.phaseCenter")} value={draft.far_field.phase_center ?? ["", "", ""]} path="far_field.phase_center" onChange={(k, v) => edit((d) => { const p = d.far_field.phase_center ?? [0, 0, 0]; p[k] = v; d.far_field.phase_center = p; }, `phase-center-${k}`)} />
        <TextField label={t("props.sim.frequencies")} mono value={freqText() ?? freqs()} id={fieldId("far_field.frequencies")}
          describedBy={frequencyIssues().map((item) => item.id).join(" ") || undefined}
          invalid={frequencyIssues().some((item) => item.issue?.severity === "error")}
          onBlur={() => setFreqText(null)}
          onChange={(v) => { setFreqText(v); edit((d) => { const list = v.split(",").map((x) => x.trim()).filter(Boolean).map(toExpr); d.far_field.frequencies = list; }, "fff"); }} />
        <For each={draft.far_field.frequencies ?? []}>{(_, k) => <GroupIssue path={`far_field.frequencies[${k()}]`} />}</For>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------------ checks

/** A check's severity in words: part of each row's accessible name, not only its icon and colour. */
const SEVERITY: Record<Check["severity"], string> = { error: "props.checks.severity.error", warning: "props.checks.severity.warning", info: "props.checks.severity.info" };

/** Where a check points, in words: "patch › Brick 1 › stop z", "Parameter W (expression)". */
export function checkPlace(c: Check): string {
  return pathText(c.path, draft, kindLabel);
}

/** The solid (its index + 1, so that 0 is "none") whose Boolean history holds the field a check
 * points at ("parts[2].booleanHistory.B.primitives[0].start[0]"), else 0. */
const booleanOperandOwner = (path: string) => {
  const m = /^parts\[(\d+)\]\.booleanHistory\./.exec(path);
  return m && draft.parts[Number(m[1])]?.booleanHistory ? Number(m[1]) + 1 : 0;
};

/** The Checks list: expand an explanation and frame geometry; Edit field moves focus to its input
 * (Restore operands for a value kept in a Boolean history). */
export function ChecksList() {
  const [open, setOpen] = createSignal(true);
  const [expanded, setExpanded] = createSignal<string | null>(null);
  const key = (c: Check) => `${c.code}:${c.path}`;
  const pathOf = (k: string) => k.slice(k.indexOf(":") + 1);
  // While a value is typed its check can turn into another one at the same field for a keystroke
  // (R = -5 → "-" is an expression error → -7): the explanation stays open for that field, on the
  // same check when it is back, else on the field's first check. It closes when the field is clean.
  const isOpen = (c: Check) => {
    const e = expanded();
    if (!e) return false;
    if (e === key(c)) return true;
    return pathOf(e) === c.path && !checks().some((x) => key(x) === e) && checks().find((x) => x.path === c.path) === c;
  };
  createEffect(() => { const e = expanded(); if (e && !checks().some((c) => c.path === pathOf(e))) setExpanded(null); });
  const errs = () => checks().filter((c) => c.severity === "error").length;
  const warns = () => checks().filter((c) => c.severity === "warning").length;
  const notes = () => checks().length - errs() - warns();
  return (
    <section class="dz-checks" aria-label={t("props.checks")}>
      <button class="dz-checks-head" aria-expanded={open()} onClick={() => setOpen(!open())}>
        <Show when={errs() + warns()} fallback={<><CircleCheck size={14} aria-hidden="true" class="dz-ok-icon" /> <span>{t("props.checks.none")}{notes() ? ` · ${t("status.checks.notes", { count: notes() })}` : ""}</span></>}>
          <Show when={errs()}><CircleAlert size={14} aria-hidden="true" class="dz-bad-icon" /></Show>
          <Show when={!errs()}><TriangleAlert size={14} aria-hidden="true" class="dz-warn-icon" /></Show>
          <span>{t("props.checks.summary", { list: [errs() ? t("status.checks.errors", { count: errs() }) : "", warns() ? t("status.checks.warnings", { count: warns() }) : ""].filter(Boolean).join(", ") })}</span>
          <Show when={errs()}><span class="muted"> · {t("props.checks.fixToRun")}</span></Show>
        </Show>
      </button>
      <Show when={open() && checks().length}>
        <ul class="dz-check-list">
          <For each={checks()}>
            {(c) => {
              const id = createUniqueId();
              const active = () => isOpen(c);
              const spatial = () => /^(parts|ports|resistors)\[\d+\]/.test(c.path);
              const show = () => focusPath(c.path, { frame: true, focus: false });
              return (
              <li>
                <button class="dz-check-item" classList={{ "dz-check-error": c.severity === "error", "dz-check-warning": c.severity === "warning", "dz-check-info": c.severity === "info" }}
                  aria-expanded={active()} aria-controls={id}
                  onClick={() => { const next = !active(); setExpanded(next ? key(c) : null); if (next && spatial()) show(); }}>
                  {c.severity === "error" ? <CircleAlert size={13} aria-hidden="true" /> : c.severity === "info" ? <Info size={13} aria-hidden="true" /> : <TriangleAlert size={13} aria-hidden="true" />}
                  <span class="visually-hidden">{t(SEVERITY[c.severity])}: </span>
                  <span class="dz-check-msg">{checkTitle(c)}</span>
                  <span class="dz-check-where mono">{checkPlace(c)}</span>
                </button>
                <div id={id} hidden={!active()} class="dz-check-detail">
                  <p>{checkExplain(c)}</p>
                  <div class="cluster-sm">
                    <Show when={c.fix}>{(f) => <button class="btn btn-ghost btn-sm" onClick={() => applyFix(f().set)}>{checkFixLabel(c)}</button>}</Show>
                    <Show when={checkAction(c, draft.ports?.length ?? 0)}><button class="btn btn-ghost btn-sm" onClick={() => addPort()}>{t("contextMenu.addPort")}</button></Show>
                    <Show when={spatial()}><button class="btn btn-ghost btn-sm" onClick={show}>{t("props.checks.show3d")}</button></Show>
                    {/* a value inside a Boolean result's kept operands has no field of its own: the operands are restored to edit it */}
                    <Show when={booleanOperandOwner(c.path)} keyed fallback={<button class="btn btn-ghost btn-sm" onClick={() => focusPath(c.path)}>{t("props.checks.editField")}</button>}>
                      {(i) => <button class="btn btn-ghost btn-sm" title={t("props.checks.restoreOperandsTitle")} onClick={() => restoreBooleanPart(i - 1)}>{t("boolean.restore")}</button>}
                    </Show>
                  </div>
                </div>
              </li>
            ); }}
          </For>
        </ul>
      </Show>
    </section>
  );
}

export function Inspector() {
  // re-created when the selection changes (or its item appears/disappears), not on every edit
  const view = () => {
    const s = selection();
    switch (s.type) {
      case "param": return draft.params[s.i] ? <ParamInspector i={s.i} /> : null;
      case "material": return draft.materials[s.i] ? <MaterialInspector i={s.i} /> : null;
      case "part": return draft.parts[s.i] ? <PartInspector i={s.i} /> : null;
      case "primitive": return draft.parts[s.i]?.primitives[s.j] ? <PartInspector i={s.i} j={s.j} /> : null;
      case "port": return draft.ports[s.i] ? <PortInspector i={s.i} /> : null;
      case "resistor": return draft.resistors[s.i] ? <ResistorInspector i={s.i} /> : null;
      case "simulation": return <SimulationInspector />;
      case "optimization": return <OptimizationInspector id={s.id} />;
      default: { const run = resultFocus()?.file; return run ? <RunInspector file={run} /> : <DesignInspector />; }
    }
  };
  return <section class="dz-inspector" data-region="properties" aria-label={t("props.label")}>{view()}</section>;
}
