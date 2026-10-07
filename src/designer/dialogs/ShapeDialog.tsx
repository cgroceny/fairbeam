// Shape dialogs ("Brick", "Cylinder", "Sphere", "Polygon", "Cone", "Torus", "Wire"):
// opened when a draw tool finishes (prefilled with what was drawn) or from the ribbon's Shapes
// buttons (defaults on the work plane). Every value takes an expression; the 3D view outlines the
// shape as it is edited. OK adds it in one undo step, into a new part or an existing one; Cancel
// adds nothing.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Plus, Trash2, X } from "lucide-solid";
import type { Axis, AxisCylinder, ConePrimitive, DesignPrimitive, Expr, TorusPrimitive, Vec3, WirePrimitive } from "../types";
import { draft, names } from "../store";
import { isReservedName } from "../../lib/legacy";
import { fmt, tryEvaluate } from "../expr";
import { ExprField, SelectField } from "../DesignPane";
import { insertShape, NEW_METAL, newPartName, planeAxes, setGhost, setShapeRequest, shapeRequest, type ShapeRequest } from "../draw";
import { discSegments, quickBundle } from "../geometry";
import { setPreviewGeometry } from "../transforms";
import { checkedShapeProblems, defaultShapeMaterial, rememberShapeMaterial } from "./shapes";
import { latestPickedPoint } from "../pointTools";
import { hasKey, t, decimalComma } from "../../i18n";
import { validateLocalFrame, wcsAxisName, worldToLocalPoint } from "../localFrame";
import "../../styles/designer-ux.css";

const AXES: Axis[] = ["x", "y", "z"];
/** title keys by kind (an extruded polygon gets its own title from the dialog) */
const TITLES: Record<DesignPrimitive["kind"], string> = { box: "shape.title.box", cylinder: "shape.title.cylinder", sphere: "shape.title.sphere", polygon: "shape.title.polygon", linpoly: "shape.title.polygon", cone: "shape.title.cone", torus: "shape.title.torus", wire: "shape.title.wire", polyhedron: "shape.title.polyhedron" };
const PLANES: { value: Axis; label: string }[] = [{ value: "z", label: "xy (normal z)" }, { value: "x", label: "yz (normal x)" }, { value: "y", label: "zx (normal y)" }];

/** The dialog for the pending shape request, if any (rendered once by the designer workspace). */
export function ShapeDialogHost() {
  return <Show when={shapeRequest()} keyed>{(req) => <ShapeDialog req={req} onClose={() => setShapeRequest(null)} />}</Show>;
}

/** Everything the dialog edits, in one store: polygons carry their extrusion (0: a sheet). */
type Editable = DesignPrimitive & { length?: Expr };

function ShapeDialog(props: { req: ShapeRequest; onClose: () => void }) {
  let box: HTMLDivElement | undefined;
  // Creation stays nonmodal so the viewport can orbit, pan and zoom beside the form.
  onMount(() => {
    const opener = document.activeElement as HTMLElement | null;
    box?.querySelector<HTMLInputElement>(".sd-geom input")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); props.onClose(); }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      // A Shapes-menu item is removed before this modeless dialog mounts. Return to the
      // canvas when the opener has gone, but preserve focus deliberately moved elsewhere.
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected && !box?.contains(active)) return;
        const target = opener && opener !== document.body && opener.isConnected &&
          !opener.matches(":disabled") && opener.getClientRects().length
          ? opener : document.querySelector<HTMLElement>(".viewport");
        target?.focus({ preventScroll: true });
      });
    });
  });
  const start = structuredClone(props.req.prim) as Editable;
  if (start.kind === "polygon") start.length = 0;
  const [p, setP] = createStore<Editable>(start);
  const set = (fn: (q: Editable) => void) => setP(produce(fn));
  const framed = () => !!props.req.frameTransforms?.length;
  /** Axis names: u, v, w while the shape is drawn in a local WCS, else x, y, z. The dialog's own
   * coordinates are those of the WCS (the saved part carries the transforms to the global ones). */
  const L = (a: Axis, upper = true): string => { const n = props.req.frameNormal; return n ? wcsAxisName(a, n, upper) : upper ? a.toUpperCase() : a; };
  const axisOptions = () => AXES.map((a) => ({ value: a, label: L(a, false) }));
  const planeOptions = () => PLANES.map((o) => ({ value: o.value, label: props.req.frameNormal ? `${planeAxes(o.value).map((a) => L(a, false)).join("")} (${t("shape.normalAlong")} ${L(o.value, false)})` : o.label }));
  const frameValid = () => !framed() || (!!props.req.frame && !!props.req.frameNormal && validateLocalFrame(props.req.frame, names().names));
  const [into, setInto] = createSignal(framed() ? -1 : props.req.into);
  const [name, setName] = createSignal(newPartName(props.req.prim.kind));
  const [material, setMaterial] = createSignal(defaultShapeMaterial(NEW_METAL));
  const [tried, setTried] = createSignal(false);
  const kind = props.req.prim.kind;
  const isPoly = kind === "polygon" || kind === "linpoly";
  const val = (e: Expr | undefined) => tryEvaluate(e, names().names).value;
  const pickedLocal = (point: [number, number, number]): [number, number, number] | null => {
    if (!props.req.frame || !props.req.frameNormal) return point;
    if (!frameValid()) return null;
    try { return worldToLocalPoint(props.req.frameNormal, point, props.req.frame, names().names); }
    catch { return null; }
  };

  /** the shape as it would be added (a polygon with a non-zero extrusion is an extruded one) */
  const result = createMemo((): DesignPrimitive => {
    const q = JSON.parse(JSON.stringify(p)) as Editable; // a plain copy that tracks every nested field
    if (isPoly) {
      const len = q.length ?? 0;
      const flat = val(len) === 0 || len === "";
      const { length: _, ...rest } = q as Editable & { length?: Expr };
      return flat ? { ...(rest as object), kind: "polygon" } as DesignPrimitive : { ...(rest as object), kind: "linpoly", length: len } as DesignPrimitive;
    }
    return q;
  });
  // The draw overlay outlines bricks, cylinders, spheres and polygons; cones, tori and wires use the
  // dashed dialog outline of the transform tools (resolved like the instant preview).
  const resolved = kind === "cone" || kind === "torus" || kind === "wire";
  createEffect(() => {
    if (!resolved) return setGhost(result(), props.req.frameTransforms ?? []);
    // resolving a cone, torus or wire is heavier than outlining a brick: rebuild once typing pauses (~150 ms)
    const shape = result();
    const timer = setTimeout(() => untrack(() => {
      const b = quickBundle({ ...draft, ports: [], resistors: [], parts: [{ name: "__shape", material: draft.materials[0]?.name ?? "", primitives: [shape], transforms: props.req.frameTransforms }] }, names().names, null);
      setPreviewGeometry(b?.parts[0]?.primitives ?? []);
    }), 150);
    onCleanup(() => clearTimeout(timer));
  });
  onCleanup(() => { setGhost(null); if (resolved) setPreviewGeometry([]); });

  const exprs = (): Expr[] => {
    const q = result();
    if (q.kind === "box") return [...q.start, ...q.stop];
    if (q.kind === "cylinder" && "axis" in q) return [...q.center, q.radius, q.inner_radius ?? 0, ...q.range];
    if (q.kind === "sphere") return [...q.center, q.radius];
    if (q.kind === "polygon" || q.kind === "linpoly") return [q.elevation, ...(q.kind === "linpoly" ? [q.length] : []), ...q.points.flat()];
    if (q.kind === "cone") return [...q.center, q.bottom_radius, q.top_radius, ...q.range];
    if (q.kind === "torus") return [...q.center, q.major_radius, q.minor_radius];
    if (q.kind === "wire") return [q.radius, ...q.points.flat()];
    return [];
  };
  // a name the tree already shows (another solid's name or label) would make two rows alike
  const nameTaken = () => into() < 0 && draft.parts.some((x) => x.name === name().trim() || x.label === name().trim());
  /** what keeps OK from adding the shape */
  const problems = createMemo((): string[] => {
    const out: string[] = [];
    if (!frameValid()) out.push(t("draw.localFrame.invalid"));
    if (exprs().some((e) => val(e) === undefined)) out.push(t("shape.problem.noEval"));
    const q = result();
    if (into() < 0) {
      const n = name().trim();
      if (!n) out.push(t("shape.problem.nameRequired"));
      else if (isReservedName(n)) out.push(t("shape.problem.reservedName"));
      else if (nameTaken()) out.push(t("shape.problem.nameTaken", { name: n }));
    }
    if (q.kind === "box") {
      AXES.forEach((a, k) => {
        const lo = val(q.start[k]), hi = val(q.stop[k]);
        if (lo !== undefined && hi !== undefined && lo > hi) out.push(t("shape.problem.minAboveMax", { axis: L(a) }));
      });
      const flat = AXES.filter((_, k) => val(q.start[k]) === val(q.stop[k])).length;
      if (flat > 1) out.push(t("shape.problem.brickFlat"));
    } else if (q.kind === "cylinder" && "axis" in q) {
      const r = val(q.radius), ri = val(q.inner_radius ?? 0), [lo, hi] = q.range.map(val);
      // the inner radius is measured against a valid outer one: with the outer radius at 0 or below,
      // only that is said (any inner radius would also be "not below the outer radius")
      if (r !== undefined && r <= 0) out.push(t("shape.problem.outerRadius"));
      else if (r !== undefined && ri !== undefined && (ri < 0 || ri >= r)) out.push(t("shape.problem.innerRadius"));
      // equal ends are fine: a flat circle (a disc or ring), built as a polygon sheet
      if (lo !== undefined && hi !== undefined && lo > hi) out.push(t("shape.problem.minBelowMax", { axis: L(q.axis) }));
    } else if (q.kind === "sphere") {
      const r = val(q.radius);
      if (r !== undefined && r <= 0) out.push(t("shape.problem.radius"));
    } else if (q.kind === "polygon" || q.kind === "linpoly") {
      if (q.points.length < 3) out.push(t("shape.problem.polygonPoints"));
    }
    // polygon topology, cone, torus and wire geometry: the same checks the Checks list runs after OK
    out.push(...checkedShapeProblems(q).filter((m) => !out.includes(m)));
    return out;
  });
  /** a circle of zero length (a drawn one at WCS height 0, or Min = Max typed here): a flat circle, built as a polygon sheet */
  const flatCircle = () => {
    const q = result();
    if (q.kind !== "cylinder" || !("axis" in q)) return null;
    const [lo, hi, r] = [val(q.range[0]), val(q.range[1]), val(q.radius)];
    return lo !== undefined && hi !== undefined && r !== undefined && Math.abs(hi - lo) < 1e-9 && r > 0 ? discSegments(r) : null;
  };

  const submit = (e: Event) => {
    e.preventDefault();
    setTried(true);
    if (problems().length) return;
    const targetInto = framed() ? -1 : into();
    insertShape(structuredClone(result()), { into: targetInto, name: name().trim(), material: material(), transforms: props.req.frameTransforms });
    if (targetInto < 0) rememberShapeMaterial(material());
    props.onClose();
  };

  const target = () => (into() >= 0 ? draft.parts[into()] : null);
  const hasMetal = () => draft.materials.some((m) => m.kind === "metal");
  const title = () => t(isPoly && result().kind === "linpoly" ? "shape.title.linpoly" : TITLES[kind]);
  const kindLabel = (k: string) => (hasKey(`shape.materialKind.${k}`) ? t(`shape.materialKind.${k}`) : k);

  return (
    <div class="scrim sd-scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="dialog dialog-sm sd" role="dialog" aria-labelledby="sd-title" ref={box} tabindex={-1}>
        <div class="dialog-head">
          <div>
            <h2 id="sd-title">{title()}</h2>
            <p class="muted">{props.req.drawn ? t("shape.intro.drawn") : t("shape.intro.typed")} {t("shape.intro.expr")} <span class="mono">W/2</span>.</p>
          </div>
          <button class="icon-btn" onClick={props.onClose} aria-label={t("common.close")} data-noprompt><X size={16} /></button>
        </div>
        <form class="sd-body" id="sd-form" onSubmit={submit} novalidate>
          <Show when={framed() && !frameValid() && !tried()}><p class="note dz-bad" role="alert">{t("draw.localFrame.invalid")}</p></Show>
          <div class="sd-row">
            <label class="dz-field">
              <span class="dz-label">{t("shape.solid")}</span>
              <select class="rp-select dz-input" value={String(into())} disabled={framed()} onChange={(e) => setInto(Number(e.currentTarget.value))}>
                <option value="-1">{t("shape.newPart")}</option>
                <For each={draft.parts}>{(part, i) => <option value={String(i())}>{t("shape.addTo", { name: part.label || part.name })}</option>}</For>
              </select>
            </label>
            <label class="dz-field">
              <span class="dz-label">{t("shape.name")}</span>
              <input autocomplete="off" class="rp-input dz-input mono" type="text" spellcheck={false} value={into() >= 0 ? target()?.label || target()?.name || "" : name()} disabled={into() >= 0}
                aria-invalid={tried() && into() < 0 && (!name().trim() || nameTaken())} onInput={(e) => setName(e.currentTarget.value)} />
            </label>
            <label class="dz-field">
              <span class="dz-label">{t("shape.material")}</span>
              <Show when={into() < 0} fallback={<select class="rp-select dz-input" disabled><option>{target()?.material}</option></select>}>
                <select class="rp-select dz-input" value={material()} onChange={(e) => setMaterial(e.currentTarget.value)}>
                  <Show when={!hasMetal()}><option value={NEW_METAL}>{t("shape.newMetal")}</option></Show>
                  <For each={draft.materials}>{(m) => <option value={m.name}>{m.name} ({kindLabel(m.kind)})</option>}</For>
                </select>
              </Show>
            </label>
          </div>
          <Show when={into() >= 0}><p class="note sd-note">{t("shape.joinNote", { name: target()?.name ?? "" })}</p></Show>
          <Show when={framed()}><p class="note sd-note">{t("shape.intro.frameNewPart")}</p></Show>
          <Show when={props.req.frameNormal}><p class="note sd-note">{t("shape.wcsNote")}</p></Show>
          <Show when={flatCircle()}>{(sides) => <p class="note">{t("shape.radiusLengthNote", { axis: L((p as unknown as AxisCylinder).axis), sides: sides() })}</p>}</Show>

          <div class="sd-geom">
            <Show when={p.kind === "box"}>
              {(() => {
                const b = () => p as unknown as { start: Vec3; stop: Vec3 };
                const picked = latestPickedPoint;
                return (
                  <>
                  <Show when={picked()}>{(point) => <div class="dz-vec-row">
                    <button type="button" class="linklike" onClick={() => { const local = pickedLocal(point().point); if (local) set((q) => { (q as { start: Vec3 }).start = [...local] as Vec3; }); }}>{t("shape.useMinCorner")}</button>
                    <button type="button" class="linklike" onClick={() => { const local = pickedLocal(point().point); if (local) set((q) => { (q as { stop: Vec3 }).stop = [...local] as Vec3; }); }}>{t("shape.useMaxCorner")}</button>
                  </div>}</Show>
                  <div class="dz-ranges">
                    <For each={AXES}>{(a, k) => (
                      <>
                        <ExprField compact label={`${L(a)}min`} unit="mm" value={b().start[k()]} path={`__shape.start[${k()}]`}
                          onChange={(v) => set((q) => { (q as { start: Vec3 }).start[k()] = v; })} />
                        <ExprField compact label={`${L(a)}max`} unit="mm" value={b().stop[k()]} path={`__shape.stop[${k()}]`}
                          onChange={(v) => set((q) => { (q as { stop: Vec3 }).stop[k()] = v; })} />
                      </>
                    )}</For>
                  </div>
                  </>
                );
              })()}
            </Show>
            <Show when={p.kind === "cylinder" && "axis" in p}>
              {(() => {
                const c = () => p as unknown as AxisCylinder;
                const picked = latestPickedPoint;
                return (
                  <>
                    <SelectField label={t("shape.axis")} value={c().axis} options={axisOptions()} onChange={(v) => set((q) => { (q as AxisCylinder).axis = v; })} />
                    <div class="dz-pair">
                      <For each={[0, 1]}>{(k) => (
                        <ExprField label={t("shape.centre", { axis: L(planeAxes(c().axis)[k]) })} unit="mm" value={c().center[k]} path={`__shape.center[${k}]`}
                          onChange={(v) => set((q) => { (q as AxisCylinder).center[k] = v; })} />
                      )}</For>
                    </div>
                    <Show when={picked()}>{(point) => <div class="dz-vec-row">
                      <button type="button" class="linklike"
                          onClick={() => { const local = pickedLocal(point().point); if (local) set((q) => { (q as AxisCylinder).center = planeAxes(c().axis).map((a) => local[AXES.indexOf(a)]) as [Expr, Expr]; }); }}>
                          {t("shape.useCenter")}
                      </button>
                      <button type="button" class="linklike"
                          onClick={() => { const local = pickedLocal(point().point); if (local) set((q) => { (q as AxisCylinder).range[0] = local[AXES.indexOf(c().axis)]; }); }}>
                          {t("shape.useFor", { field: `${L(c().axis)}min` })}
                      </button>
                      <button type="button" class="linklike"
                          onClick={() => { const local = pickedLocal(point().point); if (local) set((q) => { (q as AxisCylinder).range[1] = local[AXES.indexOf(c().axis)]; }); }}>
                          {t("shape.useFor", { field: `${L(c().axis)}max` })}
                      </button>
                    </div>}</Show>
                    <div class="dz-pair">
                      <ExprField label={t("shape.outerRadius")} unit="mm" value={c().radius} path="__shape.radius" onChange={(v) => set((q) => { (q as AxisCylinder).radius = v; })} />
                      <ExprField label={t("shape.innerRadius")} unit="mm" value={c().inner_radius ?? 0} path="__shape.inner_radius"
                        onChange={(v) => set((q) => { (q as AxisCylinder).inner_radius = v; })} />
                    </div>
                    <div class="dz-pair">
                      <ExprField label={`${L(c().axis)}min`} unit="mm" value={c().range[0]} path="__shape.range[0]" onChange={(v) => set((q) => { (q as AxisCylinder).range[0] = v; })} />
                      <ExprField label={`${L(c().axis)}max`} unit="mm" value={c().range[1]} path="__shape.range[1]" onChange={(v) => set((q) => { (q as AxisCylinder).range[1] = v; })} />
                    </div>
                  </>
                );
              })()}
            </Show>
            <Show when={p.kind === "sphere"}>
              {(() => {
                const s = () => p as unknown as { center: Vec3; radius: Expr };
                const picked = latestPickedPoint;
                return (
                  <>
                    <Show when={picked()}>{(point) =>
                      <button type="button" class="linklike"
                        onClick={() => { const local = pickedLocal(point().point); if (local) set((q) => { (q as { center: Vec3 }).center = [...local] as Vec3; }); }}>
                        {t("shape.useCenter")}
                      </button>
                    }</Show>
                    <div class="dz-vec-row sd-three">
                      <For each={AXES}>{(a, k) => (
                        <ExprField compact label={t("shape.centre", { axis: L(a) })} unit="mm" value={s().center[k()]} path={`__shape.center[${k()}]`}
                          onChange={(v) => set((q) => { (q as { center: Vec3 }).center[k()] = v; })} />
                      )}</For>
                    </div>
                    <ExprField label={t("shape.radius")} unit="mm" value={s().radius} path="__shape.radius" onChange={(v) => set((q) => { (q as { radius: Expr }).radius = v; })} />
                  </>
                );
              })()}
            </Show>
            <Show when={p.kind === "cone"}>
              {(() => {
                const c = () => p as unknown as ConePrimitive;
                const upd = (fn: (q: ConePrimitive) => void) => set((q) => fn(q as ConePrimitive));
                return (
                  <>
                    <SelectField label={t("shape.axis")} value={c().axis} options={axisOptions()} onChange={(v) => upd((q) => { q.axis = v; })} />
                    <div class="dz-pair">
                      <For each={[0, 1]}>{(k) => (
                        <ExprField label={t("shape.centre", { axis: L(planeAxes(c().axis)[k]) })} unit="mm" value={c().center[k]} path={`__shape.center[${k}]`}
                          onChange={(v) => upd((q) => { q.center[k] = v; })} />
                      )}</For>
                    </div>
                    <div class="dz-pair">
                      <ExprField label={t("shape.bottomRadius", { axis: L(c().axis, false) })} unit="mm" value={c().bottom_radius} path="__shape.bottom_radius" onChange={(v) => upd((q) => { q.bottom_radius = v; })} />
                      <ExprField label={t("shape.topRadius", { axis: L(c().axis, false) })} unit="mm" value={c().top_radius} path="__shape.top_radius" onChange={(v) => upd((q) => { q.top_radius = v; })} />
                    </div>
                    <div class="dz-pair">
                      <ExprField label={`${L(c().axis)}min`} unit="mm" value={c().range[0]} path="__shape.range[0]" onChange={(v) => upd((q) => { q.range[0] = v; })} />
                      <ExprField label={`${L(c().axis)}max`} unit="mm" value={c().range[1]} path="__shape.range[1]" onChange={(v) => upd((q) => { q.range[1] = v; })} />
                    </div>
                  </>
                );
              })()}
            </Show>
            <Show when={p.kind === "torus"}>
              {(() => {
                const tor = () => p as unknown as TorusPrimitive;
                const upd = (fn: (q: TorusPrimitive) => void) => set((q) => fn(q as TorusPrimitive));
                return (
                  <>
                    <SelectField label={t("shape.torusAxis")} value={tor().axis} options={axisOptions()} onChange={(v) => upd((q) => { q.axis = v; })} />
                    <div class="dz-vec-row sd-three">
                      <For each={AXES}>{(a, k) => (
                        <ExprField compact label={t("shape.centre", { axis: L(a) })} unit="mm" value={tor().center[k()]} path={`__shape.center[${k()}]`}
                          onChange={(v) => upd((q) => { q.center[k()] = v; })} />
                      )}</For>
                    </div>
                    <div class="dz-pair">
                      <ExprField label={t("shape.majorRadius")} unit="mm" value={tor().major_radius} path="__shape.major_radius" onChange={(v) => upd((q) => { q.major_radius = v; })} />
                      <ExprField label={t("shape.minorRadius")} unit="mm" value={tor().minor_radius} path="__shape.minor_radius" onChange={(v) => upd((q) => { q.minor_radius = v; })} />
                    </div>
                  </>
                );
              })()}
            </Show>
            <Show when={p.kind === "wire"}>
              {(() => {
                const w = () => p as unknown as WirePrimitive;
                const upd = (fn: (q: WirePrimitive) => void) => set((q) => fn(q as WirePrimitive));
                return (
                  <>
                    <ExprField label={t("shape.wireRadius")} unit="mm" value={w().radius} path="__shape.radius" onChange={(v) => upd((q) => { q.radius = v; })} />
                    <fieldset class="dz-vec">
                      <legend class="dz-label">{t("shape.points")} ({AXES.map((a) => L(a, false)).join(", ")}) <span class="dz-unit">mm</span></legend>
                      <div class="sd-points">
                        <For each={w().points}>{(pt, k) => (
                          <div class="dz-point dm-point3">
                            <span class="dz-idx mono">{k() + 1}</span>
                            <For each={[0, 1, 2]}>{(c) => (
                              <ExprField compact label={L(AXES[c], false)} value={pt[c]} path={`__shape.points[${k()}][${c}]`} onChange={(v) => upd((q) => { q.points[k()][c] = v; })} />
                            )}</For>
                            <button type="button" class="icon-btn icon-btn-sm" disabled={w().points.length <= 2} aria-label={t("shape.removePointN", { n: k() + 1 })} title={t("shape.removePoint")}
                              onClick={() => upd((q) => { q.points.splice(k(), 1); })}><Trash2 size={12} /></button>
                          </div>
                        )}</For>
                      </div>
                      <button type="button" class="btn btn-ghost btn-sm sd-add" onClick={() => upd((q) => { q.points.push([...q.points[q.points.length - 1]] as Vec3); })}>
                        <Plus size={13} aria-hidden="true" /> {t("shape.addPoint")}
                      </button>
                    </fieldset>
                  </>
                );
              })()}
            </Show>
            <Show when={isPoly}>
              {(() => {
                const g = () => p as unknown as { normal: Axis; elevation: Expr; length?: Expr; points: [Expr, Expr][] };
                const ax = () => planeAxes(g().normal);
                const axl = () => ax().map((a) => L(a, false));
                const picked = latestPickedPoint;
                return (
                  <>
                    <div class="sd-row">
                      <SelectField label={t("shape.plane")} value={g().normal} options={planeOptions()} onChange={(v) => set((q) => { (q as { normal: Axis }).normal = v; })} />
                      <ExprField label={t("shape.elevation", { axis: L(g().normal, false) })} unit="mm" value={g().elevation} path="__shape.elevation"
                        onChange={(v) => set((q) => { (q as { elevation: Expr }).elevation = v; })} />
                      <ExprField label={t("shape.heightAlong", { axis: L(g().normal, false) })} unit="mm" value={g().length ?? 0} path="__shape.length"
                        onChange={(v) => set((q) => { q.length = v; })} />
                    </div>
                    <fieldset class="dz-vec">
                      <legend class="dz-label">{t("shape.points")} ({axl().join(", ")}) <span class="dz-unit">mm</span></legend>
                      <div class="sd-points">
                        <For each={g().points}>{(pt, k) => (
                          <div class="dz-point">
                            <span class="dz-idx mono">{k() + 1}</span>
                            <ExprField compact label={axl()[0]} value={pt[0]} path={`__shape.points[${k()}][0]`} onChange={(v) => set((q) => { (q as { points: Expr[][] }).points[k()][0] = v; })} />
                            <ExprField compact label={axl()[1]} value={pt[1]} path={`__shape.points[${k()}][1]`} onChange={(v) => set((q) => { (q as { points: Expr[][] }).points[k()][1] = v; })} />
                            <button type="button" class="icon-btn icon-btn-sm" disabled={g().points.length <= 3} aria-label={t("shape.removePointN", { n: k() + 1 })} title={t("shape.removePoint")}
                              onClick={() => set((q) => { (q as { points: Expr[][] }).points.splice(k(), 1); })}><Trash2 size={12} /></button>
                            <Show when={picked()}>{(point) =>
                              <button type="button" class="linklike" style={{ "grid-column": "2 / -1" }} aria-label={t("shape.useForVertex", { n: k() + 1 })} title={t("shape.fillVertex", { n: k() + 1, axes: axl().join(", ") })}
                                onClick={() => { const local = pickedLocal(point().point); if (local) set((q) => { (q as { points: Expr[][] }).points[k()] = ax().map((a) => local[AXES.indexOf(a)]); }); }}>
                                {t("shape.usePicked")}
                              </button>
                            }</Show>
                          </div>
                        )}</For>
                      </div>
                      <button type="button" class="btn btn-ghost btn-sm sd-add" onClick={() => set((q) => { const ps = (q as { points: Expr[][] }).points; ps.push([...ps[ps.length - 1]]); })}>
                        <Plus size={13} aria-hidden="true" /> {t("shape.addPoint")}
                      </button>
                    </fieldset>
                  </>
                );
              })()}
            </Show>
          </div>
          <Show when={tried() && problems().length}>
            <ul class="sd-problems" role="alert">
              <For each={problems()}>{(m) => <li>{m}</li>}</For>
            </ul>
          </Show>
        </form>
        <div class="dialog-foot">
          <span class="muted">{summary(result(), val, L)}</span>
          <div class="dialog-actions">
            <button class="btn btn-ghost" type="button" onClick={props.onClose} data-noprompt>{t("common.cancel")}</button>
            <button class="btn btn-primary" type="submit" form="sd-form">{t("common.ok")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One line under the dialog: the evaluated size (numbers with the locale's decimal separator). */
function summary(q: DesignPrimitive, val: (e: Expr | undefined) => number | undefined, L: (a: Axis, upper?: boolean) => string): string {
  const num = (v: number) => (decimalComma() ? fmt(v).replace(".", ",") : fmt(v));
  const f = (v: number | undefined) => (v === undefined ? "?" : num(v));
  const span = (lo: number | undefined, hi: number | undefined) => (lo === undefined || hi === undefined ? "?" : num(hi - lo));
  if (q.kind === "box") {
    const size = t("shape.summary.box", { size: AXES.map((_, k) => span(val(q.start[k]), val(q.stop[k]))).join(" × ") });
    const flat = AXES.filter((_, k) => val(q.start[k]) !== undefined && val(q.start[k]) === val(q.stop[k]));
    return flat.length === 1 ? `${size} · ${t("shape.summary.sheet", { axis: L(flat[0]) })}` : size;
  }
  if (q.kind === "cylinder" && "axis" in q) {
    const [lo, hi] = q.range.map(val);
    return t("shape.summary.cylinder", { r: f(val(q.radius)), len: span(lo, hi), axis: L(q.axis, false) });
  }
  if (q.kind === "sphere") return t("shape.summary.sphere", { r: f(val(q.radius)) });
  if (q.kind === "polygon") return t("shape.summary.polygon", { count: q.points.length, axis: L(q.normal, false), elev: f(val(q.elevation)) });
  if (q.kind === "linpoly") return t("shape.summary.linpoly", { count: q.points.length, len: f(val(q.length)), axis: L(q.normal, false) });
  if (q.kind === "cone") {
    const [lo, hi] = q.range.map(val);
    return t("shape.summary.cone", { bottom: f(val(q.bottom_radius)), top: f(val(q.top_radius)), len: span(lo, hi), axis: L(q.axis, false) });
  }
  if (q.kind === "torus") return t("shape.summary.torus", { major: f(val(q.major_radius)), minor: f(val(q.minor_radius)), axis: L(q.axis, false) });
  if (q.kind === "wire") return t("shape.summary.wire", { count: q.points.length, r: f(val(q.radius)) });
  return "";
}
