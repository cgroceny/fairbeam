// Checks for the project picker labels (src/lib/projectLabels.ts) and the compare trace labels
// (src/compare/series.ts): projects that share a name are told apart, unique names stay unchanged,
// the committed demo index (no engine/params fields) still gets labels, and compared runs keep
// their differing sweep values in the legend and the table.
//
//   node --experimental-strip-types scripts/check-project-labels.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { engineBackend, engineName, labelOf, projectLabels } from "../src/lib/projectLabels.ts";
import { newestResults, resultGroups } from "../src/runner/resultsIndex.ts";
import { requireDesignResult, ResultFollow } from "../src/runner/resultFollow.ts";
import { compareLines, compareTable, traceLabels, traces } from "../src/compare/series.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
let failures = 0;
const eq = (got, want, where) => {
  checks++;
  if (got !== want) {
    failures++;
    console.error(`  FAIL ${where}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};
const labelsOf = (entries) => {
  const m = projectLabels(entries);
  return entries.map((e) => m.get(e.file));
};

// the Windows report (PR #23): a CPU and a CUDA run of the same model
{
  const got = labelsOf([
    { file: "win-patch.json", name: "Win patch", engine: "CPU", created: "2026-09-25T10:00:00+0300" },
    { file: "win-cuda.json", name: "Win patch", engine: "CUDA", created: "2026-09-25T11:00:00+0300" },
    { file: "dipole.json", name: "Half-wave dipole", engine: "CPU", created: "2026-09-24T23:18:48+0300" },
  ]);
  eq(got[0], "Win patch · CPU", "engine: CPU");
  eq(got[1], "Win patch · GPU", "engine: a CUDA run is a GPU run (the backend is a detail)");
  eq(got[2], "Half-wave dipole", "a unique name is unchanged");
}

// one name for the engine everywhere (tree, Runs table, Summary, Properties, example panel): CPU or GPU;
// the GPU backend only where a row says it is the backend
{
  for (const [raw, name] of [["cpu", "CPU"], ["CPU", "CPU"], ["gpu", "GPU"], ["GPU", "GPU"], ["CUDA", "GPU"], ["Metal", "GPU"], [" cuda ", "GPU"], ["", null], [null, null], [undefined, null], ["Vulkan", "Vulkan"]]) {
    eq(engineName(raw), name, `engineName(${JSON.stringify(raw)})`);
  }
  for (const [raw, backend] of [["CUDA", "CUDA"], ["metal", "Metal"], ["gpu", null], ["CPU", null], [null, null]]) eq(engineBackend(raw), backend, `engineBackend(${JSON.stringify(raw)})`);
}

// same engine, different parameters: only the differing parameter is named
{
  const got = labelsOf([
    { file: "a.json", name: "Patch", engine: "Metal", params: { L: 29.5, W: 38 } },
    { file: "b.json", name: "Patch", engine: "Metal", params: { L: 30.1, W: 38 } },
    { file: "c.json", name: "Patch", engine: "Metal", params: { W: 38 } },
  ]);
  eq(got[0], "Patch · L=29.5", "params a");
  eq(got[1], "Patch · L=30.1", "params b");
  eq(got[2], "Patch", "the default-parameter run keeps the bare name");
}

// engine first, then parameters for the entries the engine alone does not separate
{
  const got = labelsOf([
    { file: "a.json", name: "Horn", engine: "CPU", params: { f0: 10 } },
    { file: "b.json", name: "Horn", engine: "CUDA", params: { f0: 10 } },
    { file: "c.json", name: "Horn", engine: "CUDA", params: { f0: 12 } },
  ]);
  eq(got[0], "Horn · CPU · f0=10", "engine + params a");
  eq(got[1], "Horn · GPU · f0=10", "engine + params b");
  eq(got[2], "Horn · GPU · f0=12", "engine + params c");
}

// an old index (the demo's): the save time, with the date only when the days differ
{
  const same = labelsOf([
    { file: "a.json", name: "Dipole", created: "2026-09-25T09:05:00+0300" },
    { file: "b.json", name: "Dipole", created: "2026-09-25T14:30:00+0300" },
  ]);
  eq(same[0], "Dipole · 09:05", "time, same day a");
  eq(same[1], "Dipole · 14:30", "time, same day b");
  const days = labelsOf([
    { file: "a.json", name: "Dipole", created: "2026-09-24T09:05:00+0300" },
    { file: "b.json", name: "Dipole", created: "2026-09-25T09:05:00+0300" },
  ]);
  eq(days[0], "Dipole · 2026-09-24 09:05", "date + time a");
  eq(days[1], "Dipole · 2026-09-25 09:05", "date + time b");
  const secs = labelsOf([
    { file: "a.json", name: "Dipole", created: "2026-09-25T09:05:01+0300" },
    { file: "b.json", name: "Dipole", created: "2026-09-25T09:05:42+0300" },
  ]);
  eq(secs[0], "Dipole · 09:05:01", "seconds when the minutes match a");
  eq(secs[1], "Dipole · 09:05:42", "seconds when the minutes match b");
}

// nothing tells them apart: the file name
{
  const got = labelsOf([
    { file: "run-1.json", name: "Loop", engine: "CPU", created: "2026-09-25T09:05:00+0300" },
    { file: "run-2.json", name: "Loop", engine: "CPU", created: "2026-09-25T09:05:00+0300" },
  ]);
  eq(got[0], "Loop · run-1", "file name a");
  eq(got[1], "Loop · run-2", "file name b");
}

// a suffixed label that collides with another project's own name gets the file name too
{
  const got = labelsOf([
    { file: "a.json", name: "Patch", engine: "CPU" },
    { file: "b.json", name: "Patch", engine: "CUDA" },
    { file: "c.json", name: "Patch · CUDA" },
  ]);
  eq(new Set(got).size, 3, "no two labels are equal");
  eq(got[0], "Patch · CPU", "collision: untouched label stays");
}

// missing names fall back to the file name; labelOf falls back for files outside the index
{
  const m = projectLabels([{ file: "x.json", name: null }]);
  eq(m.get("x.json"), "x", "no name: file stem");
  eq(labelOf(m, { file: "other.json", name: "Other" }), "Other", "labelOf: not in the map");
}

// the committed demo index: every name there is unique, so every label is the plain name
{
  const index = JSON.parse(readFileSync(join(root, "public/projects/index.json"), "utf8")).projects;
  const m = projectLabels(index);
  const names = new Set(index.map((p) => p.name));
  if (names.size === index.length) for (const p of index) eq(m.get(p.file), p.name, `demo index: ${p.file}`);
  eq(new Set(m.values()).size, index.length, "demo index: labels are distinct");
}

// Results must ignore previews, follow completion time, and retain old runs in model groups.
{
  const runs = [
    { file: "a-preview.json", model: "a", created: "2026-09-26T14:00:00+0300", simulated: false },
    { file: "a-old.json", model: "a", created: "2026-09-25T12:00:00+0300", simulated: true, engine: "CPU" },
    { file: "a-new.json", model: "a", created: "2026-09-26T12:00:00+0300", simulated: true, engine: "CUDA" },
    { file: "b.json", model: "b", created: "2026-09-26T13:00:00+0300", simulated: true },
  ];
  eq(newestResults(runs, "a")[0].file, "a-new.json", "newest result of this design");
  eq(newestResults(runs, "unrun").length, 0, "unrun design has no result");
  const sameSecond = [runs[1], { ...runs[2], created: runs[1].created }];
  eq(newestResults(sameSecond, "a", new Map([["a-new.json", 1001], ["a-old.json", 1000]]))[0].file,
    "a-new.json", "history completion wins over filenames within one second");
  eq(resultGroups(runs)[0].entries.length, 2, "group retains both runs and excludes preview");
  const named = runs.slice(1).map((p) => ({ ...p, name: p.model === "a" ? "Branch-line coupler (2.4 GHz)" : "My named run" }));
  const labels = projectLabels(resultGroups(named).flatMap((g) => g.entries));
  eq(labels.get("a-new.json"), "Branch-line coupler (2.4 GHz) · GPU", "header keeps display name before collision suffix");
  eq(labels.get("b.json"), "My named run", "explicit unique name stays unchanged");
}

// A transient failure retries, pending loads deduplicate, and old responses cannot mask newer runs.
{
  const follow = new ResultFollow();
  const first = follow.begin("run-a");
  eq(follow.begin("run-a"), null, "polling deduplicates an in-flight result");
  follow.finish(first, false);
  const retry = follow.begin("run-a");
  eq(!!retry, true, "failed result can retry on the next poll");
  const newer = follow.begin("run-b");
  follow.finish(retry, true);
  eq(follow.begin("run-b"), null, "late old response preserves the newer pending request");
  follow.finish(newer, true);
  eq(follow.begin("run-b"), null, "successful result is not fetched again");
  follow.reset();
  eq(!!follow.begin("run-b"), true, "opening a design again reloads its result");
  follow.dismiss();
  eq(follow.begin("run-b"), null, "closing the dock dismisses a pending result");
  let rejected = false;
  try { requireDesignResult({ model: { id: "other-design" } }, "this-design"); } catch { rejected = true; }
  eq(rejected, true, "explicit filename overwritten by another design is refused");
  rejected = false;
  try { requireDesignResult({ model: { id: "this-design" }, preview: true }, "this-design"); } catch { rejected = true; }
  eq(rejected, true, "a preview cannot become a dock result");
}

// Compare trace labels (src/compare/series.ts, #91): the differing sweep values are a trace's
// identity and must survive in the legend, the tooltip and the table's column groups, also when a
// third trace from another model forces the model id into the label.
{
  const load = (f) => JSON.parse(readFileSync(join(root, "public/projects", f), "utf8"));
  const s0 = load("sierpinski-monopole--iterations-0.json");
  const s3 = load("sierpinski-monopole--iterations-3.json");
  const bl = load("branchline-coupler.json");
  const mixed = traceLabels([s0, s3, bl]);
  eq(mixed[0].endsWith(" iterations=0"), true, `mixed models: iterations=0 stays visible (${mixed[0]})`);
  eq(mixed[1].endsWith(" iterations=3"), true, `mixed models: iterations=3 stays visible (${mixed[1]})`);
  eq(mixed[0].startsWith("sierpinski-"), true, `mixed models: the model id leads (${mixed[0]})`);
  eq(mixed.some((l) => / \(\d\)$/.test(l)), false, `mixed models: no "(n)" suffix needed (${mixed.join(" | ")})`);
  eq(mixed[2], "branchline-coupler", "mixed models: a lone model is its id");
  eq(traceLabels([s0, s3]).join(" | "), "iterations=0 | iterations=3", "one model: just the differing values");
  // the chart legend/tooltip (compareLines) and the table groups (compareTable) use the same labels
  const ts = traces(s0, [s3, bl]);
  const lines = compareLines(ts, (s) => s.s11Db);
  const table = compareTable("f (GHz)", lines.x, ts, [{ label: "|S11| (dB)", values: (i) => lines.series[i].y }]);
  eq(lines.series.map((s) => s.label).join(" | "), mixed.join(" | "), "legend labels are the trace labels");
  eq(table.groups.slice(1).map((g) => g.label).join(" | "), mixed.join(" | "), "table column groups are the trace labels");
  // long ids give way to the values, never the other way round
  const mk = (id, params, name = id) => ({ name, model: { id, name: id, params: Object.entries(params).map(([key, value]) => ({ key, value })) } });
  const long = traceLabels([mk("a-rather-long-model-identifier", { substrate_height: 0.813 }), mk("a-rather-long-model-identifier", { substrate_height: 1.524 }), mk("dipole", { L: 60 })]);
  eq(long[0].endsWith(" substrate_height=0.813") && long[1].endsWith(" substrate_height=1.524"), true, `long id shortened, values whole (${long.join(" | ")})`);
  eq(long[0] !== long[1], true, "long labels stay distinct");
  // references keep their own label; identical runs still get a suffix
  eq(traceLabels([s0, { ...mk("reference:x.txt", {}), reference: { label: "Reference: x.txt" } }])[1], "Reference: x.txt", "reference label kept");
  eq(traceLabels([mk("patch", { L: 30 }, "Patch"), mk("patch", { L: 30 }, "Patch")]).join(" | "), "Patch | Patch (2)", "identical runs get a suffix");
}

console.log(`project labels: ${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
