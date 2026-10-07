// Multi-port S-parameter views for the dock: a compact S_ij picker (matrix popover, at most three
// pairs; compared runs draw each pair in the run's colour with its own dash), a dB/phase chart (a
// stack of panes for the stacked data formats, charts/StackedCharts.tsx), the Smith chart of a port's
// S_ii and the all-pairs table. Single-port bundles never reach this component.

import { createEffect, createMemo, createRoot, createSignal, For, on, onCleanup, Show } from "solid-js";
import { ChevronDown } from "lucide-solid";
import StackedCharts from "../charts/StackedCharts";
import { plotQuantities, type PlotFormat } from "../charts/plotQuantities";
import SmithChart from "../charts/SmithChart";
import { bundle } from "../state";
import { magDb, pairLabel, phaseDeg, sMatrix, zFromGamma, type SMatrix } from "../lib/sparams";
import { gridKeys, radioGroupKeys } from "../lib/a11y";
import { numPlain } from "../lib/format";
import { t } from "../i18n";
import { SERIES_COLORS, type Trace } from "../compare/series";
import type { Bundle } from "../types";

export type SMode = "db" | "phase";
const MAX_SERIES = 3;
const COLORS = ["--al-series-1", "--al-series-2", "--al-series-3"];
const key = (p: [number, number]) => `${p[0]},${p[1]}`;
const pairsOf = (keys: string[]) => keys.map((k) => k.split(",").map(Number) as [number, number]);

/** An S-parameter selection (picked S_ij, dB or phase, Smith port) over one matrix. The Examples
 * dock follows the open project; the designer's Results dock creates its own over the shown run. */
export interface SParamSelection {
  S: () => SMatrix | null;
  sel: () => string[] | null;
  setSel: (keys: string[] | null) => void;
  /** the plotted pairs: the stored keys still in the matrix, else the driven port's column */
  selectedPairs: () => [number, number][];
  mode: () => SMode;
  setMode: (m: SMode) => void;
  /** the Smith chart's port, always one of the matrix's ports */
  smithPort: () => number;
  setSmithPort: (p: number) => void;
}

/** Call under a reactive root. Default S_i1 (port 1 driven), up to three. */
export function createSParamSelection(matrix: () => SMatrix | null): SParamSelection {
  const S = createMemo(matrix);
  const [sel, setSel] = createSignal<string[] | null>(null);
  const [mode, setMode] = createSignal<SMode>("db");
  const [smithPort, setSmithPort] = createSignal(1);
  // Resolve stored keys against the current matrix during the same reactive read. This prevents
  // a new matrix render from observing old keys before an effect has had a chance to run.
  const selectedPairs = createMemo(() => {
    const m = S();
    if (!m) return [] as [number, number][];
    const available = new Set(m.pairs.map(key));
    const stored = sel();
    const valid = (stored ?? []).filter((k) => available.has(k)).slice(0, MAX_SERIES);
    // never empty: an emptied or stale selection (another view mode, a re-run, a design with other
    // ports) falls back to the driven port's column, S11 for a one-port design
    if (valid.length) return pairsOf(valid);
    const drive = m.excited[0] ?? m.ports[0];
    const defaults = m.pairs.filter(([, j]) => j === drive).slice(0, MAX_SERIES);
    return defaults.length ? defaults : m.pairs.slice(0, MAX_SERIES);
  });
  createEffect(on(S, (m) => {
    if (m) setSmithPort((p) => m.ports.includes(p) ? p : m.ports[0]);
  }));
  // resolved in the same read as the matrix, like selectedPairs
  const port = () => {
    const m = S();
    const p = smithPort();
    return !m || m.ports.includes(p) ? p : m.ports[0];
  };
  return { S, sel, setSel, selectedPairs, mode, setMode, smithPort: port, setSmithPort };
}

// the Examples dock's selection follows the open project
const store = createRoot(() => createSParamSelection(() => sMatrix(bundle())));
export const examplesSParams = store;

/** Bundles with two or more ports get the S-parameter views. */
export const multiPort = () => (store.S()?.ports.length ?? 0) >= 2;
export const sParams = store.S;

/** Picker (matrix popover) and dB/phase switch for the dock bar (or, with `smith`, the Smith
 * chart's port). `store` defaults to the Examples dock's selection. */
export function SParamTools(props: { smith?: boolean; store?: SParamSelection; format?: PlotFormat }) {
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  let menu: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ top: 0, left: 0 });
  const store = props.store ?? examplesSParams;
  const S = () => store.S()!;
  const toggle = (p: [number, number]) => {
    const k = key(p);
    const cur = store.selectedPairs().map(key);
    if (cur.includes(k)) { if (cur.length > 1) store.setSel(cur.filter((x) => x !== k)); }
    else if (cur.length < MAX_SERIES) store.setSel([...cur, k]);
  };
  const close = (focus = true) => {
    setOpen(false);
    document.removeEventListener("pointerdown", onDoc);
    if (focus) trigger.focus();
  };
  const onDoc = (e: PointerEvent) => !root.contains(e.target as Node) && close(false);
  const openMenu = () => {
    if (open()) return close(false);
    const r = trigger.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left });
    setOpen(true);
    document.addEventListener("pointerdown", onDoc);
    queueMicrotask(() => {
      if (menu) {
        const m = menu.getBoundingClientRect();
        const top = r.bottom + 4 + m.height > window.innerHeight - 8 ? Math.max(8, r.top - 4 - m.height) : r.bottom + 4;
        setPos({ top, left: Math.max(8, Math.min(r.left, window.innerWidth - 8 - m.width)) });
      }
      menu?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    });
  };
  onCleanup(() => document.removeEventListener("pointerdown", onDoc));
  const onKey = (e: KeyboardEvent) => {
    if (open() && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const summary = () => {
    const p = store.selectedPairs().map(pairLabel);
    return p.length ? p.join(", ") : t("sparams.none");
  };

  return (
    <Show
      when={!props.smith}
      fallback={
        <div class="seg seg-sm" role="radiogroup" aria-label={t("sparams.smithPort")} onKeyDown={radioGroupKeys}>
          <For each={S().ports}>
            {(p) => (
              <button class="seg-btn" role="radio" aria-checked={store.smithPort() === p} classList={{ active: store.smithPort() === p }} onClick={() => store.setSmithPort(p)}>
                {pairLabel([p, p])}
              </button>
            )}
          </For>
        </div>
      }
    >
      <div class="figure-menu" ref={root} onKeyDown={onKey}>
        <button ref={trigger} class="btn btn-ghost btn-sm" aria-haspopup="dialog" aria-expanded={open()} onClick={openMenu} title={t("sparams.pickerTitle")}>
          <span class="mono">{summary()}</span> <ChevronDown size={12} aria-hidden="true" />
        </button>
        <Show when={open()}>
          <div class="menu sp-menu" role="dialog" aria-label={t("sparams.pickerAria")} ref={menu} style={{ top: `${pos().top}px`, left: `${pos().left}px` }}>
            <div class="menu-row">
              <span class="menu-label">{t("sparams.matrixAxes")}</span>
              <span class="menu-label push">{store.selectedPairs().length}/{MAX_SERIES}</span>
            </div>
            <div class="sp-grid" role="group" aria-label={t("sparams.matrixAria")} onKeyDown={(e) => gridKeys(e, S().ports.length)} style={{ "grid-template-columns": `repeat(${S().ports.length}, auto)` }}>
              <For each={S().ports}>
                {(i) => (
                  <For each={S().ports}>
                    {(j) => {
                      const k = key([i, j]);
                      const on = () => store.selectedPairs().some((p) => key(p) === k);
                      const avail = () => S().get(i, j) !== null;
                      return (
                        <button
                          class="chip-btn"
                          aria-pressed={on()}
                          classList={{ active: on() }}
                          disabled={!avail() || (!on() && store.selectedPairs().length >= MAX_SERIES) || (on() && store.selectedPairs().length <= 1)}
                          title={!avail() ? t("sparams.notStored") : !on() && store.selectedPairs().length >= MAX_SERIES ? t("sparams.atMost", { count: MAX_SERIES }) : on() && store.selectedPairs().length <= 1 ? t("sparams.keepOne") : undefined}
                          onClick={() => toggle([i, j])}
                        >
                          {pairLabel([i, j])}
                        </button>
                      );
                    }}
                  </For>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
      <Show when={(props.format ?? "plot") === "plot"}><div class="seg seg-sm" role="radiogroup" aria-label={t("sparams.plottedQuantity")} onKeyDown={radioGroupKeys}>
        <button class="seg-btn" role="radio" aria-checked={store.mode() === "db"} classList={{ active: store.mode() === "db" }} onClick={() => store.setMode("db")}>dB</button>
        <button class="seg-btn" role="radio" aria-checked={store.mode() === "phase"} classList={{ active: store.mode() === "phase" }} onClick={() => store.setMode("phase")}>{t("chart.q.phase")}</button>
      </div></Show>
    </Show>
  );
}

/** dB magnitude or phase of the selected S_ij. */
export function SParamChart(props: { markers?: { x: number; label: string; active?: boolean }[]; onMarker?: (i: number) => void; inspectionKey?: string; format?: PlotFormat }) {
  const S = () => store.S() as SMatrix;
  const fGHz = createMemo(() => S().f.map((f) => f / 1e9));
  const groups = createMemo(() => plotQuantities(store.selectedPairs().flatMap((p, k) => {
      const c = S().get(p[0], p[1]);
      if (!c) return [];
      return [{ id: key(p), label: pairLabel(p), color: COLORS[k], x: fGHz(), re: c.re, im: c.im }];
    }), props.format ?? "plot", store.mode()));
  return (
    <Show when={groups().some((g) => g.series.length)} fallback={<div class="panel-empty">{t("sparams.chooseOneAbove")}</div>}>
      <StackedCharts groups={groups()} inspectionChart={props.inspectionKey}
        ariaLabel={(g) => t("results.aria.vsFrequency", { title: g.title, what: g.series.map((s) => s.label).join(", ") })}
        pane={(g) => (g.kind === "reflection" ? { markers: props.markers, onMarker: props.onMarker } : {})} />
    </Show>
  );
}

/** Smith chart of S_ii for the selected port. */
export function SParamSmith(props: { markers: { f: number; label: string }[] }) {
  const S = () => store.S() as SMatrix;
  const port = () => (S().ports.includes(store.smithPort()) ? store.smithPort() : S().ports[0]);
  const gamma = () => S().get(port(), port());
  const z0 = () => S().zRef[S().ports.indexOf(port())] ?? 50;
  const z = createMemo(() => (gamma() ? zFromGamma(gamma()!, z0()) : null));
  return (
    <Show when={gamma() && z()} fallback={<div class="panel-empty">{t("sparams.pairNotStoredProject", { pair: pairLabel([port(), port()]) })}</div>}>
      <SmithChart
        ariaLabel={t("sparams.smithOf", { pair: pairLabel([port(), port()]) })}
        quantity={pairLabel([port(), port()])}
        f={S().f}
        re={gamma()!.re}
        im={gamma()!.im}
        zRe={z()!.re}
        zIm={z()!.im}
        zRef={z0()}
        markers={props.markers}
      />
    </Show>
  );
}

/** A port's reflection S_pp of a run with its input impedance (null when not stored). */
export function portReflection(b: Bundle, port: number) {
  const m = sMatrix(b);
  const g = m?.get(port, port);
  if (!m || !g) return null;
  const z0 = m.zRef[m.ports.indexOf(port)] ?? 50;
  const z = zFromGamma(g, z0);
  return { f: m.f, re: g.re, im: g.im, zRe: z.re, zIm: z.im, z0 };
}

/** Smith chart of the selection's port S_pp for every compared run, each in its run's colour. */
export function SParamSmithCompare(props: { store: SParamSelection; traces: Trace[]; markers: { f: number; label: string }[] }) {
  const port = () => props.store.smithPort();
  const q = () => pairLabel([port(), port()]);
  const main = createMemo(() => (props.traces[0] ? portReflection(props.traces[0].bundle, port()) : null));
  const overlays = () => props.traces.slice(1).flatMap((t, i) => {
    const r = portReflection(t.bundle, port());
    return r ? [{ label: `${q()} · ${t.label}`, color: SERIES_COLORS[i + 1], re: r.re, im: r.im }] : [];
  });
  return (
    <Show when={main()} fallback={<div class="panel-empty">{t("sparams.pairNotStoredRun", { pair: q() })}</div>}>
      {(m) => (
        <SmithChart ariaLabel={t(props.traces.length > 1 ? "sparams.smithOfCompared" : "sparams.smithOf", { pair: q() })} quantity={q()}
          label={props.traces.length > 1 ? `${q()} · ${props.traces[0].label}` : undefined}
          f={m().f} re={m().re} im={m().im} zRe={m().zRe} zIm={m().zIm} zRef={m().z0} markers={props.markers} overlays={overlays()} />
      )}
    </Show>
  );
}

const every = (n: number, maxRows = 201) => {
  const step = Math.max(1, Math.ceil(n / maxRows));
  return [...Array(n).keys()].filter((i) => i % step === 0 || i === n - 1);
};

/** Table with one column per stored S_ij (dB or phase, following the chart mode). */
export function sparamTable(): { columns: string[]; rows: (string | number)[][] } | null {
  const S = store.S();
  if (!S) return null;
  const phase = store.mode() === "phase";
  const cols = S.pairs.map((p) => (phase ? phaseDeg(S.get(p[0], p[1])!) : magDb(S.get(p[0], p[1])!)));
  return {
    columns: ["f (GHz)", ...S.pairs.map((p) => `${pairLabel(p)} (${phase ? "°" : "dB"})`)],
    rows: every(S.f.length).map((k) => [Number(numPlain(S.f[k] / 1e9, 4)), ...cols.map((c) => c[k])]),
  };
}
