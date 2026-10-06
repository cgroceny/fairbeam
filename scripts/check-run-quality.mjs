// Run quality verdicts (src/lib/runQuality.ts) on the bundled example results and on edited copies.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { indexQuality, runQuality } from "../src/lib/runQuality.ts";
import { SLOW_FRACTION, SLOW_SECONDS, slowHint, watchSpeed } from "../src/designer/slowRun.ts";
import { renderPixelRatio } from "../src/scene/renderBudget.ts";

const dir = new URL("../public/projects/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");
const verdicts = {};
for (const f of files) {
  const b = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
  const q = runQuality(b);
  if (!q) continue;
  verdicts[f] = q.verdict;
  // the bundled examples all reached their end criterion
  assert.notEqual(q.verdict, "not-converged", `${f}: bundled examples converged`);
}
assert.ok(Object.keys(verdicts).length >= 10, "the example bundles were read");

const base = JSON.parse(readFileSync(new URL("patch-antenna.json", dir), "utf8"));
assert.equal(runQuality(base).verdict, "converged", "the patch example is a clean converged run");

const clone = () => structuredClone(base);
const cut = clone(); cut.run.converged = false;
assert.deepEqual(runQuality(cut), { verdict: "not-converged", reasons: [{ code: "timestep-limit" }] }, "a truncated run");

const multi = clone(); multi.run.port_runs = [{ port: 1, converged: true }, { port: 2, converged: false }];
assert.deepEqual(runQuality(multi).reasons, [{ code: "timestep-limit", port: 2 }], "multi-port: the port whose run stopped");

const gain = clone(); const port = Object.values(gain.results.ports)[0];
port.s11_re[10] = 1.05; port.s11_im[10] = 0;   // |S11| = +0.42 dB
const g = runQuality(gain);
assert.equal(g.verdict, "suspicious");
assert.equal(g.reasons[0].code, "s11-above-0db");
assert.ok(Math.abs(g.reasons[0].db - 20 * Math.log10(1.05)) < 1e-9);

const ripple = clone(); Object.values(ripple.results.ports)[0].s11_re[10] = 1.005;  // +0.04 dB: numerical
assert.equal(runQuality(ripple).verdict, "converged", "a ripple within 0.1 dB is not flagged");

const eff = clone(); eff.results.farfield[0].rad_efficiency = 1.08;
assert.deepEqual(runQuality(eff).reasons.map((r) => r.code), ["efficiency-above-100"]);
const effOk = clone(); effOk.results.farfield[0].rad_efficiency = 1.04;
assert.equal(runQuality(effOk).verdict, "converged", "within 5 % of 100 % is not flagged");

const both = clone(); both.run.converged = false; both.results.farfield[0].rad_efficiency = 1.2;
assert.equal(runQuality(both).verdict, "not-converged", "not converged outranks suspicious");

// an uncoupled port (a feed that no longer spans a gap, e.g. after a rotation): |S11| about 0 dB over the
// whole band and/or a total efficiency of a few percent at most (python/fairbeam/cli.py run_quality, the same rules)
{
  const flat = (db) => { const c = clone(); const p = Object.values(c.results.ports)[0]; const g = 10 ** (db / 20); p.s11_re = p.s11_re.map(() => g); p.s11_im = p.s11_im.map(() => 0); return c; };
  const dead = runQuality(flat(-0.04));
  assert.equal(dead.verdict, "suspicious", "|S11| = -0.04 dB over the whole band");
  assert.equal(dead.reasons.length, 1);
  assert.equal(dead.reasons[0].code, "port-uncoupled");
  assert.equal(dead.reasons[0].port, 1);
  assert.ok(Math.abs(dead.reasons[0].s11MinDb + 0.04) < 1e-9);
  assert.equal(runQuality(flat(-0.45)).verdict, "suspicious", "-0.45 dB is still no coupling");
  assert.equal(runQuality(flat(-0.54)).verdict, "converged", "-0.54 dB is just past the limit");
  assert.equal(runQuality(flat(-0.92)).verdict, "converged", "-0.92 dB everywhere: some power gets in (efficiency is fine)");
  assert.equal(runQuality(flat(-3)).verdict, "converged", "a poor match is not an uncoupled port");
  const lowEta = (eta, extra) => { const c = clone(); c.results.farfield[0].rad_efficiency = eta; if (extra) c.results.farfield.push({ ...c.results.farfield[0], rad_efficiency: extra }); return c; };
  const weak = runQuality(lowEta(0.01));
  assert.equal(weak.verdict, "suspicious", "total efficiency of 1 %");
  assert.equal(weak.reasons[0].code, "port-uncoupled");
  assert.equal(weak.reasons[0].s11MinDb, undefined, "the port itself is matched: only the efficiency is reported");
  assert.ok(weak.reasons[0].efficiency < 0.02);
  assert.equal(runQuality(lowEta(0.05)).verdict, "converged", "5 % is poor but not uncoupled");
  assert.equal(runQuality(lowEta(0.01, 0.9)).verdict, "converged", "one far-field entry above 2 % keeps the run clean");
  assert.equal(runQuality(lowEta(null)).verdict, "converged", "an unknown efficiency is not judged");
  const both = flat(-0.04); both.results.farfield[0].rad_efficiency = 0.01;
  assert.equal(runQuality(both).reasons.filter((r) => r.code === "port-uncoupled").length, 1, "one reason for the port and the efficiency");
  const notConv = flat(-0.04); notConv.run.converged = false;
  assert.equal(runQuality(notConv).verdict, "not-converged", "not converged outranks an uncoupled port");
}

const preview = clone(); delete preview.results;
assert.equal(runQuality(preview), null, "a geometry preview has no verdict");

// ---- the project index carries the verdict (python/fairbeam/cli.py run_quality), so a run is badged unread
{
  assert.deepEqual(indexQuality({ quality: "not-converged" }), { verdict: "not-converged", reasons: [] });
  assert.deepEqual(indexQuality({ quality: "suspicious" }), { verdict: "suspicious", reasons: [] });
  assert.equal(indexQuality({ quality: "converged" }).verdict, "converged");
  assert.equal(indexQuality({}), null, "an older index has no field: unknown, not converged");
  assert.equal(indexQuality(undefined), null, "a run the index does not list");
  assert.equal(indexQuality({ quality: "bogus" }), null, "an unknown verdict is ignored");
  // an index written by rebuild_index agrees with the bundles it lists (the committed one predates the field)
  const listed = JSON.parse(readFileSync(new URL("index.json", dir), "utf8")).projects;
  for (const e of listed) {
    if (e.quality === undefined) continue;
    const b = JSON.parse(readFileSync(new URL(e.file, dir), "utf8"));
    assert.equal(e.quality, runQuality(b)?.verdict, `${e.file}: the index verdict follows the bundle`);
  }
  const results = readFileSync(new URL("../src/designer/runResults.ts", import.meta.url), "utf8");
  assert.ok(/return indexQuality\(indexedRuns\(\)\.get\(file\)\)/.test(results), "the tree's badge falls back to the index's verdict");
  assert.ok(/const known = readQuality\(\)\.get\(file\);\s+if \(known !== undefined\) return known;/.test(results), "a bundle that was read outranks the index");
  const types = readFileSync(new URL("../src/types.ts", import.meta.url), "utf8");
  assert.ok(/quality\?: "converged" \| "not-converged" \| "suspicious"/.test(types), "ProjectIndexEntry.quality is optional");
}

// ---- the UI shows the verdict (UX audit 1): wiring, wording in both languages
{
  const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  assert.ok(/<RunQualityBanner file=\{r\(\)\.file\} b=\{r\(\)\.bundle\} \/>/.test(src("designer/MainArea.tsx")), "the banner is over every result tab");
  assert.ok(/RunQualityBanner/.test(src("designer/RunDock.tsx")) && /<RunQualityBadge q=\{bundleQuality\(row\.bundle\)\}/.test(src("designer/RunDock.tsx")), "the Run tab has the banner and the Runs table the badge");
  assert.ok(/<RunQualityBadge compact q=\{runQualityOf\(/.test(src("designer/NavTree.tsx")), "the navigation tree marks the run");
  const design = src("runner/designRun.ts");
  assert.ok(/verdict === "not-converged"/.test(design) && /&& !stops\) setDesignDockTab\("runs"\)/.test(design), "a run that did not converge keeps the dock on its Run tab");
  const en = JSON.parse(readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8"));
  const tr = JSON.parse(readFileSync(new URL("../src/i18n/tr.json", import.meta.url), "utf8"));
  for (const key of ["quality.banner.notConverged", "quality.banner.suspicious", "quality.reason.timestepLimit", "quality.reason.timestepLimitPort", "quality.reason.s11", "quality.reason.efficiency", "quality.badge.notConverged", "quality.badge.check"]) {
    assert.ok(en[key] && tr[key], `${key} is worded in both languages`);
  }
  // one actionable hint per reason
  assert.match(en["quality.reason.timestepLimit"], /Raise max timesteps, or relax the end criterion/);
  assert.match(en["quality.reason.s11"], /Refine the mesh, move the boundaries away from the model, or lower the end criterion/);
  assert.match(en["quality.reason.efficiency"], /efficiency note/);
}

// ---- a run far slower than the estimate (UX tests A, B, C: "0 MC/s" for minutes, 23 min against a ~1 min estimate)
{
  const expected = 250;                  // MCells/s the estimate assumed
  const slow = 20;                       // 8 % of it
  assert.equal(SLOW_FRACTION, 0.1);
  assert.equal(SLOW_SECONDS, 60);
  let since = null;
  since = watchSpeed(since, 100, slow, expected);
  assert.equal(since, 100, "the clock starts when the speed falls below 10 % of the estimate");
  assert.equal(slowHint(since, 100), false, "not yet");
  assert.equal(slowHint(since, 160), false, "exactly a minute is not more than a minute");
  assert.equal(slowHint(since, 161), true, "more than 60 s of it: the hint shows");
  since = watchSpeed(since, 130, 21, expected);
  assert.equal(since, 100, "it stays slow: the clock keeps its start");
  since = watchSpeed(since, 140, 0, expected);
  assert.equal(since, 100, "a zero reading is slow too");
  since = watchSpeed(since, 150, expected * 0.1, expected);
  assert.equal(since, null, "back at 10 %: the clock resets");
  assert.equal(slowHint(since, 1000), false);
  since = watchSpeed(null, 200, 0, expected);
  assert.equal(since, 200, "0 MC/s from the start counts");
  assert.equal(watchSpeed(since, 210, undefined, expected), 200, "no reading leaves the clock as it is");
  assert.equal(watchSpeed(since, 210, null, expected), 200);
  assert.equal(watchSpeed(since, 210, NaN, expected), 200);
  assert.equal(watchSpeed(since, 210, 5, undefined), 200, "no estimate: nothing is known");
  assert.equal(watchSpeed(null, 210, 5, 0), null, "an estimate of zero is no estimate");
  assert.equal(watchSpeed(null, 210, 5, undefined), null);
  assert.equal(slowHint(null, 1e9), false);
  // the dock shows the hint, from the same estimate as the Run dialog, and it is worded
  const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
  const dock = src("designer/RunDock.tsx");
  assert.ok(/watchSpeed\(since, at, measured, untrack\(expected\)\)/.test(dock) && /slowHint\(slowSince\(\), now\(\)\)/.test(dock), "RunDock: the watch and the hint");
  assert.ok(/estimateTime\(bundle\(\), job\(\)\.engine \?\? "cpu"\)\?\.mcps/.test(dock), "RunDock: the expected speed is the estimate's");
  assert.ok(/<Show when=\{slow\(\)\}>[\s\S]*t\("runDock\.slow", \{ speed: num\(speed\(\) \?\? 0, 0\), expected: num\(expected\(\) \?\? 0, 0\) \}\)/.test(dock), "RunDock: the hint shows the two speeds");
  const en = JSON.parse(src("i18n/en.json")), tr = JSON.parse(src("i18n/tr.json"));
  assert.ok(en["runDock.slow"] && tr["runDock.slow"], "worded in both languages");
  assert.match(en["runDock.slow"], /machine is probably busy/);
  assert.match(en["runDock.slow"], /other runs or programs/);
  assert.match(en["runDock.slow"], /3D view/);
  // the 3D view draws at a lower resolution while a local CPU run is active, and not otherwise
  assert.equal(renderPixelRatio(2, false), 2);
  assert.equal(renderPixelRatio(3, false), 2, "the usual cap");
  assert.equal(renderPixelRatio(2, true), 1, "busy: one pixel per CSS pixel");
  assert.equal(renderPixelRatio(1.25, true), 1);
  assert.equal(renderPixelRatio(0.75, true), 0.75, "never above the display's own ratio");
  assert.equal(renderPixelRatio(NaN, true), 1);
  const viewport = src("scene/Viewport.tsx");
  assert.ok(/renderPixelRatio\(window\.devicePixelRatio \|\| 1, localCpuRunActive\(\)\)/.test(viewport), "Viewport: the pixel ratio follows the run");
  assert.ok(/createEffect\(on\(localCpuRunActive, \(\) => resize\(\), \{ defer: true \}\)\)/.test(viewport), "Viewport: it redraws when a run starts or ends");
  const run = src("runner/designRun.ts");
  assert.ok(/job\.status === "running" && \(job\.engine \?\? "cpu"\) === "cpu"/.test(run), "only a local CPU run throttles it (a GPU run does not compete for the cores)");
}

// ---- "Converged" is the field-energy end criterion, not a good match (UX test B: a green banner next to |S11| of -5 dB)
{
  const en = JSON.parse(readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8"));
  const tr = JSON.parse(readFileSync(new URL("../src/i18n/tr.json", import.meta.url), "utf8"));
  for (const key of ["summary.converged", "runDock.converged", "progress.converged", "progress.convergedAt", "props.run.converged"]) {
    assert.match(en[key], /[Ff]ield[- ]energy/, `${key}: says it is the field energy`);
    assert.doesNotMatch(en[key], /^Converged[.:]/, `${key}: no bare "Converged"`);
  }
  for (const key of ["summary.converged", "runDock.converged", "progress.converged", "progress.convergedAt"]) assert.match(en[key], /end criterion|match/, `${key}: not a statement about the match`);
  assert.match(en["summary.converged"], /not a measure of how well the antenna is matched/);
  assert.match(en["runDock.converged"], /not a measure of the match/);
  for (const key of ["summary.converged", "runDock.converged", "progress.converged", "progress.convergedAt", "props.run.converged"]) assert.ok(tr[key] && tr[key] !== en[key], `${key} in Turkish`);
  for (const key of ["summary.converged", "progress.converged", "progress.convergedAt"]) {
    assert.deepEqual([...en[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), [...tr[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort(), `${key}: the same values`);
  }
}

// ---- the uncoupled port is worded and placed like the other reasons
{
  const view = readFileSync(new URL("../src/designer/RunQualityView.tsx", import.meta.url), "utf8");
  assert.ok(/case "port-uncoupled": return \{/.test(view) && /quality\.action\.checks/.test(view) && /setDesignDockTab\("checks"\)/.test(view), "the reason has its words and a way to the checks");
  assert.ok(/verdictHeadline\(q\(\)\)/.test(view) && /verdictHeadline\(o\.q, true\)/.test(view) && /verdictHeadline\(c\(\)\)/.test(view), "banner, other runs and badge use the headline");
  const en = JSON.parse(readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8"));
  const tr = JSON.parse(readFileSync(new URL("../src/i18n/tr.json", import.meta.url), "utf8"));
  for (const key of ["quality.banner.uncoupled", "quality.banner.otherUncoupled", "quality.badge.uncoupled", "quality.action.checks", "quality.reason.uncoupledS11", "quality.reason.uncoupledEfficiency", "quality.reason.uncoupledBoth"]) {
    assert.ok(en[key] && tr[key], `${key} is worded in both languages`);
  }
  assert.match(en["quality.reason.uncoupledS11"], /both ends of the port sit on the metal faces/);
  assert.match(en["quality.reason.uncoupledS11"], /does not follow a shape that was moved, rotated or mirrored/);
}

// ---- a converged run that works but is not a good antenna yet gets a hint, never a verdict (matchHint)
{
  const { matchHint } = await import("../src/lib/runQuality.ts");
  const mk = (f0, fRes, dip) => {
    const c = structuredClone(base);
    const n = 201, fr = Array.from({ length: n }, (_, i) => 1.4e9 + (i * 2e9) / (n - 1));
    const p = Object.values(c.results.ports)[0];
    const g = 10 ** (dip / 20);
    p.s11_re = fr.map((x) => 1 - (1 - g) * Math.exp(-(((x - fRes) / 0.15e9) ** 2)));
    p.s11_im = fr.map(() => 0);
    c.results.frequency = fr;
    c.results.farfield = [{ ...c.results.farfield[0], f: f0 }];
    return c;
  };
  const poor = matchHint(mk(2.45e9, 1.8e9, -3.3));   // the reported patch: resonant at 1.80 GHz, only -3.3 dB deep
  assert.ok(poor && poor.off === "below" && Math.abs(poor.f - 1.8e9) < 0.02e9 && poor.db > -3.4 && poor.db < -3.2, "resonance 26 % below f0, -3.3 dB");
  assert.equal(matchHint(mk(2.45e9, 2.45e9, -25)), null, "a deep dip at f0 needs no hint");
  assert.equal(matchHint(mk(2.45e9, 2.45e9, -4))?.off, undefined, "a shallow dip at f0: poor match only");
  assert.equal(matchHint(mk(2.45e9, 2.9e9, -20))?.off, "above", "a good dip 18 % above f0");
  const cut = mk(2.45e9, 1.8e9, -3.3); cut.run.converged = false;
  assert.equal(matchHint(cut), null, "a run that did not converge gets its verdict, not a match hint");
  const view = readFileSync(new URL("../src/designer/RunQualityView.tsx", import.meta.url), "utf8");
  assert.ok(/quality\.reason\.s11NotConverged/.test(view) && /timestep-limit"\) - Number/.test(view), "|S11| > 0 dB after a truncated run: the cause first");
}

console.log(`run quality: ${Object.keys(verdicts).length} example bundles (${Object.entries(verdicts).filter(([, v]) => v === "suspicious").map(([f]) => f).join(", ") || "none"} suspicious), synthetic cases, the index field, UI wiring and wording`);
