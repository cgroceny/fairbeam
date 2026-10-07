// Designer state: the design file open in the Design tab, its unsaved draft, the selection, undo /
// redo, save with optimistic concurrency, the live geometry preview of the draft (built by the
// run server from the unsaved state, so what you see is what openEMS will mesh) and the checks
// against absurd states (instant ones from checks.ts, the rest from the server with each preview).
import { batch, createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import { reconcile, unwrap } from "solid-js/store";
import { api, type PcbFile, type PcbOptions } from "../runner/api";
import { applyModelEntry, forgetPreviewFailure, restoreProject, invalidatePreview, previewActive, previewFailure, previewIsCurrent, previewState, health, modelKey, models, refreshModels, runDesignPreview, selectModel, serverState, setUnsavedDesignCheck, showEmptyDesign, showQuickPreview } from "../runner/store";
import { bundle, openCount, setCenterView, setHiddenParts } from "../state";
import { quickBundle } from "./geometry";
import { portFeedEntries } from "../lib/portGroups";
import { clearBackup, forgetLastDesign, readBackup, readLastDesign, rememberLastDesign, writeBackup } from "./draftBackup";
import type { Axis, Design, DesignCut, DesignParam, DesignPart, DesignPrimitive, DesignTransform, Expr, Selection, Vec3 } from "./types";
import { nameMap, namesIn, paramValues, RESERVED, tryEvaluate } from "./expr";
import { openParametersTab, setParameterRanges } from "./dockState";
import { appMode, setAppMode } from "../workspace";
import { designChecks, mergeChecks, type Check, type CheckFix } from "./checks";
import { checkMessage } from "./checkText";
import { validColor } from "./colors";
import { designMaterial, type LibraryMaterial } from "./materials";
import { designMaterialFromUser, type UserMaterial } from "./userMaterials";
import { openTransform } from "./transforms";
import { lastShapeMaterial, pickShapeMaterial } from "./shapeMaterial";
import { createDesignerSession } from "./sessionCore";
import { createDesignerIO } from "./sessionIO";
import { normComponent } from "./navModel";
import { readGeneralSettings } from "../lib/generalSettings";
import { gapCounts } from "../lib/cstReport";
import { confirmDraftDiscard } from "../lib/ConfirmDialog";
import { createdNote, type TemplateKey } from "./templates";
import { applyPythonScript, replaceDesignContent, type PythonApplyOutcome } from "./pythonApply";
import { t } from "../i18n/index.ts";

export const defaultDesignerSession = createDesignerSession({
  edited: () => { quickPreview(); schedulePreview(); },
  restored: () => { quickPreview(); schedulePreview(0); },
});
export const { file, setFile, draft, setDraft, selection, setSelection, loading, setLoading, saving, setSaving,
  message, setMessage, serverErrors, setServerErrors, conflict, setConflict, serverChecks, setServerChecks,
  dirty, canUndo, canRedo, edit, undo, redo, historySteps, undoLabel, redoLabel, historyIndex, historyDesign, goToHistory,
  historyMark, changedSince, rollbackTo, syncSavedDesignName, revertObservedEdit,
  registerPostEditObserver, registerDocumentChangeObserver, registerDeriveHook,
} = defaultDesignerSession;
export type { HistoryStep, HistoryMark } from "./sessionCore";
const { asyncState, loaded, snapshot, draftText, showSaveNote, checksTicket, setChecksTicket } = defaultDesignerSession;
// the Run panel submits the saved file: it must not run this design while its draft is unsaved
setUnsavedDesignCheck((key) => dirty() && file()?.id === key);

// Keep a local backup of an unsaved draft (draftBackup.ts), written a second after the last edit;
// a clean draft removes it. The draft text is tracked so that every later edit is backed up too,
// not only the first one that made the draft dirty.
let backupTimer: ReturnType<typeof setTimeout> | undefined;
createRoot(() => createEffect(() => {
  const f = file(), unsaved = dirty(), text = unsaved ? draftText() : "";
  clearTimeout(backupTimer);
  if (!f || f.readonly) return;
  if (!unsaved) { clearBackup(f.id, f.backup_scope, f.hash); return; }
  backupTimer = setTimeout(() => writeBackup(f.id, f.hash, JSON.parse(text) as Design, f.backup_scope), 1000);
}));

/** Parameter values (defaults and derived) for the inspector's live evaluation. */
export const names = createRoot(() => createMemo(() => (loaded() ? paramValues(draft.params ?? []) : { names: nameMap(), errors: nameMap<string>() })));

/** The cheap checks, recomputed on every edit (they read the whole draft). */
const liveChecks = createRoot(() => createMemo(() => (loaded() ? designChecks(draft) : [])));

/** Everything the Checks list shows: live checks plus the server-only ones, errors first. */
export const checks = createRoot(() => createMemo(() => mergeChecks(liveChecks(), serverChecks())));

export interface Issue { severity: "error" | "warning" | "info"; message: string }

/** The worst issue per JSON path: a failed server build (serverErrors) or a check. */
export const issues = createRoot(() => createMemo(() => {
  const out: Record<string, Issue> = {};
  for (const c of checks()) {
    if (!out[c.path] || (c.severity === "error" && out[c.path].severity !== "error")) out[c.path] = { severity: c.severity, message: checkMessage(c) };
  }
  for (const [path, message] of Object.entries(serverErrors())) if (!out[path] || out[path].severity !== "error") out[path] = { severity: "error", message };
  return out;
}));

export const errorCount = createRoot(() => createMemo(() => checks().filter((c) => c.severity === "error").length));

/** The worst error or warning at every JSON path and each of its prefixes: "parts[3].stop[2]" marks
 * itself, "parts[3].stop", "parts[3]" and "parts" (a prefix ends before a "." or "["), so
 * issueUnder is one lookup per tree node instead of a scan of every issue (notes mark nothing). */
const issueIndex = createRoot(() => createMemo(() => {
  const worst = new Map<string, "error" | "warning">();
  const mark = (path: string, sev: "error" | "warning") => {
    if (worst.get(path) !== "error") worst.set(path, sev);
  };
  for (const [k, v] of Object.entries(issues())) {
    if (v.severity !== "error" && v.severity !== "warning") continue;
    mark(k, v.severity);
    for (let i = 0; i < k.length; i++) if (k[i] === "." || k[i] === "[") mark(k.slice(0, i), v.severity);
  }
  return worst;
}));

/** Worst issue at a JSON path or anywhere below it ("parts[1]" covers "parts[1].name", not "parts[10]"). */
export function issueUnder(prefix: string): Issue["severity"] | null {
  return issueIndex().get(prefix) ?? null;
}

/** The part the 3D view highlights (the selected part, or the part of the selected shape). */
export const highlightedPart = createRoot(() => createMemo(() => {
  const s = selection();
  if (!loaded()) return null;
  if (s.type === "part" || s.type === "primitive") return draft.parts[s.i]?.name ?? null;
  return null;
}));

export async function confirmDiscard(): Promise<boolean> {
  if (!dirty()) return true;
  const f = file()!;
  const ticket = asyncState.ticket();
  const ok = await confirmDraftDiscard(t("store.discard", { file: f.file }));
  if (!asyncState.isDraftCurrent(ticket)) return false;
  // discarded on purpose: the local backup must not bring them back on the next open
  if (ok) { clearTimeout(backupTimer); clearBackup(f.id, f.backup_scope, f.hash); }
  return ok;
}

// ------------------------------------------------------------------ editing with undo

/** Update only the stored sweep draft through the normal undo/dirty/save workflow. */
export function editParameterSweep(value: Design["parameter_sweep"]) {
  // the sweep the draft already has is no edit: no undo step, no history entry, nothing to save
  // (the Parameter sweep dialog writes through here; opening or re-entering it must not touch the draft)
  if (JSON.stringify(unwrap(draft.parameter_sweep) ?? null) === JSON.stringify(value ?? null)) return;
  edit((d) => { d.parameter_sweep = value; }, "parameter_sweep", t("history.editSweep"));
}

// ------------------------------------------------------------------ instant preview (browser-built)

let quickFrame = 0;
let quickOpened = 0;
/** Draw the draft at once from the browser's own evaluation; the server build follows. */
export function quickPreview() {
  quickOpened = openCount();
  if (quickFrame) return;
  quickFrame = requestAnimationFrame(() => {
    quickFrame = 0;
    if (appMode() !== "design" || openCount() !== quickOpened || !loaded() || !draft.parts.length) return;
    const b = quickBundle(unwrap(draft), names().names, bundle());
    if (b) showQuickPreview(b);
  });
}

// ------------------------------------------------------------------ preview

let timer: ReturnType<typeof setTimeout> | undefined;

/** The Checks entry for a preview the server gave no verdict on (offline, a network failure, a
 * server error): without it the list would show only the browser-side checks, an all-clear the
 * server never gave. It stays until a later preview of the current draft succeeds. */
export const PREVIEW_UNAVAILABLE = "preview_unavailable";
export function previewUnavailableCheck(reason: string): Check {
  return {
    severity: "warning", path: "", code: PREVIEW_UNAVAILABLE,
    message: "Server checks unavailable: the preview failed",
    explain: `${reason} The mesh numbers and the server's checks shown are from the last successful preview, not from this draft; `
      + "the list only has the checks made in the browser. Retry the preview (status bar) once the server responds.",
  };
}

function stopPreview() {
  clearTimeout(timer);
  asyncState.invalidatePreview();
  return invalidatePreview();
}

export function schedulePreview(delay = 250) {
  const previewTicket = stopPreview();
  const ticket = asyncState.ticket();
  timer = setTimeout(async () => {
    if (!asyncState.isPreviewCurrent(ticket) || appMode() !== "design" || !previewIsCurrent(previewTicket) || !loaded()) return;
    // nothing drawn yet: an empty work area (not the previous project); the browser-side checks
    // say what is missing, no server build needed
    if (!draft.parts.length) {
      showEmptyDesign(draft.model.name);
      batch(() => { setServerErrors({}); setServerChecks([]); });
      return;
    }
    const r = await runDesignPreview(JSON.parse(snapshot()) as Design);
    if (!r || !asyncState.isPreviewCurrent(ticket) || appMode() !== "design") return;
    batch(() => {
      setServerErrors(r.fields);
      setServerChecks(r.unavailable ? [previewUnavailableCheck(r.unavailable)] : r.checks);
    });
    setChecksTicket(r.unavailable ? null : ticket);
  }, delay);
}

/** Build the server preview of the current draft again (the status bar's Retry after a failure). */
export function retryPreview() {
  if (appMode() === "design" && loaded()) schedulePreview(0);
}

// The server is back (the status bar's server button, the Run dialog, a later edit): a failed or
// missing preview is built again, so the mesh and the checks become current without another edit.
createRoot(() => createEffect(on(serverState, (state, before) => {
  if (state === "online" && before !== "online" && (previewFailure() !== null || previewState() !== "ready")) retryPreview();
}, { defer: true })));

// ------------------------------------------------------------------ files

export const defaultDesignerIO = createDesignerIO(defaultDesignerSession, {
  transport: { design: api.design, saveDesign: (f, d, hash) => api.saveDesign(f.id, d, hash, f.backup_scope) },
  rememberLastDesign: f => rememberLastDesign(f.id, f.backup_scope),
  readBackup: f => readBackup(f.id, f.hash, f.backup_scope), clearBackup: f => clearBackup(f.id, f.backup_scope, f.hash),
  stopPreview, forgetPreviewFailure, resetParamAsks: () => setParamAsks([]),
  schedulePreview: () => schedulePreview(0), applyModelEntry,
});
export const { openDesign, save, saveBeforeLeaving } = defaultDesignerIO;
const { take, applyValidation, isReleased } = defaultDesignerIO;
/** Keep the Design tab on the model picked in the Run panel. */
export function syncToModel() {
  const id = modelKey();
  if (id && file()?.id !== id && defaultDesignerIO.navigationTarget() !== id) openDesign(id);
}

/** Release the open draft without deleting its saved file or cancelling simulation jobs. */
export function closeDesign() {
  defaultDesignerSession.notifyDocumentChange();
  // closing follows Save or Don't save: either way the draft's backup is no longer wanted
  const closing = file();
  if (closing) clearBackup(closing.id, closing.backup_scope, closing.hash);
  forgetLastDesign(closing?.backup_scope);
  clearTimeout(backupTimer);
  stopPreview();
  restoreProject();
  asyncState.cancelNavigation();
  asyncState.replaceDocument();
  defaultDesignerIO.setNavigationTarget(null);
  defaultDesignerIO.forgetRelease();
  defaultDesignerSession.forgetSaveNote();
  batch(() => {
    // Unmount the workspace before clearing the draft read by its inspector.
    setAppMode("home");
    setFile(null);
    setDraft(reconcile({} as Design));
    defaultDesignerSession.resetHistory();
    setServerErrors({});
    setServerChecks([]);
    setConflict(null);
    setSelection({ type: "design" });
    setParamAsks([]);
    setMessage(null);
    setSaving(false);
    setLoading(false);
    selectModel("");
  });
}

/** Save before the draft is closed or replaced: true only when this draft is saved and unchanged.
 * A failed/conflicting save or edits arriving during it must never discard the draft. */
export async function saveAndCloseDesign(): Promise<boolean> {
  if (!(await saveBeforeLeaving())) return false;
  closeDesign();
  return true;
}

// ------------------------------------------------------------------ replacing the open draft

/** A pending "Save changes before …?" decision (CloseProject.tsx shows it). */
export interface ReplaceRequest {
  action: "create" | "open";
  /** the design about to be created or opened, for the dialog's text */
  target: string;
  /** true: saved or released, go on; false: cancelled, keep everything as it is */
  decide: (proceed: boolean) => void;
}
export const [replaceRequest, setReplaceRequest] = createSignal<ReplaceRequest | null>(null);

/** Before a new or another design replaces the open draft, ask Save / Don't save / Cancel.
 * Resolves true when nothing unsaved is at stake, once the save succeeded, or after "Don't save";
 * false on Cancel (no file is created, the draft, selection and undo history stay). */
export function confirmReplaceDraft(action: ReplaceRequest["action"], target: string): Promise<boolean> {
  if (!file() || isReleased() || (!dirty() && !saving())) return Promise.resolve(true);
  if (replaceRequest()) return Promise.resolve(false);
  return new Promise((resolve) => setReplaceRequest({
    action, target,
    decide: (proceed) => { setReplaceRequest(null); resolve(proceed); },
  }));
}

/** "Don't save": the replacement may drop this draft; its backup goes once the other design opens. */
export function releaseDraft() {
  defaultDesignerIO.releaseDraft();
}

export async function createDesign(body: { id: string; name?: string; from?: string; template?: TemplateKey; python?: { source_model: string; model?: Design["model"] }; cst?: { source: string; filename?: string };
  pcb?: { files: PcbFile[]; options?: PcbOptions }; design?: Design }) {
  if (!(await confirmReplaceDraft("create", body.name || body.id))) return null;
  const mine = asyncState.navigationTicket();
  defaultDesignerIO.setNavigationTarget(body.id);
  stopPreview();
  setLoading(true);
  try {
    const res = await api.createDesign(body);
    // The newer design-aware auto mesh is `design`; `auto` is the legacy mesh editor.
    // Apply this only to newly created designs, then persist it in the created file. An imported
    // CST macro or PCB artwork keeps the mesh the import chose (an fairbeam export restores its original mesh).
    const preferredMesh = readGeneralSettings().meshMode === "auto" ? "design" : "auto";
    const { from, python, cst, pcb, design } = body;
    const meshChanged = !from && !python && !cst && !pcb && !design && !!res.design.mesh && res.design.mesh.mode !== "manual" && res.design.mesh.mode !== preferredMesh;
    if (meshChanged) {
      res.design.mesh.mode = preferredMesh;
      if (preferredMesh === "design") {
        for (const key of ["cells_per_wavelength", "pad", "edge_rule", "max_ratio", "air_cells_per_wavelength"] as const) delete res.design.mesh[key];
        res.design.mesh.overrides ??= {};
      }
    }
    await refreshModels();
    if (!asyncState.isOwnedNavigationCurrent(mine)) return res;
    selectModel(res.id);
    take({ id: res.id, file: res.file, design: res.design, hash: res.hash, readonly: res.readonly, backup_scope: res.backup_scope });
    const createdDocument = asyncState.ticket();
    if (meshChanged) await save();
    if (!asyncState.isOwnedNavigationCurrent(mine) || !asyncState.isDocumentCurrent(createdDocument)) return res;
    applyValidation(res.validation);
    const report = res.import_report;
    // the gaps are counted from the report's rows, as the import dialog does: not-imported items, items
    // the exporter left out and items imported with a change
    // (PCB artwork: only the entities that were not imported; its warnings, such as the missing port, are advice)
    const gaps = report ? (body.pcb ? report.notes.filter((n) => n.severity === "refused").length : gapCounts(report.notes).total) : 0;
    const pcbFiles = body.pcb?.files ?? [];
    showSaveNote({ tone: gaps ? "warn" : "good", text: body.design
      ? t("store.importedDesign", { name: res.design.model.name, file: res.file })
      : body.python
      ? t("store.createdPython", { file: res.file })
      : report ? t("store.createdCst", { file: res.file,
        source: body.pcb ? (pcbFiles.length === 1 ? pcbFiles[0].name : t("pcbImport.nFiles", { count: pcbFiles.length })) : body.cst?.filename ?? t("store.theCstMacro"),
        parts: t("cstImport.count.part", { count: report.counts.part }), ports: t("cstImport.count.port", { count: report.counts.port }) })
        + (gaps ? t("store.createdCstRefused", { count: gaps }) : ".")
      : createdNote(body.template ?? "patch", res.file) });
    setAppMode("design");
    schedulePreview(0);
    return res;
  } catch (e) {
    // the open draft stays: after a failed create, the next replacement asks again
    if (asyncState.isOwnedNavigationCurrent(mine)) defaultDesignerIO.forgetRelease();
    throw e;
  } finally {
    if (asyncState.isOwnedNavigationCurrent(mine)) {
      defaultDesignerIO.setNavigationTarget(null);
      setLoading(false);
    }
  }
}

/** After a reload: open the design that was open before it, if the server still has it. Called once
 * the models are listed; does nothing when a design is open already or none was remembered. */
export async function reopenLastDesign() {
  const scope = health()?.backup_scope;
  const id = readLastDesign(scope);
  if (!id || file() || appMode() === "design") return;
  const m = models().find((x) => x.key === id);
  if (!m || m.error || m.kind !== "design") { forgetLastDesign(scope); return; }
  setAppMode("design");
  selectModel(id);
  await openDesign(id, scope);
}

/** Open a design in the designer workspace. */
export async function enterDesign(id: string) {
  if (file()?.id !== id && !(await confirmReplaceDraft("open", models().find((m) => m.key === id)?.model?.name ?? id))) return;
  setAppMode("design");
  selectModel(id);
  if (file()?.id !== id) await openDesign(id);
  else schedulePreview(0);
}

export async function exportPython(): Promise<string | null> {
  let f = file();
  if (!f) return null;
  if (dirty()) {
    const document = asyncState.ticket();
    if (!(await save()) || !asyncState.isDocumentCurrent(document) || dirty() || saving() || conflict()) return null;
    f = file();
    if (!f) return null;
  }
  const ticket = asyncState.ticket();
  try {
    const source = (await api.designPython(f.id)).source;
    if (!asyncState.isDocumentCurrent(ticket)) return null;
    if (dirty()) {
      setMessage({ tone: "warn", text: t("store.saveFirst") });
      return null;
    }
    return source;
  } catch (e) {
    if (asyncState.isDocumentCurrent(ticket)) setMessage({ tone: "critical", text: (e as Error).message });
    return null;
  }
}

/** Apply a Python script (the Python panel's Edit mode): the run server builds it, without solving, and the
 * design's content becomes the result in one undo step. On an error the design is untouched. */
export async function applyPython(source: string): Promise<PythonApplyOutcome> {
  if (!file()) return { ok: false, message: t("python.edit.noDesign") };
  const ticket = asyncState.ticket();
  return applyPythonScript(source, {
    convert: (text) => api.designFromPython(text, JSON.parse(JSON.stringify(unwrap(draft.model))) as Design["model"]),
    current: () => asyncState.isDocumentCurrent(ticket),
    replace: (next) => {
      edit((d) => replaceDesignContent(d, next), "", t("history.applyPython"));
      setSelection({ type: "design" });
    },
  });
}

// ------------------------------------------------------------------ structure operations

const unique = (base: string, taken: string[]) => {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}${n}`)) return `${base}${n}`;
};

/** 1, 2 or 5 × 10^k: the size a new shape gets looks deliberate. */
function nice(v: number): number {
  const e = 10 ** Math.floor(Math.log10(v));
  const m = v / e;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * e;
}

/** A size for new shapes that fits the design: a fifth of its largest extent (bricks, cylinders,
 * spheres, polygons, evaluated), else a tenth of the wavelength at f max, else 10 mm. */
export function designScale(): number {
  const n = names().names;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const grow = (p: (number | undefined)[]) => p.forEach((v, k) => {
    if (v === undefined || !Number.isFinite(v)) return;
    lo[k] = Math.min(lo[k], v);
    hi[k] = Math.max(hi[k], v);
  });
  const ev = (e: unknown) => tryEvaluate(e as number | string, n).value;
  for (const part of draft.parts ?? []) {
    for (const pr of part.primitives) {
      if (pr.kind === "box" || (pr.kind === "cylinder" && "start" in pr)) {
        grow(pr.start.map(ev));
        grow(pr.stop.map(ev));
      } else if (pr.kind === "sphere") {
        const c = pr.center.map(ev), r = ev(pr.radius) ?? 0;
        grow(c.map((v) => (v === undefined ? v : v - r)));
        grow(c.map((v) => (v === undefined ? v : v + r)));
      } else if (pr.kind === "wire") {
        for (const q of pr.points) grow(q.map(ev));
      } else if (pr.kind === "polyhedron") {
        for (const q of pr.vertices) grow(q.map(ev));
      } else if (pr.kind === "torus") {
        const c = pr.center.map(ev), r = (ev(pr.major_radius) ?? 0) + (ev(pr.minor_radius) ?? 0);
        grow(c.map((v) => (v === undefined ? v : v - r)));
        grow(c.map((v) => (v === undefined ? v : v + r)));
      } else if (pr.kind === "cylinder" || pr.kind === "cone") {
        const k = "xyz".indexOf(pr.axis), [u, v] = [(k + 1) % 3, (k + 2) % 3];
        const r = pr.kind === "cone" ? Math.max(ev(pr.bottom_radius) ?? 0, ev(pr.top_radius) ?? 0) : ev(pr.radius) ?? 0;
        for (const t of pr.range) for (const s of [-r, r]) {
          const p: (number | undefined)[] = [0, 0, 0];
          p[k] = ev(t);
          p[u] = (ev(pr.center[0]) ?? 0) + s;
          p[v] = (ev(pr.center[1]) ?? 0) + s;
          grow(p);
        }
      } else {
        const k = "xyz".indexOf(pr.normal), [u, v] = [(k + 1) % 3, (k + 2) % 3];
        for (const q of pr.points) {
          const p: (number | undefined)[] = [0, 0, 0];
          p[k] = ev(pr.elevation);
          p[u] = ev(q[0]);
          p[v] = ev(q[1]);
          grow(p);
        }
      }
    }
  }
  const span = Math.max(...hi.map((h, k) => h - lo[k]).filter(Number.isFinite), 0);
  if (span > 0) return nice(span / 5);
  const fmax = ev(draft.simulation?.f_max);
  return fmax && fmax > 0 ? nice(299.792458 / fmax / 10) : 10;
}

export type ShapeKind = DesignPrimitive["kind"];

/** A new shape at the origin, sized from the design. */
export function newPrimitive(kind: ShapeKind): DesignPrimitive {
  const a = designScale();
  const h = a / 2;
  switch (kind) {
    case "box": return { kind, start: [-h, -h, 0], stop: [h, h, h] };
    case "cylinder": return { kind, axis: "z", center: [0, 0], radius: a / 4, inner_radius: 0, range: [0, a] };
    case "sphere": return { kind, center: [0, 0, h], radius: a / 4 };
    case "polygon": return { kind, normal: "z", elevation: 0, points: [[-h, -h], [h, -h], [0, h]] };
    case "linpoly": return { kind, normal: "z", elevation: 0, length: h, points: [[-h, -h], [h, -h], [h, h], [-h, h]] };
    case "cone": return { kind, axis: "z", center: [0, 0], bottom_radius: a / 4, top_radius: 0, range: [0, a] };
    case "torus": return { kind, axis: "z", center: [0, 0, h], major_radius: a / 4, minor_radius: a / 20 };
    case "wire": return { kind, points: [[0, 0, 0], [0, 0, a]], radius: a / 50 };
    // a tetrahedron (no drawing tool: polyhedra come from an example or a CST import)
    case "polyhedron": return { kind, vertices: [[-h, -h, 0], [h, -h, 0], [0, h, 0], [0, 0, a]], faces: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]] };
  }
}

const PART_NAMES: Record<ShapeKind, string> = { box: "brick", cylinder: "cylinder", sphere: "sphere", polygon: "polygon", linpoly: "extrusion", cone: "cone", torus: "torus", wire: "wire", polyhedron: "solid" };

/** Reveal an addition once. Selection alone, edits and later server previews never move the camera. */
export function selectAddedGeometry(s: Extract<Selection, { type: "part" | "primitive" }>) {
  setSelection(s);
  if (appMode() !== "design") return;
  const d = unwrap(draft), part = d.parts[s.i];
  if (!part) return;
  const added = s.type === "primitive" ? { ...part, primitives: [part.primitives[s.j]] } : part;
  // Resolve only the new geometry, including its part's cuts and transforms. Unrelated parts and
  // ports may still contain unfinished expressions and must not prevent a valid addition's fit.
  const b = quickBundle({ ...d, parts: [added], ports: [] }, names().names, null);
  const bounds = b?.parts[0]?.bbox;
  if (!bounds || !bounds.flat().every(Number.isFinite)) return;
  // Adding before the initial server preview finishes must win over its default model fit.
  if (!previewActive()) {
    const preview = quickBundle(d, names().names, bundle());
    if (preview) showQuickPreview(preview);
  }
  setHiddenParts(part.name, false);
  window.dispatchEvent(new CustomEvent("fairbeam:frame-added", {
    detail: { bounds, label: part.label ?? part.name },
  }));
}

/** Reveal an added port or resistor once, like selectAddedGeometry: the camera fits it with the
 * smallest metal it touches (frameBounds), so a new feed shows where it sits on its conductor. */
export function selectAddedFeed(s: Extract<Selection, { type: "port" | "resistor" }>) {
  setSelection(s);
  if (appMode() !== "design") return;
  const bounds = frameBounds(s);
  if (!bounds) return;
  const label = s.type === "port" ? `port ${draft.ports[s.i]?.number ?? s.i + 1}` : draft.resistors[s.i]?.name || `R${s.i + 1}`;
  window.dispatchEvent(new CustomEvent("fairbeam:frame-added", { detail: { bounds, label } }));
}

export function addShape(kind: ShapeKind) {
  // a new solid, in the design's metal (the one used last, else the first, else a new copper)
  const metal = pickShapeMaterial(draft.materials, lastShapeMaterial(file()?.id), "");
  edit((d) => {
    if (!metal) d.materials.push({ name: unique("copper", d.materials.map((m) => m.name)), kind: "metal" });
    const mat = metal || d.materials[d.materials.length - 1].name;
    const part: DesignPart = { name: unique(PART_NAMES[kind], d.parts.map((p) => p.name)), material: mat, primitives: [newPrimitive(kind)] };
    d.parts.push(part);
  }, "", `Add ${PART_NAMES[kind]}`);
  selectAddedGeometry({ type: "primitive", i: draft.parts.length - 1, j: 0 });
}

export function addPrimitiveToPart(i: number, kind: ShapeKind) {
  edit((d) => { d.parts[i].primitives.push(newPrimitive(kind)); }, "", t("history.addTo", { what: PART_NAMES[kind], name: draft.parts[i]?.label || draft.parts[i]?.name || t("history.part") }));
  selectAddedGeometry({ type: "primitive", i, j: draft.parts[i].primitives.length - 1 });
}

// ------------------------------------------------------------------ transforms (with copies)

export function addTransform(i: number, type: DesignTransform["type"]) {
  openTransform(type, { type: "part", i });
}

export function removeTransform(i: number, k: number) {
  edit((d) => {
    d.parts[i].transforms?.splice(k, 1);
    if (!d.parts[i].transforms?.length) delete d.parts[i].transforms;
  });
}

// ------------------------------------------------------------------ cuts (a boolean subtraction for sheets)

/** The part's first flat sheet a cut can remove area from (a rectangular sheet, a polygon, a flat
 * circle): its plane (normal axis index and the sheet's own expression for the position), its centre
 * and its extent along the two in-plane axes, in numbers. */
function firstSheet(part: DesignPart): { k: number; at: Expr; c: [number, number]; size: [number, number] } | null {
  const n = names().names;
  const ev = (e: Expr) => tryEvaluate(e, n).value;
  for (const pr of part.primitives) {
    if (pr.kind === "box") {
      const a = pr.start.map(ev), b = pr.stop.map(ev);
      if ([...a, ...b].some((x) => x === undefined)) continue;
      const flat = [0, 1, 2].filter((q) => Math.abs(b[q]! - a[q]!) < 1e-12);
      if (flat.length !== 1) continue;
      const k = flat[0], [u, v] = [(k + 1) % 3, (k + 2) % 3];
      return { k, at: pr.start[k], c: [(a[u]! + b[u]!) / 2, (a[v]! + b[v]!) / 2], size: [Math.abs(b[u]! - a[u]!), Math.abs(b[v]! - a[v]!)] };
    }
    if (pr.kind === "polygon") {
      const pts = pr.points.map((q) => [ev(q[0]), ev(q[1])]);
      const at = ev(pr.elevation);
      if (at === undefined || pts.some((q) => q[0] === undefined || q[1] === undefined) || !pts.length) continue;
      const us = pts.map((q) => q[0]!), vs = pts.map((q) => q[1]!);
      const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
      return { k: ["x", "y", "z"].indexOf(pr.normal), at: pr.elevation, c: [(u0 + u1) / 2, (v0 + v1) / 2], size: [u1 - u0, v1 - v0] };
    }
    if (pr.kind === "cylinder" && "axis" in pr) {
      const [lo, hi, r, cu, cv] = [ev(pr.range[0]), ev(pr.range[1]), ev(pr.radius), ev(pr.center[0]), ev(pr.center[1])];
      if ([lo, hi, r, cu, cv].some((x) => x === undefined) || Math.abs(hi! - lo!) >= 1e-9) continue;
      return { k: ["x", "y", "z"].indexOf(pr.axis), at: pr.range[0], c: [cu!, cv!], size: [2 * r!, 2 * r!] };
    }
  }
  return null;
}

/** A slot in the part's first flat sheet: centred, a tenth of its width across and half its length
 * along its longer side, in the sheet's plane (the sheet's own expressions for the plane). */
export function addCut(i: number) {
  const part = draft.parts[i];
  const sheet = firstSheet(part);
  let cut: DesignCut;
  if (sheet) {
    const { k, at, c, size } = sheet, [u, v] = [(k + 1) % 3, (k + 2) % 3];
    const [long, short] = size[0] >= size[1] ? [u, v] : [v, u];
    const centre = (q: number) => c[q === u ? 0 : 1], len = (q: number) => size[q === u ? 0 : 1];
    const start: Vec3 = [0, 0, 0], stop: Vec3 = [0, 0, 0];
    start[k] = at; stop[k] = at;
    start[long] = centre(long) - len(long) / 4; stop[long] = centre(long) + len(long) / 4;
    start[short] = centre(short) - len(short) / 20; stop[short] = centre(short) + len(short) / 20;
    cut = { start, stop };
  } else {
    const s = designScale();
    cut = { start: [-s / 10, -s / 2, 0], stop: [s / 10, s / 2, 0] };
  }
  edit((d) => { (d.parts[i].cuts ??= []).push(cut); }, "", t("history.addBoolean", { name: part.label || part.name }));
}

/** A round hole in the part's first flat sheet: centred, a sixth of its smaller side across the radius. */
export function addRoundCut(i: number) {
  const part = draft.parts[i];
  const sheet = firstSheet(part);
  const s = designScale();
  const cut: DesignCut = sheet
    ? { kind: "circle", normal: (["x", "y", "z"] as const)[sheet.k], elevation: sheet.at, center: [sheet.c[0], sheet.c[1]],
      radius: Math.max(Math.min(...sheet.size) / 6, 1e-3) }
    : { kind: "circle", normal: "z", elevation: 0, center: [0, 0], radius: s / 10 };
  edit((d) => { (d.parts[i].cuts ??= []).push(cut); }, "", t("history.addBoolean", { name: part.label || part.name }));
}

/** A diamond cut in the part's first flat sheet: centred, a quarter of its smaller side from the centre to each tip. */
export function addPolygonCut(i: number) {
  const part = draft.parts[i];
  const sheet = firstSheet(part);
  const s = designScale();
  const [cu, cv, r] = sheet ? [sheet.c[0], sheet.c[1], Math.max(Math.min(...sheet.size) / 4, 1e-3)] : [0, 0, s / 8];
  const cut: DesignCut = { kind: "polygon", normal: sheet ? (["x", "y", "z"] as const)[sheet.k] : "z", elevation: sheet ? sheet.at : 0,
    points: [[cu - r, cv], [cu, cv - r], [cu + r, cv], [cu, cv + r]] };
  edit((d) => { (d.parts[i].cuts ??= []).push(cut); }, "", t("history.addBoolean", { name: part.label || part.name }));
}

export function removeCut(i: number, k: number) {
  edit((d) => {
    d.parts[i].cuts?.splice(k, 1);
    if (!d.parts[i].cuts?.length) delete d.parts[i].cuts;
  }, "", `Remove boolean cut from ${draft.parts[i]?.label || draft.parts[i]?.name || "part"}`);
}

/** Shapes a part expands to (its transforms evaluated), or null when a count does not evaluate. */
export function copyCount(part: DesignPart): number | null {
  let n = 1;
  for (const t of part.transforms ?? []) {
    if (t.type === "move") continue;
    if (t.type === "mirror") n *= t.keep === false ? 1 : 2;
    else {
      const c = tryEvaluate(t.copies ?? 0, names().names).value;
      if (c === undefined || c < 0 || Math.abs(c - Math.round(c)) > 1e-9) return null;
      n *= Math.round(c) + 1;
    }
  }
  return n;
}

/** An old start/stop cylinder along x, y or z in the axis form (axis, center, radius, range). */
export function toAxisCylinder(i: number, j: number): boolean {
  const pr = draft.parts[i]?.primitives[j];
  if (!pr || pr.kind !== "cylinder" || !("start" in pr)) return false;
  const n = names().names;
  const a = pr.start.map((e) => tryEvaluate(e, n).value), b = pr.stop.map((e) => tryEvaluate(e, n).value);
  if ([...a, ...b].some((v) => v === undefined)) return false;
  const moving = [0, 1, 2].filter((k) => Math.abs(b[k]! - a[k]!) > 1e-12);
  if (moving.length !== 1) return false;
  const k = moving[0], [u, v] = [(k + 1) % 3, (k + 2) % 3];
  const [lo, hi] = a[k]! <= b[k]! ? [pr.start[k], pr.stop[k]] : [pr.stop[k], pr.start[k]];
  edit((d) => {
    d.parts[i].primitives[j] = { kind: "cylinder", axis: "xyz"[k] as Axis, center: [pr.start[u], pr.start[v]], radius: pr.radius,
      ...(pr.inner_radius !== undefined ? { inner_radius: pr.inner_radius } : {}), range: [lo, hi], ...(pr.priority !== undefined ? { priority: pr.priority } : {}) };
  });
  return true;
}

// ------------------------------------------------------------------ checks -> selection

/** The item a check's JSON path belongs to. */
export function selectionForPath(path: string): Selection {
  let m: RegExpExecArray | null;
  if ((m = /^params\[(\d+)\]/.exec(path))) return { type: "param", i: +m[1] };
  if ((m = /^materials\.([^.]+)/.exec(path))) {
    const i = draft.materials.findIndex((x) => x.name === m![1]);
    if (i >= 0) return { type: "material", i };
  }
  if ((m = /^materials\[(\d+)\]/.exec(path))) return { type: "material", i: +m[1] };
  if ((m = /^parts\[(\d+)\]\.primitives\[(\d+)\]/.exec(path))) return { type: "primitive", i: +m[1], j: +m[2] };
  if ((m = /^parts\[(\d+)\]/.exec(path))) return { type: "part", i: +m[1] };
  if ((m = /^ports\[(\d+)\]/.exec(path))) return { type: "port", i: +m[1] };
  if ((m = /^resistors\[(\d+)\]/.exec(path))) return { type: "resistor", i: +m[1] };
  if (/^(simulation|mesh|far_field|monitors)/.test(path)) return { type: "simulation" };
  return { type: "design" };
}

/** The input id of a field (DesignPane's ExprField uses the same rule). */
export const fieldId = (path: string) => `dz-${path.replace(/[^\w]/g, "-")}`;

/** Apply a check's offered edit (``fix.set`` of design_checks): each JSON path gets its value, in one
 * undo step. */
export function applyFix(set: CheckFix["set"]) {
  // the paths come from the server's last check; after an edit (or with the server offline) they
  // may point at another item, so the fix waits for the checks of the current draft
  if (!checksTicket() || !asyncState.isDraftCurrent(checksTicket()!)) {
    setMessage({ tone: "warn", text: t("store.checksCatchingUp") });
    return;
  }
  edit((d) => {
    for (const [path, value] of Object.entries(set)) {
      const keys = path.match(/[^.[\]]+/g) ?? [];
      let o = d as unknown as Record<string, unknown> | undefined;
      for (const k of keys.slice(0, -1)) o = o?.[k] as Record<string, unknown> | undefined;
      if (o && keys.length) o[keys[keys.length - 1]] = typeof value === "object" && value !== null ? structuredClone(value) : value;
    }
  });
}

/** A component path in canonical form (navModel.ts, pure for the tree's checks). */
export { normComponent };

/** Put part ``i`` into the component folder ``path`` ("" = the top level): only the tree's grouping
 * changes, the simulation ignores components. One undo step, with a message. */
export function moveToComponent(i: number, path: string) {
  const to = normComponent(path), part = draft.parts[i];
  if (!part || normComponent(part.component) === to) return;
  edit((d) => { if (to) d.parts[i].component = to; else delete d.parts[i].component; });
  setSelection({ type: "part", i });
  setMessage({ tone: "good", text: to ? t("store.moved", { part: part.label || part.name, to }) : t("store.movedTop", { part: part.label || part.name }) });
}

/** Drop part ``i`` onto part ``onto``: into its folder, or, when ``onto`` is at the top level, into a
 * new component holding both (named after ``onto``), like grouping two icons. One undo step. */
export function groupParts(i: number, onto: number) {
  const a = draft.parts[i], b = draft.parts[onto];
  if (!a || !b || i === onto) return;
  const folder = normComponent(b.component);
  if (folder) return moveToComponent(i, folder);
  const taken = new Set(componentFolders());
  const base = (b.label || b.name).replace(/[/\s]+/g, " ").trim() || "group";
  let name = base;
  for (let k = 2; taken.has(name); k++) name = `${base} ${k}`;
  edit((d) => { d.parts[i].component = name; d.parts[onto].component = name; });
  setSelection({ type: "part", i });
  setMessage({ tone: "good", text: t("store.grouped", { a: a.label || a.name, b: b.label || b.name, name }) });
}

/** Every component folder in use, parents included ("antenna" for "antenna/feed"), sorted. */
export function componentFolders(): string[] {
  const out = new Set<string>();
  for (const p of [...draft.parts, ...(draft.components ?? []).map(component => ({ component }))]) {
    const segs = normComponent(p.component).split("/").filter(Boolean);
    segs.forEach((_, k) => out.add(segs.slice(0, k + 1).join("/")));
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** Select the item a check points at and focus its field (or the first field under that path). */
export function focusPath(path: string, options: { frame?: boolean; focus?: boolean } = {}) {
  if (/^params\[\d+\]\.(min|max)$/.test(path)) setParameterRanges(true);
  if (/^params(?:\[|$)/.test(path)) openParametersTab();
  const s = selectionForPath(path);
  setSelection(s);
  if (options.frame) {
    setCenterView("3d");
    const bounds = frameBounds(s);
    if (bounds) {
      if (!previewActive()) {
        const preview = quickBundle(unwrap(draft), names().names, bundle());
        if (preview) showQuickPreview(preview);
      }
      if (s.type === "part" || s.type === "primitive") setHiddenParts(draft.parts[s.i].name, false);
      // Switching from Drawing mounts the viewport before this one-shot request is delivered.
      requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("fairbeam:frame-added", { detail: { bounds, label: path, reason: "check" } })));
    }
  }
  if (options.focus === false) return;
  const target = path === "mesh" ? "mesh.cells_per_wavelength" : path;
  const pointPath = target.match(/^parts\[\d+\]\.primitives\[\d+\]\.points\[(\d+)\](?:\[|$)/);
  if (pointPath) window.dispatchEvent(new CustomEvent("fairbeam:reveal-point", { detail: { path: target, index: Number(pointPath[1]) } }));
  requestAnimationFrame(() => {
    // the field itself, else the first field under it, else the nearest enclosing one
    let p = target;
    for (;;) {
      const id = fieldId(p);
      const el = (document.getElementById(id) ?? document.querySelector(`[id^="${id}-"]`)) as HTMLElement | null;
      if (el) {
        // Native details keep fields mounted; reveal every enclosing disclosure before focusing.
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement) parent.open = true;
        }
        el.scrollIntoView({ block: "nearest" });
        el.focus();
        return;
      }
      const up = p.replace(/(\[\d+\]|\.[^.[\]]+)$/, "");
      if (up === p || !up) return;
      p = up;
    }
  });
}

/** Resolve just the checked item, so unrelated invalid fields cannot prevent its fit. */
export function selectionBounds(s: Selection): import("../types").Part["bbox"] | null {
  const d = unwrap(draft), values = names().names;
  let bounds: import("../types").Part["bbox"] | undefined;
  if (s.type === "part" || s.type === "primitive") {
    const part = d.parts?.[s.i];
    if (!part || (s.type === "primitive" && !part.primitives[s.j])) return null;
    const item = s.type === "primitive" ? { ...part, primitives: [part.primitives[s.j]] } : part;
    bounds = quickBundle({ ...d, parts: [item], ports: [], simulation: { ...d.simulation, f_min: 1, f_max: 2 } }, values, null)?.parts[0]?.bbox;
  } else if (s.type === "port" || s.type === "resistor") {
    const item = s.type === "port" ? d.ports?.[s.i] : d.resistors?.[s.i];
    if (!item) return null;
    const points = portFeedEntries(item, "").flatMap(([, feed]) => [feed.start, feed.stop])
      .map((point) => point.map((v) => tryEvaluate(v, values).value ?? NaN));
    bounds = [[0, 1, 2].map((k) => Math.min(...points.map((point) => point[k]))),
      [0, 1, 2].map((k) => Math.max(...points.map((point) => point[k])))] as import("../types").Part["bbox"];
  }
  return bounds?.flat().every(Number.isFinite) ? bounds : null;
}

/** Camera bounds for a check: the item itself, and for a port or resistor also the smallest metal
 * part it touches (the patch a probe feeds, not the ground plane), so the view shows where the feed
 * sits on its conductor. Only the camera uses this: the selection outline keeps selectionBounds. */
export function frameBounds(s: Selection): import("../types").Part["bbox"] | null {
  type Bounds = import("../types").Part["bbox"];
  const exact = selectionBounds(s);
  if (!exact || (s.type !== "port" && s.type !== "resistor")) return exact;
  const metals = new Set(draft.materials.filter((m) => m.kind === "metal").map((m) => m.name));
  const size = (b: Bounds) => Math.hypot(...b[1].map((v, k) => v - b[0][k]));
  let best: Bounds | null = null;
  for (let i = 0; i < draft.parts.length; i++) {
    if (!metals.has(draft.parts[i].material)) continue;
    const b = selectionBounds({ type: "part", i });
    if (!b) continue;
    const tol = 1e-6 * Math.max(1, size(b), size(exact));
    const touches = [0, 1, 2].every((k) => b[0][k] <= exact[1][k] + tol && exact[0][k] <= b[1][k] + tol);
    if (touches && (!best || size(b) < size(best))) best = b;
  }
  if (!best) return exact;
  const ctx = best;
  return [exact[0].map((v, k) => Math.min(v, ctx[0][k])), exact[1].map((v, k) => Math.max(v, ctx[1][k]))] as Bounds;
}

export const [feedCreation, setFeedCreation] = createSignal<"lumped" | "waveguide" | "element" | null>(null);
export function addPort() { setFeedCreation("lumped"); }
export function createFeed(value: import("./types").DesignPort | import("./types").DesignResistor) {
  const isPort = "number" in value;
  edit((d) => { if (isPort) d.ports.push(value); else d.resistors.push(value); });
  setFeedCreation(null);
  selectAddedFeed({ type: isPort ? "port" : "resistor", i: (isPort ? draft.ports : draft.resistors).length - 1 });
}

/** A TE10 waveguide port sized from the design (a = 2 b), exciting along +z. */
export function addWaveguidePort() { setFeedCreation("waveguide"); }

/** Switch a port between lumped and waveguide, keeping its place (a waveguide takes a × b from the
 * port box across its direction where it has one). */
export function setPortType(i: number, type: "lumped" | "waveguide") {
  if (type === "waveguide" && draft.ports[i]?.group) {
    setMessage({ tone: "warn", text: t("props.port.group.removeBeforeWaveguide") });
    return;
  }
  const n = names().names;
  edit((d) => {
    const p = d.ports[i];
    if (p.type === type) return;
    p.type = type;
    if (type === "waveguide") {
      const k = "xyz".indexOf(p.direction), [u, v] = [(k + 1) % 3, (k + 2) % 3];
      const span = (ax: number) => Math.abs((tryEvaluate(p.stop[ax], n).value ?? 0) - (tryEvaluate(p.start[ax], n).value ?? 0));
      const s = designScale();
      p.mode = "TE10";
      p.a = span(u) > 0 ? span(u) : 2 * s;
      p.b = span(v) > 0 ? span(v) : s;
      delete p.R; delete p.reference_impedance;
    } else {
      delete p.mode; delete p.a; delete p.b;
      p.R = 50;
    }
  }, `ports[${i}].type`);
}

export function addResistor() { setFeedCreation("element"); }

export function addParam() {
  edit((d) => {
    d.params.push({ key: unique("p", d.params.map((p) => p.key)), default: 1, unit: "mm" });
  });
  focusPath(`params[${draft.params.length - 1}].key`);
}

export function addMaterial(kind: "metal" | "dielectric") {
  edit((d) => {
    const base = kind === "metal" ? "metal" : "dielectric";
    d.materials.push(kind === "metal" ? { name: unique(base, d.materials.map((m) => m.name)), kind }
      : { name: unique(base, d.materials.map((m) => m.name)), kind, eps_r: 4.3, tan_d: 0.02, tan_d_freq: 1 });
  });
  setSelection({ type: "material", i: draft.materials.length - 1 });
}

/** A copy of a library material's values, under a free name (the design stays self-contained). */
export function addLibraryMaterial(m: LibraryMaterial) {
  edit((d) => { d.materials.push(designMaterial(m, unique(m.name, d.materials.map((q) => q.name)))); });
  setSelection({ type: "material", i: draft.materials.length - 1 });
}

/** A copy of a "My materials" entry's values, under a free name (the design stays self-contained). */
export function addUserMaterial(m: UserMaterial) {
  edit((d) => { d.materials.push(designMaterialFromUser(m, unique(m.name, d.materials.map((q) => q.name)))); });
  setSelection({ type: "material", i: draft.materials.length - 1 });
}

/** Set (or, with undefined, clear) the display color of parts or materials: one undo step for all. */
export function setColors(kind: "parts" | "materials", indices: number[], color: string | undefined) {
  const c = color === undefined ? undefined : validColor(color);
  if (color !== undefined && !c) return;
  edit((d) => {
    for (const i of indices) {
      const o = d[kind][i];
      if (!o) continue;
      if (c) o.color = c; else delete o.color;
    }
  }, `${kind}[${indices[0] ?? 0}].color`);
}

/** Remove the selected item (a material only when no part uses it). */
export function removeSelected() {
  const s = selection();
  if (s.type === "material" && draft.parts.some((p) => p.material === draft.materials[s.i]?.name)) {
    setMessage({ tone: "warn", text: t("store.materialInUse", { material: draft.materials[s.i].name }) });
    return;
  }
  const list = { param: "params", material: "materials", part: "parts", port: "ports", resistor: "resistors" } as const;
  edit((d) => {
    if (s.type === "primitive") {
      d.parts[s.i].primitives.splice(s.j, 1);
      if (!d.parts[s.i].primitives.length) d.parts.splice(s.i, 1);
    } else if (s.type in list) {
      (d[list[s.type as keyof typeof list]] as unknown[]).splice((s as { i: number }).i, 1);
    }
  }, "", `Remove ${s.type}`);
  setSelection({ type: "design" });
}

export function duplicateSelected() {
  const s = selection();
  edit((d) => {
    if (s.type === "part") {
      const p = structuredClone(unwrap(d.parts[s.i]));
      p.name = unique(p.name, d.parts.map((q) => q.name));
      // "Patch" -> "Patch copy" -> "Patch copy 2", not "Patch copy copy"
      const base = (d.parts[s.i].label || d.parts[s.i].name).replace(/ copy( \d+)?$/, "");
      const taken = new Set(d.parts.map((q) => q.label || q.name));
      let label = `${base} copy`;
      for (let k = 2; taken.has(label); k++) label = `${base} copy ${k}`;
      p.label = label;
      d.parts.splice(s.i + 1, 0, p);
    } else if (s.type === "primitive") {
      d.parts[s.i].primitives.splice(s.j + 1, 0, structuredClone(unwrap(d.parts[s.i].primitives[s.j])));
    } else if (s.type === "port") {
      const p = structuredClone(unwrap(d.ports[s.i]));
      p.number = Math.max(...d.ports.map((q) => q.number)) + 1;
      d.ports.push(p);
    }
  }, "", `Duplicate ${s.type}`);
  // the copy lies exactly on the original, so say where it went: otherwise nothing seems to happen
  if (s.type === "part") {
    selectAddedGeometry({ type: "part", i: s.i + 1 });
    setMessage({ tone: "good", text: t("store.duplicatedPart", { label: draft.parts[s.i + 1].label }) });
  } else if (s.type === "primitive") {
    selectAddedGeometry({ type: "primitive", i: s.i, j: s.j + 1 });
    setMessage({ tone: "good", text: t("store.duplicatedShape") });
  } else if (s.type === "port") {
    selectAddedFeed({ type: "port", i: draft.ports.length - 1 });
    setMessage({ tone: "good", text: t("store.duplicatedPort", { number: draft.ports.at(-1)!.number }) });
  }
}

export const canRemove = () => !["design", "simulation"].includes(selection().type);
export const canDuplicate = () => ["part", "primitive", "port"].includes(selection().type);

/** A part picked in the 3D view; a click on empty space (null) clears the selection. */
export function pickPart(name: string | null) {
  if (!loaded()) return;
  if (!name) {
    if (selection().type !== "design") setSelection({ type: "design" });
    return;
  }
  const i = draft.parts.findIndex((p) => p.name === name);
  if (i >= 0) setSelection({ type: "part", i });
}

// ------------------------------------------------------------------ new parameters from expressions

/** A name an expression uses that is not a parameter yet: the "New parameter" dialog asks for it. */
export interface ParamAsk {
  key: string;
  /** unit of the field it came from (prefills the parameter's unit) */
  unit?: string;
  /** where the parameter goes in the list (a derived parameter may only use the ones above it); default: the end */
  insertAt?: number;
  /** the dialog renamed the key: rewrite the field's expression */
  rename?: (from: string, to: string) => void;
}
export const [paramAsks, setParamAsks] = createSignal<ParamAsk[]>([]);

/** Names in an expression that are neither parameters nor functions / constants. */
export function unknownNames(e: Expr | undefined | null): string[] {
  if (e === undefined || e === null || typeof e === "number" || !loaded()) return [];
  const known = new Set((draft.params ?? []).map((p) => p.key));
  return [...namesIn(e)].filter((n) => !known.has(n) && !RESERVED.has(n));
}

/** Queue "New parameter" dialogs, one after another (names already queued are skipped). */
export function askParams(asks: ParamAsk[]) {
  const queued = new Set(paramAsks().map((a) => a.key));
  const fresh = asks.filter((a) => !queued.has(a.key) && unknownNames(a.key).length > 0);
  if (fresh.length) setParamAsks((q) => [...q, ...fresh]);
}

/** Every whole-word use of `from` in an expression replaced by `to`. */
export const renameInExpr = (e: string, from: string, to: string) =>
  e.replace(new RegExp(`(?<![\\w.])${from.replace(/[^\w]/g, "")}(?!\\w)`, "g"), to);

/** Add a parameter (at `at`, default the end) in one undo step; a selected parameter below it stays selected. */
export function createParam(p: DesignParam, at?: number) {
  const i = at === undefined ? draft.params.length : Math.max(0, Math.min(at, draft.params.length));
  edit((d) => { d.params.splice(i, 0, p); });
  const s = selection();
  if (s.type === "param" && s.i >= i) setSelection({ type: "param", i: s.i + 1 });
}

// ------------------------------------------------------------------ deleting a design

/** Delete a design (the server moves the file into its history folder). If it is open, it is
 * closed (unsaved changes are dropped) and the start screen shows. Throws the server's error. */
export async function deleteDesign(id: string): Promise<string> {
  const owner = file(), ticket = asyncState.ticket();
  const scope = owner?.id === id ? owner.backup_scope : health()?.backup_scope;
  const res = await api.deleteDesign(id, scope);
  const sameDocument = asyncState.isDocumentCurrent(ticket);
  if (sameDocument && defaultDesignerIO.navigationTarget() === id) {
    asyncState.cancelNavigation();
    defaultDesignerIO.setNavigationTarget(null);
    setLoading(false);
  }
  clearBackup(id, res.backup_scope);
  if (sameDocument && file()?.id === id && file()?.backup_scope === res.backup_scope) {
    defaultDesignerSession.notifyDocumentChange();
    clearTimeout(backupTimer);
    stopPreview();
    asyncState.replaceDocument();
    defaultDesignerIO.forgetRelease();
    defaultDesignerSession.forgetSaveNote();
    batch(() => {
      setFile(null);
      setDraft(reconcile({} as Design));
      defaultDesignerSession.resetHistory();
      setServerErrors({});
      setServerChecks([]);
      setConflict(null);
      setSelection({ type: "design" });
      setParamAsks([]);
      setMessage(null);
      setSaving(false);
    });
    if (appMode() === "design" && defaultDesignerIO.navigationTarget() === null) setAppMode("home");
  }
  if (sameDocument && modelKey() === id) selectModel("");
  await refreshModels();
  return res.moved_to;
}
