// Sweep summary for multi-port models (dividers, couplers, filters, arrays): per run, the
// S-parameters that describe the circuit instead of |S11| / Dmax, at each run's first band centre
// or at a frequency the user types. Reads the member bundles (results.sparams) on demand.
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { ArrowDown, ArrowUp } from "lucide-solid";
import { projectUrl } from "../env";
import { num } from "../lib/format";
import { sAt, sMatrix, type SMatrix } from "../lib/sparams";
import type { Bundle } from "../types";
import type { Job } from "./api";
import { attach, openResult } from "./store";
import type { SweepGroup } from "./sweep";
import { fmt, t } from "../i18n";
import NumberField from "../components/NumberField";

/** A sweep of a model whose runs drove several ports (fairbeam run --excite, default all for <= 4 ports). */
export const isMultiPortGroup = (g: SweepGroup) => g.jobs.some((j) => (j.info?.port_total ?? 1) > 1);

const cache = new Map<string, Bundle | null>();

async function loadBundle(j: Job): Promise<Bundle | null> {
  const key = `${j.bundle}|${j.finished ?? ""}`;
  if (cache.has(key)) return cache.get(key)!;
  try {
    const r = await fetch(projectUrl(j.bundle!), { cache: "no-store" });
    const b = r.ok ? ((await r.json()) as Bundle) : null;
    cache.set(key, b);
    return b;
  } catch {
    return null;
  }
}

/** |S_ij| in dB at fHz; S_ji when only that column was driven (reciprocal network). */
export function sDb(S: SMatrix, i: number, j: number, fHz: number): number | null {
  const v = sAt(S, i, j, fHz) ?? sAt(S, j, i, fHz);
  return v ? 10 * Math.log10(Math.max(1e-30, v[0] * v[0] + v[1] * v[1])) : null;
}

export interface MultiRow {
  job: Job;
  values: Record<string, number>;
  fGHz: number | null;
  s21: number | null;
  /** worst input match over the ports with a known S_ii, and that port */
  siiMax: number | null;
  siiPort: number | null;
  /** worst coupling between the ports after the first (isolation), N >= 3 */
  iso: number | null;
  isoPair: [number, number] | null;
  loaded: boolean;
}

/** The summary values of one S-matrix at fHz. */
export function multiRow(S: SMatrix | null, fHz: number | null): Omit<MultiRow, "job" | "values" | "fGHz" | "loaded"> {
  const out = { s21: null as number | null, siiMax: null as number | null, siiPort: null as number | null, iso: null as number | null, isoPair: null as [number, number] | null };
  if (!S || fHz === null || S.ports.length < 2) return out;
  const [p1, p2] = S.ports;
  out.s21 = sDb(S, p2, p1, fHz);
  for (const p of S.ports) {
    const v = sDb(S, p, p, fHz);
    if (v !== null && (out.siiMax === null || v > out.siiMax)) [out.siiMax, out.siiPort] = [v, p];
  }
  const rest = S.ports.slice(1);
  for (let a = 0; a < rest.length; a++)
    for (let b = a + 1; b < rest.length; b++) {
      const v = sDb(S, rest[a], rest[b], fHz);
      if (v !== null && (out.iso === null || v > out.iso)) [out.iso, out.isoPair] = [v, [rest[a], rest[b]]];
    }
  return out;
}

/** First band centre of a run (job stats, else the bundle), else the middle of its frequency range (GHz). */
function bandCentre(j: Job, b: Bundle | null): number | null {
  const s = j.stats.bands?.[0]?.f_center_ghz;
  if (s) return s;
  const band = b?.results?.bands?.[0];
  if (band?.f_center) return band.f_center / 1e9;
  const f = b?.results?.frequency;
  return f?.length ? (f[0] + f[f.length - 1]) / 2e9 : null;
}

const sub = (p: [number, number] | null) => (p ? `S${p[0]}${p[1]}` : "Sij");

export default function SweepSummaryMulti(props: { group: SweepGroup }) {
  const [freq, setFreq] = createSignal(""); // GHz; empty: each run's first band centre
  const done = () => props.group.jobs.filter((j) => j.status === "done" && j.bundle);
  const [bundles] = createResource(
    () => done().map((j) => `${j.id}|${j.finished}`).join(";") || null,
    async () => new Map(await Promise.all(done().map(async (j) => [j.id, await loadBundle(j)] as const))),
  );
  const chosen = () => {
    const v = Number(freq());
    return freq().trim() && v > 0 ? v : null;
  };
  const allRows = createMemo<MultiRow[]>(() =>
    props.group.jobs.map((j) => {
      const b = bundles()?.get(j.id) ?? null;
      const S = sMatrix(b);
      const fGHz = chosen() ?? (j.status === "done" ? bandCentre(j, b) : null);
      return { job: j, values: j.sweep!.values, fGHz, loaded: !!b, ...multiRow(S, b && fGHz !== null ? fGHz * 1e9 : null) };
    }),
  );
  const nPorts = createMemo(() => Math.max(0, ...props.group.jobs.map((j) => j.info?.port_total ?? 0)));
  const isoLabel = () => {
    const p = allRows().find((r) => r.isoPair)?.isoPair ?? null;
    return nPorts() === 3 && p ? `|${sub(p)}|` : t("sweep.multi.isolation");
  };
  type Col = { key: string; label: string; unit: string; digits: number; get: (r: MultiRow) => number | null; title?: string };
  const cols = createMemo<Col[]>(() => [
    ...props.group.keys.map((k) => ({ key: `p:${k}`, label: k, unit: "", digits: 3, get: (r: MultiRow) => r.values[k] ?? null })),
    { key: "f", label: "f", unit: "GHz", digits: 3, get: (r) => r.fGHz },
    { key: "s21", label: "|S21|", unit: "dB", digits: 2, get: (r) => r.s21, title: t("sweep.multi.s21Title") },
    { key: "sii", label: "max |Sii|", unit: "dB", digits: 2, get: (r) => r.siiMax, title: t("sweep.multi.siiTitle") },
    ...(nPorts() >= 3
      ? [{ key: "iso", label: isoLabel(), unit: "dB", digits: 2, get: (r: MultiRow) => r.iso, title: t("sweep.multi.isoTitle") }]
      : []),
  ]);
  const [sort, setSort] = createSignal<{ key: string; dir: 1 | -1 }>({ key: "_index", dir: 1 });
  const rows = createMemo(() => {
    const list = allRows();
    const s = sort();
    if (s.key === "_index") return s.dir === 1 ? list : [...list].reverse();
    const col = cols().find((c) => c.key === s.key);
    if (!col) return list;
    return [...list].sort((a, b) => {
      const va = col.get(a);
      const vb = col.get(b);
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * s.dir;
    });
  });
  const toggle = (key: string) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const cell = (r: MultiRow, c: Col) => {
    const v = c.get(r);
    if (v !== null) return num(v, c.digits);
    if (r.job.status !== "done") return r.job.status;
    return bundles.loading && !r.loaded ? "…" : "—";
  };
  const fieldId = () => `sweep-f-${props.group.id}`;

  return (
    <div class="stack-sm">
      <div class="cluster-sm">
        <label class="rp-inline-field" for={fieldId()}>
          <span>{t("sweep.multi.at")}</span>
          <NumberField id={fieldId()} class="rp-input rp-sweep-f" step="any" min="0" placeholder={t("sweep.multi.bandCentre")} value={freq()}
            onInput={(e) => setFreq(e.currentTarget.value)} />
          <span>GHz</span>
        </label>
        <Show when={bundles.error}>
          <span class="rp-small muted">{t("sweep.multi.readError")}</span>
        </Show>
      </div>
      <div class="rp-summary">
        <table class="table">
          <caption>
            {t("sweep.multi.caption", { ports: nPorts(), at: chosen() ? t("sweep.multi.atFreq", { f: fmt.num(chosen()!, 6) }) : t("sweep.multi.atBand") })}
          </caption>
          <thead>
            <tr>
              <For each={cols()}>
                {(c) => (
                  <th class="num" title={c.title} aria-sort={sort().key === c.key ? (sort().dir === 1 ? "ascending" : "descending") : "none"}>
                    <button class="rp-sort" onClick={() => toggle(c.key)}>
                      {c.label}
                      <Show when={sort().key === c.key}>
                        <Show when={sort().dir === 1} fallback={<ArrowDown size={12} aria-hidden="true" />}><ArrowUp size={12} aria-hidden="true" /></Show>
                      </Show>
                      <Show when={c.unit}><span class="th-unit">{c.unit}</span></Show>
                    </button>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(r) => {
                const open = () => (r.job.status === "done" && r.job.bundle ? openResult(r.job.bundle) : attach(r.job));
                return (
                  <tr class="row-select" tabindex={0} onClick={open} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open())}
                    title={r.siiPort ? (r.isoPair ? t("sweep.multi.worstMatchIso", { port: r.siiPort, pair: sub(r.isoPair) }) : t("sweep.multi.worstMatch", { port: r.siiPort })) : undefined}>
                    <For each={cols()}>{(c) => <td class="num">{cell(r, c)}</td>}</For>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  );
}
