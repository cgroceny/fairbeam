#!/usr/bin/env node
// Measured solver times (public/benchmarks.json): the committed file matches its sources
// (scripts/build-benchmarks.mjs), and the Run section's table logic (src/lib/benchmarks.ts) picks the
// right rows for every committed bundle: like with like, the bundle's own run marked or added.
// Usage: node --experimental-strip-types scripts/check-benchmarks.mjs   (part of npm run check:exports)
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBenchmarks, serialize } from "./build-benchmarks.mjs";
import { validateBundle } from "../src/lib/validate.ts";
import { benchView, engineText, shortMachine, timestepsText } from "../src/lib/benchmarks.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projects = join(root, "public", "projects");
let checks = 0;
let failed = 0;
const ok = (cond, msg) => {
  checks++;
  if (!cond) {
    failed++;
    console.log(`FAIL ${msg}`);
  }
};

// 1. the committed file is what the script writes from the current sources
const committed = readFileSync(join(root, "public", "benchmarks.json"), "utf8");
ok(committed === serialize(buildBenchmarks()), "public/benchmarks.json is stale: run node scripts/build-benchmarks.mjs");
const file = JSON.parse(committed);

const load = (f) => {
  const v = validateBundle(JSON.parse(readFileSync(join(projects, f), "utf8")));
  if (!v.bundle) throw new Error(`${f}: ${v.errors.join("; ")}`);
  return v.bundle;
};
const clone = (x) => JSON.parse(JSON.stringify(x));

// 2. every committed bundle: rows shown, measured with its own parameters, its run marked exactly once
//    (the patch antenna's bundle is the older 16.06 s run: it is added as "this run")
for (const f of readdirSync(projects).filter((x) => x.endsWith(".json") && x !== "index.json").sort()) {
  const b = load(f);
  const v = benchView(file, b);
  ok(v !== null, `${f}: no measured rows`);
  if (!v) continue;
  ok(v.paramNote === null, `${f}: unexpected parameter note "${v.paramNote}"`);
  ok(v.meshNote === null, `${f}: unexpected mesh note "${v.meshNote}"`);
  const self = v.rows.filter((r) => r.self).length;
  if (f === "patch-antenna.json") {
    ok(self === 0 && v.thisRun !== null, `${f}: the committed run should be added as "this run"`);
    ok(v.thisRun?.solver_s === 16.06 && timestepsText(v.thisRun?.timesteps ?? null) === "18,468", `${f}: this run ${JSON.stringify(v.thisRun)}`);
    const machines = v.rows.map((r) => `${r.row.machine} ${engineText(r.row)}`).join(" | ");
    ok(machines === "Apple M5 Pro CPU · 4 | Apple M5 Pro Metal | AMD Ryzen 9 7900X CPU · 4 | AMD Ryzen 9 7900X CPU · 24 | NVIDIA RTX 3060 (on the 7900X) CUDA",
      `${f}: rows ${machines}`);
    ok(v.rows[0].row.solver_s === 10.6, `${f}: M5 Pro CPU should be the re-measured 10.6 s`);
    // the Windows rows with repeated runs take the docs' medians; MCells/s scaled from the first run
    const [t4, t24, cuda] = v.rows.slice(2).map((r) => r.row);
    ok(t4.solver_s === 52.9 && t4.mcells_s === 65.9 && t4.note?.includes("46.6, 52.9, 58.0"), `${f}: 7900X 4 threads ${JSON.stringify(t4)}`);
    ok(t24.solver_s === 49.91 && !t24.note, `${f}: 7900X 24 threads should stay the single run`);
    ok(cuda.solver_s === 2.56 && cuda.mcells_s === 1362.3 && cuda.note?.includes("2.53, 2.56, 2.58"), `${f}: CUDA ${JSON.stringify(cuda)}`);
  } else {
    ok(self === 1 && v.thisRun === null, `${f}: own run marked ${self} times, thisRun ${!!v.thisRun}`);
  }
  if (f.startsWith("sierpinski-monopole--iterations-0")) {
    ok(v.rows.every((r) => r.row.params.iterations === 0), `${f}: rows with other parameters shown`);
  }
}

// 3. changed parameters: the default-parameter rows with a note; this run added (it is not measured)
{
  const b = clone(load("patch-antenna.json"));
  b.model.params.find((p) => p.key === "patch_w").value = 30;
  b.run.solver_time_s = 20;
  const v = benchView(file, b);
  ok(v?.paramNote?.startsWith("Measured with the default parameters; this one uses patch_w = 30") === true, `changed params note: ${v?.paramNote}`);
  ok(v?.rows.length === 5 && v.rows.every((r) => !Object.keys(r.row.params).length), "changed params: default rows");
  ok(v?.thisRun != null, "changed params: this run added");
}
// 4. same parameters, different grid: mesh note
{
  const b = clone(load("dipole.json"));
  b.run.grid = [50, 50, 50];
  const v = benchView(file, b);
  ok(v?.meshNote?.includes("50 × 50 × 50") === true, `mesh note: ${v?.meshNote}`);
}
// 5. geometry only: rows, no this-run row; unknown model or no file: hidden
{
  const b = clone(load("wilkinson-divider.json"));
  delete b.run;
  const v = benchView(file, b);
  ok(v !== null && v.thisRun === null && v.rows.every((r) => !r.self), "geometry-only bundle");
  const u = clone(load("dipole.json"));
  u.model.id = "no-such-model";
  ok(benchView(file, u) === null, "unknown model is hidden");
  ok(benchView(null, load("dipole.json")) === null, "missing file is hidden");
}
// 6. a CUDA run on another machine: named from its log, added as this run
{
  const b = clone(load("pyramidal-horn.json"));
  b.run.host = { os: "Windows", machine: "AMD64", cpu: "Intel Core i7" };
  b.run.log_tail = [...(b.run.log_tail ?? []), "Create FDTD engine (GPU, backend: CUDA (NVIDIA GeForce RTX 4090))"];
  const v = benchView(file, b);
  ok(v?.thisRun?.machine === "NVIDIA GeForce RTX 4090 (on Intel Core i7)" && engineText(v.thisRun) === "CUDA", `CUDA this run: ${JSON.stringify(v?.thisRun)}`);
}

// 7. short machine names for the narrow table
for (const [full, short] of [
  ["AMD Ryzen 9 7900X 12-Core Processor", "Ryzen 9 7900X"],
  ["NVIDIA RTX 3060 (on the 7900X)", "RTX 3060 (on the 7900X)"],
  ["Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz", "Core i7-8700"],
  ["Apple M5 Pro", "Apple M5 Pro"],
]) ok(shortMachine(full) === short, `shortMachine("${full}") = "${shortMachine(full)}"`);

console.log(`${checks - failed}/${checks} benchmark checks passed`);
if (failed) process.exit(1);
