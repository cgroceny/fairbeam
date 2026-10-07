import { lumpedLabel } from "../lumped.ts";
// The designer's navigation tree (the Navigation Tree, #52), the left column: the design, its
// a Parameters row that opens the bottom dock (#53), components (parts in folders with their
// shapes: drag a part onto a folder, #49; right-click for the context menu, #44), materials, ports,
// lumped elements, and the results of the design's runs. A filter
// box narrows it. The rows come from navModel.ts (a flat role="tree" with aria-level); a result
// node focuses that view of its run (resultFocus.ts, runResults.ts), a geometry node goes back to
// the geometry, and Ctrl/⌘-click on runs compares them.
import { createEffect, createMemo, createSignal, For, type JSX, on, Show } from "solid-js";
import {
  BookmarkPlus, Box, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, Crosshair, Download, Eye, EyeOff, FolderClosed, FolderOpen,
  GitCompareArrows, History, Layers, Move, Orbit, Palette, Pencil, Plus, Radar, ScrollText, Search, SlidersHorizontal, Square, Table2, Trash2, Ungroup, Variable, Waves,
  X, Zap, ChartSpline, ChevronsLeft,
} from "lucide-solid";
import { kindLabel, SHAPES } from "./DesignPane";
import { openColor } from "./ColorPopover";
import { boundsPortTarget, closeContext, openContext, renaming, setRenaming } from "./context";
import { deleteComponent, newComponent, renameComponent, ungroupComponent } from "./componentOps";
import { openTransform } from "./transforms";
import { saveDesignMaterial } from "./userMaterialsStore";
import TreeMenu, { type TreeMenuAction } from "./TreeMenu";
import { hiddenParts, setHiddenParts } from "../state";
import { openParametersTab } from "./dockState";
import { focusResult, IN_3D, resultFocus } from "./resultFocus";
import { activateMainTab, activeMainResult, closeMainTab, mainTabs } from "./mainTabsState";
import { isMainResultView } from "./resultTabs";
import { designResult } from "../runner/designRun";
import { matchesShortcut, SHORTCUTS } from "./shortcuts";
import { setLeftTreeCollapsed } from "./layoutState";
import { RunQualityBadge } from "./RunQualityView";
import { designResultNodes, openSweepView, readRunContent, runContentOf, runQualityOf, selectedRuns, selectRun, sweepViewId, setSweepViewId } from "./runResults";
import { SweepCompareView } from "../runner/RunHistory";
import { optimizationNodes, type OptimizationRun } from "./optimizationResults";
import { applyOptimizationBest, deleteOptimizationRecord, loadOptimizationRuns, openOptimization, stopOptimization } from "./optimizationActions";
import { isTerminal } from "../runner/api";
import { jobs, saveOptimizationBest } from "../runner/store";
import { openMeshConvergence } from "./ConvergenceDialog";
import {
  componentTree, flatten, folderParts, MAX_COMPARE, partDropDecision, type Folder, type Issue, type NavNode, type NavRow, type NavSection, treeKey,
} from "./navModel";
import {
  addMaterial, addParam, addPort, addResistor, copyCount, draft, edit, file, issueUnder, groupParts, moveToComponent, names, normComponent, selection, setSelection,
} from "./store";
import type { Selection } from "./types";
import { fmt, t } from "../i18n";
import "../styles/designer-tree.css";

const same = (a: Selection, b: Selection) => JSON.stringify(a) === JSON.stringify(b);
// A single solid has one visible row even when a viewport pick selects its primitive.
const rowRepresents = (row: Selection, selected: Selection) => same(row, selected)
  || (row.type === "part" && selected.type === "primitive" && row.i === selected.i
    && selected.j === 0 && draft.parts[row.i]?.primitives.length === 1);

const ICONS: Record<string, typeof Box> = {
  design: Layers, run: History, curve: ChartSpline, smith: Orbit, farfield: Radar, current: Waves, table: Table2, log: ScrollText,
  part: Box, port: Zap, resistor: SlidersHorizontal,
};
const iconOf = (r: NavRow): typeof Box | null => {
  if (r.icon === "folder" || r.icon === "group") return r.expanded ? FolderOpen : FolderClosed;
  if (r.icon?.startsWith("shape:")) return SHAPES.find((s) => s.kind === r.icon!.slice(6))?.icon ?? Box;
  return (r.icon && ICONS[r.icon]) || null;
};

// ------------------------------------------------------------------ drag a part onto a component folder

const PART_DRAG = "application/x-fairbeam-part";
const [dropAt, setDropAt] = createSignal<string | null>(null);
const [draggedPart, setDraggedPart] = createSignal<number | null>(null);

/** Drop handlers that move a dragged part into the folder ``path()`` ("" = the top level). Dropped
 * on a part (``onto``), it joins that part's folder, or a new one with both when there is none. */
function dropInto(target: () => { key: string; target: import("./navModel").PartDropTarget }) {
  const ours = (e: DragEvent) => !!e.dataTransfer?.types.includes(PART_DRAG);
  return {
    onDragOver: (e: DragEvent) => {
      if (!ours(e)) return;
      e.preventDefault(); e.stopPropagation();
      const i = draggedPart();
      const allowed = i !== null && !!partDropDecision(draft.parts, i, target().target);
      e.dataTransfer!.dropEffect = allowed ? "move" : "none";
      setDropAt(allowed ? target().key : null);
    },
    onDragLeave: (e: DragEvent) => { if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) setDropAt(null); },
    onDrop: (e: DragEvent) => {
      if (!ours(e)) return;
      e.preventDefault(); e.stopPropagation(); setDropAt(null);
      const payload = e.dataTransfer!.getData(PART_DRAG);
      if (!/^\d+$/.test(payload)) return;
      const i = Number(payload);
      const d = partDropDecision(draft.parts, i, target().target);
      if (!d) return;
      if (d.kind === "group") groupParts(i, d.onto);
      else moveToComponent(i, d.path);
    },
  };
}

// ------------------------------------------------------------------ one row

// labels are i18n keys (translated where they are shown)
const ADD: Partial<Record<NavSection, TreeMenuAction>> = {
  components: { label: "tree.add.component", run: () => createComponent(), icon: Plus },
  parameters: { label: "tree.add.parameter", run: addParam, icon: Plus },
  materials: { label: "tree.add.dielectric", run: () => addMaterial("dielectric"), icon: Plus },
  ports: { label: "tree.add.port", run: addPort, icon: Plus },
  lumped: { label: "tree.add.resistor", run: addResistor, icon: Plus },
};

/** The component folder being renamed inline (its path), like `renaming` for parts and shapes. */
const [renamingFolder, setRenamingFolder] = createSignal<string | null>(null);

function createComponent(parent = "") {
  const path = newComponent(parent);
  setOpen(["sec:components", `folder:${parent}`, `folder:${path}`], true);
  setRenamingFolder(path);
}
const focusCurrent = () => queueMicrotask(() => document.querySelector<HTMLElement>('.nt-tree [role="treeitem"][tabindex="0"]')?.focus());

function Row(props: { row: NavRow; selected: boolean; tabStop: boolean; onActivate: (r: NavRow, e: MouseEvent | KeyboardEvent) => void;
  onToggle: (r: NavRow) => void; onMenu: (r: NavRow, e: MouseEvent | KeyboardEvent) => void; hidden: () => boolean; toggleHidden?: () => void;
  shown: () => boolean; onClose: () => void }) {
  const r = props.row;
  const a = r.action;
  const sel = a.kind === "select" ? a.sel : null;
  // A one-shape part can also be grabbed by its shape row; multiple-shape parts move by their parent row.
  const part = sel?.type === "part" ? sel
    : sel?.type === "primitive" && draft.parts[sel.i]?.primitives.length === 1 ? { type: "part" as const, i: sel.i } : null;
  const geometry = sel?.type === "part" || sel?.type === "primitive";
  const Icon = iconOf(r);
  const add = r.section ? ADD[r.section] : undefined;
  const dropTarget = a.kind === "folder" ? { key: r.id, target: { kind: "folder" as const, path: a.path } }
    : r.section === "components" ? { key: r.id, target: { kind: "root" as const } }
    : part ? { key: r.id, target: { kind: "part" as const, index: part.i } } : null;
  const partDrop = dropTarget ? dropInto(() => dropTarget) : null;
  const folderRename = () => a.kind === "folder" && renamingFolder() === a.path;
  const rename = () => (!!sel && !!renaming() && rowRepresents(sel, renaming()!)) || folderRename();
  const finish = (value: string) => {
    const label = value.trim();
    if (a.kind === "folder") {
      setRenamingFolder(null);
      const to = label && label !== r.label ? renameComponent(a.path, label) : null;
      // the renamed folder is a new row: keep the keyboard focus on it
      if (to) queueMicrotask(() => document.querySelector<HTMLElement>(`.nt-tree [data-id="${CSS.escape(`folder:${to}`)}"]`)?.focus());
      else focusCurrent();
      return;
    }
    // Finish before editing: replacing the row can blur this input synchronously.
    // Its blur handler must not commit the same rename a second time.
    setRenaming(null);
    if (label && sel && (sel.type === "part" || sel.type === "primitive")) edit((d) => {
      if (sel.type === "part") d.parts[sel.i].label = label;
      else d.parts[sel.i].primitives[sel.j].label = label;
    });
    focusCurrent();
  };
  return (
    <Show when={!rename()} fallback={<input autocomplete="off" class="rp-input dz-input nt-rename" aria-label={t("tree.renameItem")} value={r.label}
      style={{ "margin-left": `${8 + (r.level - 1) * 12}px` }}
      ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
      onBlur={(e) => { if (rename()) finish(e.currentTarget.value); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(e.currentTarget.value); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setRenaming(null); setRenamingFolder(null); focusCurrent(); }
      }} />}>
      <div role="treeitem" class="dz-node nt-row" data-id={r.id} data-node={r.section}
        classList={{
          selected: props.selected, "nt-shown": props.shown(), "nt-section": !!r.section, "nt-has-sub": !!r.sub, "nt-has-metrics": !!r.metrics, "dm-folder": a.kind === "folder" || a.kind === "group", "nt-hidden": props.hidden(),
          "dz-bad-node": r.issue === "error", "dz-warn-node": r.issue === "warning", "dz-drop": dropTarget !== null && dropAt() === dropTarget.key,
        }}
        style={{ "padding-left": `${8 + (r.level - 1) * 12}px` }} title={part ? t("tree.part.dragTitle", { name: r.label }) : r.title ?? (r.sub && !r.section ? `${r.label} · ${r.sub}` : r.label)}
        aria-level={r.level} aria-setsize={r.size} aria-posinset={r.pos} aria-selected={props.selected}
        aria-expanded={r.expandable ? r.expanded : undefined} aria-haspopup={geometry || a.kind === "folder" || r.section === "components" ? "menu" : undefined}
        tabindex={props.tabStop ? 0 : -1}
        draggable={!!part}
        onDragStart={(e) => { if (!part) return; e.stopPropagation(); setDraggedPart(part.i); e.dataTransfer!.setData(PART_DRAG, String(part.i)); e.dataTransfer!.effectAllowed = "move"; }}
        onDragEnd={() => { setDropAt(null); setDraggedPart(null); }}
        onDragOver={partDrop?.onDragOver}
        onDragLeave={partDrop?.onDragLeave}
        onDrop={partDrop?.onDrop}
        onClick={(e) => props.onActivate(r, e)} onContextMenu={(e) => props.onMenu(r, e)}>
        <Show when={r.expandable} fallback={<span class="nt-twisty" aria-hidden="true" />}>
          <span class="nt-twisty" aria-hidden="true" onClick={(e) => { e.stopPropagation(); props.onToggle(r); }}>
            {r.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        </Show>
        <span class="nt-icon" aria-hidden="true"><Show when={Icon}>{(() => { const I = Icon!; return <I size={13} />; })()}</Show></span>
        <span class="dz-node-label" classList={{ mono: r.icon === "param" }}>{r.label}<Show when={props.shown()}><span class="visually-hidden">{t("tree.shownSuffix")}</span></Show><Show when={a.kind === "run"}><RunQualityBadge compact q={runQualityOf((a as { file: string }).file)} /></Show></span>
        <Show when={r.count !== undefined}><span class="nt-count">{r.count}</span></Show>
        <Show when={r.sub}><span class="dz-node-sub">{r.sub}</span></Show>
        <Show when={props.toggleHidden}><button class="icon-btn icon-btn-sm nt-eye" tabindex={-1} aria-label={t(props.hidden() ? "tree.showParts" : "tree.hideParts")} title={t(props.hidden() ? "tree.showParts" : "tree.hideParts")} aria-pressed={!props.hidden()} onClick={(e) => { e.stopPropagation(); props.toggleHidden?.(); }}>{props.hidden() ? <EyeOff size={14} /> : <Eye size={14} />}</button></Show>
        <Show when={add}>
          <button class="icon-btn icon-btn-sm nt-add" tabindex={-1} aria-label={t(add!.label)} title={t(add!.label)}
            onClick={(e) => { e.stopPropagation(); add!.run(); }}><Plus size={13} /></button>
        </Show>
        {/* a result that is shown (a main-area tab, the 3D pattern or currents in the 3D view): a dot,
            and × on hover or focus closes it (Delete on the row does the same) */}
        <Show when={props.shown()}>
          <button class="icon-btn icon-btn-sm nt-shown-btn" tabindex={-1} aria-label={t("tree.closeShown", { label: r.label })} title={t("tree.closeShown.title")}
            onClick={(e) => { e.stopPropagation(); props.onClose(); }}>
            <span class="nt-shown-dot" aria-hidden="true" /><X size={12} class="nt-shown-x" aria-hidden="true" />
          </button>
        </Show>
        {/* a row with secondary text keeps the button column, so its text starts where the others do (a section summary is a sentence and takes the room) */}
        <Show when={r.sub && !r.section && !props.toggleHidden && !add}><span class="nt-slot" aria-hidden="true" /></Show>
        {/* a run's headline numbers (resonance, |S11| min, Dmax) on a line of their own */}
        <Show when={r.metrics}><span class="nt-metrics">{r.metrics}</span></Show>
      </div>
    </Show>
  );
}

// ------------------------------------------------------------------ the tree

/** The viewer's expand/collapse choices, for the session. */
const [openState, setOpenState] = createSignal<ReadonlyMap<string, boolean>>(new Map());
const setOpen = (ids: string[], value: boolean) => setOpenState((m) => {
  if (ids.every((id) => m.get(id) === value)) return m;
  const n = new Map(m);
  for (const id of ids) n.set(id, value);
  return n;
});

/** Selections a click on a run keeps: none of the geometry or parameter kinds, which would hide
 * the run's Properties. */
const runKeepsSelection = (s: Selection) => s.type === "design" || s.type === "simulation";
/** two clicks on a sweep folder this close together are a double-click (Compare all) */
const DOUBLE_CLICK_MS = 500;

export function NavTree() {
  createEffect(on(() => file()?.id, () => setSweepViewId(null), { defer: true }));
  let treeEl!: HTMLDivElement;
  const [filter, setFilter] = createSignal("");
  const [focusId, setFocusId] = createSignal<string | null>(null);
  const [note, setNote] = createSignal("");
  const [treeMenu, setTreeMenu] = createSignal<{x:number;y:number;label:string;actions:TreeMenuAction[];trigger:HTMLElement}|null>(null);

  const worst = (...prefixes: string[]): Issue => {
    const r = prefixes.map(issueUnder);
    return r.includes("error") ? "error" : r.includes("warning") ? "warning" : null;
  };
  const partSub = (p: (typeof draft.parts)[number]) => {
    const n = (p.transforms ?? []).length ? copyCount(p) : 1;
    const cuts = (p.cuts ?? []).length;
    return [p.material, n === 1 ? "" : n === null ? t("tree.part.copiesUnknown") : t("tree.part.copies", { count: n - 1, total: n }), cuts ? t("tree.part.cuts", { count: cuts }) : ""].filter(Boolean).join(" · ");
  };
  // the same structure keeps its folder objects (the tree is not rebuilt on every keystroke)
  const folders = createMemo(() => componentTree(draft.parts, draft.components), undefined, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });

  // the evaluated runs of each optimization, read from its manifest again whenever its evaluation count changes
  const [optRuns, setOptRuns] = createSignal<Record<string, OptimizationRun[]>>({});
  const optRead = new Map<string, string>();
  createEffect(() => {
    for (const job of jobs()) {
      const s = job.stats as { manifest_file?: string; file?: string; evaluations?: number };
      const manifest = s.manifest_file ?? s.file;
      if (!(job.kind === "optimize" || job.optimize) || !manifest) continue;
      const stamp = `${s.evaluations ?? 0}:${job.status}`;
      if (optRead.get(job.id) === stamp) continue;
      optRead.set(job.id, stamp);
      loadOptimizationRuns(manifest).then((runs) => setOptRuns((m) => ({ ...m, [job.id]: runs }))).catch(() => optRead.delete(job.id));
    }
  });
  const optJob = (id: string) => jobs().find((j) => j.id === id);

  const nodes = createMemo<NavNode[]>(() => {
    const d = draft;
    const select = (sel: Selection) => ({ kind: "select" as const, sel });
    const sec = (section: NavSection, label: string, children: NavNode[], extra: Partial<NavNode> = {}): NavNode =>
      ({ id: `sec:${section}`, label, section, count: children.length, action: { kind: "section", section }, open: true, children, ...extra });
    const partNode = (i: number): NavNode => {
      const p = d.parts[i];
      const single = p.primitives.length === 1 ? p.primitives[0] : undefined;
      return {
        id: `part:${i}`, label: p.label || p.name, icon: single ? `shape:${single.kind}` : "part", sub: partSub(p), issue: worst(`parts[${i}]`), action: select({ type: "part", i }), open: true,
        searchText: single ? [single.label, kindLabel(single)].filter(Boolean).join(" ") : undefined,
        children: single ? undefined : p.primitives.map((pr, j) => ({
          id: `prim:${i}:${j}`, label: pr.label || kindLabel(pr), icon: `shape:${pr.kind}`, issue: worst(`parts[${i}].primitives[${j}]`),
          action: select({ type: "primitive", i, j }),
        })),
      };
    };
    const folderNode = (f: Folder): NavNode => ({
      id: `folder:${f.path}`, label: f.name, sub: String(folderParts(f).length), title: t("tree.folder.title", { path: f.path }), icon: "folder",
      issue: worst(...folderParts(f).map((i) => `parts[${i}]`)), action: { kind: "folder", path: f.path }, open: true,
      children: [...f.folders.map(folderNode), ...f.parts.map(partNode)],
    });
    const tree = folders();
    // runs, with sweep runs grouped under one "Sweep …" node each
    const results = designResultNodes();
    // jobs name the design by its file id (like designRuns), not by model.id
    const optimizations = optimizationNodes(jobs(), file()?.id ?? "", (id) => optRuns()[id] ?? []);
    return [
      { id: "design", label: d.model.name, icon: "design", issue: worst("model"), action: select({ type: "design" }) },
      // the parameters live in the bottom dock (#53): one row here opens that tab
      { id: "parameters", label: t("tree.parameters"), sub: String(d.params.length), icon: "param", title: t("tree.parameters.title"),
        issue: d.params.some((p) => names().errors[p.key]) ? "error" : worst("params"), action: { kind: "parameters" } },
      sec("components", t("tree.components"), [...tree.folders.map(folderNode), ...tree.parts.map(partNode)],
        { count: d.parts.length, issue: worst("parts"), title: t("tree.components.title") }),
      sec("materials", t("tree.materials"), d.materials.map((m, i) => ({
        id: `mat:${i}`, label: m.name, sub: m.kind === "metal" ? t("tree.material.metal") : `εr ${m.eps_r}`, issue: worst(`materials.${m.name}`, `materials[${i}]`),
        action: select({ type: "material", i }),
      })), { issue: worst("materials") }),
      sec("ports", t("tree.ports"), d.ports.map((p, i) => ({
        id: `port:${i}`, label: `Port ${p.number}`, icon: "port", issue: worst(`ports[${i}]`), action: select({ type: "port", i }),
        sub: p.type === "waveguide" ? `${p.mode ?? "TE10"} · ${p.direction}` : `${typeof p.R === "number" ? fmt.num(p.R, 3) : p.R} Ω · ${p.direction}`,
      })), { issue: worst("ports") }),
      sec("lumped", t("tree.lumped"), d.resistors.map((r, i) => ({
        id: `res-el:${i}`, label: r.name || `R${i + 1}`, sub: lumpedLabel(r), icon: "resistor", issue: worst(`resistors[${i}]`), action: select({ type: "resistor", i }),
      })), { issue: worst("resistors") }),
      sec("results", t("tree.results"), results, results.length ? { title: t("tree.results.title") } : { sub: t("tree.results.none") }),
      // each optimization (running or finished) is a node here, like the mesh convergence studies in Results
      sec("optimizations", t("tree.optimizations"), optimizations, optimizations.length ? { title: t("tree.optimizations.title") } : { sub: t("optTree.none") }),
    ];
  });

  // unchanged rows keep their object, so the list only re-renders what changed (and keeps focus)
  let previous = new Map<string, NavRow>();
  const rows = createMemo(() => {
    const next = new Map<string, NavRow>();
    const out = flatten(nodes(), openState(), filter()).map((r) => {
      const old = previous.get(r.id);
      const keep = old && JSON.stringify(old) === JSON.stringify(r) ? old : r;
      next.set(r.id, keep);
      return keep;
    });
    previous = next;
    return out;
  });

  const isSelected = (r: NavRow) => {
    const f = resultFocus();
    const a = r.action;
    switch (a.kind) {
      case "select": return !f && rowRepresents(a.sel, selection());
      case "optimization": { const sel = selection(); return !f && sel.type === "optimization" && sel.id === a.jobId; }
      case "run": return !!f && (f.compare?.length ? selectedRuns().includes(a.file) : f.file === a.file && !r.expanded);
      case "result": return !!f && !f.compare?.length && f.file === a.file && f.view === a.view && (a.f === undefined || f.f === a.f) && (a.map === undefined || f.map === a.map);
      default: return false;
    }
  };
  // a result row is shown when its view is open as a main-area tab for the shown run (a far field at
  // the pattern's frequency), or drawn in the 3D view (3D pattern, surface currents at its frequency)
  const isShown = (r: NavRow) => {
    const a = r.action;
    if (a.kind !== "result") return false;
    const f = resultFocus();
    if (IN_3D.has(a.view)) return !!f && f.file === a.file && f.view === a.view && (a.f === undefined || f.f === a.f) && (a.map === undefined || f.map === a.map);
    if (!isMainResultView(a.view) || designResult()?.file !== a.file || !mainTabs().open.includes(a.view)) return false;
    if (a.view === "fieldmap" && a.map !== undefined) return (f?.file === a.file && f.map !== undefined ? f.map : runContentOf(a.file)?.fieldPlanes?.[0]?.map) === a.map;
    if (a.view !== "pattern" || a.f === undefined) return true;
    return (f?.file === a.file && f.f !== undefined ? f.f : runContentOf(a.file)?.farfield[0]) === a.f;
  };
  // closing a tab leaves the others; a result drawn in 3D goes back to the geometry
  const closeShown = (r: NavRow) => {
    const a = r.action;
    if (a.kind !== "result") return;
    if (IN_3D.has(a.view)) focusResult(null);
    else if (isMainResultView(a.view)) closeMainTab(a.view);
  };
  // one row is in the tab order: the focused one, else the selected one, else the first
  const tabStop = createMemo(() => {
    const list = rows();
    const id = focusId();
    return (id && list.some((r) => r.id === id) ? id : list.find(isSelected)?.id) ?? list[0]?.id;
  });

  // keep the selection visible: open the folders (and the part) above a selected shape, the run of a result
  createEffect(on(selection, (s) => {
    if (s.type !== "part" && s.type !== "primitive") return;
    const segs = normComponent(draft.parts[s.i]?.component).split("/").filter(Boolean);
    setOpen(["sec:components", ...segs.map((_, k) => `folder:${segs.slice(0, k + 1).join("/")}`), ...(s.type === "primitive" ? [`part:${s.i}`] : [])], true);
  }));
  createEffect(() => {
    const f = resultFocus();
    if (f) {
      const parent = designResultNodes().find((node) => node.action.kind === "sweep" && node.children?.some((child) => child.action.kind === "run" && child.action.file === f.file));
      setOpen(["sec:results", ...(parent ? [parent.id] : []), ...(f.compare?.length ? [] : [`run:${f.file}`])], true);
    }
  });
  // an open run lists its far fields and current maps once its bundle has been read
  createEffect(() => {
    // (collapsed runs are read too, up to a cap, for the quality badge on their row)
    let reads = 0;
    for (const r of rows()) if (r.action.kind === "run" && (r.expanded || reads++ < 30)) void readRunContent(r.action.file);
  });

  const toggle = (r: NavRow) => { if (r.expandable) setOpen([r.id], !r.expanded); };
  let lastSweepClick = { id: "", at: 0 };
  const folderIndices = (path: string) => draft.parts.flatMap((p, i) => {
    const component = normComponent(p.component);
    return component === path || component.startsWith(`${path}/`) ? [i] : [];
  });
  const toggleParts = (indices: number[]) => {
    const hide = indices.some((i) => !hiddenParts[draft.parts[i].name]);
    indices.forEach((i) => setHiddenParts(draft.parts[i].name, hide));
  };
  const activate = (r: NavRow, e: MouseEvent | KeyboardEvent) => {
    setFocusId(r.id);
    setNote("");
    const a = r.action;
    switch (a.kind) {
      // a geometry node brings the 3D view to the front of the main area (MainArea.tsx)
      case "select": focusResult(null); activateMainTab("3d"); setSelection(a.sel); break;
      case "parameters": focusResult(null); openParametersTab(); break;
      // a run shows in the result tab in front, if there is one, else in the dock as before
      // a run or result node drops a stale geometry/parameter selection, so Properties shows the run
      // (the Inspector shows a selected item before the focused run)
      case "run":
        if (!e.ctrlKey && !e.metaKey && !runKeepsSelection(selection())) setSelection({ type: "design" });
        if (!selectRun(a.file, e.ctrlKey || e.metaKey, activeMainResult() ? "main" : "keep")) setNote(t("tree.note.compareFull", { max: MAX_COMPARE })); break;
      // a result node opens (or shows) its main-area tab, as the 1D Results do
      case "result": if (!runKeepsSelection(selection())) setSelection({ type: "design" }); focusResult({ file: a.file, view: a.view, ...(a.f === undefined ? {} : { f: a.f }), ...(a.map === undefined ? {} : { map: a.map }) }, "main"); break;
      // a sweep folder opens and closes like the other folders; a second click on it right after the
      // first (a double-click: the first one re-renders the row, so no dblclick event reaches it) or
      // its menu compares all runs
      case "sweep": {
        const at = performance.now();
        const double = e instanceof MouseEvent && lastSweepClick.id === r.id && at - lastSweepClick.at < DOUBLE_CLICK_MS;
        lastSweepClick = { id: r.id, at: double ? 0 : at };
        if (double) openSweepView(a.id); else toggle(r);
        break;
      }
      case "convergence": openMeshConvergence(a.id); break;
      case "optimization": {
        const job = optJob(a.jobId);
        if (!job) { setNote(t("tree.note.optimizationGone")); break; }
        focusResult(null); setSelection({ type: "optimization", id: a.jobId }); openOptimization(job);
        break;
      }
      case "optimization-history": {
        const job = optJob(a.jobId);
        if (job) openOptimization(job);
        else setNote(t("tree.note.optimizationGone"));
        break;
      }
      // opened in the designer like a run result (the dock loads and checks it), not in Results mode
      case "optimization-best": focusResult({ file: a.file, view: resultFocus()?.view ?? "sparams" }); break;
      case "optimization-save": void saveBest(a.jobId); break;
      case "optimization-apply": { const job = optJob(a.jobId); if (job) void applyOptimizationBest(job).then(setNote); break; }
      default: toggle(r);
    }
  };

  async function saveBest(jobId: string) {
    try {
      // the runner store posts JSON (the server refuses anything else) and refreshes the run index
      const result = await saveOptimizationBest(jobId);
      setNote(t("tree.note.savedBest", { file: result.file }));
    } catch (error) { setNote(t("tree.note.saveBestFailed", { error: (error as Error).message })); }
  }
  const menu = (r: NavRow, e: MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    const trigger = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const x=e instanceof MouseEvent&&e.clientX?e.clientX:rect.left+24, y=e instanceof MouseEvent&&e.clientY?e.clientY:rect.bottom;
    const a=r.action;
    if(a.kind==="select"&&(a.sel.type==="part"||a.sel.type==="primitive")) { setTreeMenu(null); focusResult(null); if(openContext({selection:a.sel,trigger,x,y,...boundsPortTarget(a.sel.i)})) return; }
    closeContext();
    const actions:TreeMenuAction[]=[];
    const runResult = (action: "copyResultData" | "exportResultCsv" | "addResultToComparison") => {
      if (a.kind !== "run" && a.kind !== "result") return;
      const ref = a.kind === "run" ? { file: a.file, view: "sparams" as const } : a;
      void import("./treeResultActions").then((m) => m[action](ref)).then(setNote).catch((error) => setNote(String(error)));
    };
    if(a.kind==="section" || a.kind === "group"){actions.push({label:t(r.expanded?"tree.menu.collapse":"tree.menu.expand"),run:()=>toggle(r),icon:r.expanded?ChevronsDownUp:ChevronsUpDown});const add=r.section?ADD[r.section]:undefined;if(add)actions.push({...add,label:t(add.label)});if(r.section==="materials")actions.push({label:t("tree.add.metal"),run:()=>addMaterial("metal"),icon:Plus});}
    else if(a.kind==="folder"){const parts=()=>folderIndices(a.path);actions.push({label:t(r.expanded?"tree.menu.collapseFolder":"tree.menu.expandFolder"),run:()=>toggle(r),icon:r.expanded?ChevronsDownUp:ChevronsUpDown},{label:t("tree.showParts"),run:()=>parts().forEach(i=>setHiddenParts(draft.parts[i].name,false)),icon:Eye},{label:t("tree.hideParts"),run:()=>parts().forEach(i=>setHiddenParts(draft.parts[i].name,true)),icon:EyeOff});
      // component commands: rename (inline, F2), ungroup (contents one level up), delete with its parts
      actions.push({label:t("tree.add.component"),run:()=>createComponent(a.path),icon:Plus});
      const n=parts().length;
      if(n) {
        actions.push({label:t("tree.menu.transformComponent",{count:n}),run:()=>openTransform("move",{type:"component",indices:parts(),name:a.path}),icon:Move});
        actions.push({label:t("contextMenu.color"),run:()=>openColor({kind:"parts",indices:parts(),label:r.label,x,y}),icon:Palette});
      }
      actions.push({label:t("tree.menu.renameComponent",{key:SHORTCUTS.rename.key}),run:()=>setRenamingFolder(a.path),icon:Pencil},
        {label:t("tree.menu.ungroupComponent"),run:()=>ungroupComponent(a.path),icon:Ungroup},
        {label:t("tree.menu.deleteComponent",{count:n}),run:()=>deleteComponent(a.path),icon:Trash2});}
    else if(a.kind==="select") {
      if(a.sel.type!=="material") { activate(r,new KeyboardEvent("keydown")); return; }
      if(a.sel.type==="material") { const mi=a.sel.i; actions.push({label:t("contextMenu.color"),run:()=>openColor({kind:"materials",indices:[mi],label:r.label,x,y}),icon:Palette},{label:t("userMaterials.saveTo"),run:()=>void saveDesignMaterial(mi),icon:BookmarkPlus}); }
    }
    else if(a.kind==="parameters") { activate(r,new KeyboardEvent("keydown")); return; }
    else if(a.kind==="sweep") actions.push({label:t(r.expanded?"tree.menu.collapse":"tree.menu.expand"),run:()=>toggle(r),icon:r.expanded?ChevronsDownUp:ChevronsUpDown},{label:t("tree.sweep.compareAllMenu"),run:()=>openSweepView(a.id),icon:GitCompareArrows});
    else if (a.kind === "convergence") { openMeshConvergence(a.id); return; }
    else if (a.kind === "optimization" || a.kind === "optimization-history" || a.kind === "optimization-best") {
      const job = optJob(a.jobId);
      actions.push({ label: t("optTree.menu.open"), run: () => { if (job) { setSelection({ type: "optimization", id: job.id }); focusResult(null); openOptimization(job); } }, icon: Crosshair });
      if (a.kind === "optimization") {
        const has = !!(job?.stats as { best_file?: string } | undefined)?.best_file;
        if (has && job) actions.push({ label: t("optTree.menu.apply"), run: () => void applyOptimizationBest(job).then(setNote), icon: Variable });
        if (job && !isTerminal(job.status)) actions.push({ label: t("optTree.menu.stop"), run: () => void stopOptimization(job).then(setNote), icon: Square });
        if (job && isTerminal(job.status)) actions.push({ label: t("optTree.menu.delete"), run: () => void deleteOptimizationRecord(job).then(setNote), icon: Trash2 });
      }
    }
    else if (a.kind === "run") actions.push(
      { label: t("tree.menu.focusRun"), run: () => { selectRun(a.file, false); }, icon: Crosshair },
      { label: t("tree.menu.addToComparison"), run: () => runResult("addResultToComparison"), icon: GitCompareArrows },
    );
    else if (a.kind === "result") actions.push(
      { label: t("tree.menu.focusResult"), run: () => activate(r, new KeyboardEvent("keydown")), icon: Crosshair },
      { label: t("tree.menu.copyData"), run: () => runResult("copyResultData"), icon: Copy },
      { label: t("tree.menu.exportCsv"), run: () => runResult("exportResultCsv"), icon: Download },
      { label: t("tree.menu.addToComparison"), run: () => runResult("addResultToComparison"), icon: GitCompareArrows },
    );
    setTreeMenu({x,y,label:r.label,actions,trigger});
  };
  const focusRow = (id: string) => {
    setFocusId(id);
    queueMicrotask(() => treeEl.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus());
  };
  const onKey: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (e) => {
    const el = e.target as HTMLElement;
    if (el.getAttribute("role") !== "treeitem") return; // the rename field, the add buttons
    const list = rows();
    const i = list.findIndex((r) => r.id === el.dataset.id);
    if (i < 0) return;
    const r = list[i];
    // Ctrl/⌘+Enter is Run (DesignKeys): leave it to the document instead of activating the row
    if (matchesShortcut("run", e)) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate(r, e);
      // keep the focus on the row (re-rendered when it opened)
      focusRow(r.id);
      return;
    }
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { menu(r, e); return; }
    // F2 on a component folder renames it (on a part or shape the designer's F2 does)
    if (matchesShortcut("rename", e) && r.action.kind === "folder") { e.preventDefault(); setRenamingFolder(r.action.path); return; }
    // Delete on a shown result closes it; it removes the selected geometry (DesignKeys) only from a geometry row
    if (e.key === "Delete" && isShown(r)) { e.preventDefault(); e.stopPropagation(); closeShown(r); focusRow(r.id); return; }
    if ((e.key === "Delete" || e.key === "Backspace") && r.action.kind !== "select") { e.stopPropagation(); return; }
    const m = treeKey(list, i, e.key);
    if (!m) return;
    e.preventDefault();
    // an opened or closed row is a new row object (re-rendered): focus it again
    if ("toggle" in m) { toggle(list[m.toggle]); focusRow(list[m.toggle].id); }
    else focusRow(list[m.focus].id);
  };

  return (
    <div class="nt">
      <Show when={sweepViewId()}>{(id) => (
        <SweepCompareView id={id()} onClose={() => setSweepViewId(null)}
          onOpenRun={(file) => {
            setSweepViewId(null);
            selectRun(file, false);
          }} />
      )}</Show>
      <div class="nt-head">
      <div class="nt-filter">
        <Search size={13} aria-hidden="true" />
        <input autocomplete="off" class="rp-input nt-filter-input" type="search" placeholder={t("tree.filter")} aria-label={t("tree.filter.label")} aria-controls="nt-tree"
          value={filter()} onInput={(e) => setFilter(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filter()) { e.preventDefault(); e.stopPropagation(); setFilter(""); }
            if (e.key === "ArrowDown" && rows().length) { e.preventDefault(); focusRow(rows()[0].id); }
          }} />
        <Show when={filter()}>
          <button class="icon-btn icon-btn-sm" onClick={() => setFilter("")} aria-label={t("tree.filter.clear")} title={t("tree.filter.clear")}><X size={13} /></button>
        </Show>
      </div>
        <button class="icon-btn icon-btn-sm nt-collapse" data-layout-focus="tree-collapse" type="button" onClick={() => setLeftTreeCollapsed(true)} aria-label={t("tree.collapse")}
          aria-expanded="true" title={t("tree.collapse.title", { key: SHORTCUTS.tree.key })}><ChevronsLeft size={14} aria-hidden="true" /></button>
      </div>
      <p class="nt-help muted">{t("tree.components.help")}</p>
      <p class="nt-note" role="status">{note()}</p>
      <div id="nt-tree" class="dz-tree nt-tree" role="tree" aria-label={t("tree.label")} aria-multiselectable="true" ref={treeEl} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}
        onFocusIn={(e) => { const id = (e.target as HTMLElement).dataset?.id; if (id) setFocusId(id); }}>
        <For each={rows()} fallback={<p class="nt-empty muted">{t("tree.filter.none", { filter: filter() })}</p>}>
          {(r) => {
            // visibility is per part: a part or a folder row has the eye; a shape row only dims with its part
            const a = r.action;
            const indices = a.kind === "select" && (a.sel.type === "part" || a.sel.type === "primitive") ? [a.sel.i] : a.kind === "folder" ? folderIndices(a.path) : [];
            const eye = indices.length > 0 && !(a.kind === "select" && a.sel.type === "primitive");
            const hidden = () => indices.length > 0 && indices.every((i) => !!hiddenParts[draft.parts[i]?.name]);
            return <Row row={r} selected={isSelected(r)} tabStop={tabStop() === r.id} onActivate={activate} onToggle={toggle} onMenu={menu} hidden={hidden} toggleHidden={eye ? () => toggleParts(indices) : undefined}
              shown={() => isShown(r)} onClose={() => { closeShown(r); focusRow(r.id); }} />;
          }}
        </For>
      </div>
      <Show when={treeMenu()}>{(m) => <TreeMenu {...m()} close={(restore = true) => {
        const trigger = m().trigger;
        setTreeMenu(null);
        if (restore) trigger.focus();
      }} />}</Show>
    </div>
  );
}
