import { createEffect, createSignal, on, onCleanup, Show, For } from "solid-js";
import { ArrowDownToDot, Crosshair, Magnet, Ruler } from "lucide-solid";
import { edit, draft, file, setMessage, setSelection } from "./store";
import { applyTransform } from "./transformModel";
import { alignOffset, applyPointAlign } from "./pointAlign.ts";
import { faceAlignTransforms, type FaceAlignMode, type PickedFace } from "./faceTransforms.ts";
import { fmt, t, decimalComma } from "../i18n";
import { copyText, measure } from "./measure.ts";

export type PointPickMode = "measure" | "vertex" | "edge" | "face" | "align-source" | "align-target" | "face-source" | "face-target";
type Point = [number, number, number];
export type PickedPoint = {
  point: Point;
  kind: "vertex" | "edge midpoint" | "face centre" | "circle centre" | "triangle centre";
  label: string;
  /** the part the point was picked on (the solid an alignment moves) */
  part?: string;
  /** face alignment picks: the planar face */
  face?: PickedFace;
};
const [mode, setMode] = createSignal<PointPickMode | null>(null);
const [points, setPoints] = createSignal<PickedPoint[]>([]);
const [hover, setHover] = createSignal<PickedPoint | null>(null);
const [alignSource, setAlignSource] = createSignal<PickedPoint | null>(null);
const [alignTarget, setAlignTarget] = createSignal<PickedPoint | null>(null);
const [faceSource, setFaceSource] = createSignal<PickedFace | null>(null);
const [faceTarget, setFaceTarget] = createSignal<PickedFace | null>(null);
const [faceMode, setFaceMode] = createSignal<FaceAlignMode>("against");
const [faceCentre, setFaceCentre] = createSignal(true);
export const isFacePickMode = (m: PointPickMode | null) => m === "face-source" || m === "face-target";
export const pointPickMode = mode;
export const pickedPoints = points;
export const hoveredPickedPoint = hover;
export const latestPickedPoint = () => points().at(-1) ?? null;

export function clearPickedPoints() {
  setMode(null);
  setPoints([]);
  setAlignSource(null);
  setAlignTarget(null);
  setFaceSource(null);
  setFaceTarget(null);
  setHover(null);
}

/** Mount once with the ribbon, so tab changes do not lose picks or Escape handling. */
export function usePointTools() {
  const pick = (event: Event) => {
    const detail = (event as CustomEvent<PickedPoint>).detail;
    if (!mode() || !detail) return;
    // Measure: a third click starts a new pair
    setPoints((previous) => mode() === "measure" && previous.length >= 2 ? [detail] : [...previous, detail]);
    setHover(null);
    if (mode() === "align-source") {
      setAlignSource(detail);
      setMode("align-target");
    } else if (mode() === "align-target") {
      setAlignTarget(detail);
      setMode(null);
    } else if (mode() === "face-source" && detail.face) {
      setFaceSource(detail.face);
      setMode("face-target");
    } else if (mode() === "face-target" && detail.face) {
      setFaceTarget(detail.face);
      setMode(null);
    }
  };
  const preview = (event: Event) => setHover((event as CustomEvent<PickedPoint | null>).detail ?? null);
  const key = (event: KeyboardEvent) => { if (event.key === "Escape") clearPickedPoints(); };
  createEffect(on(() => file()?.id, clearPickedPoints));
  window.addEventListener("fairbeam:point-pick", pick);
  window.addEventListener("fairbeam:point-hover", preview);
  window.addEventListener("keydown", key);
  onCleanup(() => {
    window.removeEventListener("fairbeam:point-pick", pick);
    window.removeEventListener("fairbeam:point-hover", preview);
    window.removeEventListener("keydown", key);
    clearPickedPoints();
  });
}

function start(mode: PointPickMode) { setMode(mode); setHover(null); }
function align() {
  const a = alignSource(), b = alignTarget();
  // The solid that owns the first pick moves, whatever is selected.
  const name = a?.part ?? "";
  if (!a || !b || !draft.parts.some((p) => p.name === name)) {
    setMessage({ tone: "warn", text: t("pointTools.needAlignPicks") });
    return;
  }
  const offset = alignOffset(a.point, b.point);
  if (offset.every((v) => v === 0)) {
    setMessage({ tone: "good", text: t("pointTools.alignedNoMove", { part: name }) });
  } else {
    let moved = -1;
    edit((design) => { moved = applyPointAlign(design, name, offset); });
    if (moved >= 0) setSelection({ type: "part", i: moved });
    setMessage({ tone: "good", text: t("pointTools.aligned", { part: name, offset: offset.map((v) => fmt.fixed(v, 4)).join(listSep()) }) });
  }
  setAlignSource(null);
  setAlignTarget(null);
  setPoints([]);
}

const AXIS_NAMES = ["x", "y", "z"];
const faceText = (f: PickedFace) => t("pointTools.faceText", { sign: f.sign > 0 ? "+" : "−", axis: AXIS_NAMES[f.axis], part: f.part, value: f.value });
/** Coordinates as text: Turkish numbers have a decimal comma, so they are separated by "; ". */
const listSep = () => (decimalComma() ? "; " : ", ");
/** The kind of a picked point (a data value) in the current language. */
const KIND_KEYS: Record<PickedPoint["kind"], string> = {
  vertex: "pointTools.kind.vertex", "edge midpoint": "pointTools.kind.edgeMidpoint", "face centre": "pointTools.kind.faceCentre",
  "circle centre": "pointTools.kind.circleCentre", "triangle centre": "pointTools.kind.triangleCentre",
};

/** Turn and move the source face's part so that face lies against (or flush with) the target. */
function alignFaces() {
  const a = faceSource(), b = faceTarget();
  const i = a ? draft.parts.findIndex((p) => p.name === a.part) : -1;
  if (!a || !b || i < 0) {
    setMessage({ tone: "warn", text: t("pointTools.needFacePicks") });
    return;
  }
  if (a.part === b.part) {
    setMessage({ tone: "warn", text: t("pointTools.otherPart") });
    setFaceTarget(null);
    setMode("face-target");
    return;
  }
  let transforms;
  try { transforms = faceAlignTransforms(a, b, faceMode(), faceCentre()); } catch (e) {
    setMessage({ tone: "warn", text: (e as Error).message });
    return;
  }
  if (!transforms.length) {
    setMessage({ tone: "good", text: t("pointTools.alreadyAligned", { face: faceText(a) }) });
  } else {
    edit((design) => { for (const t of transforms) applyTransform(design, { type: "part", i }, t); });
    setSelection({ type: "part", i });
    const turned = transforms.find((t) => t.type === "rotate");
    const moved = transforms.find((t) => t.type === "move");
    const details = (turned && turned.type === "rotate" ? t("pointTools.turned", { angle: turned.angle, axis: turned.axis }) : "")
      + (moved && moved.type === "move" ? t(turned ? "pointTools.thenMoved" : "pointTools.moved", { offset: moved.offset.join(", ") }) : "");
    setMessage({ tone: "good", text: t(faceMode() === "against" ? "pointTools.alignedAgainst" : "pointTools.alignedFlush", { part: a.part, details }) });
  }
  setFaceSource(null);
  setFaceTarget(null);
  setPoints([]);
}

export default function PointTools() {
  const [open, setOpen] = createSignal(false);
  return <div class="point-tools" role="group" aria-label={t("pointTools.aria")}>
    <div class="rb-wcs">
      <button class="rb-btn" aria-expanded={open()} title={t("pointTools.pickTitle")} onClick={() => setOpen(!open())}>
        <Crosshair size={16} aria-hidden="true" /><span>{t("pointTools.pick")}</span>
      </button>
      <Show when={open()}>
        <div class="rb-pop" role="group" aria-label={t("pointTools.kindAria")} onKeyDown={(event) => {
          if (event.key === "Escape") { setOpen(false); (event.currentTarget.parentElement?.querySelector("button"))?.focus(); }
        }}>
          <For each={[["vertex", "pointTools.vertex"], ["edge", "pointTools.edge"], ["face", "pointTools.face"]] as const}>{([kind, label]) =>
            <button class="btn btn-ghost btn-sm" aria-pressed={mode() === kind} onClick={() => { start(kind); setOpen(false); }}>{t(label)}</button>
          }</For>
        </div>
      </Show>
    </div>
    <button class="rb-btn" aria-pressed={mode() === "measure"} title={t("pointTools.measureTitle")} onClick={() => { setPoints([]); start("measure"); }}>
      <Ruler size={16} aria-hidden="true" /><span>{t("pointTools.measure")}</span>
    </button>
    <button class="rb-btn" aria-pressed={mode() === "align-source" || mode() === "align-target"} title={t("pointTools.alignTitle")} onClick={() => {
      setAlignSource(null); setAlignTarget(null); start("align-source");
    }}>
      <ArrowDownToDot size={16} aria-hidden="true" /><span>{t("pointTools.align")}</span>
    </button>
    <button class="rb-btn" aria-pressed={isFacePickMode(mode())} title={t("pointTools.alignFacesTitle")} onClick={() => {
      setFaceSource(null); setFaceTarget(null); start("face-source");
    }}>
      <Magnet size={16} aria-hidden="true" /><span>{t("pointTools.alignFaces")}</span>
    </button>
  </div>;
}

export function PointReadout() {
  const delta = () => {
    const [a, b] = points();
    return a && b ? measure(a.point, b.point) : null;
  };
  const distance = () => delta()?.distance ?? null;
  const copy = () => {
    const d = distance();
    if (d === null) return;
    navigator.clipboard?.writeText(copyText(d)).then(() => setMessage({ tone: "good", text: t("pointTools.copied", { d: copyText(d) }) }), () => {});
  };
  const angle = () => {
    if (points().length < 3) return null;
    const [a, b, c] = points().slice(-3).map(p => p.point);
    const u = a.map((value, i) => value - b[i]), v = c.map((value, i) => value - b[i]);
    const norm = Math.hypot(...u) * Math.hypot(...v);
    return norm ? Math.acos(Math.max(-1, Math.min(1, u.reduce((sum, value, i) => sum + value * v[i], 0) / norm))) * 180 / Math.PI : null;
  };
  return <Show when={points().length || mode()}>
    <div class="point-tools-panel" role="region" aria-label={t("pointTools.readoutAria")}>
      <div class="point-tools-summary">
        <Show when={mode()}><span>{t(({ "align-source": "pointTools.mode.alignSource", "align-target": "pointTools.mode.alignTarget", "face-source": "pointTools.mode.faceSource", "face-target": "pointTools.mode.faceTarget", measure: "pointTools.mode.measure" } as Record<string, string>)[mode()!] ?? "pointTools.mode.hover")}</span></Show>
        <Show when={distance() !== null}><span>{t("pointTools.distance", { d: fmt.fixed(distance()!, 4) })}</span></Show>
        <Show when={delta()}>{(m) => <span>{t("pointTools.deltas", { x: fmt.fixed(m().dx, 4), y: fmt.fixed(m().dy, 4), z: fmt.fixed(m().dz, 4) })}</span>}</Show>
        <Show when={distance() !== null}><button class="btn btn-ghost btn-sm" title={t("pointTools.copyTitle")} onClick={copy}>{t("pointTools.copy")}</button></Show>
        <Show when={angle() !== null}><span>{t("pointTools.angle", { a: fmt.fixed(angle()!, 3) })}</span></Show>
        <Show when={alignSource() && alignTarget()}><span>{t("pointTools.alignPreview", { part: alignSource()!.part ?? "?", offset: alignOffset(alignSource()!.point, alignTarget()!.point).map((v) => fmt.fixed(v, 4)).join(listSep()) })}</span><button class="btn btn-ghost btn-sm" onClick={align}>{t("pointTools.applyAlignment")}</button></Show>
        <Show when={faceSource() && faceTarget()}>
          <div class="seg" role="radiogroup" aria-label={t("pointTools.faceAlignAria")}>
            <For each={[["against", "pointTools.against"], ["flush", "pointTools.flush"]] as [FaceAlignMode, string][]}>{([value, label]) =>
              <button class="seg-btn" role="radio" aria-checked={faceMode() === value} classList={{ active: faceMode() === value }}
                title={t(value === "against" ? "pointTools.againstTitle" : "pointTools.flushTitle")} onClick={() => setFaceMode(value)}>{t(label)}</button>
            }</For>
          </div>
          <label class="dz-check"><input type="checkbox" checked={faceCentre()} onChange={(e) => setFaceCentre(e.currentTarget.checked)} /> {t("pointTools.centre")}</label>
          <button class="btn btn-ghost btn-sm" onClick={alignFaces}>{t("pointTools.applyFaceAlignment")}</button>
        </Show>
        <button class="btn btn-ghost btn-sm" onClick={clearPickedPoints}>{t("pointTools.clear")}</button>
      </div>
      <Show when={faceSource() || faceTarget()}>
        <div class="point-tools-list">
          <Show when={faceSource()}>{(f) => <span class="point-tools-readout">{t("pointTools.moveFace", { face: faceText(f()) })}</span>}</Show>
          <Show when={faceTarget()}>{(f) => <span class="point-tools-readout">{t("pointTools.targetFace", { face: faceText(f()) })}</span>}</Show>
        </div>
      </Show>
      <div class="point-tools-list">
        <For each={points()}>{point => <span class="point-tools-readout">
          {point.label} · {t(KIND_KEYS[point.kind] ?? point.kind)}: ({point.point.map((value) => fmt.fixed(value, 4)).join(listSep())}) mm
        </span>}</For>
      </div>
      <Show when={mode() === "face"}><span>{t("pointTools.faceNote")}</span></Show>
    </div>
  </Show>;
}
