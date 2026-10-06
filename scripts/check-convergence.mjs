// Checks for the designer's mesh convergence study (src/designer/convergence.ts,
// ConvergenceDialog.tsx; the study runs in python/fairbeam/convergence.py):
//
//   node --experimental-strip-types scripts/check-convergence.mjs
//
// 1. The dialog's densities, run budget, the design at another density (auto, design and manual
//    mesh), the total estimate and the 10-minute warning.
// 2. The report rows and plot series of a finished study.
// 3. The navigation tree: a study's runs form one "Mesh convergence" folder with a report row and
//    the verdict in its sub line.
// 4. The UI registration: the Simulation ribbon's Mesh group, the Mesh section of Simulation
//    settings, the tree action, the mounted dialog and the API client.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DENSITIES, DEFAULT_TOL, currentDensity, designAtDensity, longStudyWarning, meshBlocker, parseDensities,
  planDensities, plotPoints, reportRows, series, setDensity, studySub, totalEstimate, verdictDetail, verdictText,
} from "../src/designer/convergence.ts";
import { flatten, resultNodes } from "../src/designer/navModel.ts";
import { t } from "../src/i18n/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
const eq = (got, want, label) => {
  checks++;
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${label}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
};
const ok = (cond, label) => eq(!!cond, true, label);

// 1. setup
eq(DEFAULT_DENSITIES, [15, 20, 30, 40], "default densities");
eq(DEFAULT_TOL, { f_pct: 0.5, s11_db: 1, dmax_db: 0.2 }, "default tolerances");
eq(parseDensities("15, 20,30 40").values, [15, 20, 30, 40], "densities parse with commas and spaces");
for (const bad of ["20, 15", "15, 15", "15", "a, b", "2, 10", "15, 500"]) ok(parseDensities(bad).error, `refused densities "${bad}"`);
eq(planDensities([15, 20, 30, 40], 3), [15, 20, 30], "max runs caps the densities");

const auto = { mesh: { mode: "auto", cells_per_wavelength: 20, air_cells_per_wavelength: 10 } };
const at40 = designAtDensity(auto, 40);
eq(at40.mesh, { mode: "auto", cells_per_wavelength: 40, air_cells_per_wavelength: 20 }, "auto mesh: density set, air scaled");
eq(auto.mesh.cells_per_wavelength, 20, "the design itself is unchanged");
const legacy = { mesh: {} };
eq(designAtDensity(legacy, 30).mesh, { cells_per_wavelength: 30 }, "legacy mesh without a mode");
const dm = { mesh: { mode: "design", overrides: { max_ratio: 1.3 } } };
eq(designAtDensity(dm, 30).mesh, { mode: "design", overrides: { max_ratio: 1.3, cells_per_wavelength: 30 } }, "design mesh: an override");
eq(currentDensity(dm), null, "design mesh without an override: the server's choice");
eq(currentDensity(designAtDensity(dm, 30)), 30, "design mesh with the override");
const expr = { mesh: { mode: "auto", cells_per_wavelength: "cpw", air_cells_per_wavelength: 12 } };
eq(designAtDensity(expr, 25).mesh, { mode: "auto", cells_per_wavelength: 25 }, "an expression density drops the air density");
const manual = { mesh: { mode: "manual", lines: { x: [0, 1], y: [0, 1], z: [0, 1] } } };
ok(meshBlocker(manual)?.includes("manual mesh lines"), "manual mesh is refused with a reason");
eq(meshBlocker(auto), null, "automatic mesh runs");
let threw = false;
try { setDensity(manual, 20); } catch { threw = true; }
ok(threw, "setDensity refuses manual lines");
eq(totalEstimate([{ seconds: [10, 50] }, { seconds: [20, 100] }]), [30, 150], "total estimate adds the runs");
eq(totalEstimate([{ seconds: [10, 50] }, null]), null, "an unknown run leaves the total unknown");
eq(longStudyWarning([100, 500]), null, "no warning up to 10 minutes");
eq(longStudyWarning([300, 601]), null, "an estimate that reads 10 min is not called long");
ok(longStudyWarning([300, 700])?.includes("12"), "warning above 10 minutes quotes the estimate (700 s = 12 min)");

// 2. report
const member = (density, f, s11, dmax, extra = {}) => ({ density, status: "done", file: `p-${density}.json`,
  metrics: { f_res: f, s11_db: s11, dmax_dbi: dmax, zin_re: 48.2, zin_im: -3.4, cells: density ** 3, wall_time_s: 12 }, ...extra });
const study = {
  id: "cv-1", name: "Patch · mesh convergence", kind: "mesh-convergence",
  members: [member(15, 2.30e9, -18, 6.1), member(20, 2.36e9, -22, 6.3), member(30, 2.39e9, -24, 6.35), member(40, 2.392e9, -24.4, 6.36)],
  convergence: { tolerances: DEFAULT_TOL, densities: [15, 20, 30, 40], max_runs: 4, converged: true, converged_at: 30, done: true,
    reason: "converged", verdict: "converged at 30 cells/λ", next: null,
    steps: [
      { from: 15, to: 20, df_pct: 2.6, ds11_db: -4, ddmax_db: 0.2, dzin_ohm: 1, ok: { f: false, s11: false, dmax: false }, converged: false },
      { from: 20, to: 30, df_pct: 1.27, ds11_db: -2, ddmax_db: 0.05, dzin_ohm: 1, ok: { f: false, s11: false, dmax: true }, converged: false },
      { from: 30, to: 40, df_pct: 0.08, ds11_db: -0.4, ddmax_db: 0.01, dzin_ohm: 0.5, ok: { f: true, s11: true, dmax: true }, converged: true },
    ] },
};
const rows = reportRows(study);
eq(rows.map((r) => [r.density, r.ok, r.chosen]), [[15, null, false], [20, false, false], [30, false, true], [40, true, false]], "rows: step verdicts and the chosen density");
eq(rows[1].df, 2.6, "a row carries the change from the previous run");
eq(rows[0].zin, "48.2 − j3.4", "impedance text");
eq(series(study, "f_res").map((p) => p.y), [2.3, 2.36, 2.39, 2.392], "resonance series in GHz");
const pts = plotPoints(series(study, "dmax_dbi"), 180, 72);
ok(pts.every((p) => p.x >= 0 && p.x <= 180 && p.y >= 0 && p.y <= 72), "plot points stay inside the box");
eq(plotPoints([{ x: 1, y: 5 }], 100, 50)[0].x, 50, "a single point is centred");

// 3. navigation tree
const runs = ["p-40.json", "p-30.json", "plain.json"].map((file) => ({ file, label: file, sub: "", title: file }));
const sweep = (index, extra = {}) => ({ id: "cv-1", name: "Patch · mesh convergence", kind: "convergence", total: 4, index, ...extra });
const running = resultNodes(runs, [
  { model: "m", bundle: "p-30.json", status: "done", sweep: sweep(0) },
  { model: "m", bundle: "p-40.json", status: "running", sweep: sweep(1) },
], "m", () => null);
const folder = running.find((n) => n.id === "sweep:cv-1");
eq(folder.label, "Mesh convergence", "the study folder label");
eq(folder.sub, "1 of 4 runs · in progress", "a running study's sub line");
eq(folder.children[0].action, { kind: "convergence", id: "cv-1" }, "the first child opens the report");
const closed = resultNodes(runs, [
  { model: "m", bundle: "p-30.json", status: "done", sweep: sweep(0, { total: 2, verdict: "converged at 30 cells/λ" }) },
  { model: "m", bundle: "p-40.json", status: "done", sweep: sweep(1, { total: 2, verdict: "converged at 30 cells/λ" }) },
], "m", () => null).find((n) => n.id === "sweep:cv-1");
eq(closed.sub, "2 of 2 runs · converged at 30 cells/λ", "a closed study shows its verdict");
eq(closed.children.slice(1).map((c) => c.action.file), ["p-30.json", "p-40.json"], "runs coarse to fine");
eq(studySub({ total: 3, done: 3, failed: 0, active: false }), "3 of 3 runs · stopped", "no verdict: stopped");
const rowsFlat = flatten([{ id: "sec", label: "Results", action: { kind: "section", section: "results" }, open: true, children: [closed] }], new Map(), "convergence");
ok(rowsFlat.some((r) => r.id === "convergence:cv-1"), "the filter finds the report row");
const plain = resultNodes(runs, [{ model: "m", bundle: "p-30.json", status: "done", sweep: { id: "sw-1", name: "Param", total: 1, index: 0 } }], "m", () => null);
ok(plain.find((n) => n.id === "sweep:sw-1").label.startsWith("Sweep "), "parameter sweeps keep their label");

// 4. registration
const src = (p) => readFileSync(join(root, p), "utf8");
const ws = src("src/designer/DesignWorkspace.tsx");
// the ribbon's texts are i18n keys (src/i18n/en.json)
const en = JSON.parse(src("src/i18n/en.json"));
const meshStart = ws.indexOf('<RGroup label={t("ribbon.sim.mesh")}');
const meshGroup = ws.slice(meshStart, ws.indexOf("</RGroup>", meshStart));
ok(meshStart > 0 && en["ribbon.sim.mesh"] === "Mesh", "ribbon: the Mesh group");
ok(meshGroup.includes('label={t("ribbon.sim.convergence")}') && en["ribbon.sim.convergence"] === "Mesh convergence…" && meshGroup.includes("openMeshConvergence()"), "ribbon: Mesh group has Mesh convergence…");
ok(en["ribbon.sim.meshSettings"] === "Mesh settings" && meshGroup.indexOf('label={t("ribbon.sim.meshSettings")}') >= 0 && meshGroup.indexOf('label={t("ribbon.sim.meshSettings")}') < meshGroup.indexOf('label={t("ribbon.sim.convergence")}'), "ribbon: next to Mesh settings");
ok(ws.includes("<ConvergenceDialog />"), "the dialog is mounted in the workspace");
const ss = src("src/designer/SimSettingsDialog.tsx");
const meshSection = ss.slice(ss.indexOf('id="ss-mesh"'), ss.indexOf('id="ss-monitors"'));
ok(meshSection.includes("openMeshConvergence()") && meshSection.includes('t("sim.mesh.convergence")') && en["sim.mesh.convergence"] === "Mesh convergence…", "Simulation settings › Mesh opens the study");
const tree = src("src/designer/NavTree.tsx");
ok(/case "convergence": openMeshConvergence\(a\.id\)/.test(tree), "the tree's report row opens the report");
const apiSrc = src("src/runner/api.ts");
ok(apiSrc.includes('"/convergence"') && apiSrc.includes("`/convergence/${"), "API client: submit and read a study");
const dialog = src("src/designer/ConvergenceDialog.tsx");
ok(dialog.includes("longStudyWarning") && dialog.includes("estimateTime"), "the dialog estimates the time and warns");
ok(dialog.includes("setDensity(d, c)"), "the dialog applies the converged density");
const server = src("python/fairbeam/server.py");
ok(server.includes('r"/api/convergence"') && server.includes('r"/api/convergence/(cv-[\\w-]+)"'), "server routes");

// 2b. no resonance in the band: a minimum at the band edge is not a resonance, so a study
// of such runs is not comparable and must never report "converged" (python/fairbeam/convergence.py)
{
  const edge = (density) => member(density, 1.0e9, -3, null, { metrics: { f_res: 1.0e9, s11_db: -3, dmax_dbi: null, no_resonance: true, zin_re: 20, zin_im: -40, cells: density ** 3, wall_time_s: 5 } });
  const flat = {
    id: "cv-2", name: "Dipole · mesh convergence", kind: "mesh-convergence",
    members: [edge(15), edge(20)],
    convergence: { tolerances: DEFAULT_TOL, densities: [15, 20], max_runs: 2, converged: false, converged_at: null, done: true, reason: "exhausted",
      verdict: "not comparable: no resonance in the band (the minimum is at the band edge)", next: null,
      steps: [{ from: 15, to: 20, df_pct: 0, ds11_db: 0.01, ddmax_db: null, dzin_ohm: 0.1, ok: { f: true, s11: true, dmax: null }, comparable: false, converged: false }] },
  };
  const r = reportRows(flat);
  eq(r.map((x) => [x.ok, x.notComparable, x.noResonance, x.chosen]), [[null, false, true, false], [null, true, true, false]], "rows: a step with no resonance is not comparable, never 'within'");
  eq(verdictText(flat.convergence.verdict), t("conv.verdict.notComparable"), "the verdict is worded as not comparable");
  ok(/no resonance in the band/.test(verdictText(flat.convergence.verdict)) && !/^converged/i.test(verdictText(flat.convergence.verdict)), "the verdict does not say converged");
  ok(/cannot be compared/.test(verdictDetail(flat)) && /band edge/.test(verdictDetail(flat)), "the report explains it instead of blaming the resonance for moving");
  ok(!/still moves/.test(verdictDetail(flat)), "no 'still moves' for a step that is not comparable");
  eq(studySub({ total: 2, done: 2, failed: 0, active: false, verdict: flat.convergence.verdict }).includes("not comparable"), true, "the tree's sub line says so");
  // a study written before the field existed keeps its meaning: comparable
  const old = reportRows({ ...study, members: study.members.map((m) => ({ ...m })) });
  eq(old.map((x) => x.notComparable), [false, false, false, false], "older studies: every step comparable");
  ok(en["conv.verdict.notComparable"] && en["conv.verdict.notComparableLast"] && en["conv.notComparable"] && en["conv.notComparable.title"], "worded in en.json");
  ok(readFileSync(join(root, "src/designer/ConvergenceDialog.tsx"), "utf8").includes('r.notComparable ? t("conv.notComparable")'), "the table cell says n/a");
}

console.log(`convergence: ${checks} checks passed`);
