import { createEffect, createRoot, createSignal, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { Bundle, ProjectIndexEntry } from "./types";
import { DEMO, projectUrl, publicUrl } from "./env";

/** demo bundles are immutable per deploy; local projects change under a running viewer */
const FETCH_CACHE: RequestCache = DEMO ? "no-cache" : "no-store";
import { summarize, validateBundle } from "./lib/validate";
import { t } from "./i18n/index.ts";
import { syncSavedTheme } from "./lib/generalSettings";

export type Theme = "system" | "light" | "dark";
export type DockTab = "reflection" | "impedance" | "smith" | "pattern" | "signals" | "array";
export type Axis = "x" | "y" | "z";

export interface Layers {
  edges: boolean;
  mesh: boolean;
  /** z = 0 reference grid and the work-plane drawing grid; snapping is independent */
  guideGrid: boolean;
  domain: boolean;
  nf2ff: boolean;
  ground: boolean;
  pattern: boolean;
  dielectricXray: boolean;
  /** surface-current heatmap on metal sheets (bundles with a fields section) */
  current: boolean;
}

export const [index, setIndex] = createSignal<ProjectIndexEntry[]>([]);
export const [bundle, setBundle] = createSignal<Bundle | null>(null);
export const [source, setSource] = createSignal<string>("");
export const [loadError, setLoadError] = createSignal<string | null>(null);
/** The project file whose load failed (a failed local file has nothing to retry). */
export const [failedProject, setFailedProject] = createSignal<string | null>(null);

const GUIDE_GRID_KEY = "fairbeam.guideGrid";
function storedGuideGrid(): boolean {
  try { return localStorage.getItem(GUIDE_GRID_KEY) !== "false"; }
  catch { return true; }
}

export const [layers, setLayers] = createStore<Layers>({
  edges: true,
  mesh: false,
  guideGrid: storedGuideGrid(),
  domain: false,
  nf2ff: false,
  ground: true,
  pattern: false,
  dielectricXray: false,
  current: false,
});
// A viewing preference, independent of model changes and the drawing snap settings.
createRoot(() => createEffect(() => {
  const visible = layers.guideGrid;
  try { localStorage.setItem(GUIDE_GRID_KEY, String(visible)); }
  catch { /* restricted storage: keep the preference for this session */ }
}));
export const [hiddenParts, setHiddenParts] = createStore<Record<string, boolean>>({});
export const [meshPlane, setMeshPlane] = createStore<{ axis: Axis; index: number }>({ axis: "z", index: 0 });
export const [farfieldIndex, setFarfieldIndex] = createSignal(0);
/** the E/H field-plane map drawn in the 3D view (index into the bundle's field_planes), or null */
export const [fieldPlaneMap, setFieldPlaneMap] = createSignal<number | null>(null);
/** its colour scale: dB below the map's maximum (FIELD_PLANE_DB_RANGE) or linear */
export const [fieldPlaneScale, setFieldPlaneScale] = createSignal<"db" | "linear">("db");
/** how the field-plane map is shown, in the 3D view and the 2D tab alike: its magnitude, its phase,
 * or the instantaneous field over one period (needs the map's phasor); the component of a map that
 * stores several; the instant of the animation (degrees of the period) and whether it plays */
export const [fieldPlaneMode, setFieldPlaneMode] = createSignal<"magnitude" | "phase" | "animate">("magnitude");
export const [fieldPlanePart, setFieldPlanePart] = createSignal<"all" | "x" | "y" | "z">("all");
export const [fieldPlanePhase, setFieldPlanePhase] = createSignal(0);
export const [fieldPlanePlaying, setFieldPlanePlaying] = createSignal(false);
export const [dockTab, setDockTab] = createSignal<DockTab>("reflection");
export const [hoverPart, setHoverPart] = createSignal<string | null>(null);
/** designer mesh view: the solids fade so the FDTD mesh plane shows through */
export const [solidFade, setSolidFade] = createSignal(false);
/** the 3D view's cursor position (mm) on the model or the ground plane; null off the view */
export const [viewCursor, setViewCursor] = createSignal<{ x: number; y: number; z: number } | null>(null);
/** the part selected in the designer: highlighted in the 3D view */
export const [selectedPart, setSelectedPart] = createSignal<string | null>(null);
/** the one shape of that part selected in the designer's tree (its index in the part), or null for
 * the whole part: the 3D view highlights only its pieces */
export const [selectedShape, setSelectedShape] = createSignal<number | null>(null);
export const [exportOpen, setExportOpen] = createSignal(false);
/** When true, the viewport keeps its camera on the next bundle change (live geometry preview). */
export const [keepCamera, setKeepCamera] = createSignal(false);
export type CenterView = "3d" | "drawing";
export const [centerView, setCenterView] = createSignal<CenterView>("3d");
export const [packageOpen, setPackageOpen] = createSignal(false);

const THEME_KEY = "fairbeam.theme";
function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}
export const [theme, setThemeSignal] = createSignal<Theme>(storedTheme());
export function applyTheme(t: Theme) {
  // attribute first: effects that read CSS tokens on the theme signal must see the new values
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  setThemeSignal(t);
  try {
    localStorage.setItem(THEME_KEY, t);
    syncSavedTheme(t);
  } catch {
    /* private mode: preference is per session */
  }
}

export async function loadIndex() {
  try {
    const r = await fetch(publicUrl("projects/index.json"), { cache: FETCH_CACHE });
    if (!r.ok) throw new Error(`${r.status}`);
    const data = (await r.json()) as { projects: ProjectIndexEntry[] };
    setIndex(data.projects ?? []);
    return data.projects ?? [];
  } catch {
    setIndex([]);
    return [];
  }
}

/** Problems found (and repaired) when the current bundle was opened; shown in a banner. */
export const [loadWarnings, setLoadWarnings] = createSignal<string[]>([]);

/** Open a parsed bundle. It is validated first (src/lib/validate.ts): a bundle that cannot be shown
 * throws with the reasons; a repairable one opens with its problems listed in loadWarnings. */
/** bumped on every open, so a slow load can tell that something newer was opened meanwhile */
let openSeq = 0;
export const openCount = () => openSeq;
let loadSeq = 0;

/** Leave no preview or stale result visible while navigating to a design's results. */
export function clearProject() {
  openSeq++;
  loadSeq++;
  setBundle(null);
  setSource("");
  setLoadError(null);
  setLoadWarnings([]);
}

export function openBundle(raw: Bundle | unknown, label: string) {
  const v = validateBundle(raw);
  if (!v.bundle) throw new Error(summarize(v.errors));
  openSeq++;
  const b = v.bundle;
  setLoadWarnings(v.warnings);
  // Preview rebuilds and result/geometry switches for the same model retain session visibility.
  // A different model starts with all of its parts visible. untrack: an effect that opens a bundle
  // must not start depending on bundle() (a History click looped).
  if (untrack(bundle)?.model.id !== b.model.id) setHiddenParts(reconcile({}));
  setFarfieldIndex(0);
  const zIdx = b.mesh.z.findIndex((z) => z >= 0);
  setMeshPlane({ axis: "z", index: Math.max(0, zIdx) });
  setLayers({ pattern: false, ground: true, current: false });
  setFieldPlaneMap(null);
  setFailedProject(null);
  setLoadError(null);
  setSource(label);
  setBundle(b);
}

export async function loadProject(file: string, isCurrent: () => boolean = () => true) {
  const mine = ++loadSeq;
  const start = openSeq;
  const stale = () => mine !== loadSeq || openSeq !== start || !isCurrent();
  setFailedProject(null);
  try {
    const r = await fetch(projectUrl(file), { cache: FETCH_CACHE });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    if (stale()) return false; // a newer pick or open won the race
    openBundle(json, file);
    try {
      localStorage.setItem("fairbeam.last", file);
    } catch {
      /* ignore */
    }
    return true;
  } catch (e) {
    if (!stale()) { setLoadError(t("load.openFailed", { file, error: (e as Error).message })); setFailedProject(file); }
    return false;
  }
}

export async function loadFile(f: File, isCurrent: () => boolean = () => true) {
  const mine = ++loadSeq;
  const start = openSeq;
  // A local file has no server-side retry target. Do not leave Retry pointing at a prior project.
  setFailedProject(null);
  try {
    const json = JSON.parse(await f.text());
    if (mine !== loadSeq || openSeq !== start || !isCurrent()) return false;
    openBundle(json, f.name);
    return true;
  } catch (e) {
    if (mine === loadSeq && openSeq === start && isCurrent()) setLoadError(t("load.openFailed", { file: f.name, error: (e as Error).message }));
    return false;
  }
}

export function lastProject(): string | null {
  try {
    return localStorage.getItem("fairbeam.last");
  } catch {
    return null;
  }
}
