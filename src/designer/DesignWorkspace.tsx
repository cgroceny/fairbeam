// The designer workspace: a ribbon over the 3D view, the navigation tree on the left
// (NavTree.tsx: the design, geometry and the results of its runs), the properties of
// the selection on the right, checks and results at the bottom. Helper dialogs set the work plane
// (WCS) and add transforms. The inspector, fields and checks come from DesignPane.tsx; drawing is
// src/designer/draw.ts + src/scene/drawOverlay.ts.
import { createEffect, createSignal, For, type JSX, lazy, on, onCleanup, onMount, Show } from "solid-js";
import {
  Box, CircleDot, Cone, Cylinder, Eye, EyeOff, FileCode, Globe, Grid3x3, Hexagon, Home, Layers, LayoutGrid, Library,
  Camera, FileText, Radio, Waves, History, Move3d,
  MousePointer2, MousePointerClick, Pencil, Play, Plus, Redo2, Save, Settings2, Cog, SlidersHorizontal, Spline, Torus, Trash2, Triangle, Undo2, X, Zap, Keyboard,
  ChevronDown, ChevronUp, ChevronsRight, FileUp, Activity, Gauge, Layers2, CircuitBoard, ClipboardList, LocateFixed, Shapes, ScanLine, ChartNoAxesCombined, SlidersVertical,
  ArrowUpFromLine, Combine, Circle, PenTool, Fullscreen, AudioWaveform, Radar, Package, Omega, Timer, ChartScatter, ChartLine, Grid2x2, Diamond, Anvil, CopyPlus, Clipboard,
  SquareDashed, RectangleHorizontal, Rotate3d, LayoutDashboard, Gem, Aperture,
} from "lucide-solid";
import { health, meshFreshness, setRunOpen } from "../runner/store";
import { setCstImportOpen } from "../lib/cstImport";
import { setPcbImportOpen } from "../lib/pcbImport";
import { CLOSE_KEY, requestCloseProject } from "./CloseProject";
import { bundle, layers, setLayers, setSelectedPart, setSelectedShape, type Layers as LayerState } from "../state";
import { SAVE_KEY } from "../editor/store";
import { openSimSettings, runDialogOpen, setRunDialogOpen, setSimSettingsOpen, simSettingsOpen, sweepDialogOpen } from "../runner/designRun";
import { EFFICIENCY_POINTS_DEFAULT } from "./checks";
import FeedCreationDialog from "./FeedCreationDialog";
import BackupNotice from "./BackupNotice";
import RunDialog from "./RunDialog";
import OptimizeDialog, { openDesignerOptimize } from "./OptimizeDialog";
const SweepDialog = lazy(() => import("./SweepDialog"));
const openDesignerSweep = () => import("./SweepDialog").then((m) => m.openDesignerSweep());
import ConvergenceDialog, { openMeshConvergence } from "./ConvergenceDialog";
import { PythonPanel, isPythonPanelActive, openPythonPanel } from "./PythonPanel";
import { setSidePanelCollapsed, toggleBottomDock, toggleLeftTree, toggleSidePanel } from "./layoutState";
import RunDock from "./RunDock";
import { meshView, setMeshView, toggleMeshView } from "./MeshView";
import SimSettingsDialog from "./SimSettingsDialog";
import { setAppMode } from "../workspace";
import {
  armBoolean, acceptBooleanPick, automaticOverlap, booleanPending, booleanNotice, booleanHistory, setBooleanNotice, setBooleanPending, resolveAutomaticOverlap, restoreBooleanPart,
  applyPendingBoolean, runBoolean, selectedPair, booleanPreviewError, booleanPreviewNote, booleanShortcut, overlapChoices, partTitle, selectedPartIndex, setBooleanOperation, setOverlapChoice, swapBooleanOperands, BOOLEAN_LABELS, BOOLEAN_SYMBOLS,
} from "./booleanUi";
import { operandBToken } from "./booleanPreview";
import { BooleanTargets } from "./BooleanTargets";
import PointTools, { PointReadout, usePointTools } from "./pointTools";
import { selectedVertexTarget, stopVertexEdit, toggleVertexEdit, vertexTarget } from "./vertexEdit";
import type { BooleanOperation } from "./booleanUi";
import { tryEvaluate } from "./expr";
import { shown as fmt } from "./displayNumber.ts";
import { t } from "../i18n";
import { cellsText, meshStats } from "./meshStats";
import { leaveResultsFor, resultFocus } from "./resultFocus";
import { activateMainTab, cycleMainTabs, focusActiveMainTab } from "./mainTabsState";
import { openRibbonResult, ribbonCurrents, ribbonExportReady, ribbonFarfield, ribbonFieldPlanes, ribbonPattern3d, ribbonResult } from "./ribbonResults";
import { ARRAY_PATTERN_NOTE, PatternQuantitySelect } from "../components/FarfieldCard";
import { farfieldOverride } from "../lib/arrayStore";
import RibbonField from "./RibbonField";
import "../styles/ribbon.css";
import { cyclePanes } from "./panes";
import type { Expr } from "./types";
import { ExprField, Inspector, kindLabel } from "./DesignPane";
import { humanizePaths } from "./pathText";
import { NavTree } from "./NavTree";
import { CAMERA_VIEWS, type ViewName } from "../scene/cameraViews";
import { CameraViewIcon } from "../scene/CameraViewIcon";
import { ShapeDialogHost } from "./dialogs/ShapeDialog";
import { NewParamHost } from "./dialogs/NewParamDialog";
import { openShapeDialog } from "./dialogs/shapes";
import { MaterialLibraryDialog } from "./MaterialLibrary";
import { UserMaterialsDialog } from "./UserMaterialsDialog";
import ContextMenu from "./ContextMenu";
import ColorPopoverHost from "./ColorPopover";
import { TRANSFORM_RIBBON_ITEMS } from "./transformRibbon";
import { WcsDialogHost } from "./dialogs/WcsDialog";
import { openTransform } from "./transforms";
import { setRenaming } from "./context";
import { matchesShortcut, SHORTCUTS } from "./shortcuts";
import { commandModifier, isMacPlatform } from "../lib/shortcut";
import { showShortcutHelp } from "./ShortcutHelp";
import FaceExtrudeDialog from "./FaceExtrudeDialog";
import { HistoryDialog } from "./HistoryDialog";
import {
  addMaterial, addParam, addPort, addWaveguidePort, addResistor, addShape, canDuplicate, canRedo, canRemove, canUndo, undoLabel, redoLabel, conflict, dirty, draft, issueUnder, names,
  duplicateSelected, edit, errorCount, exportPython, file, highlightedPart, message, pickPart, redo, removeSelected, save, saving,
  selection, setMessage, setSelection, type ShapeKind, undo,
} from "./store";
import { downloadFailedMessage, downloadMessage, revealDownloadedFile, saveDownload } from "../lib/download";
import {
  axisName, cancel, commit, confirmShapes, facePicking, extrudeFacePicking, height, heightStep, HINTS, plane, planeAxes, points, resetWcsToGlobal, setConfirmShapes, setHeight, setWcsDialog, setWcsVisible, wcsIsGlobal, wcsVisible,
  setFacePicking, setExtrudeFacePicking, setSnap, setSnapTo, snap, snapTo, type SnapKind, startTool, tool, type DrawTool,
} from "./draw";
import { captureActiveSurface, screenshotAvailable, screenshotReason } from "../components/exportContext";
import NumberField from "../components/NumberField";
import { renderedView, setRenderDialogOpen, setRenderedView } from "../render/state";

const [pythonSavePath, setPythonSavePath] = createSignal<string | undefined>();

/** A translated text whose {placeholders} are JSX (chips, bold names): "{a} overlaps {b}". */
function rich(text: string, parts: Record<string, JSX.Element>): JSX.Element {
  return text.split(/\{(\w+)\}/).map((piece, i) => (i % 2 ? parts[piece] ?? `{${piece}}` : piece));
}

// ------------------------------------------------------------------ ribbon

function RButton(props: { icon: typeof Box; label: string; title?: string; action?: string; onClick: () => void; disabled?: boolean; pressed?: boolean; primary?: boolean; issue?: "error" | "warning" | null; ariaKeyShortcuts?: string }) {
  return (
    <button class="rb-btn" data-action={props.action} classList={{ "rb-primary": props.primary, "rb-issue-error": props.issue === "error", "rb-issue-warning": props.issue === "warning" }} onClick={props.onClick} disabled={props.disabled}
      aria-pressed={props.pressed === undefined ? undefined : props.pressed} aria-keyshortcuts={props.ariaKeyShortcuts} aria-label={props.label} title={props.title ?? props.label}>
      <props.icon size={16} aria-hidden="true" />
      <span>{props.label}</span>
    </button>
  );
}

/** A ribbon group. When the ribbon runs out of room (see fitRibbon) its buttons first lose their
 *  labels (data-size="icons"; the label stays as tooltip and accessible name) and, only when that
 *  is not enough, the group folds into one drop-down button (data-collapsed). */
function RGroup(props: { label: string; icon: typeof Box; class?: string; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  let host!: HTMLDivElement;
  let toggle!: HTMLButtonElement;
  onMount(() => {
    const outside = (e: PointerEvent) => { if (open() && !host.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    onCleanup(() => document.removeEventListener("pointerdown", outside));
  });
  return (
    <div ref={host} class={`rb-group ${props.class ?? ""}`} role="group" aria-label={props.label} data-open={open() ? "" : undefined}
      onFocusOut={(e) => { const next = e.relatedTarget as Node | null; if (open() && (!next || !host.contains(next))) setOpen(false); }}
      onKeyDown={(e) => { if (e.key === "Escape" && open() && !e.defaultPrevented) { e.stopPropagation(); setOpen(false); toggle.focus(); } }}>
      <button ref={toggle} type="button" class="rb-btn rb-group-toggle" aria-expanded={open()} title={props.label} onClick={() => setOpen(!open())}>
        <props.icon size={16} aria-hidden="true" /><span>{props.label}<ChevronDown size={11} aria-hidden="true" /></span>
      </button>
      {/* a command chosen from a folded group closes it; toggles and pop-up openers keep it open */}
      <div class="rb-items" onClick={(e) => {
        const b = (e.target as HTMLElement).closest("button");
        if (open() && b?.classList.contains("rb-btn") && !b.matches("[aria-expanded], [aria-pressed], [aria-haspopup]")) {
          // Hiding the folded commands while one has focus drops keyboard focus to the page. Put
          // it back on the group toggle, unless the command moved focus to a dialog or another UI.
          const items = host.querySelector(".rb-items");
          const focusedCommand = !!items?.contains(document.activeElement);
          const focused = document.activeElement;
          setOpen(false);
          if (focusedCommand) queueMicrotask(() => {
            const active = document.activeElement;
            if (active === focused || active === document.body) toggle.focus();
          });
        }
      }}>{props.children}</div>
      <div class="rb-label" title={props.label}>{props.label}</div>
    </div>
  );
}

type RibbonDensity = "wide" | "full" | "compact";
/** Fits the shown ribbon tab into one row. It keeps inline fields and command labels as long as
 *  possible, folds groups from the right before resorting to icon-only commands. */
function fitRibbon(shell: HTMLElement) {
  const toolbar = shell.querySelector<HTMLElement>(".rb:not([hidden]) .rb-toolbar");
  if (!toolbar) return;
  const groups = [...toolbar.querySelectorAll<HTMLElement>(":scope > .rb-group")];
  for (const g of groups) { delete g.dataset.size; delete g.dataset.collapsed; delete g.dataset.align; }
  const room = toolbar.clientWidth;
  const fits = () => groups.reduce((sum, g) => sum + g.offsetWidth, 0) <= room;
  const done = () => {
    shell.dataset.fit = fits() ? "row" : "scroll";
    for (const g of groups) {
      if (g.dataset.collapsed !== undefined) g.dataset.align = g.offsetLeft + 300 > room ? "end" : "start";
      g.dataset.popAlign = g.getBoundingClientRect().left < 340 ? "start" : "end";
    }
  };
  const foldFromRight = () => {
    for (let i = groups.length - 1; i >= 0; i--) {
      // folding one button saves nothing; a field that is always shown (Farfield › Quantity, not
      // the .rb-extra fields that lower densities hide) folds on its own
      const items = groups[i].querySelector(".rb-items");
      // Floating WCS/dialog controls do not occupy the ribbon. Counting their fields folds the
      // one-button WCS group as soon as it opens, hiding the very popover the user requested.
      const floating = ".rb-pop, [role=dialog], [role=menu]";
      const field = !!items && [...items.querySelectorAll("select, input")]
        .some((el) => !el.closest(`.rb-extra, ${floating}`));
      const buttons = items ? [...items.querySelectorAll(".rb-btn")].filter((el) => !el.closest(floating)) : [];
      if (items && buttons.length < 2 && !field) continue;
      groups[i].dataset.collapsed = "";
      if (fits()) return true;
    }
    return false;
  };
  shell.dataset.density = "wide";
  if (fits() || foldFromRight()) return done();
  for (const g of groups) delete g.dataset.collapsed;
  for (const density of ["full", "compact"] as RibbonDensity[]) {
    shell.dataset.density = density;
    if (fits() || foldFromRight()) return done();
    for (const g of groups) delete g.dataset.collapsed;
  }
  for (let i = groups.length - 1; i >= 0; i--) {
    groups[i].dataset.size = "icons";
    if (fits()) return done();
  }
  done();
}

// labels and titles are i18n keys: t() at render
const SHAPES: { kind: ShapeKind; label: string; title: string; icon: typeof Box }[] = [
  { kind: "box", label: "ribbon.shapes.box", title: "ribbon.shapes.boxTitle", icon: Box },
  { kind: "cylinder", label: "ribbon.shapes.cylinder", title: "ribbon.shapes.cylinderTitle", icon: Cylinder },
  { kind: "sphere", label: "ribbon.shapes.sphere", title: "ribbon.shapes.sphereTitle", icon: Globe },
  { kind: "polygon", label: "ribbon.shapes.polygon", title: "ribbon.shapes.polygonTitle", icon: Triangle },
  { kind: "linpoly", label: "ribbon.shapes.linpoly", title: "ribbon.shapes.linpolyTitle", icon: Hexagon },
  { kind: "cone", label: "ribbon.shapes.cone", title: "ribbon.shapes.coneTitle", icon: Cone },
  { kind: "torus", label: "ribbon.shapes.torus", title: "ribbon.shapes.torusTitle", icon: Torus },
  { kind: "wire", label: "ribbon.shapes.wire", title: "ribbon.shapes.wireTitle", icon: Spline },
];
const DRAW: { t: DrawTool; label: string; icon: typeof Box }[] = [
  { t: "brick", label: "ribbon.shapes.box", icon: Box },
  { t: "cylinder", label: "ribbon.draw.circle", icon: Circle },
  { t: "polygon", label: "ribbon.shapes.polygon", icon: PenTool },
];
const cameraViewRibbonIcon = (view: ViewName): typeof Box => (props) => <CameraViewIcon view={view} {...props} />;
const VIEWS = CAMERA_VIEWS.map((view) => ({ ...view, icon: cameraViewRibbonIcon(view.id) }));
const VIEW_LAYERS: { key: keyof LayerState; label: string; hint: string }[] = [
  { key: "guideGrid", label: "model.layer.guideGrid", hint: "model.layer.guideGrid.hint" },
  { key: "ground", label: "model.layer.ground", hint: "model.layer.ground.hint" },
  { key: "edges", label: "model.layer.edges", hint: "model.layer.edges.hint" },
  { key: "domain", label: "model.layer.domain", hint: "model.layer.domain.hint" },
  { key: "nf2ff", label: "model.layer.nf2ff", hint: "model.layer.nf2ff.hint" },
  { key: "mesh", label: "model.layer.mesh", hint: "model.layer.mesh.hint" },
  { key: "dielectricXray", label: "model.layer.dielectricXray", hint: "model.layer.dielectricXray.hint" },
];

/** A Shapes button: the shape dialog with defaults on the work plane and the selected part (CST);
 * every kind has one, the direct addition is only a fallback. */
function shapeButton(kind: ShapeKind) {
  if (!openShapeDialog(kind)) addShape(kind);
}

/** Ribbon Run: the Run dialog (engine, threads, points, name). It saves, refuses with the check
 * errors, and the run's progress and results show in the bottom dock (RunDock.tsx). */
function runDesign() {
  if (!file()) return;
  setRunDialogOpen(true);
}

/** Ribbon Python: the saved design as a .py file. The request (never proof of a saved file) or
 * the failure shows in the designer's message line; exportPython reports its own errors there. */
async function doExport() {
  setPythonSavePath(undefined);
  const src = await exportPython();
  if (!src || !file()) return;
  const name = `${file()!.id}.py`;
  try {
    const result = await saveDownload(name, src, "text/x-python");
    setPythonSavePath(result.status === "saved" ? result.path : undefined);
    setMessage({ tone: result.status === "failed" || result.status === "cancelled" ? "critical" : "good", text: downloadMessage(result) });
  } catch (e) {
    console.error(e);
    setMessage({ tone: "critical", text: downloadFailedMessage(name, e) });
  }
}

type RibbonTab = "home" | "model" | "transform" | "view" | "sim" | "optimize" | "post";
const RIBBON_TABS: { key: RibbonTab; label: string }[] = [
  { key: "home", label: "ribbon.tab.home" },
  { key: "model", label: "ribbon.tab.model" },
  { key: "transform", label: "ribbon.tab.transform" },
  { key: "view", label: "ribbon.tab.view" },
  { key: "sim", label: "ribbon.tab.sim" },
  { key: "optimize", label: "ribbon.tab.optimize" },
  { key: "post", label: "ribbon.tab.post" },
];
const storedTab = (): RibbonTab => {
  try {
    const v = localStorage.getItem("fairbeam.ribbonTab");
    if (v === "setup") return "sim";
    return RIBBON_TABS.some((t) => t.key === v) ? v as RibbonTab : "home";
  } catch {
    return "home";
  }
};
const [ribbonTab, setRibbonTab] = createSignal<RibbonTab>(storedTab());
const storedMinimized = () => { try { return localStorage.getItem("fairbeam.ribbonMinimized") === "true"; } catch { return false; } };
const [ribbonMinimized, setRibbonMinimized] = createSignal(storedMinimized());
function setMinimized(value: boolean) {
  setRibbonMinimized(value);
  try { localStorage.setItem("fairbeam.ribbonMinimized", String(value)); } catch { /* private mode */ }
}
function chooseTab(t: RibbonTab) {
  setRibbonTab(t);
  try { localStorage.setItem("fairbeam.ribbonTab", t); } catch { /* private mode */ }
  // a geometry tab takes the 3D pattern or currents off the 3D view (resultFocus.ts)
  leaveResultsFor(t);
}
export function resetRibbonLayout() { setMinimized(false); chooseTab("home"); }
/** Simulation › Ports › Lumped: show the Simulation tab and add a lumped port, selected in Properties (the PCB import's
 * "Add a port at the feed" hint opens it). */
export function openPortTool() { setMinimized(false); chooseTab("sim"); addPort(); }

const BOOLEAN_OPS: BooleanOperation[] = ["add", "subtract", "intersect", "insert"];
const BOOLEAN_KEYS = { add: SHORTCUTS.booleanAdd, subtract: SHORTCUTS.booleanSubtract, intersect: SHORTCUTS.booleanIntersect, insert: SHORTCUTS.booleanInsert } as const;
const B_CHIP = (op: BooleanOperation | null) => ({ "--al-3d-bool-sub": "bool-chip-sub", "--al-3d-bool-add": "bool-chip-add", "--al-3d-bool-other": "bool-chip-other" } as const)[operandBToken(op)];

function BooleanMenuButton() {
  const [booleanMenuOpen, setBooleanMenuOpenRaw] = createSignal(false);
  // with A selected, an operation lists the other solids right in the menu (one pick applies it)
  const [listOp, setListOp] = createSignal<BooleanOperation | null>(null);
  const setBooleanMenuOpen = (open: boolean) => { setBooleanMenuOpenRaw(open); setListOp(null); };
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  let menu: HTMLDivElement | undefined;
  const close = (restoreFocus = false) => { setBooleanMenuOpen(false); if (restoreFocus) trigger?.focus(); };
  onMount(() => {
    const outside = (e: PointerEvent) => { if (booleanMenuOpen() && !root.contains(e.target as Node)) close(); };
    const reposition = () => { if (booleanMenuOpen()) close(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    });
  });
  createEffect(() => {
    if (!booleanMenuOpen()) return;
    listOp();
    queueMicrotask(() => {
      if (!booleanMenuOpen()) return;
      const target = menu?.querySelector<HTMLButtonElement>("button[role=menuitem]:not(:disabled)");
      (target ?? menu)?.focus();
    });
  });
  return (
          <div class="rb-wcs" ref={root}>
            <button ref={trigger} class="rb-btn" type="button" aria-haspopup="menu" aria-expanded={booleanMenuOpen()} aria-controls="rb-boolean-menu"
              title={t("ribbon.tools.booleanTitle")} onClick={() => setBooleanMenuOpen(!booleanMenuOpen())}>
              <Combine size={16} aria-hidden="true" /><span>{t("ribbon.tools.boolean")}</span>
            </button>
            <Show when={booleanMenuOpen()}>
              <div id="rb-boolean-menu" ref={menu} class="rb-pop" role="menu" tabIndex={-1} aria-label={t("ribbon.tools.booleanMenu")}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); return; }
                  if (e.key === "Tab") { close(); return; }
                  if (e.key === "ArrowLeft" && listOp()) { e.preventDefault(); setListOp(null); return; }
                  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
                  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button[role=menuitem]:not(:disabled)")];
                  if (!items.length) return;
                  e.preventDefault();
                  const i = items.indexOf(document.activeElement as HTMLButtonElement);
                  const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : i < 0
                    ? e.key === "ArrowDown" ? 0 : items.length - 1
                    : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
                  items[next]?.focus();
                }}>
                <Show when={listOp()} fallback={<>
                <For each={BOOLEAN_OPS}>{(op) => {
                  const pair = () => selectedPair();
                  const pairLabel = () => { const q = pair(); return q ? t(`ribbon.tools.pair.${op}`, { a: partTitle(q[0]), b: partTitle(q[1]) }) : ""; };
                  return <button class="btn btn-ghost btn-sm bool-menu-item" type="button" role="menuitem" aria-keyshortcuts={BOOLEAN_KEYS[op].key}
                    disabled={draft.parts.length < 2}
                    title={draft.parts.length < 2 ? t("boolean.needTwo") : pair() ? t("ribbon.tools.pairTitle", { label: pairLabel() }) : t("ribbon.tools.booleanItemTitle", { op: BOOLEAN_LABELS[op], key: BOOLEAN_KEYS[op].key })}
                    onClick={() => { const q = pair(); if (q) { close(true); runBoolean(op, q[0], q[1]); } else if (selectedPartIndex() >= 0) setListOp(op); else { armBoolean(op); close(true); } }}><span>{pair() ? pairLabel() : BOOLEAN_LABELS[op]}{!pair() && selectedPartIndex() >= 0 ? " ▸" : ""}</span><kbd>{BOOLEAN_KEYS[op].key}</kbd></button>;
                }}
                </For></>}>
                  {(op) => <BooleanTargets op={op()} a={selectedPartIndex()} itemClass="btn btn-ghost btn-sm bool-menu-item" onBack={() => setListOp(null)} onDone={() => close(true)} />}
                </Show>
                <Show when={!listOp() && booleanHistory().length}><button class="btn btn-ghost btn-sm" type="button" role="menuitem"
                  title={booleanHistory().map(h=>`${BOOLEAN_LABELS[h.operation]}: ${h.a}, ${h.b} → ${h.result}`).join("\n")}
                  onClick={() => { setBooleanPending({a:-1,operation:"add"}); close(true); }}>{t("ribbon.tools.booleanHistory")}</button></Show>
              </div>
            </Show>
          </div>
  );
}

function ToolsGroup() {
  return (
        <RGroup label={t("ribbon.tools.group")} icon={Shapes}>
          <BooleanMenuButton />
          <PointTools />
          <button class="rb-btn" type="button" aria-pressed={extrudeFacePicking()} title={t("ribbon.tools.extrudeFaceTitle", { key: SHORTCUTS.extrudeFace.key })} onClick={() => { startTool(null); setFacePicking(false); setExtrudeFacePicking(true); }}><ArrowUpFromLine size={16} aria-hidden="true" /><span>{t("ribbon.tools.extrudeFace")}</span></button>
          <button class="rb-btn" type="button" aria-pressed={!!vertexTarget()} disabled={!vertexTarget() && !selectedVertexTarget()}
            title={t(!vertexTarget() && !selectedVertexTarget() ? "ribbon.tools.editPointsDisabled" : "ribbon.tools.editPointsTitle")}
            onClick={() => { const t = vertexTarget() ?? selectedVertexTarget(); if (t) toggleVertexEdit(t); }}>
            <MousePointer2 size={16} aria-hidden="true" /><span>{t("ribbon.tools.editPoints")}</span>
          </button>
        </RGroup>
  );
}

export function Ribbon() {
  usePointTools();
  const [drawOptionsOpen, setDrawOptionsOpen] = createSignal(false);
  const [library, setLibrary] = createSignal(false);
  const [myMaterials, setMyMaterials] = createSignal(false);
  const [historyOpen, setHistoryOpen] = createSignal(false);
  let geometryTab: RibbonTab = ribbonTab() === "post" ? "model" : ribbonTab();
  // an empty design (a new one, or one whose parts were all deleted before it was reopened) opens on
  // Modeling, where the first shape is added, and so does a design that shows no results while the
  // remembered tab is Post-processing (a design made from a template, with every button greyed out):
  // not on the tab remembered from the last design. The remembered tab is left alone.
  createEffect(on(() => file()?.id, (id) => {
    if (!id || resultFocus() !== null) return;
    if ((draft.parts?.length ?? 0) === 0 || ribbonTab() === "post") { setRibbonTab("model"); geometryTab = "model"; }
  }));
  createEffect(on(resultFocus, (focus, previous) => {
    if (focus) {
      if (ribbonTab() !== "post") geometryTab = ribbonTab();
      setRibbonTab("post");
    } else if (previous && ribbonTab() === "post") setRibbonTab(geometryTab);
  }));
  // camera commands act on the 3D view: it comes to the front of the main area first
  const view = (id: string) => { activateMainTab("3d"); document.querySelector(".viewport")?.dispatchEvent(new CustomEvent("fairbeam:view", { detail: id })); };
  const fit = () => { activateMainTab("3d"); document.querySelector<HTMLButtonElement>(".viewport [data-action='fit']")?.click(); };
  const currentMonitors = () => (draft as typeof draft & { monitors?: { currents?: Expr[] } }).monitors?.currents ?? [];
  const fieldPlaneCount = () => (draft as typeof draft & { monitors?: { field_planes?: unknown[] } }).monitors?.field_planes?.length ?? 0;
  /** the efficiency-over-the-band monitor's number of frequencies (undefined: no such monitor) */
  const efficiencyPoints = () => {
    const eff = (draft as typeof draft & { monitors?: { efficiency?: { points?: number } } }).monitors?.efficiency;
    return eff ? eff.points ?? EFFICIENCY_POINTS_DEFAULT : undefined;
  };
  const wavelength = (v: Expr) => {
    const f = tryEvaluate(v, names().names).value;
    return f && f > 0 ? `${Number((299.792458 / f).toPrecision(5))}` : "—";
  };
  // one row at every width: re-fit when the centre column resizes, the tab changes or the ribbon
  // is expanded again (fitRibbon only touches data attributes, never Solid-owned content)
  let shell!: HTMLDivElement;
  let fitFrame = 0;
  const refit = () => { cancelAnimationFrame(fitFrame); fitFrame = requestAnimationFrame(() => fitRibbon(shell)); };
  onMount(() => {
    let width = -1;
    const resetRibbon = resetRibbonLayout;
    window.addEventListener("fairbeam:reset-layout", resetRibbon);
    const observer = new ResizeObserver(() => { if (shell.clientWidth !== width) { width = shell.clientWidth; fitRibbon(shell); } });
    observer.observe(shell);
    // a group that appears or goes within a tab (Post-processing › Farfield while a pattern is
    // shown) changes the needed width without resizing the shell: fit again (#175). fitRibbon
    // only sets attributes, so this does not trigger itself.
    const content = new MutationObserver(refit);
    for (const toolbar of shell.querySelectorAll(".rb-toolbar")) content.observe(toolbar, { childList: true, subtree: true });
    // compact widths (scaling.css, max-width 1040px): the tree and properties overlay the centre
    // below the ribbon, so every ribbon tab stays reachable; they start at the ribbon's height
    const wrap = shell.closest<HTMLElement>(".rb-wrap") ?? shell;
    const workspace = shell.closest<HTMLElement>(".workspace");
    const ribbonHeight = new ResizeObserver(() => workspace?.style.setProperty("--dw-ribbon-h", `${wrap.offsetHeight}px`));
    ribbonHeight.observe(wrap);
    void document.fonts?.ready.then(refit);
    onCleanup(() => { observer.disconnect(); content.disconnect(); ribbonHeight.disconnect(); workspace?.style.removeProperty("--dw-ribbon-h"); cancelAnimationFrame(fitFrame); window.removeEventListener("fairbeam:reset-layout", resetRibbon); });
  });
  createEffect(on([ribbonTab, ribbonMinimized, simSettingsOpen, saving], () => { if (shell) { fitRibbon(shell); refit(); } }));
  // the Simulation ribbon's mesh readout: after a failed preview it names the numbers as the last
  // successful preview's (or unknown), never as the mesh of the current draft
  const stats = () => meshFreshness() === "unknown" ? null : meshStats(bundle());
  const meshReadout = () => {
    const s = stats(), fresh = meshFreshness();
    if (!s) return fresh === "unknown" ? t("ribbon.sim.meshUnknown") : t("ribbon.sim.meshPending");
    const text = t("ribbon.sim.meshCells", { cells: cellsText(s.cells), min: fmt(s.minCell) });
    return fresh === "stale" ? t("ribbon.sim.meshStale", { text }) : t("ribbon.sim.meshPreview", { text });
  };
  const meshReadoutTitle = () => t(({
    current: "ribbon.sim.meshTitle.current",
    updating: "ribbon.sim.meshTitle.updating",
    stale: "ribbon.sim.meshTitle.stale",
    unknown: "ribbon.sim.meshTitle.unknown",
  } as const)[meshFreshness()]);
  const boundariesText = () => {
    const raw = draft.simulation.boundaries;
    const values = Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/).filter(Boolean);
    return values.slice(0, 6).join(", ") || t("ribbon.sim.unset");
  };
  const valueText = (v: unknown) => Array.isArray(v) ? v.map(String).join(", ") : String(v ?? t("ribbon.sim.default"));
  const issueTitle = (title: string, issue: "error" | "warning" | null) => issue ? t(issue === "error" ? "ribbon.issue.error" : "ribbon.issue.warning", { title }) : title;
  const issueFor = (...paths: string[]): "error" | "warning" | null => paths.some((p) => issueUnder(p) === "error") ? "error" : paths.some((p) => issueUnder(p) === "warning") ? "warning" : null;
  const onTabKeyDown: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent> = (e) => {
    if (!(e.target instanceof HTMLButtonElement) || e.target.getAttribute("role") !== "tab") return;
    const index = RIBBON_TABS.findIndex((tab) => `rb-tab-${tab.key}` === e.target.id);
    if (index < 0) return;
    let next = index;
    if (e.key === "ArrowRight") next = (index + 1) % RIBBON_TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + RIBBON_TABS.length) % RIBBON_TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = RIBBON_TABS.length - 1;
    else return;
    e.preventDefault();
    chooseTab(RIBBON_TABS[next].key);
    (e.currentTarget.querySelector(`#rb-tab-${RIBBON_TABS[next].key}`) as HTMLButtonElement)?.focus();
  };
  return (
    <div class="rb-shell" ref={shell}>
      <div class="rb-tabs" aria-label={t("ribbon.tabs.aria")}>
        <div role="tablist" aria-label={t("ribbon.tabs.list")} onKeyDown={onTabKeyDown}>
        <For each={RIBBON_TABS}>{(tab) => (
          <button id={`rb-tab-${tab.key}`} role="tab" class="rb-tab" aria-controls={`rb-panel-${tab.key}`}
            aria-selected={ribbonTab() === tab.key} tabindex={ribbonTab() === tab.key ? 0 : -1}
            onClick={() => chooseTab(tab.key)} onDblClick={() => setMinimized(!ribbonMinimized())}>{t(tab.label)}</button>
        )}</For>
        </div>
        <button class="rb-minimize" type="button" aria-label={t(ribbonMinimized() ? "ribbon.expand" : "ribbon.minimize")} title={t(ribbonMinimized() ? "ribbon.expandTitle" : "ribbon.minimizeTitle", { key: SHORTCUTS.ribbon.key })} aria-expanded={!ribbonMinimized()} onClick={() => setMinimized(!ribbonMinimized())}>
          {ribbonMinimized() ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
      </div>
      <For each={RIBBON_TABS}>{(tab) => <div class="rb" id={`rb-panel-${tab.key}`} role="tabpanel" aria-labelledby={`rb-tab-${tab.key}`}
        hidden={ribbonMinimized() || ribbonTab() !== tab.key}>
      <div class="rb-toolbar" role="toolbar" aria-label={t("ribbon.toolbar")}>
      <Show when={ribbonTab() === tab.key}>
      <Show when={tab.key === "home"}>
        <RGroup label={t("ribbon.home.project")} icon={Home}>
          <RButton icon={Home} label={t("ribbon.home.start")} title={t("ribbon.home.startTitle")} onClick={() => setAppMode("home")} />
          <RButton icon={FileUp} label={t("ribbon.home.importCst")} title={t("ribbon.home.importCstTitle")} onClick={() => setCstImportOpen(true)} />
          <RButton icon={CircuitBoard} label={t("ribbon.home.importPcb")} title={t("ribbon.home.importPcbTitle")} onClick={() => setPcbImportOpen(true)} />
          <RButton icon={Save} label={saving() ? t("ribbon.home.saving") : t("common.save")} title={saving() ? t("ribbon.home.saving") : !dirty() && !conflict() ? t("ribbon.home.noChanges") : t("ribbon.home.saveTitle", { key: SAVE_KEY })} onClick={save} disabled={saving() || (!dirty() && !conflict())} />
          <RButton icon={X} label={t("common.close")} title={health()?.desktop ? t("ribbon.home.closeTitle", { key: CLOSE_KEY }) : t("ribbon.home.closeProject")} onClick={requestCloseProject} />
          <RButton icon={Keyboard} label={t("ribbon.home.shortcuts")} title={t("ribbon.home.shortcutsTitle", { key: SHORTCUTS.help.key })} onClick={showShortcutHelp} />
        </RGroup>
        <RGroup label={t("ribbon.home.clipboard")} icon={Clipboard}>
          <RButton icon={History} label={t("ribbon.home.history")} title={t("ribbon.home.historyTitle")} onClick={() => setHistoryOpen(true)} />
          <RButton icon={Undo2} label={t("ribbon.home.undo")} title={canUndo() ? `${undoLabel() ? t("history.undoNamed", { label: undoLabel() }) : SHORTCUTS.undo.label} (${SHORTCUTS.undo.key})` : t("ribbon.home.nothingToUndo")} onClick={undo} disabled={!canUndo()} />
          <RButton icon={Redo2} label={t("ribbon.home.redo")} title={canRedo() ? `${redoLabel() ? t("history.redoNamed", { label: redoLabel() }) : SHORTCUTS.redo.label} (${SHORTCUTS.redo.key})` : t("ribbon.home.nothingToRedo")} onClick={redo} disabled={!canRedo()} />
          <RButton icon={CopyPlus} label={t("ribbon.home.duplicate")}
            title={canDuplicate() ? `${SHORTCUTS.duplicate.label} (${SHORTCUTS.duplicate.key})` : t("ribbon.home.selectionNeeded")}
            ariaKeyShortcuts={isMacPlatform() ? "Meta+D" : "Control+D"} onClick={duplicateSelected} disabled={!canDuplicate()} />
          <RButton icon={Trash2} label={t("common.delete")}
            title={canRemove() ? `${SHORTCUTS.delete.label} (${SHORTCUTS.delete.key})` : t("ribbon.home.selectionNeeded")}
            ariaKeyShortcuts={isMacPlatform() ? "Backspace Delete" : "Delete Backspace"} onClick={removeSelected} disabled={!canRemove()} />
        </RGroup>
      </Show>
      <Show when={tab.key === "model"}>
        <ToolsGroup />
        <RGroup label={t("ribbon.shapes.group")} icon={Box}>
          <For each={SHAPES}>{(s) => <RButton icon={s.icon} label={t(s.label)} title={t(s.title)} onClick={() => shapeButton(s.kind)} />}</For>
        </RGroup>
        <RGroup label={t("ribbon.draw.group")} icon={Pencil}>
          <For each={DRAW}>{(d) => <RButton icon={d.icon} label={t(d.label)} title={HINTS[d.t]} pressed={tool() === d.t} onClick={() => { setFacePicking(false); startTool(tool() === d.t ? null : d.t); }} />}</For>
          <div class="rb-wcs">
            <RButton icon={Cog} label={t("ribbon.draw.options")} title={t("ribbon.draw.optionsTitle")} pressed={drawOptionsOpen()} onClick={() => setDrawOptionsOpen(!drawOptionsOpen())} />
            <Show when={drawOptionsOpen()}><DrawOptionsPanel onClose={() => setDrawOptionsOpen(false)} /></Show>
          </div>
        </RGroup>
        <RGroup label={t("ribbon.wcs.group")} icon={Grid3x3}>
          <RButton icon={MousePointerClick} label={t("ribbon.wcs.face")} title={t("ribbon.wcs.faceTitle")} pressed={facePicking()}
            onClick={() => { startTool(null); setExtrudeFacePicking(false); setFacePicking(!facePicking()); }} />
          <RButton icon={Move3d} label={t("ribbon.wcs.transform")} title={t("ribbon.wcs.transformTitle")} onClick={() => setWcsDialog(true)} />
          <RButton icon={LocateFixed} label={t("ribbon.wcs.global")} title={t("ribbon.wcs.globalTitle")} disabled={wcsIsGlobal()} onClick={resetWcsToGlobal} />
          <RButton icon={wcsVisible() ? Eye : EyeOff} label={t("ribbon.wcs.show")} title={t("ribbon.wcs.showTitle")} pressed={wcsVisible()} onClick={() => setWcsVisible(!wcsVisible())} />
        </RGroup>
        <RGroup label={t("ribbon.materials.group")} icon={Library}>
          <RButton icon={Library} label={t("ribbon.materials.library")} title={t("ribbon.materials.libraryTitle")} onClick={() => setLibrary(true)} />
          <RButton icon={Diamond} label={t("ribbon.materials.dielectric")} title={t("ribbon.materials.dielectricTitle")} onClick={() => addMaterial("dielectric")} />
          <RButton icon={Anvil} label={t("ribbon.materials.metal")} title={t("ribbon.materials.metalTitle")} onClick={() => addMaterial("metal")} />
        </RGroup>
        <RGroup label={t("ribbon.params.group")} icon={Plus}><RButton icon={Plus} label={t("ribbon.params.add")} title={t("ribbon.params.addTitle")} onClick={addParam} /></RGroup>
      </Show>
      <Show when={tab.key === "transform"}>
        <RGroup label={t("ribbon.transform.group")} icon={Move3d}>
          <For each={TRANSFORM_RIBBON_ITEMS}>{(item) => <RButton icon={item.icon} label={t(item.label)} title={item.disabled() ? t("ribbon.transform.selectFirst") : t(item.title)} disabled={item.disabled()} onClick={item.onClick} />}</For>
        </RGroup>
      </Show>
      <Show when={tab.key === "view"}>
        <RGroup label={t("ribbon.home.view")} icon={Eye}>
          <For each={VIEWS}>{(v) => <RButton icon={v.icon} label={t(v.label)} title={`${t(v.title)} (${v.shortcut})`} onClick={() => view(v.id)} />}</For>
          <RButton icon={Fullscreen} label={t("ribbon.view.fit")} title={`${SHORTCUTS.fit.label} (${SHORTCUTS.fit.key})`} onClick={fit} />
          <RButton icon={Camera} label={t("ribbon.view.screenshot")} disabled={!screenshotAvailable()} title={screenshotAvailable()?t("ribbon.view.screenshotTitle"):screenshotReason()} onClick={() => void captureActiveSurface()} />
        </RGroup>
        <RGroup label={t("render.group")} icon={Gem}>
          <RButton icon={Gem} label={t("render.toggle.label")} pressed={renderedView()} disabled={!bundle()?.parts.length} title={t("render.toggle.title")} onClick={() => setRenderedView(!renderedView())} />
          <RButton icon={Aperture} label={t("render.image.label")} disabled={!bundle()?.parts.length} title={t("render.image.title")} onClick={() => setRenderDialogOpen(true)} />
        </RGroup>
        <RGroup label={t("model.layers")} icon={Layers}>
          <For each={VIEW_LAYERS}>{(item) => {
            const on = () => item.key === "mesh" ? meshView() : layers[item.key];
            const disabled = () => item.key === "ground" && !bundle()?.half_space;
            return <RButton icon={on() ? Eye : EyeOff} label={t(item.label)} title={disabled() ? t("ribbon.view.noGroundPlane") : t(item.hint)} pressed={on()} disabled={disabled()}
              onClick={() => item.key === "mesh" ? setMeshView(!on()) : setLayers(item.key, !on())} />;
          }}</For>
        </RGroup>
      </Show>
      <Show when={tab.key === "sim"}>
        <RGroup label={t("ribbon.sim.band")} icon={AudioWaveform}>
          <RButton icon={AudioWaveform} label={t("ribbon.sim.band")}
            issue={issueFor("simulation.f_min", "simulation.f_max")}
            title={issueTitle(t("ribbon.sim.bandTitle", { min: valueText(draft.simulation.f_min), max: valueText(draft.simulation.f_max) }), issueFor("simulation.f_min", "simulation.f_max"))}
            onClick={() => openSimSettings("freq")} />
        </RGroup>
        {/* inline fields: only while the ribbon has room to spare (the Frequency band and Mesh
            settings dialogs hold the same values) */}
        <RGroup label={t("ribbon.sim.frequency")} icon={Waves} class="rb-extra">
          <div class="rb-frequency">
            <Show when={!simSettingsOpen()}>
              <div class="rb-field-pair">
                <RibbonField label={t("ribbon.sim.fMin")} unit="GHz" value={draft.simulation.f_min} path="simulation.f_min" onChange={(v) => edit((d) => { d.simulation.f_min = v; }, "fmin")} />
                <RibbonField label={t("ribbon.sim.fMax")} unit="GHz" value={draft.simulation.f_max} path="simulation.f_max" onChange={(v) => edit((d) => { d.simulation.f_max = v; }, "fmax")} />
              </div>
            </Show>
            <span class="rb-info mono" title={t("ribbon.sim.wavelengthTitle", { meshTitle: meshReadoutTitle(), mesh: meshReadout() })}>λ {wavelength(draft.simulation.f_max)}–{wavelength(draft.simulation.f_min)} mm · <span class="rb-mesh-readout" data-fresh={meshFreshness()}>{meshReadout()}</span></span>
          </div>
        </RGroup>
        <RGroup label={t("ribbon.sim.boundaries")} icon={SquareDashed}>
          <RButton icon={SquareDashed} label={t("ribbon.sim.boundaries")}
            issue={issueFor("simulation.boundaries")}
            title={issueTitle(t("ribbon.sim.boundariesTitle", { list: boundariesText() }), issueFor("simulation.boundaries"))}
            onClick={() => openSimSettings("bounds")} />
        </RGroup>
        <RGroup label={t("ribbon.sim.mesh")} icon={ScanLine}>
          <div class="rb-mesh-fields rb-extra">
            <Show when={!simSettingsOpen() && (draft.mesh.mode === "auto" || !draft.mesh.mode)}>
              <RibbonField label={t("ribbon.sim.cellsPerWavelength")} value={draft.mesh.cells_per_wavelength ?? 20} path="mesh.cells_per_wavelength" onChange={(v) => edit((d) => { d.mesh.cells_per_wavelength = v; }, "cpw")} />
            </Show>
          </div>
          <RButton icon={SlidersVertical} label={t("ribbon.sim.meshSettings")}
              issue={issueFor("mesh")}
              title={issueTitle(t("ribbon.sim.meshSettingsTitle", { cpw: valueText(draft.mesh.cells_per_wavelength), mesh: meshReadout() }), issueFor("mesh"))}
              onClick={() => openSimSettings("mesh")} />
          <RButton icon={ChartNoAxesCombined} label={t("ribbon.sim.convergence")} title={t("ribbon.sim.convergenceTitle")}
              onClick={() => openMeshConvergence()} />
          <RButton icon={LayoutGrid} label={t("ribbon.sim.meshView")} pressed={meshView()} title={t(meshView() ? "ribbon.sim.meshViewOn" : "ribbon.sim.meshViewOff")} onClick={toggleMeshView} />
        </RGroup>
        <RGroup label={t("ribbon.sim.ports")} icon={Zap}>
          <RButton icon={Zap} label={t("ribbon.sim.lumped")} title={t("ribbon.sim.lumpedTitle")} onClick={addPort} />
          <RButton icon={RectangleHorizontal} label={t("ribbon.sim.waveguide")} title={t("ribbon.sim.waveguideTitle")} onClick={addWaveguidePort} />
          <RButton icon={Omega} label={t("ribbon.sim.resistor")} title={t("ribbon.sim.resistorTitle")} onClick={addResistor} />
        </RGroup>
        <RGroup label={t("ribbon.sim.monitors")} icon={Radio}>
          <RButton icon={Radio} label={t("ribbon.sim.farField")}
            issue={issueFor("far_field")}
            title={issueTitle(t(draft.far_field.enabled ? "ribbon.sim.farFieldOn" : "ribbon.sim.farFieldOff", { freqs: valueText(draft.far_field.frequencies ?? []) }), issueFor("far_field"))}
            onClick={() => openSimSettings("monitors")} />
          <RButton icon={Activity} label={t("ribbon.sim.currents")}
            issue={issueFor("monitors.currents")}
            title={issueTitle(currentMonitors().length ? t("ribbon.sim.currentsTitle", { freqs: valueText(currentMonitors()) }) : t("ribbon.sim.currentsAdd"), issueFor("monitors.currents"))}
            onClick={() => openSimSettings("currents")} />
          <RButton icon={Gauge} label={t("ribbon.sim.efficiency")}
            issue={issueFor("monitors.efficiency")}
            title={issueTitle(efficiencyPoints() !== undefined ? t("ribbon.sim.efficiencyTitle", { n: efficiencyPoints() }) : t("ribbon.sim.efficiencyAdd"), issueFor("monitors.efficiency"))}
            onClick={() => openSimSettings("efficiency")} />
          <RButton icon={Layers2} label={t("ribbon.fieldPlane")}
            issue={issueFor("monitors.field_planes")}
            title={issueTitle(fieldPlaneCount() ? t("ribbon.sim.fieldPlanesTitle", { count: fieldPlaneCount() }) : t("ribbon.sim.fieldPlaneAdd"), issueFor("monitors.field_planes"))}
            onClick={() => openSimSettings("fieldplanes")} />
        </RGroup>
        <RGroup label={t("ribbon.sim.solver")} icon={Settings2}>
          <RButton icon={Timer} label={t("ribbon.sim.solverLimits")}
            issue={issueFor("simulation.end_criteria_db", "simulation.max_timesteps")}
            title={issueTitle(t("ribbon.sim.solverLimitsTitle", { db: draft.simulation.end_criteria_db ?? -60, steps: draft.simulation.max_timesteps ?? 60000 }), issueFor("simulation.end_criteria_db", "simulation.max_timesteps"))}
            onClick={() => openSimSettings("solver")} />
        </RGroup>
        <RGroup label={t("ribbon.sim.run")} icon={Play}>
          <RButton icon={Play} label={t("ribbon.sim.run")} primary title={`${t(errorCount() ? "ribbon.sim.runFixErrors" : "ribbon.sim.runTitle")} (${SHORTCUTS.run.key})`} onClick={runDesign} />
        </RGroup>
      </Show>
      <Show when={tab.key === "optimize"}>
        <RGroup label={t("ribbon.optimize.group")} icon={SlidersHorizontal}>
          <RButton icon={ChartScatter} label={t("ribbon.optimize.sweep")} title={t("ribbon.optimize.sweepTitle")} onClick={() => void openDesignerSweep()} />
          <RButton icon={SlidersHorizontal} label={t("ribbon.optimize.optimizer")} title={t("ribbon.optimize.optimizerTitle")} onClick={() => void openDesignerOptimize()} />
        </RGroup>
      </Show>
      <Show when={tab.key === "post"}>
        <RGroup label={t("ribbon.post.openTabs")} icon={LayoutDashboard}>
          <RButton icon={ClipboardList} label={t("ribbon.post.summary")} title={ribbonResult() ? t("ribbon.post.summaryTitle") : t("ribbon.post.runFirst")} disabled={!ribbonResult()} onClick={() => void openRibbonResult("summary")} />
          <RButton icon={ChartLine} label={t("ribbon.post.sparams")} title={ribbonResult() ? t("ribbon.post.sparamsTitle") : t("ribbon.post.runFirst")} disabled={!ribbonResult()} onClick={() => void openRibbonResult("sparams")} />
          <RButton icon={CircleDot} label={t("ribbon.post.smith")} title={ribbonResult() ? t("ribbon.post.smithTitle") : t("ribbon.post.runFirst")} disabled={!ribbonResult()} onClick={() => void openRibbonResult("smith")} />
          <RButton icon={Gauge} label={t("ribbon.sim.efficiency")} title={ribbonResult() ? t("ribbon.post.efficiencyTitle") : t("ribbon.post.runFirst")} disabled={!ribbonResult()} onClick={() => void openRibbonResult("efficiency")} />
          <RButton icon={Radar} label={t("ribbon.post.pattern")} title={ribbonResult() ? t("ribbon.post.patternTitle") : t("ribbon.post.runFirst")} disabled={!ribbonResult()} onClick={() => void openRibbonResult("pattern")} />
          <RButton icon={Rotate3d} label={t("ribbon.post.pattern3d")} title={ribbonPattern3d().reason} disabled={!ribbonPattern3d().ok} pressed={resultFocus()?.view === "pattern3d"} onClick={() => void openRibbonResult("pattern3d")} />
          {/* only a run with surface-current maps (#90); the tooltip gives the reason otherwise */}
          <RButton icon={Activity} label={t("ribbon.post.currents")} title={ribbonCurrents().reason} disabled={!ribbonCurrents().ok} onClick={() => void openRibbonResult("currents")} />
          <RButton icon={Layers2} label={t("ribbon.fieldPlane")} title={ribbonFieldPlanes().reason} disabled={!ribbonFieldPlanes().ok} pressed={resultFocus()?.view === "fieldplane"} onClick={() => void openRibbonResult("fieldplane")} />
          <RButton icon={Grid2x2} label={t("ribbon.post.fieldMap")} title={ribbonFieldPlanes().ok ? t("ribbon.post.fieldMapTitle") : ribbonFieldPlanes().reason} disabled={!ribbonFieldPlanes().ok} pressed={resultFocus()?.view === "fieldmap"} onClick={() => void openRibbonResult("fieldmap")} />
        </RGroup>
        {/* while a pattern is shown (the Pattern tab or the 3D pattern): the quantity it draws */}
        <Show when={ribbonFarfield()}>{(shown) => (
          <RGroup label={t("ribbon.post.farfield")} icon={Globe}>
            <label class="rb-ff-quantity"><span>{t("ribbon.post.quantity")}</span>
              <PatternQuantitySelect bundle={shown().bundle} ff={shown().ff} class="rp-input"
                directivityOnly={resultFocus()?.view === "pattern3d" && farfieldOverride() ? ARRAY_PATTERN_NOTE : undefined} />
            </label>
          </RGroup>
        )}</Show>
        <RGroup label={t("ribbon.post.report")} icon={FileText}>
          <RButton icon={FileText} label={t("ribbon.post.pdf")} title={ribbonExportReady() ? t("ribbon.post.pdfTitle") : t("ribbon.post.openRunFirst")} disabled={!ribbonExportReady()} onClick={() => openRibbonResult("report")} />
          <RButton icon={Package} label={t("ribbon.post.package")} title={ribbonExportReady() ? t("ribbon.post.packageTitle") : t("ribbon.post.openRunFirst")} disabled={!ribbonExportReady()} onClick={() => openRibbonResult("export")} />
          <RButton icon={FileCode} label={t("ribbon.post.python")} action="open-python" title={t("ribbon.post.pythonTitle")} onClick={() => { setRunOpen(false); setSidePanelCollapsed(false); void openPythonPanel(); }} />
        </RGroup>
        <p class="rb-result-note" title={ribbonResult() ? t("ribbon.post.compareNote") : t("ribbon.results.selectResult")}>{ribbonResult() ? t("ribbon.post.compareNote") : t("ribbon.results.selectResult")}
          <Show when={ribbonResult() && !ribbonCurrents().ok}> {ribbonCurrents().reason}</Show></p>
      </Show>
      </Show>
      </div>
      </div>}</For>
      <Show when={runDialogOpen()}>
        <RunDialog />
      </Show>
      <OptimizeDialog />
      <Show when={sweepDialogOpen()}><SweepDialog /></Show>
      <ConvergenceDialog />
      <Show when={simSettingsOpen()}>
        <SimSettingsDialog />
      </Show>
      <Show when={library()}>
        <MaterialLibraryDialog onClose={() => setLibrary(false)} onManage={() => { setLibrary(false); setMyMaterials(true); }} />
      </Show>
      <Show when={myMaterials()}>
        <UserMaterialsDialog onClose={() => setMyMaterials(false)} />
      </Show>
      <FeedCreationDialog />
      <ShapeDialogHost />
      <WcsDialogHost />
      <FaceExtrudeDialog />
      <Show when={booleanPending()?.a === -1}><div class="rb-pop dm-boolean-history" role="dialog" aria-label={t("boolean.history")}><h3 class="dz-h">{t("boolean.history")}</h3><For each={booleanHistory()}>{h=><p>{BOOLEAN_LABELS[h.operation]}: {h.a} + {h.b} → {h.result} <button class="btn btn-ghost btn-sm" onClick={()=>restoreBooleanPart(h.index)}>{t("boolean.restore")}</button></p>}</For><button class="btn btn-ghost btn-sm" onClick={()=>setBooleanPending(null)}>{t("common.close")}</button></div></Show>
      <NewParamHost />
      <ContextMenu />
      <ColorPopoverHost />
      <Show when={historyOpen()}><HistoryDialog onClose={() => setHistoryOpen(false)} /></Show>
    </div>
  );
}

/** Under the ribbon while a draw tool is on: what to click, and how many points so far. */
export function DrawHint() {
  return (
    <>
    <PointReadout />
    <Show when={automaticOverlap()}>{(overlap) =>
      <div class="rb-hint" role="group" aria-label={t("boolean.overlap.aria")}>
        <span>{rich(t("boolean.overlap.text"), {
          a: <span class="bool-chip bool-chip-a">{partTitle(overlap().a)}</span>,
          b: <span class="bool-chip bool-chip-other">{partTitle(overlap().b)}</span>,
          common: <span class="bool-chip bool-chip-both">{t("boolean.commonVolume")}</span>,
        })}</span>
        <For each={overlapChoices(overlap())}>{([choice, label]) =>
          <button class="btn btn-ghost btn-sm" onClick={() => resolveAutomaticOverlap(choice)}
            onMouseEnter={() => setOverlapChoice(choice)} onMouseLeave={() => setOverlapChoice(null)}
            onFocus={() => setOverlapChoice(choice)} onBlur={() => setOverlapChoice(null)}>{label}</button>
        }</For>
      </div>
    }</Show>
    <Show when={!automaticOverlap() && !booleanPending() && booleanNotice()}><div class="rb-hint" role="status"><span>{booleanNotice()}</span><button class="btn btn-ghost btn-sm" onClick={() => setBooleanNotice("")}>{t("boolean.dismiss")}</button></div></Show>
    <Show when={booleanPending() && booleanPending()!.a >= 0 ? booleanPending() : null}>{(p) =>
      <div class="rb-hint" role="group" aria-label={t("boolean.aria")}>
        <MousePointerClick size={13} aria-hidden="true" />
        <span>
          <b>{BOOLEAN_LABELS[p().operation]}</b>{": "}
          <span class="bool-chip bool-chip-a" title={t("boolean.aKept")}>{partTitle(p().a)}</span>
          {` ${BOOLEAN_SYMBOLS[p().operation]} `}
          <Show when={p().b !== undefined} fallback={<span>{t(`boolean.pickB.${p().operation}`)}</span>}>
            <span class={`bool-chip ${B_CHIP(p().operation)}`} title={p().operation === "insert" ? t("boolean.bInsert") : p().operation === "subtract" ? t("boolean.bSubtract") : "B"}>{partTitle(p().b!)}</span>
            {" · "}<span class="bool-chip bool-chip-both">{t("boolean.commonVolume")}</span>{" · "}<span class="bool-chip bool-chip-result">{t("boolean.result")}</span>{" · "}<span class="muted">{t("boolean.applyHint")}</span>
          </Show>
        </span>
        <span class="bool-ops" role="group" aria-label={t("boolean.operations")}>
          <For each={BOOLEAN_OPS}>{(op) =>
            <button class="btn btn-ghost btn-sm" aria-pressed={p().operation === op} aria-keyshortcuts={BOOLEAN_KEYS[op].key}
              title={t("boolean.opTitle", { op: BOOLEAN_LABELS[op], key: BOOLEAN_KEYS[op].key })} onClick={() => setBooleanOperation(op)}>{BOOLEAN_LABELS[op]} <kbd>{BOOLEAN_KEYS[op].key}</kbd></button>}
          </For>
        </span>
        <Show when={p().b !== undefined}>
          <button class="btn btn-ghost btn-sm" title={t("boolean.swapTitle")} onClick={swapBooleanOperands}>{t("boolean.swap")}</button>
          <button class="btn btn-sm btn-primary" disabled={!!booleanPreviewError()} aria-keyshortcuts="Enter" title={booleanPreviewError() || t("boolean.applyTitle")} onClick={() => applyPendingBoolean()}>{t("common.apply")}</button>
        </Show>
        <button class="btn btn-ghost btn-sm" title={t("boolean.cancelTitle")} onClick={() => setBooleanPending(null)}>{t("common.cancel")}</button>
        <Show when={booleanNotice() || booleanPreviewError()}><span class="bool-error" role="alert">{booleanNotice() || booleanPreviewError()}</span></Show>
        <Show when={!booleanNotice() && !booleanPreviewError() && booleanPreviewNote()}><span role="status">{booleanPreviewNote()}</span></Show>
      </div>
    }</Show>
    <Show when={vertexTarget() && !tool()}>
      <div class="rb-hint" role="status">
        <MousePointer2 size={13} aria-hidden="true" />
        <span>{rich(t("draw.vertexEdit"), { part: <b>{draft.parts[vertexTarget()!.i]?.label || draft.parts[vertexTarget()!.i]?.name}</b> })}</span>
        <button class="icon-btn icon-btn-sm rb-hint-x" onClick={stopVertexEdit} aria-label={t("draw.stopVertexEdit")} title={t("draw.stopVertexEditTitle")}><X size={13} /></button>
      </div>
    </Show>
    <Show when={facePicking()}>
      <div class="rb-hint" role="status">
        <MousePointerClick size={13} aria-hidden="true" />
        <span>{t("draw.facePick")}</span>
        <button class="icon-btn icon-btn-sm rb-hint-x" onClick={() => setFacePicking(false)} aria-label={t("draw.stopPicking")} title={t("draw.stopPickingTitle")}><X size={13} /></button>
      </div>
    </Show>
    <Show when={tool() && !facePicking()}>
      <div class="rb-hint" role="status">
        <Pencil size={13} aria-hidden="true" />
        <span>{heightStep() ? t("draw.heightStep") : t("draw.baseStep", { hint: HINTS[tool()!] })}</span>
        <span class="muted">{wcsIsGlobal() ? t("draw.onPlane", { plane: "xy", axis: "z", value: "0" }) : t("draw.onWcsPlane", { u: axisName(planeAxes(plane().normal)[0]), v: axisName(planeAxes(plane().normal)[1]), w: axisName(plane().normal) })}</span>
        <Show when={points().length}><span>{t("draw.points", { count: points().length })}</span></Show>
        <Show when={tool() === "polygon" && points().length >= 3}><button class="linklike" onClick={() => commit()}>{t("draw.closePolygon")}</button></Show>
        <button class="icon-btn icon-btn-sm rb-hint-x" onClick={() => startTool(null)} aria-label={t("draw.stop")} title={t("draw.stopTitle")}><X size={13} /></button>
      </div>
    </Show>
    </>
  );
}

// ------------------------------------------------------------------ helper dialogs

/** Drawing options: grid snap, the default extrusion height, what the pointer snaps to besides the
 * grid, whether a finished shape opens its dialog, and a look at the drawing plane. */
function DrawOptionsPanel(props: { onClose: () => void }) {
  let box!: HTMLDivElement;
  onMount(() => {
    const toggle = box.parentElement?.querySelector<HTMLButtonElement>(".rb-btn");
    const away = (e: PointerEvent) => { if (!box.contains(e.target as Node) && !(e.target as HTMLElement).closest(".rb-wcs")) props.onClose(); };
    document.addEventListener("pointerdown", away);
    onCleanup(() => {
      document.removeEventListener("pointerdown", away);
      if (box.contains(document.activeElement)) toggle?.focus();
    });
  });
  return (
    <div class="rb-pop" ref={box} role="dialog" aria-label={t("draw.options.aria")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault(); e.stopPropagation(); props.onClose();
        }
      }}>
      <h3 class="dz-h">{t("draw.options.title")}</h3>
      <div class="dz-pair">
        <label class="dz-field">
          <span class="dz-label">{t("draw.wcs.gridSnap")} <span class="dz-unit">mm</span></span>
          <NumberField class="rp-input dz-input mono" min="0" step="any" value={snap()} onInput={(e) => setSnap(Math.max(0, Number(e.currentTarget.value) || 0))} />
        </label>
        <ExprField label={t("draw.wcs.defaultHeight")} unit="mm" value={height()} path="__wcs.height" onChange={(v) => setHeight(v === "" ? 0 : v)} />
      </div>
      <p class="note">{t("draw.wcs.heightNote")}</p>
      <div class="wcs-toggles" role="group" aria-label={t("draw.wcs.snapAria")}>
        <span class="dz-label">{t("draw.wcs.snapTo")}</span>
        <For each={[["corner", "draw.wcs.corners"], ["midpoint", "draw.wcs.midpoints"], ["edge", "draw.wcs.edges"]] as [SnapKind, string][]}>{([k, label]) => (
          <label class="dz-check"><input type="checkbox" checked={snapTo(k)} onChange={(e) => setSnapTo(k, e.currentTarget.checked)} /> {t(label)}</label>
        )}</For>
      </div>
      <label class="dz-check"><input type="checkbox" checked={confirmShapes()} onChange={(e) => setConfirmShapes(e.currentTarget.checked)} /> {t("draw.wcs.confirm")}</label>
      <div class="cluster-sm">
        <button class="btn btn-ghost btn-sm" onClick={() => document.querySelector(".viewport")?.dispatchEvent(new CustomEvent("fairbeam:view", { detail: { z: "top", y: "front", x: "right" }[plane().normal] }))}>
          <Eye size={13} aria-hidden="true" /> {t("draw.wcs.lookAt")}
        </button>
        <button class="btn btn-ghost btn-sm" onClick={props.onClose}>{t("common.close")}</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ side panels

export function DesignTreePanel() {
  return (
    <aside class="panel panel-left dw-left" aria-label={t("workspace.tree")}>
      <div class="dw-title">
        <span class="dw-name" title={draft.model?.name}>{draft.model?.name}</span>
        <Show when={dirty()}><span class="code-dot" aria-label={t("workspace.unsaved")} title={t("workspace.unsavedTitle")} /></Show>
        <span class="mono muted dw-file" title={file()?.file}>{file()?.file}</span>
      </div>
      <NavTree />
    </aside>
  );
}

export function DesignSide() {
  return (
    <aside class="panel panel-right dw-right" data-region="properties" aria-label={t("workspace.properties")}>
      <div class="dw-panel-head">
        <span class="dw-panel-title">{t("workspace.properties")}</span>
        <button class="icon-btn icon-btn-sm" type="button" data-action="collapse-properties" aria-label={t("workspace.collapseProperties")} aria-expanded="true"
          title={t("workspace.collapsePropertiesTitle", { key: SHORTCUTS.side.key })} onClick={() => setSidePanelCollapsed(true)}>
          <ChevronsRight size={14} aria-hidden="true" />
        </button>
      </div>
      <BackupNotice />
      <Show when={message() && !isPythonPanelActive()}>
        <p class={`dz-msg dz-msg-${message()!.tone}`} role="status">
          {humanizePaths(message()!.text, draft, kindLabel)}
          <Show when={pythonSavePath() && message()!.text.includes(pythonSavePath()!)}>
            <button class="linklike" onClick={() => void revealDownloadedFile(pythonSavePath()!)
              .catch((e) => setMessage({ tone: "critical", text: t("workspace.showInFolderFailed", { error: String(e) }) }))}>{t("workspace.showInFolder")}</button>
          </Show>
        </p>
      </Show>
      <Show when={isPythonPanelActive()} fallback={<Inspector />}><PythonPanel /></Show>
    </aside>
  );
}

/** Bottom dock: Checks, and the progress and results of a run started from the designer. */
export function DesignDock() {
  return <RunDock />;
}

/** Shortcuts, 3D picking and the highlight while the designer is on screen. */
export function DesignKeys() {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = commandModifier(e);
      const k = e.key.toLowerCase();
      const t = e.target as HTMLElement | null;
      const desktop = !!health()?.desktop;
      if (matchesShortcut("ribbon", e)) { e.preventDefault(); setMinimized(!ribbonMinimized()); return; }
      if (matchesShortcut("tree", e)) { e.preventDefault(); toggleLeftTree(); return; }
      if (matchesShortcut("dock", e)) { e.preventDefault(); toggleBottomDock(); return; }
      if (matchesShortcut("side", e)) { e.preventDefault(); toggleSidePanel(); return; }
      // main-area tabs (MainArea.tsx): anywhere in the workspace but a dialog or a menu; a switch made
      // from inside the main area keeps the focus there, on the tab shown
      if (matchesShortcut("mainTabs", e)) {
        if (t?.closest?.(".dialog, .scrim, .rb-pop, [role=menu]")) return;
        e.preventDefault();
        // asked before the switch: leaving a result tab removes its panel (and the focused element)
        const inMain = !!t?.closest?.(".dw-main");
        cycleMainTabs(e.shiftKey ? -1 : 1);
        if (inMain) focusActiveMainTab();
        return;
      }
      // F6 / Shift+F6: the next / previous pane (panes.ts), from a field too, but not from a dialog or a menu
      if (matchesShortcut("panes", e)) {
        if (t?.closest?.(".dialog, .scrim, .rb-pop, [role=menu]")) return;
        e.preventDefault();
        cyclePanes(e.shiftKey ? -1 : 1);
        return;
      }
      // Save works everywhere, as before the shortcut table: while typing in a field, in a dialog,
      // with a drawing tool active. Always suppress the browser's "Save page as".
      if (matchesShortcut("save", e)) { e.preventDefault(); if (!e.repeat) void save(); return; }
      // Save remains ahead of the field/dialog/drawing guard (`if (inField || inOverlay || tool()) return;`).
      // Tree and viewport handlers run first and own their local keys.
      if (e.defaultPrevented && !(desktop && mod && ["t", "n", "w", "r"].includes(k))) return;
      if (desktop && ((mod && ["t", "n", "w", "r"].includes(k)) || e.key === "F5")) e.preventDefault();
      const inField = !!t?.closest?.("input, textarea, select, [contenteditable=true]");
      const inOverlay = !!t?.closest?.(".dialog, .scrim, .rb-pop, [role=menu]");
      if (desktop && inField && mod && ["d", "b", "e"].includes(k)) e.preventDefault();
      // Run works from anywhere in the designer, also while a Properties field, a parameter cell or
      // the description has the focus (⌘Enter inserts nothing in a text area). Not from a dialog or
      // a menu, and not in the middle of a drawing.
      if (matchesShortcut("run", e) && !inOverlay && !tool()) { e.preventDefault(); if (!e.repeat) runDesign(); return; }
      if (e.key === "Escape" && booleanPending() && !tool()) { setBooleanPending(null); return; }
      if (e.key === "Escape") { if (tool()) return; if (inOverlay) return; if (!inField && selection().type !== "design") setSelection({ type: "design" }); return; }
      if (inField || inOverlay) return;
      if (matchesShortcut("extrudeFace", e)) { e.preventDefault(); startTool(null); setFacePicking(false); setExtrudeFacePicking(true); return; }
      if (tool()) return;
      // Boolean keys: + add, − subtract, * intersect, / insert (with two parts); Enter applies the one shown
      for (const [id, op] of [["booleanAdd", "add"], ["booleanSubtract", "subtract"], ["booleanIntersect", "intersect"], ["booleanInsert", "insert"]] as const) {
        if (matchesShortcut(id, e)) { if (booleanShortcut(op)) e.preventDefault(); return; }
      }
      if (matchesShortcut("close", e)) return; // global desktop handler owns close
      if (matchesShortcut("undo", e) || matchesShortcut("redo", e)) { e.preventDefault(); if (matchesShortcut("redo", e)) redo(); else undo(); return; }
      if (matchesShortcut("transform", e)) {
        if (!desktop) return;
        e.preventDefault();
        chooseTab("transform");
        const selected = selection();
        if (selected.type === "part" || selected.type === "primitive") openTransform("move", selected);
        return;
      }
      if (matchesShortcut("duplicate", e)) { e.preventDefault(); if (canDuplicate()) duplicateSelected(); return; }
      if (matchesShortcut("delete", e) && canRemove()) { e.preventDefault(); removeSelected(); return; }
      const selected = selection();
      if (matchesShortcut("rename", e) && (selected.type === "part" || selected.type === "primitive")) { e.preventDefault(); setRenaming(selected); return; }
      if (matchesShortcut("fit", e) && !mod && !e.altKey && t?.matches(".viewport")) { e.preventDefault(); document.querySelector<HTMLButtonElement>(".viewport [data-action='fit']")?.click(); return; }
      if (matchesShortcut("brick", e)) { e.preventDefault(); shapeButton("box"); return; }
      if (matchesShortcut("export", e)) { e.preventDefault(); void doExport(); return; }
      if (matchesShortcut("help", e)) { e.preventDefault(); showShortcutHelp(); return; }
    };
    const onPick = (e: Event) => { if (!tool()) pickPart((e as CustomEvent<string | null>).detail); };
    // Enter applies the Boolean shown, also right after B was picked in the tree (whose rows use Enter
    // themselves): taken in the capture phase, but never from a field, a button, a menu or a dialog
    const onBooleanEnter = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || booleanPending()?.b === undefined || tool()) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable=true], button, a, [role=menuitem], .dialog, .scrim, .rb-pop")) return;
      e.preventDefault(); e.stopPropagation(); applyPendingBoolean();
    };
    document.addEventListener("keydown", onBooleanEnter, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("fairbeam:pick", onPick);
    onCleanup(() => {
      setBooleanPending(null);
      setBooleanNotice("");
      startTool(null);
      setFacePicking(false);
      setExtrudeFacePicking(false);
      cancel();
      document.removeEventListener("keydown", onBooleanEnter, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("fairbeam:pick", onPick);
      setSelectedPart(null);
      setSelectedShape(null);
    });
  });
  createEffect(() => setSelectedPart(highlightedPart()));
  createEffect(() => { const s = selection(); setSelectedShape(s.type === "primitive" ? s.j : null); });
  createEffect(on(() => file()?.id, () => { setBooleanPending(null); setBooleanNotice(""); }));
  // B: a part picked in the tree or the 3D view, or one of its shapes
  createEffect(on(selection, (s) => {
    const i = selectedPartIndex(s);
    if (booleanPending() && booleanPending()!.a >= 0 && i >= 0) acceptBooleanPick(i);
    // "Select a solid as A" is answered by selecting one: the notice must not linger
    else if (i >= 0 && !booleanPending()) setBooleanNotice("");
  }, { defer: true }));
  // the simulation settings open as a dialog (ribbon Settings, the tree node, a check's link)
  createEffect(on(selection, (s) => { if (s.type === "simulation") setSimSettingsOpen(true); }, { defer: true }));
  return null;
}
