// Simulation settings: frequency range, boundaries (an unfolded box of the six faces),
// mesh, monitors (far-field frequencies and surface-current maps) and solver limits, in one dialog.
// It edits the draft live (with undo, so the preview follows); Cancel restores what was there when
// the dialog opened. Opened from the Simulation ribbon's section buttons at their matching section.
import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import { Activity, Box, Gauge, Grid3x3, Radio, Timer, Waves, X } from "lucide-solid";
import { openMeshConvergence } from "./ConvergenceDialog";
import { FOCUSABLE, useModal } from "../lib/dialog";
import { tabKeyTarget } from "../lib/tabKeys";
import { bundle } from "../state";
import { engine, meshFreshness } from "../runner/store";
import { setSimSettingsOpen, setSimSettingsSection, simSettingsSection } from "../runner/designRun";
import { ExprField } from "./DesignPane";
import FieldPlanesEditor, { addFieldPlane, fieldPlanes } from "./FieldPlanesEditor";
import { setMeshView } from "./MeshView";
import { cellsText, estimateText, estimateTime, meshStats } from "./meshStats";
import { EFFICIENCY_POINTS_DEFAULT, EFFICIENCY_POINTS_MAX, EFFICIENCY_POINTS_MIN, END_DB_MAX, END_DB_MIN } from "./checks";
import { changedSince, draft, edit, fieldId, historyMark, issueUnder, issues, names, rollbackTo } from "./store";
import { tryEvaluate } from "./expr";
import type { Design, Expr } from "./types";
import { fmt, t } from "../i18n";
import NumberField from "../components/NumberField";
import { applyRunProfile, RUN_PROFILES, runProfileSupported, type RunProfile } from "./runProfiles";

/** monitors is optional in the design format (python/fairbeam/design.py): surface-current maps and
 * the efficiency over the band. */
type WithMonitors = Design & { monitors?: { currents?: Expr[]; efficiency?: { points?: number } } };

const FACES = ["x−", "x+", "y−", "y+", "z−", "z+"] as const;
/** label / hint are i18n keys (translated at render); an unknown boundary shows its id */
const TYPES: { id: string; label?: string; short: string; hint?: string; color: string }[] = [
  { id: "MUR", label: "sim.bound.mur", short: "MUR", hint: "sim.bound.mur.hint", color: "var(--al-series-1)" },
  { id: "PML_8", label: "sim.bound.pml", short: "PML", hint: "sim.bound.pml.hint", color: "var(--al-series-3)" },
  { id: "PEC", label: "sim.bound.pec", short: "PEC", hint: "sim.bound.pec.hint", color: "var(--al-3d-metal)" },
  { id: "PMC", label: "sim.bound.pmc", short: "PMC", hint: "sim.bound.pmc.hint", color: "var(--al-series-2)" },
];
const typeOf = (id: string) => TYPES.find((x) => x.id === id) ?? { id, short: id, color: "var(--al-text-3)" };
const typeLabel = (x: (typeof TYPES)[number]) => (x.label ? t(x.label) : x.id);
const typeHint = (x: (typeof TYPES)[number]) => (x.hint ? t(x.hint) : "");

/** "12.5" -> 12.5, anything else stays an expression */
const toExpr = (text: string): Expr => {
  const s = text.trim();
  return s !== "" && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s) : s;
};
/** -10 -> "−10" (a typographic minus, as in the rest of the dialog's text) */
const minus = (n: number) => String(n).replace("-", "−");
const parseList = (text: string): Expr[] => text.split(",").map((x) => x.trim()).filter(Boolean).map(toExpr);

const SECTIONS = [
  { id: "profile", label: "sim.profile.title", icon: Gauge, paths: ["mesh", "simulation.end_criteria_db"] },
  { id: "freq", label: "sim.section.freq", icon: Waves, paths: ["simulation.f_min", "simulation.f_max"] },
  { id: "bounds", label: "sim.section.bounds", icon: Box, paths: ["simulation.boundaries"] },
  { id: "mesh", label: "sim.section.mesh", icon: Grid3x3, paths: ["mesh"] },
  { id: "monitors", label: "sim.section.monitors", icon: Radio, paths: ["far_field", "monitors"] },
  { id: "solver", label: "sim.section.solver", icon: Timer, paths: ["simulation.end_criteria_db", "simulation.max_timesteps"] },
] as const;

/** A comma-separated list of frequencies (expressions allowed) with the checks of each entry. */
function FreqList(props: { label: string; path: string; value: Expr[]; onChange: (v: Expr[]) => void; placeholder?: string }) {
  // the text as typed while focused (re-joining the list on every key would eat the commas)
  const [text, setText] = createSignal<string | null>(null);
  const bad = () => props.value.map((_, k) => issues()[`${props.path}[${k}]`]).filter(Boolean);
  return (
    <label class="dz-field">
      <span class="dz-label">{props.label} <span class="dz-unit">{t("sim.freqList.unit")}</span></span>
      <input autocomplete="off" id={fieldId(props.path)} class="rp-input dz-input mono" type="text" spellcheck={false} placeholder={props.placeholder}
        value={text() ?? props.value.map(String).join(", ")} aria-invalid={bad().some((i) => i!.severity === "error")}
        onInput={(e) => { setText(e.currentTarget.value); props.onChange(parseList(e.currentTarget.value)); }} onBlur={() => setText(null)} />
      <For each={bad()}>{(i) => <span class="dz-value" classList={{ "dz-bad": i!.severity === "error", "dz-warn": i!.severity === "warning" }}>{i!.message}</span>}</For>
    </label>
  );
}

/** The six faces of the simulation box, unfolded (y− faces you), each clickable. */
function BoundaryBox(props: { bounds: string[]; selected: number; onSelect: (k: number) => void }) {
  const S = 52;
  // [column, row] of each face in the net: z+ above y−, z− below it, x− / y− / x+ / y+ around
  const CELL: [number, number][] = [[0, 1], [2, 1], [1, 1], [3, 1], [1, 2], [1, 0]];
  const onKey = (k: number): JSX.EventHandler<SVGGElement, KeyboardEvent> => (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); props.onSelect(k); }
  };
  return (
    <svg class="ss-box" viewBox={`-4 -4 ${4 * S + 8} ${3 * S + 22}`} role="group" aria-label={t("sim.bounds.boxAria")}>
      <For each={FACES}>{(face, k) => {
        const [c, r] = CELL[k()];
        const ty = () => typeOf(props.bounds[k()]);
        return (
          <g role="button" tabindex={0} aria-pressed={props.selected === k()} aria-label={`${face}: ${typeLabel(ty())}`}
            onClick={() => props.onSelect(k())} onKeyDown={onKey(k())}>
            <rect class="ss-face" classList={{ "ss-on": props.selected === k() }} x={c * S} y={r * S} width={S - 2} height={S - 2} rx={3}
              style={{ fill: ty().color, "fill-opacity": 0.28 }} />
            <text x={c * S + (S - 2) / 2} y={r * S + S / 2 - 6} text-anchor="middle">{face}</text>
            <text x={c * S + (S - 2) / 2} y={r * S + S / 2 + 8} text-anchor="middle">{ty().short}</text>
          </g>
        );
      }}</For>
      <text class="ss-axis-l" x={0} y={3 * S + 14}>{t("sim.bounds.unfolded")}</text>
    </svg>
  );
}

export default function SimSettingsDialog() {
  let box: HTMLDivElement | undefined;
  let pane: HTMLDivElement | undefined;
  const d = () => draft as WithMonitors;
  // The edits apply live. Cancel goes back to the design and history of the moment the dialog
  // opened (nothing is left in the undo list); OK keeps the edits.
  const opened = historyMark();
  const changed = () => changedSince(opened);
  const close = () => setSimSettingsOpen(false);
  const cancel = () => { rollbackTo(opened); close(); };
  useModal(() => box, cancel);

  const [face, setFace] = createSignal(4);
  const [section, setSection] = createSignal<string>("freq");
  const [profile, setProfile] = createSignal<RunProfile>("balanced");
  const bounds = () => (typeof d().simulation.boundaries === "string" ? Array(6).fill(d().simulation.boundaries) : (d().simulation.boundaries as string[]));
  const setBound = (k: number | "all", v: string) => edit((x) => {
    if (k === "all") { x.simulation.boundaries = v; return; }
    const b = typeof x.simulation.boundaries === "string" ? Array(6).fill(x.simulation.boundaries) : [...x.simulation.boundaries];
    b[k] = v;
    x.simulation.boundaries = b.every((y) => y === b[0]) ? b[0] : b;
  }, `boundaries${k}`);
  const open = () => bounds().some((b) => b === "MUR" || b.startsWith("PML"));
  const stats = () => meshStats(bundle());
  const designMesh = () => d().mesh.mode === "design";
  const manualMesh = () => d().mesh.mode === "manual";
  const autoSettings = () => bundle()?.mesh?.auto?.settings ?? {};
  const autoNotes = () => bundle()?.mesh?.auto?.notes ?? {};
  const currentAuto = () => meshFreshness() === "current" && autoSettings().mode === "design";
  const autoValue = (key: string, fallback: Expr | string) => currentAuto() ? (autoSettings()[key] ?? fallback) : fallback;
  const override = (key: string) => (d().mesh.overrides as Record<string, Expr | null | undefined> | undefined)?.[key];
  const setOverride = (key: string, value: Expr | null | undefined) => edit((x) => {
    x.mesh.overrides ??= {};
    if (value === undefined) delete (x.mesh.overrides as Record<string, unknown>)[key];
    else (x.mesh.overrides as Record<string, unknown>)[key] = value;
  }, `mesh-${key}`);
  const toggleOverride = (key: string, checked: boolean, fallback: Expr | null) => setOverride(key, checked ? (currentAuto() ? autoSettings()[key] as Expr | null | undefined : undefined) ?? fallback : undefined);
  let previousLegacy: Design["mesh"] | undefined;
  const setMode = (mode: string) => edit((x) => {
    if (x.mesh.mode === "manual") {
      const settings = x.mesh.automatic;
      x.mesh = { ...(settings ?? { mode: "design", overrides: {} }), thin_metal: x.mesh.thin_metal };
    } else if (mode === "design") {
      if (x.mesh.mode !== "design") previousLegacy = JSON.parse(JSON.stringify(x.mesh));
      x.mesh.mode = "design";
      for (const key of ["cells_per_wavelength", "pad", "edge_rule", "max_ratio", "air_cells_per_wavelength"]) delete (x.mesh as Record<string, unknown>)[key];
      x.mesh.overrides ??= {};
    } else if (mode === "auto") {
      x.mesh = previousLegacy ?? { mode: "auto", cells_per_wavelength: 20, thin_metal: x.mesh.thin_metal };
    }
  }, "mesh-mode");
  const excited = () => Math.max(1, (d().ports ?? []).filter((p) => p.excite !== false).length);
  const est = () => estimateTime(bundle(), engine(), excited());
  const currents = () => d().monitors?.currents ?? [];
  const setCurrents = (v: Expr[]) => edit((x) => {
    const w = x as WithMonitors;
    if (v.length) w.monitors = { ...(w.monitors ?? {}), currents: v };
    else if (w.monitors) {
      delete w.monitors.currents;
      if (!Object.keys(w.monitors).length) delete w.monitors;
    }
  }, "currents");
  const efficiency = () => d().monitors?.efficiency;
  /** the efficiency-over-the-band monitor: {points} on, undefined off (monitors dropped when empty) */
  const setEfficiency = (v: { points: number } | undefined) => edit((x) => {
    const w = x as WithMonitors;
    if (v) w.monitors = { ...(w.monitors ?? {}), efficiency: v };
    else if (w.monitors) {
      delete w.monitors.efficiency;
      if (!Object.keys(w.monitors).length) delete w.monitors;
    }
  }, "efficiency");
  const effIssue = () => issues()["monitors.efficiency.points"] ?? issues()["monitors.efficiency"];
  const endIssue = () => issues()["simulation.end_criteria_db"];
  const sectionIssue = (paths: readonly string[]) => paths.map(issueUnder).find((x) => x === "error") ?? paths.map(issueUnder).find(Boolean) ?? null;

  // a click in the nav wins over the scroll position for a moment (the last sections cannot
  // scroll to the top of the pane)
  let pinned = 0;
  const go = (id: string) => {
    setSection(id);
    pinned = Date.now() + 800;
    const target = pane?.querySelector<HTMLElement>(`#ss-${id}`);
    if (pane && target) pane.scrollTop += target.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  };
  onMount(() => {
    const start = simSettingsSection();
    setSimSettingsSection("freq");
    // the ribbon's Surface current button: when there is no monitor yet, one at the far-field
    // frequencies (else the band centre), after the snapshot above so Cancel takes it back; then
    // the field to edit it
    if (start === "currents") {
      const ff = d().far_field.enabled ? d().far_field.frequencies ?? [] : [];
      if (!currents().length && ff.length) setCurrents([...ff]);
      else if (!currents().length) {
        const n = names().names;
        const lo = tryEvaluate(d().simulation.f_min, n).value, hi = tryEvaluate(d().simulation.f_max, n).value;
        if (lo !== undefined && hi !== undefined && hi > 0) setCurrents([Number(((lo + hi) / 2).toPrecision(4))]);
      }
      requestAnimationFrame(() => { go("monitors"); document.getElementById(fieldId("monitors.currents"))?.focus(); });
      return;
    }
    // the ribbon's Efficiency button: the monitor at the default points when there is none (also
    // after the snapshot, so Cancel takes it back), then its points field
    if (start === "efficiency") {
      if (efficiency() === undefined) setEfficiency({ points: EFFICIENCY_POINTS_DEFAULT });
      requestAnimationFrame(() => { go("monitors"); document.getElementById(fieldId("monitors.efficiency.points"))?.focus(); });
      return;
    }
    // the ribbon's Field plane button: a plane just above the model when there is none (after the
    // snapshot, so Cancel takes it back), then the last plane's position field
    if (start === "fieldplanes") {
      if (!fieldPlanes().length) addFieldPlane();
      requestAnimationFrame(() => { go("monitors"); document.getElementById(fieldId(`monitors.field_planes[${Math.max(0, fieldPlanes().length - 1)}].position`))?.focus(); });
      return;
    }
    if (SECTIONS.some((s) => s.id === start)) requestAnimationFrame(() => go(start));
  });
  const onScroll = () => {
    if (!pane || Date.now() < pinned) return;
    // The last section cannot reach the pane's top when there is no content below it.
    if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2) {
      setSection(SECTIONS[SECTIONS.length - 1].id);
      return;
    }
    const top = pane.scrollTop + 24;
    let cur: string = SECTIONS[0].id;
    for (const s of SECTIONS) {
      const el = pane.querySelector<HTMLElement>(`#ss-${s.id}`);
      if (el && el.offsetTop - pane.offsetTop <= top) cur = s.id;
    }
    setSection(cur);
  };
  // the section tabs (#107): only the selected one is a Tab stop; the arrows / Home / End move to
  // a tab and select it (with its scroll); Tab from a tab goes into the selected section
  const onTabKey = (e: KeyboardEvent & { currentTarget: HTMLElement }) => {
    const i = SECTIONS.findIndex((s) => document.getElementById(`ss-tab-${s.id}`) === document.activeElement);
    if (i < 0) return;
    if (e.key === "Tab" && !e.shiftKey) {
      const panel = pane?.querySelector(`#ss-${section()}`);
      const target = [...(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find((x) => x.offsetParent !== null);
      if (target) { e.preventDefault(); target.focus(); }
      return;
    }
    const next = tabKeyTarget(e.key, i, SECTIONS.length);
    if (next === null) return;
    e.preventDefault();
    go(SECTIONS[next].id);
    document.getElementById(`ss-tab-${SECTIONS[next].id}`)?.focus();
  };

  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && cancel()}>
      <div class="dialog ss-dialog" role="dialog" aria-modal="true" aria-labelledby="ss-title" ref={box} tabindex={-1}>
        <div class="dialog-head">
          <div>
            <h2 id="ss-title">{t("sim.title")}</h2>
            <p class="muted">{t("sim.subtitle")}</p>
          </div>
          <button class="icon-btn" onClick={cancel} aria-label={changed() ? t("sim.discardClose") : t("sim.cancelClose")}><X size={16} /></button>
        </div>
        <div class="ss-main">
          <nav class="ss-nav" role="tablist" aria-label={t("sim.sections")} aria-orientation="vertical" onKeyDown={onTabKey}>
            <For each={SECTIONS}>{(s) => (
              <button role="tab" id={`ss-tab-${s.id}`} aria-controls={`ss-${s.id}`} aria-selected={section() === s.id}
                tabindex={section() === s.id ? 0 : -1} onClick={() => go(s.id)}>
                <s.icon size={14} aria-hidden="true" /> {t(s.label)}
                <Show when={sectionIssue(s.paths)}><span class="ss-bad" aria-label={t("sim.hasProblem")}>●</span></Show>
              </button>
            )}</For>
          </nav>
          <div class="ss-pane" ref={pane} onScroll={onScroll}>
            <section id="ss-profile" class="stack" aria-labelledby="ss-profile-title">
              <h3 id="ss-profile-title">{t("sim.profile.title")}</h3>
              <p class="note">{t("sim.profile.note")}</p>
              <div class="cluster">
                <label class="field">
                  <span class="dz-label">{t("sim.profile.choice")}</span>
                  <select class="rp-select dz-input" value={profile()} disabled={!runProfileSupported(d())}
                    onChange={(e) => setProfile(e.currentTarget.value as RunProfile)}>
                    <For each={Object.keys(RUN_PROFILES) as RunProfile[]}>{(key) => <option value={key}>{t(`sim.profile.${key}`)}</option>}</For>
                  </select>
                </label>
                <button class="btn btn-ghost" type="button" disabled={!runProfileSupported(d())}
                  onClick={() => edit((x) => { applyRunProfile(x, profile()); }, "run-profile")}>
                  {t("sim.profile.apply")}
                </button>
              </div>
              <p class="note">{runProfileSupported(d())
                ? t("sim.profile.summary", { cpw: RUN_PROFILES[profile()].cpw, endDb: RUN_PROFILES[profile()].endDb })
                : t("sim.profile.manual")}</p>
            </section>
            <section id="ss-freq" class="stack">
              <h3>{t("sim.freq.title")}</h3>
              <div class="ss-row">
                <ExprField label="f min" unit="GHz" value={d().simulation.f_min} path="simulation.f_min" onChange={(v) => edit((x) => { x.simulation.f_min = v; }, "fmin")} />
                <ExprField label="f max" unit="GHz" value={d().simulation.f_max} path="simulation.f_max" onChange={(v) => edit((x) => { x.simulation.f_max = v; }, "fmax")} />
              </div>
              <p class="note">{t("sim.freq.note")}</p>
            </section>

            <section id="ss-bounds" class="stack">
              <h3>{t("sim.section.bounds")}</h3>
              <div class="ss-bounds">
                <BoundaryBox bounds={bounds()} selected={face()} onSelect={setFace} />
                <div class="stack">
                  <fieldset class="dz-vec">
                    <legend class="dz-label">{t("sim.bounds.face", { face: FACES[face()] })}</legend>
                    <div class="cluster-sm">
                      <For each={TYPES}>{(ty) => (
                        <button class="btn btn-ghost btn-sm" aria-pressed={bounds()[face()] === ty.id} title={typeHint(ty)} onClick={() => setBound(face(), ty.id)}>
                          <span class="ss-swatch" style={{ background: ty.color }} aria-hidden="true" />{ty.short}
                        </button>
                      )}</For>
                    </div>
                  </fieldset>
                  <fieldset class="dz-vec">
                    <legend class="dz-label">{t("sim.bounds.allFaces")}</legend>
                    <div class="cluster-sm">
                      <For each={TYPES}>{(ty) => (
                        <button class="btn btn-ghost btn-sm" aria-pressed={bounds().every((b) => b === ty.id)} title={typeHint(ty)} onClick={() => setBound("all", ty.id)}>{ty.short}</button>
                      )}</For>
                    </div>
                  </fieldset>
                  <div class="ss-legend">
                    <For each={TYPES}>{(ty) => <span><span class="ss-swatch" style={{ background: ty.color }} aria-hidden="true" />{typeLabel(ty)}</span>}</For>
                  </div>
                </div>
              </div>
              {designMesh() ? (
                <div class="dz-field">
                  <span class="dz-label">
                    {t("sim.pad.label")} <span class="dz-unit">mm</span>
                  </span>
                  <label class="dz-check">
                    <input
                      type="checkbox"
                      aria-label={t("sim.pad.override")}
                      checked={override("pad") !== undefined}
                      disabled={!currentAuto() && override("pad") === undefined}
                      onChange={(e) => toggleOverride("pad", e.currentTarget.checked, 0.25)}
                    />{" "}
                    {t("sim.pad.override")}
                  </label>
                  <input autocomplete="off"
                    class="rp-input dz-input mono"
                    aria-label={t("sim.mesh.airPadding")}
                    disabled={override("pad") === undefined}
                    value={String(override("pad") ?? autoValue("pad", t("sim.pendingPreview")))}
                    onInput={(e) => setOverride("pad", toExpr(e.currentTarget.value))}
                  />
                  <span class="dz-value">
                    {currentAuto()
                      ? (autoNotes().pad ?? t("sim.pad.currentPreview"))
                      : t("sim.pad.pendingNote")}
                  </span>
                </div>
              ) : (
                <ExprField
                  optional
                  label={open() ? t("sim.pad.labelEmpty") : t("sim.pad.labelEmptyNoOpen")}
                  unit="mm"
                  value={d().mesh.pad ?? ""}
                  path="mesh.pad"
                  onChange={(v) =>
                    edit((x) => {
                      x.mesh.pad = v === "" ? null : v;
                    }, "pad")
                  }
                />
              )}
              <p class="note">{t("sim.bounds.note")}</p>
            </section>

            <section id="ss-mesh" class="stack">
              <h3>{t("sim.section.mesh")}</h3>
              <label class="dz-field">
                <span class="dz-label">{t("sim.mesh.mode")}</span>
                <select
                  class="rp-input dz-input"
                  aria-label={t("sim.mesh.mode")}
                  value={manualMesh() ? "manual" : designMesh() ? "design" : "auto"}
                  onChange={(e) => setMode(e.currentTarget.value)}
                >
                  <Show when={manualMesh()}><option value="manual">{t("sim.mesh.mode.manual")}</option></Show>
                  <option value="design">{t("sim.mesh.mode.design")}</option>
                  {/* the old automatic mesh is only offered to a design that already uses it */}
                  <Show when={!manualMesh() && !designMesh()}><option value="auto">{t("sim.mesh.mode.auto")}</option></Show>
                </select>
              </label>
              <Show when={manualMesh()}>
                <p class="note">{t("sim.mesh.manualNote")}</p>
                <dl class="kv"><For each={["x", "y", "z"] as const}>{(axis) => <><dt>{axis}</dt><dd>{t("sim.mesh.lineCount", { n: d().mesh.lines?.[axis]?.length ?? 0 })}</dd></>}</For></dl>
                <button class="btn btn-ghost btn-sm" onClick={() => setMode("design")}>{t("sim.mesh.switchAuto")}</button>
              </Show>
              <Show when={designMesh()}>
                <p class="note">
                  {t("sim.mesh.autoNote")}{" "}
                  {currentAuto()
                    ? t("sim.mesh.currentPreview")
                    : t("sim.mesh.previewPending")}
                </p>
                <For
                  each={
                    [
                      ["cells_per_wavelength", "sim.mesh.cpw", 20],
                      ["edge_rule", "sim.mesh.edgeRule", "thirds"],
                      ["air_cells_per_wavelength", "sim.mesh.airCpw", 20],
                      ["max_ratio", "sim.mesh.maxRatio", 1.4],
                      ["pad", "sim.mesh.airPadding", 0.25],
                      ["dielectric_cells", "sim.mesh.dielectricCells", 3],
                    ] as [string, string, Expr][]
                  }
                >
                  {([key, labelKey, fallback]) => {
                    const label = () => t(labelKey);
                    const enabled = () => override(key) !== undefined;
                    const shown = () => (enabled() ? override(key)! : autoValue(key, fallback));
                    return (
                      <div class="ss-auto-field">
                        <label class="dz-check">
                          <input
                            type="checkbox"
                            aria-label={t("sim.mesh.override", { label: label() })}
                            checked={enabled()}
                            disabled={!currentAuto() && !enabled()}
                            onChange={(e) => toggleOverride(key, e.currentTarget.checked, fallback)}
                          />{" "}
                          {t("sim.mesh.override", { label: label() })}
                        </label>
                        <Show
                          when={key === "edge_rule"}
                          fallback={
                            <input autocomplete="off"
                              class="rp-input dz-input mono"
                              aria-label={label()}
                              disabled={!enabled()}
                              value={String(shown() ?? "")}
                              onInput={(e) => setOverride(key, toExpr(e.currentTarget.value))}
                            />
                          }
                        >
                          <select
                            class="rp-input dz-input"
                            aria-label={label()}
                            disabled={!enabled()}
                            value={String(shown())}
                            onChange={(e) => setOverride(key, e.currentTarget.value)}
                          >
                            <option value="thirds">{t("sim.mesh.edgeRule.thirds")}</option>
                            <option value="edge">{t("sim.mesh.edgeRule.edge")}</option>
                          </select>
                        </Show>
                        <span class="dz-value">
                          {currentAuto()
                            ? (autoNotes()[key] ?? t("sim.mesh.serverValue"))
                            : t("sim.mesh.pendingReason")}
                        </span>
                      </div>
                    );
                  }}
                </For>
              </Show>
              <Show when={!designMesh() && !manualMesh()}>
              <div class="ss-row">
                <ExprField label={t("sim.mesh.cpwAtFmax")} value={d().mesh.cells_per_wavelength} path="mesh.cells_per_wavelength"
                  onChange={(v) => edit((x) => { x.mesh.cells_per_wavelength = v; }, "cpw")} />
                <div class="dz-field">
                  <span class="dz-label">{t("sim.mesh.airToOpen")} <span class="dz-unit">mm</span></span>
                  <span class="mono">{d().mesh.pad === undefined || d().mesh.pad === null || d().mesh.pad === "" ? t("sim.mesh.padAuto") : String(d().mesh.pad)}</span>
                  <button class="linklike dz-value" onClick={() => go("bounds")}>{t("sim.mesh.setUnderBounds")}</button>
                </div>
              </div>
              <div class="ss-row">
                <label class="dz-field">
                  <span class="dz-label">{t("sim.mesh.edgeRule")}</span>
                  <select class="rp-input dz-input" value={d().mesh.edge_rule ?? "thirds"}
                    onChange={(e) => edit((x) => { x.mesh.edge_rule = e.currentTarget.value === "edge" ? "edge" : undefined; }, "edge-rule")}>
                    <option value="thirds">{t("sim.mesh.edgeRule.thirds")}</option><option value="edge">{t("sim.mesh.edgeRule.edge")}</option>
                  </select>
                </label>
                <ExprField label={t("sim.mesh.maxRatio")} value={d().mesh.max_ratio ?? 1.4} path="mesh.max_ratio"
                  onChange={(v) => edit((x) => { x.mesh.max_ratio = v === 1.4 ? undefined : v; }, "max-ratio")} />
              </div>
              <ExprField optional label={t("sim.mesh.airCpwEmpty")} value={d().mesh.air_cells_per_wavelength ?? ""}
                path="mesh.air_cells_per_wavelength" onChange={(v) => edit((x) => { x.mesh.air_cells_per_wavelength = v === "" ? null : v; }, "air-cpw")} />
              </Show>
              <label class="dz-field">
                <span class="dz-label">{t("sim.mesh.thinMetal")}</span>
                <select class="rp-input dz-input" value={d().mesh.thin_metal ?? "sheet"}
                  onChange={(e) => edit((x) => { x.mesh.thin_metal = e.currentTarget.value === "volume" ? "volume" : undefined; }, "thin")}>
                  <option value="sheet">{t("sim.mesh.thinMetal.sheet")}</option>
                  <option value="volume">{t("sim.mesh.thinMetal.volume")}</option>
                </select>
                <span class="dz-value">{t("sim.mesh.thinMetal.note")}</span>
              </label>
              <Show when={!manualMesh()}><dl class="kv">
                <dt>{t("sim.mesh.previewMesh")}</dt>
                <dd class="mono">{stats() ? t("sim.mesh.previewStats", { lines: stats()!.lines.join(" × "), cells: cellsText(stats()!.cells) }) : t("sim.mesh.waitingPreview")}</dd>
                <dt>{t("sim.mesh.smallestCell")}</dt><dd class="mono">{stats() ? `${fmt.fixed(stats()!.minCell, 3)} mm` : "—"}</dd>
                <dt>{t("sim.mesh.solverTime")}</dt><dd class="mono" title={est()?.basis}>{estimateText(est())} <span class="muted">{t("sim.mesh.estimate")}</span></dd>
              </dl>
              <div class="cluster-sm">
                <button class="btn btn-ghost btn-sm" onClick={() => { close(); setMeshView(true); }}><Grid3x3 size={13} aria-hidden="true" /> {t("sim.mesh.showView")}</button>
                <button class="btn btn-ghost btn-sm" title={t("sim.mesh.convergenceTitle")}
                  onClick={() => { close(); openMeshConvergence(); }}><Gauge size={13} aria-hidden="true" /> {t("sim.mesh.convergence")}</button>
                <span class="note">{t("sim.mesh.autoHint")}</span>
              </div></Show>
            </section>

            <section id="ss-monitors" class="stack">
              <h3>{t("sim.section.monitors")}</h3>
              <label class="dz-check"><input type="checkbox" checked={d().far_field.enabled}
                onChange={(e) => { const c = e.currentTarget.checked; edit((x) => { x.far_field.enabled = c; }, "ff"); }} /> {t("sim.mon.farField")}</label>
              <Show when={d().far_field.enabled}>
                <FreqList label={t("sim.mon.ffFreqs")} path="far_field.frequencies" value={d().far_field.frequencies ?? []} placeholder={t("sim.mon.ffFreqsEmpty")}
                  onChange={(v) => edit((x) => { x.far_field.frequencies = v; }, "fff")} />
                <label class="dz-check"><input type="checkbox" checked={d().far_field.phase_center !== undefined} onChange={(e) => edit((x) => { x.far_field.phase_center = e.currentTarget.checked ? [0, 0, 0] : undefined; }, "phase-center-toggle")} /> {t("sim.mon.phaseCentre")}</label>
                <Show when={d().far_field.phase_center}><div class="dz-vec"><div class="dz-vec-row">
                  <For each={[0, 1, 2]}>{(k) => <ExprField label={["X", "Y", "Z"][k]} unit="mm" compact value={d().far_field.phase_center![k]} path={`far_field.phase_center[${k}]`} onChange={(v) => edit((x) => { const p = [...(x.far_field.phase_center ?? [0, 0, 0])] as [Expr, Expr, Expr]; p[k] = v; x.far_field.phase_center = p; }, `phase-center-${k}`)} />}</For>
                </div><Show when={issues()["far_field.phase_center"]}><span class="dz-value dz-bad">{issues()["far_field.phase_center"]!.message}</span></Show></div></Show>
                <div class="dz-vec" role="group" aria-label={t("sim.mon.ffFaces")}>
                  <span class="dz-label">{t("sim.mon.ffFaces")}</span>
                  <div class="dz-vec-row">
                    <For each={["x−", "x+", "y−", "y+", "z−", "z+"]}>{(name, k) => (
                      <label class="dz-check"><input type="checkbox" checked={d().far_field.faces?.[k()] ?? true}
                        onChange={(e) => { const c = e.currentTarget.checked; edit((x) => {
                          const f = [...(x.far_field.faces ?? Array(6).fill(true))]; f[k()] = c;
                          x.far_field.faces = f.every(Boolean) ? undefined : f;
                        }, "ff-faces"); }} /> {name}</label>
                    )}</For>
                  </div>
                  <p class="note">{t("sim.mon.ffFacesNote")}</p>
                  <Show when={issues()["far_field.faces"]}><span class="dz-value dz-bad">{issues()["far_field.faces"]!.message}</span></Show>
                  <For each={[0, 1, 2, 3, 4, 5]}>{(k) => <Show when={issues()[`far_field.faces[${k}]`]}><span class="dz-value">{issues()[`far_field.faces[${k}]`]!.message}</span></Show>}</For>
                </div>
              </Show>
              <label class="dz-check"><input type="checkbox" checked={efficiency() !== undefined}
                onChange={(e) => setEfficiency(e.currentTarget.checked ? { points: EFFICIENCY_POINTS_DEFAULT } : undefined)} /> {t("sim.mon.efficiency")}</label>
              <Show when={efficiency()}>
                <label class="dz-field">
                  <span class="dz-label">{t("sim.mon.effPoints")}</span>
                  <NumberField id={fieldId("monitors.efficiency.points")} class="rp-input dz-input mono" min={EFFICIENCY_POINTS_MIN} max={EFFICIENCY_POINTS_MAX} step="1"
                    value={efficiency()!.points ?? EFFICIENCY_POINTS_DEFAULT} aria-invalid={effIssue()?.severity === "error"}
                    aria-describedby={`${fieldId("monitors.efficiency.points")}-message`}
                    onInput={(e) => {
                      // an empty or unparsable entry keeps the stored value; any other number is stored
                      // and flagged by the monitor-efficiency check (a whole number in range), which blocks the run
                      const text = e.currentTarget.value.trim();
                      const v = Number(text);
                      if (text !== "" && Number.isFinite(v)) setEfficiency({ points: v });
                    }}
                    onBlur={(e) => { e.currentTarget.value = String(efficiency()?.points ?? EFFICIENCY_POINTS_DEFAULT); }} />
                  <span id={`${fieldId("monitors.efficiency.points")}-message`} class="dz-value" classList={{ "dz-bad": effIssue()?.severity === "error" }}>
                    {effIssue()?.message ?? t("sim.mon.effRange", { min: EFFICIENCY_POINTS_MIN, max: EFFICIENCY_POINTS_MAX })}</span>
                </label>
                <p class="note">{t("sim.mon.effNote", { points: efficiency()!.points ?? EFFICIENCY_POINTS_DEFAULT })}{d().far_field.enabled ? "" : ` ${t("sim.mon.effNeedsFarField")}`}</p>
              </Show>
              <FreqList label={t("sim.mon.currents")} path="monitors.currents" value={currents()} placeholder={t("sim.mon.currentsEmpty")} onChange={setCurrents} />
              <p class="note"><Activity size={11} aria-hidden="true" /> {t("sim.mon.currentsNote")}</p>
              <p class="note">{t("sim.mon.currentsSingle")}{(d().ports ?? []).length > 1 ? ` ${t("sim.mon.currentsMulti")}` : ""} {t("sim.mon.currentsLegend")}</p>
              <FieldPlanesEditor />
            </section>

            <section id="ss-solver" class="stack">
              <h3>{t("sim.section.solver")}</h3>
              <div class="ss-row">
                <label class="dz-field">
                  <span class="dz-label">{t("sim.solver.end")} <span class="dz-unit">dB</span></span>
                  <NumberField id={fieldId("simulation.end_criteria_db")} class="rp-input dz-input mono" min={END_DB_MIN} max={END_DB_MAX} step="5" value={d().simulation.end_criteria_db ?? -60}
                    aria-invalid={endIssue()?.severity === "error"} aria-describedby={`${fieldId("simulation.end_criteria_db")}-message`}
                    onInput={(e) => {
                      // an empty or unparsable entry (the browser reports both as "") keeps the stored value;
                      // an out-of-range number is stored and flagged by the end-criterion check, which blocks the run
                      const text = e.currentTarget.value.trim();
                      const v = Number(text);
                      if (text !== "" && Number.isFinite(v)) edit((x) => { x.simulation.end_criteria_db = v; }, "end");
                    }}
                    onBlur={(e) => { e.currentTarget.value = String(d().simulation.end_criteria_db ?? -60); }} />
                  <span id={`${fieldId("simulation.end_criteria_db")}-message`} class="dz-value" classList={{ "dz-bad": endIssue()?.severity === "error" }}>
                    {endIssue()?.message ?? t("sim.solver.endHint", { max: minus(END_DB_MAX), min: minus(END_DB_MIN) })}</span>
                </label>
                <label class="dz-field">
                  <span class="dz-label">{t("sim.solver.maxSteps")}</span>
                  <NumberField id={fieldId("simulation.max_timesteps")} class="rp-input dz-input mono" min="1000" step="1000" value={d().simulation.max_timesteps ?? ""} placeholder={t("sim.solver.maxStepsAuto")}
                    onInput={(e) => {
                      if (e.currentTarget.value.trim() === "") { edit((x) => { delete x.simulation.max_timesteps; }, "maxts"); return; }
                      const v = Math.round(Number(e.currentTarget.value)); if (v > 0) edit((x) => { x.simulation.max_timesteps = v; }, "maxts");
                    }} />
                  <span class="dz-value">{t("sim.solver.maxStepsHint")}</span>
                </label>
              </div>
            </section>
          </div>
        </div>
        <div class="dialog-foot">
          <span class="muted">{t("sim.footNote")}</span>
          <div class="dialog-actions">
            <button class="btn btn-ghost" onClick={cancel} title={changed() ? t("sim.discardTitle") : undefined}>{changed() ? t("sim.discard") : t("common.cancel")}</button>
            <button class="btn btn-primary" onClick={close}>{t("common.ok")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
