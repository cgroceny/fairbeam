// The designer's navigation tree as data (the Navigation Tree, #52): top-level sections for the
// components, materials, ports, lumped elements and the results of
// the open design, flattened into rows with their level for a role="tree". Pure (no Solid, no DOM),
// so scripts/check-nav-tree.mjs tests it: building, the filter, the arrow keys, run labels and the
// multi-selection of runs. NavTree.tsx renders the rows and wires the actions.
import type { ProjectIndexEntry } from "../types";
import type { ResultView } from "./resultFocus";
import type { Selection } from "./types";
import { newestResults } from "../runner/resultsIndex.ts";
import { projectLabels } from "../lib/projectLabels.ts";
import { studySub } from "./convergence.ts";
import { fmt, localeTag, t } from "../i18n/index.ts";

export type NavSection = "parameters" | "components" | "materials" | "ports" | "lumped" | "results" | "optimizations";
export type Issue = "error" | "warning" | null;
export type NavIcon = "design" | "folder" | "part" | "material" | "port" | "resistor" | "farfield" | "current"
  | "run" | "group" | "curve" | "smith" | "table" | "log" | "param" | string;

/** What a row does when it is activated. */
export type NavAction =
  | { kind: "select"; sel: Selection }
  | { kind: "folder"; path: string }
  | { kind: "section"; section: NavSection }
  | { kind: "parameters" }
  | { kind: "run"; file: string }
  | { kind: "group"; file: string }
  | { kind: "sweep"; id: string }
  | { kind: "convergence"; id: string }
  | { kind: "result"; file: string; view: ResultView; f?: number; map?: number }
  | { kind: "optimization"; jobId: string; file: string }
  | { kind: "optimization-history"; jobId: string; file: string }
  | { kind: "optimization-best"; jobId: string; file: string }
  | { kind: "optimization-save"; jobId: string }
  | { kind: "optimization-apply"; jobId: string; file: string };

export interface NavNode {
  id: string;
  label: string;
  sub?: string;
  /** a run's headline numbers ("2.415 GHz · −15.0 dB · 6.6 dBi"), on a second line under its name */
  metrics?: string;
  title?: string;
  /** an empty section's whole hint ("none yet: Simulation › Run"): the row's tooltip and accessible
   * description, while `sub` shows its short form ("none yet") */
  hint?: string;
  /** Searchable geometry labels retained when a single-solid part uses one visible row. */
  searchText?: string;
  icon?: NavIcon;
  action: NavAction;
  issue?: Issue;
  /** top-level sections carry data-node (the DOM hook for other parts of #50) */
  section?: NavSection;
  /** shown next to a section's title */
  count?: number;
  /** expanded unless the viewer collapsed it */
  open?: boolean;
  children?: NavNode[];
}

export interface NavRow extends Omit<NavNode, "children"> {
  level: number;
  expandable: boolean;
  expanded: boolean;
  /** position among its siblings, for aria-posinset / aria-setsize */
  pos: number;
  size: number;
}

// ------------------------------------------------------------------ component folders (components)

/** A component path in canonical form: trimmed folder names joined by "/" ("" = the top level). */
export const normComponent = (path: string | undefined) => (path ?? "").split("/").map((x) => x.trim()).filter(Boolean).join("/");

export interface Folder { name: string; path: string; folders: Folder[]; parts: number[] }

/** Parts grouped by their component path ("antenna/feed"): folders in order of first use, then parts.
 * The data model has no explicit sibling order; displayed part order follows the parts array. */
export function componentTree(parts: { component?: string }[], components: readonly string[] = []): Folder {
  const root: Folder = { name: "", path: "", folders: [], parts: [] };
  // Preserve first-use sibling order in arrays, but avoid rescanning every sibling per part.
  const byPath = new Map<string, Folder>();
  const addPath = (component: string | undefined) => {
    let f = root;
    for (const seg of normComponent(component).split("/").filter(Boolean)) {
      const path = f.path ? `${f.path}/${seg}` : seg;
      let next = byPath.get(path);
      if (!next) {
        next = { name: seg, path, folders: [], parts: [] };
        f.folders.push(next);
        byPath.set(path, next);
      }
      f = next;
    }
    return f;
  };
  components.forEach(addPath);
  parts.forEach((p, i) => addPath(p.component).parts.push(i));
  return root;
}

export const folderParts = (f: Folder): number[] => [...f.parts, ...f.folders.flatMap(folderParts)];

export type PartDropTarget = { kind: "root" } | { kind: "folder"; path: string } | { kind: "part"; index: number };
export type PartDropDecision = { kind: "move"; path: string } | { kind: "group"; onto: number };
/** Resolve a part drop without DOM state. Self drops are invalid; parts have no explicit sibling order. */
export function partDropDecision(parts: readonly { component?: string }[], dragged: number, target: PartDropTarget): PartDropDecision | null {
  if (!Number.isInteger(dragged) || dragged < 0 || dragged >= parts.length) return null;
  if (target.kind === "part") {
    if (!Number.isInteger(target.index) || target.index < 0 || target.index >= parts.length || target.index === dragged) return null;
    return { kind: "group", onto: target.index };
  }
  return { kind: "move", path: target.kind === "root" ? "" : normComponent(target.path) };
}

// ------------------------------------------------------------------ the runs of a design

export interface RunRow { file: string; label: string; sub: string; title: string }

export interface SweepTreeMeta {
  id: string; name: string; total: number; done: number; failed: number; active: boolean;
  /** "convergence": a mesh convergence study (python/fairbeam/convergence.py), with its verdict once done */
  kind?: string; verdict?: string;
}
type JobSweepMeta = { id: string; name: string; total: number; index?: number; kind?: string; verdict?: string };
export type ResultTreeItem = { kind: "run"; run: RunRow } | { kind: "sweep"; sweep: SweepTreeMeta; runs: RunRow[] };

/** Group only bundles belonging to jobs of this model; unmatched runs remain peers. */
export function groupSweepRuns(runs: readonly RunRow[], jobs: readonly { bundle?: string | null; model?: string; model_id?: string | null; status: string; sweep?: JobSweepMeta | null }[], model: string): ResultTreeItem[] {
  const modelJobs = jobs.filter(j => (j.model_id === model || j.model === model) && j.sweep);
  const byFile = new Map(modelJobs.filter(j => j.status === "done" && j.bundle).map(j => [j.bundle!, j]));
  const groups = new Map<string, { sweep: SweepTreeMeta; runs: RunRow[]; newest: number }>();
  const items: { at: number; item: ResultTreeItem }[] = [];
  for (const job of modelJobs) {
    const meta = job.sweep!;
    let group = groups.get(meta.id);
    if (!group) {
      group = { sweep: { id: meta.id, name: meta.name, total: meta.total, done: 0, failed: 0, active: false, ...(meta.kind ? { kind: meta.kind } : {}) }, runs: [], newest: Number.MAX_SAFE_INTEGER };
      groups.set(meta.id, group);
    }
    // a convergence study closes with the number it ran and its verdict on every job
    if (meta.verdict) Object.assign(group.sweep, { verdict: meta.verdict, total: meta.total });
    if (job.status === "done") group.sweep.done++;
    if (job.status === "failed") group.sweep.failed++;
    if (!["done", "failed", "cancelled", "interrupted"].includes(job.status)) group.sweep.active = true;
  }
  runs.forEach((run, i) => {
    const job = byFile.get(run.file);
    if (!job?.sweep) { items.push({ at: i, item: { kind: "run", run } }); return; }
    const group = groups.get(job.sweep.id)!;
    group.newest = Math.min(group.newest, i);
    group.runs.push(run);
  });
  // inside a group, runs follow the server's run index like Run History / Compare all (#151)
  const order = (file: string) => byFile.get(file)?.sweep?.index ?? Number.MAX_SAFE_INTEGER;
  for (const group of groups.values()) group.runs.sort((a, b) => order(a.file) - order(b.file));
  for (const { sweep, runs: children, newest } of groups.values()) items.push({ at: children.length ? newest : 0, item: { kind: "sweep", sweep, runs: children } });
  return items.sort((a, b) => a.at - b.at).map(x => x.item);
}

/** A run's headline numbers as the tree shows them (empty: none known yet). */
export type RunMetricsText = (file: string) => string;

export function sweepNode(sweep: SweepTreeMeta, runs: readonly RunRow[], content: (file: string) => RunContent | null, metrics: RunMetricsText = () => ""): NavNode {
  const children = runs.map((r, i) => ({
    id: `run:${r.file}`, label: r.label, sub: r.sub, metrics: metrics(r.file) || undefined, title: r.title,
    icon: "run" as const, action: { kind: "run" as const, file: r.file }, open: i === 0,
    children: runChildren(r.file, content(r.file)),
  }));
  if (sweep.kind === "convergence") return {
    id: `sweep:${sweep.id}`,
    label: t("tree.convergence"),
    sub: studySub(sweep),
    title: t("tree.sweep.title", { name: sweep.name }),
    icon: "group",
    action: { kind: "sweep", id: sweep.id },
    open: false,
    children: [{ id: `convergence:${sweep.id}`, label: t("tree.convergence.report"), icon: "table", action: { kind: "convergence", id: sweep.id } }, ...children],
  };
  const status = t(sweep.active ? "tree.sweep.status.active" : sweep.failed ? "tree.sweep.status.failed" : sweep.done < sweep.total ? "tree.sweep.status.stopped" : "tree.sweep.status.complete");
  return {
    id: `sweep:${sweep.id}`,
    label: t("tree.sweep", { name: sweep.name }),
    sub: [t("tree.sweep.runs", { count: sweep.total }), status, t("tree.sweep.done", { count: sweep.done }), ...(sweep.failed ? [t("tree.sweep.failed", { count: sweep.failed })] : [])].join(" · "),
    // a click opens or closes the folder like any other; double-click (or its menu) compares all runs
    title: t("tree.sweep.title", { name: sweep.name }),
    icon: "group",
    action: { kind: "sweep", id: sweep.id },
    open: false,
    children,
  };
}

export function resultNodes(runs: readonly RunRow[], jobs: Parameters<typeof groupSweepRuns>[1], model: string, content: (file: string) => RunContent | null, metrics: RunMetricsText = () => ""): NavNode[] {
  const items = groupSweepRuns(runs, jobs, model);
  let opened = false;
  return items.map(item => item.kind === "run" ? {
    id: `run:${item.run.file}`, label: item.run.label, sub: item.run.sub, metrics: metrics(item.run.file) || undefined, title: item.run.title, icon: "run", action: { kind: "run" as const, file: item.run.file },
    open: !opened && (opened = true), children: runChildren(item.run.file, content(item.run.file)),
  } : sweepNode(item.sweep, item.runs, content, metrics));
}

const SEP = " · ";
const stamp = (created: string | undefined) => /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(created ?? "");

/** A sweep point as its label names it: "k=0.466", "w=12, h=1.6" (four significant digits). */
export function sweepPointText(values: Readonly<Record<string, number | string>>): string {
  return Object.entries(values).map(([k, v]) => `${k}=${typeof v === "number" ? +v.toPrecision(4) : v}`).join(", ");
}

/** The runs of one model, newest first: the picker label (projectLabels: the name, plus the engine,
 * parameters or time when names repeat) and a sub line with when and where it ran, minus what the
 * label already says. `finished` holds sub-second completion times from the job history.
 * `sweepValues` (bundle file -> its sweep point, from the job history): a sweep's run is named by its
 * parameter values ("Dip C · k=0.466"), also the point at the design's own value, which has no
 * parameter of its own in the index and would otherwise be told apart by engine and time. */
export function runRows(entries: readonly ProjectIndexEntry[], model: string, finished: ReadonlyMap<string, number> = new Map(),
  sweepValues: ReadonlyMap<string, Readonly<Record<string, number | string>>> = new Map()): RunRow[] {
  const runs = newestResults(entries, model, finished);
  const labels = projectLabels(runs);
  const days = new Set(runs.map((r) => stamp(r.created)?.[1]).filter(Boolean));
  return runs.map((r) => {
    const point = sweepValues.get(r.file);
    // the server names a point that changes a parameter after it ("Dip C · k=0.4194"): that name is
    // kept; the point at the design's own value has the plain name, and gets its value added
    const name = (r.name ?? "").trim() || r.file.replace(/\.json$/i, "");
    const label = point && Object.keys(point).length
      ? (Object.keys(point).every((k) => name.includes(`${k}=`)) ? name : `${name}${SEP}${sweepPointText(point)}`)
      : labels.get(r.file) ?? r.file;
    const m = stamp(r.created);
    // the label may carry the time already (with seconds, or the date) when names repeat
    const when = !m || label.includes(m[2]) ? "" : days.size > 1 ? `${m[1].slice(5)} ${m[2]}` : m[2];
    const sub = [when, r.engine ?? ""].filter((s) => s && !label.split(SEP).includes(s)).join(SEP);
    return { file: r.file, label, sub, title: [r.file, r.created, r.engine].filter(Boolean).join(SEP) };
  });
}

/** What a run's bundle holds beyond the S-parameters: far-field and surface-current frequencies (Hz)
 * and its field-plane maps (index into the bundle's field_planes, with the tree's label). */
export interface RunContent { farfield: number[]; currents: number[]; fieldPlanes?: { map: number; f: number; label: string }[] }

/** A field-plane map's name in the tree and on the colour bar: "E-field (z = 1.5 mm, 2.45 GHz)",
 * "Ex (z = 1.5 mm, 2.45 GHz)" for one component. */
export function fieldPlaneLabel(m: { quantity?: unknown; component?: unknown; normal?: unknown; position_mm?: unknown; f?: unknown }): string {
  const q = m.quantity === "H" ? "H" : "E";
  const name = typeof m.component === "string" && m.component !== "abs" ? `${q}${m.component}` : t(q === "H" ? "tree.result.hField" : "tree.result.eField");
  const pos = typeof m.position_mm === "number" ? fmt.num(+m.position_mm.toPrecision(4), 9) : "?";
  const f = typeof m.f === "number" ? ghz(m.f) : "? GHz";
  return `${name} (${typeof m.normal === "string" ? m.normal : "?"} = ${pos} mm, ${f})`;
}

/** Read from a bundle (or its raw JSON): tolerant, it only lists what is there. */
export function runContent(b: unknown): RunContent {
  const o = (b ?? {}) as { results?: { farfield?: { f?: unknown }[] } | null; fields?: { planes?: { frequencies?: { f_target?: unknown; f?: unknown }[] }[] }; field_planes?: unknown };
  const uniq = (xs: unknown[]) => [...new Set(xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x)))];
  const fieldPlanes = (Array.isArray(o.field_planes) ? o.field_planes as Record<string, unknown>[] : [])
    .flatMap((m, map) => (m && typeof m.f === "number" && Number.isFinite(m.f) ? [{ map, f: m.f, label: fieldPlaneLabel(m) }] : []));
  return {
    farfield: uniq((o.results?.farfield ?? []).map((f) => f.f)),
    currents: uniq((o.fields?.planes?.[0]?.frequencies ?? []).map((f) => f.f_target ?? f.f)),
    ...(fieldPlanes.length ? { fieldPlanes } : {}),
  };
}

const ghz = (f: number) => `${fmt.num(+(f / 1e9).toPrecision(4), 9)} GHz`;

/** The children of a run node: 1D results, far fields, 2D/3D results, tables and the log
 * (result folders). Far fields and currents are listed once the run's bundle has been read. */
export function runChildren(file: string, content: RunContent | null): NavNode[] {
  const leaf = (view: ResultView, label: string, icon: NavIcon, f?: number, map?: number): NavNode => ({
    id: `res:${file}:${view}${map !== undefined ? `:${map}` : f === undefined ? "" : `:${f}`}`, label, icon,
    action: { kind: "result", file, view, ...(f === undefined ? {} : { f }), ...(map === undefined ? {} : { map }) },
  });
  const group = (key: string, label: string, children: NavNode[]): NavNode => ({
    id: `grp:${file}:${key}`, label, icon: "group", action: { kind: "group", file }, open: true, children,
  });
  const out: NavNode[] = [
    group("1d", t("tree.result.1d"), [
      leaf("sparams", t("tree.result.sparams"), "curve"), leaf("impedance", t("tree.result.impedance"), "curve"), leaf("vswr", "VSWR", "curve"), leaf("smith", t("tree.result.smith"), "smith"),
      leaf("efficiency", t("tree.result.efficiency"), "curve"),
    ]),
  ];
  // per frequency: the directivity cuts (a main-area tab) and the pattern in the 3D view (far field)
  if (content?.farfield.length) out.push(group("farfield", t("tree.result.farfields"), content.farfield.flatMap((f) => [
    leaf("pattern", t("tree.result.farfield", { f: ghz(f) }), "farfield", f), leaf("pattern3d", t("tree.result.pattern3d", { f: ghz(f) }), "farfield", f),
  ])));
  // the surface currents (drawn in the 3D view) and the E/H field planes (a 2D map and a 3D plane)
  const maps = [
    ...(content?.currents ?? []).map((f) => leaf("currents", t("tree.result.current", { f: ghz(f) }), "current", f)),
    // per map: the 2D heat map (a main-area tab) and the map in the 3D view
    ...(content?.fieldPlanes ?? []).flatMap((m) => [
      leaf("fieldmap", t("tree.result.fieldMap2d", { label: m.label }), "current", m.f, m.map),
      leaf("fieldplane", t("tree.result.fieldPlane3d", { label: m.label }), "current", m.f, m.map),
    ]),
  ];
  if (maps.length) out.push(group("2d3d", t("tree.result.2d3d"), maps));
  out.push(group("tables", t("tree.result.tables"), [leaf("summary", t("tree.result.summary"), "table"), leaf("table", t("tree.result.table"), "table")]), leaf("log", t("tree.result.log"), "log"));
  return out;
}

/** Run nodes under Results: the newest open, the others collapsed until opened. */
export function runNodes(runs: readonly RunRow[], content: (file: string) => RunContent | null): NavNode[] {
  return runs.map((r, i) => ({
    id: `run:${r.file}`, label: r.label, sub: r.sub, title: r.title, icon: "run", action: { kind: "run", file: r.file },
    open: i === 0, children: runChildren(r.file, content(r.file)),
  }));
}

// ------------------------------------------------------------------ filter and flatten

// lower case in the UI language (Turkish İ/I lower to i/ı)
const lower = (s: string) => s.toLocaleLowerCase(localeTag());
const tokens = (q: string) => lower(q).split(/\s+/).filter(Boolean);

/** Every word of the filter occurs in the label or the sub line (case-insensitive). */
export function matchesFilter(query: string, ...texts: (string | undefined)[]): boolean {
  // a typed "-1.25" finds a label that shows the typographic minus "−1.25" (fmt writes U+2212)
  const plain = (s: string) => s.replace(/\u2212/g, "-");
  const words = tokens(query).map(plain);
  if (!words.length) return true;
  const hay = plain(lower(texts.filter(Boolean).join(" ")));
  // a word also matches across spaces and hyphens, so "farfield" finds "Far field" and "s11" "S-11"
  const squashed = hay.replace(/[\s-]+/g, "");
  return words.every((w) => hay.includes(w) || squashed.includes(w));
}

/**
 * Flatten the tree into rows, depth first. `open` holds the viewer's expand/collapse choices by
 * id (a node's own `open` is the default). With a filter, a node shows when it or something below
 * it matches, or it sits under a match; everything on the way is expanded, and empty sections go.
 */
export function flatten(nodes: readonly NavNode[], open: ReadonlyMap<string, boolean>, filter = ""): NavRow[] {
  const filtering = tokens(filter).length > 0;
  const hit = (n: NavNode) => matchesFilter(filter, n.label, n.sub, n.searchText);
  const hasHit = (n: NavNode): boolean => hit(n) || (n.children ?? []).some(hasHit);
  const rows: NavRow[] = [];
  const walk = (list: readonly NavNode[], level: number, underHit: boolean) => {
    const shown = filtering && !underHit ? list.filter(hasHit) : list;
    shown.forEach((n, k) => {
      const { children, ...rest } = n;
      const kids = children ?? [];
      const expandable = kids.length > 0;
      const expanded = expandable && (filtering || (open.get(n.id) ?? n.open ?? true));
      rows.push({ ...rest, level, expandable, expanded, pos: k + 1, size: shown.length });
      if (expanded) walk(kids, level + 1, underHit || (filtering && hit(n)));
    });
  };
  walk(nodes, 1, false);
  return rows;
}

// ------------------------------------------------------------------ keyboard (WAI-ARIA tree pattern)

export type TreeMove = { focus: number } | { toggle: number } | null;

/** Arrow keys on the visible rows: Up/Down move, Home/End jump, Right opens a closed node or steps
 * into it, Left closes an open node or goes to its parent. */
export function treeKey(rows: readonly Pick<NavRow, "level" | "expandable" | "expanded">[], i: number, key: string): TreeMove {
  const n = rows.length;
  if (!n) return null;
  const r = rows[i];
  switch (key) {
    case "ArrowDown": return { focus: Math.min(n - 1, i + 1) };
    case "ArrowUp": return { focus: Math.max(0, i - 1) };
    case "Home": return { focus: 0 };
    case "End": return { focus: n - 1 };
    case "ArrowRight":
      if (!r?.expandable) return null;
      return r.expanded ? { focus: Math.min(n - 1, i + 1) } : { toggle: i };
    case "ArrowLeft": {
      if (!r) return null;
      if (r.expandable && r.expanded) return { toggle: i };
      for (let j = i - 1; j >= 0; j--) if (rows[j].level < r.level) return { focus: j };
      return null;
    }
    default: return null;
  }
}

// ------------------------------------------------------------------ several runs (compare)

/** Up to eight runs compare: one categorical series colour each (src/compare/series.ts,
 * docs/DESIGN.md Charts). */
export const MAX_COMPARE = 8;

/** The runs selected after a click on one: a plain click selects it alone, Ctrl/⌘ adds or removes
 * it. `full` when adding would exceed `max` (the selection stays). */
export function pickRuns(current: readonly string[], file: string, additive: boolean, max = MAX_COMPARE): { files: string[]; full: boolean } {
  if (!additive) return { files: [file], full: false };
  if (current.includes(file)) {
    const rest = current.filter((f) => f !== file);
    return { files: rest.length ? rest : [file], full: false };
  }
  if (current.length >= max) return { files: [...current], full: true };
  return { files: [...current, file], full: false };
}
