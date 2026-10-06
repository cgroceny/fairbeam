#!/usr/bin/env node
// Write public/benchmarks.json: the measured solver times of each example model on the reference
// machines, keyed by model id, for the "Measured on other machines" table in the viewer's Run section.
// Sources (measurements only, nothing is estimated):
//   - docs/benchmarks/windows-7900x.json and windows-7900x-rtx3060-cuda.json (scripts/bench_compare.py)
//   - the committed reference bundles in public/projects/ (their run metadata)
//   - values stated only in docs/BENCHMARKS.md and docs/GPU.md, and the medians of repeated runs
//     (scripts/benchmarks-from-docs.mjs)
// Solver time is the sum over all port runs, as in docs/BENCHMARKS.md. Each row records the parameters
// it was measured with (`params`: the non-default values, {} = default parameters) and its grid.
// Usage: node scripts/build-benchmarks.mjs [--check]   (--check: fail if the committed file is stale)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC_MEDIANS, DOC_ROWS, MACHINES } from "./benchmarks-from-docs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "public", "benchmarks.json");
const WINDOWS = ["docs/benchmarks/windows-7900x.json", "docs/benchmarks/windows-7900x-rtx3060-cuda.json"];

const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));
const round = (v, d) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const sameValue = (a, b) => a === b || (Number.isFinite(Number(a)) && Number(a) === Number(b) && a !== "" && b !== "");

/** The committed bundles: model id → its parameter defaults, and one row per simulated bundle. */
function bundles() {
  const dir = join(root, "public", "projects");
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json") || f === "index.json") continue;
    out.push({ file: `public/projects/${f}`, b: JSON.parse(readFileSync(join(dir, f), "utf8")) });
  }
  return out;
}

/** Only the values that differ from the model's defaults, with the default's type. */
function overrides(values, defaults) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    const d = defaults[k];
    const typed = typeof d === "number" && Number.isFinite(Number(v)) ? Number(v) : v;
    if (d === undefined || !sameValue(typed, d)) out[k] = typed;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** "sierpinski-monopole--iterations-3" → { id, values: { iterations: "3" } } (fairbeam/cli.py _slug) */
function parseStem(stem) {
  const [id, ...parts] = stem.split("--");
  const values = {};
  for (const p of parts) {
    const i = p.indexOf("-");
    if (i > 0) values[p.slice(0, i)] = p.slice(i + 1);
  }
  return { id, values };
}

function machineOf(hostCpu, engine) {
  const m = MACHINES[hostCpu];
  if (!m) return { label: hostCpu ?? "unknown host", order: 99, backend: null };
  if (engine === "gpu" && m.gpu) return { ...m, label: m.gpu.label, order: m.gpu.order };
  return m;
}

function row({ hostCpu, engine, threads, timesteps, solver_s, mcells_s, params, grid, date, source, note }) {
  const m = machineOf(hostCpu, engine);
  const r = { machine: m.label, host_cpu: hostCpu ?? null, engine };
  if (engine === "gpu") {
    if (m.backend) r.backend = m.backend;
    r.threads = null;
  } else if (!threads && m.logical_threads) {
    r.threads = m.logical_threads;
    r.all_threads = true;
  } else {
    r.threads = threads || null;
    if (!threads) r.all_threads = true;
  }
  Object.assign(r, {
    timesteps: timesteps ?? null,
    solver_s: round(solver_s, 3),
    mcells_s: round(mcells_s, 1),
    params,
    grid: grid ?? null,
  });
  if (date) r.date = date;
  r.source = source;
  if (note) r.note = note;
  return { order: m.order, row: r };
}

const sameParams = (a, b) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => k in b && sameValue(v, b[k]));
const sameSlot = (a, model, r) =>
  a.model === model && sameParams(a.row.params, r.params) && a.row.host_cpu === r.host_cpu &&
  a.row.engine === r.engine && (r.engine === "gpu" || a.row.threads === r.threads);

export function buildBenchmarks() {
  const all = bundles();
  const defaults = {};
  for (const { b } of all) {
    defaults[b.model.id] ??= Object.fromEntries((b.model.params ?? []).map((p) => [p.key, p.default]));
  }
  const entries = []; // { model, order, row }
  const push = (model, r) => entries.push({ model, ...r });

  // 1. the committed Apple M5 Pro bundles
  for (const { file, b } of all) {
    const run = b.run;
    if (!run) continue;
    const ports = run.port_runs ?? [];
    const values = Object.fromEntries((b.model.params ?? []).map((p) => [p.key, p.value ?? p.default]));
    push(b.model.id, row({
      hostCpu: run.host?.cpu ?? null,
      engine: run.engine ?? "cpu",
      threads: run.threads,
      timesteps: ports.length ? ports.map((p) => p.timesteps) : run.timesteps ? [run.timesteps] : null,
      solver_s: ports.length ? ports.reduce((s, p) => s + (p.solver_time_s ?? 0), 0) : run.solver_time_s,
      mcells_s: run.speed_mcells_s,
      params: overrides(values, defaults[b.model.id]),
      grid: run.grid,
      date: typeof b.created === "string" ? b.created.slice(0, 10) : null,
      source: file,
    }));
  }

  // 2. the Windows measurements
  for (const rel of WINDOWS) {
    for (const m of readJson(rel).models) {
      const { id, values } = parseStem(m.bundle);
      for (const r of Object.values(m.runs)) {
        push(id, row({
          hostCpu: r.cpu, engine: r.engine, threads: r.threads, timesteps: r.timesteps, solver_s: r.solver_s,
          mcells_s: r.mcells_s, params: overrides(values, defaults[id] ?? {}), grid: m.grid, source: rel,
        }));
      }
    }
  }

  // 3. values stated only in the docs: replace a bundle's row for the same slot, or add
  for (const d of DOC_ROWS) {
    const built = row({ hostCpu: d.host_cpu, ...d, params: overrides(d.params, defaults[d.model] ?? {}) });
    const i = entries.findIndex((e) => sameSlot(e, d.model, built.row));
    if (i >= 0) entries[i] = { model: d.model, ...built };
    else push(d.model, built);
  }
  // repeated runs: the median replaces the JSON's first run; same timesteps and cells, so MCells/s scales
  for (const n of DOC_MEDIANS) {
    const e = entries.find((x) => sameSlot(x, n.model, { params: {}, host_cpu: n.host_cpu, engine: n.engine, threads: n.threads }));
    if (!e) throw new Error(`DOC_MEDIANS: no row for ${n.model} on ${n.host_cpu} (${n.engine})`);
    const first = e.row.solver_s;
    e.row.solver_s = n.median;
    if (e.row.mcells_s !== null) e.row.mcells_s = round((e.row.mcells_s * first) / n.median, 1);
    e.row.source = `${e.row.source}, ${n.source}`;
    e.row.note = `median of ${n.runs.length} runs: ${n.runs.map((t) => t.toFixed(t < 10 ? 2 : 1)).join(", ")} s`;
  }

  const models = {};
  // default parameters first, then each set of changed parameters
  const paramKey = (p) => `${Object.keys(p).length}:${JSON.stringify(p)}`;
  entries.sort((a, b) =>
    a.model.localeCompare(b.model) || paramKey(a.row.params).localeCompare(paramKey(b.row.params)) ||
    a.order - b.order || a.row.engine.localeCompare(b.row.engine) || (a.row.threads ?? 0) - (b.row.threads ?? 0));
  for (const e of entries) (models[e.model] ??= []).push(e.row);
  return {
    schema: "fairbeam-benchmarks/1",
    generator: "scripts/build-benchmarks.mjs",
    sources: [...WINDOWS, "public/projects/*.json", "docs/BENCHMARKS.md", "docs/GPU.md"],
    models,
  };
}

/** One row per line, so a diff shows which measurement changed. */
export function serialize(data) {
  const lines = ["{"];
  for (const k of ["schema", "generator", "sources"]) lines.push(` ${JSON.stringify(k)}: ${JSON.stringify(data[k])},`);
  lines.push(' "models": {');
  const ids = Object.keys(data.models);
  ids.forEach((id, i) => {
    lines.push(`  ${JSON.stringify(id)}: [`);
    const rows = data.models[id];
    rows.forEach((r, j) => lines.push(`   ${JSON.stringify(r)}${j < rows.length - 1 ? "," : ""}`));
    lines.push(`  ]${i < ids.length - 1 ? "," : ""}`);
  });
  lines.push(" }", "}", "");
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = serialize(buildBenchmarks());
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(OUT, "utf8");
    } catch {
      /* missing: stale */
    }
    if (current !== text) {
      console.log("FAIL public/benchmarks.json is out of date: run node scripts/build-benchmarks.mjs");
      process.exit(1);
    }
    console.log("public/benchmarks.json is up to date");
  } else {
    writeFileSync(OUT, text);
    const data = JSON.parse(text);
    const n = Object.values(data.models).reduce((s, r) => s + r.length, 0);
    console.log(`wrote public/benchmarks.json: ${Object.keys(data.models).length} models, ${n} rows`);
  }
}
