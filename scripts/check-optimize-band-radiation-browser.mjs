// EN/TR optimizer controls. Intercept submissions; no solver, native app, or render job.
// The three history rows are synthetic presentation fixtures, not RF measurements.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer-core";
import { startStack, chromePath } from "./scenarios/stack.mjs";
import { Session, auditInPage } from "./scenarios/harness.mjs";
import { withStartupDiagnostics, safeDiagnosticText } from "./scenarios/startup-diagnostics.mjs";

if (process.env.CI !== "true" && process.env.GITHUB_ACTIONS !== "true" &&
    process.env.FAIRBEAM_ALLOW_LOCAL_BROWSER !== "1" && process.env.FAIRBEAM_ALLOW_BROWSER_TEST !== "1") {
  throw new Error("Local browser acceptance requires explicit browser-test authorization.");
}
const out = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS
  ? join(process.env.FAIRBEAM_TEST_ARTIFACTS, "optimize-band-radiation")
  : join(tmpdir(), `fairbeam-optimize-band-radiation-${Date.now()}`));
await mkdir(out, { recursive: true });
const outcomes = [], forbidden = [];
let stack, browser, page, currentLanguage, failure;

function syntheticJob(body, lang) {
  const now = Date.now() / 1000;
  return { id: `opt-band-browser-${lang}`, kind: "optimize", label: "Synthetic optimizer history",
    model: body.model, model_id: body.model, params: body.params, overrides: {},
    optimize: { vary: body.vary, goals: body.goals, max_evals: body.max_evals, method: body.method, excite: body.excite },
    sweep: null, threads: body.threads, name: "synthetic-optimizer", status: "done", phase: "done",
    created: now, started: now, finished: now + 3, created_iso: new Date().toISOString(), duration_s: 3,
    exit_code: 0, bundle: null, error: null, end_criteria_db: -60, engine: "cpu",
    last_progress: null, stats: {}, info: {} };
}

function history(job) {
  const parameter = job.optimize.vary[0];
  const values = [[null, 75, 3.25, -30], null, [-12.25, 85, 4.5, -31]];
  return values.map((parts, index) => ({ type: "opt_eval", seq: index + 1, at: job.created + index, t: index,
    index: index + 1, evaluations: index + 1, max_evals: 3,
    params: { [parameter.key]: parameter.start }, cost: index === 2 ? 0 : 10000 + index,
    met: index === 2, wall_time_s: 1, file: null, best_index: index === 2 ? 3 : 1, best_cost: 10000,
    // These point-only numbers must not fill an unavailable or historical band result.
    metrics: { f0_ghz: 2.4, s11_at: { "2.3": -99, "2.6": -30 }, s11_f0_db: -99, engine: "cpu" },
    ...(parts ? { goals: parts.map((value, i) => ({ kind: job.optimize.goals[i].kind,
      value, cost: value === null ? 10000 : 0, met: value !== null })) } : {}) }));
}

async function downloadedCsv(directory, before) {
  const end = Date.now() + 10000;
  do {
    const file = (await readdir(directory)).find(name => !before.has(name) && name.endsWith(".csv"));
    if (file) return { file, text: await readFile(join(directory, file), "utf8") };
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  } while (Date.now() < end);
  throw new Error("optimizer CSV download did not complete");
}
const csvRows = text => text.trim().split(/\r?\n/).map(line =>
  [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match => match[1].replaceAll('""', '"')));

try {
  stack = await startStack({ log: console.log });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(),
    args: ["--no-sandbox", "--mute-audio", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] });
  for (const lang of ["en", "tr"]) {
    currentLanguage = lang;
    const context = await browser.createBrowserContext();
    page = await context.newPage();
    const submitted = [], pageErrors = [];
    let job;
    page.on("pageerror", error => pageErrors.push(safeDiagnosticText(error.message)));
    try {
      await page.setViewport({ width: 1280, height: 1000 });
      await page.evaluateOnNewDocument(language =>
        localStorage.setItem("fairbeam.generalSettings", JSON.stringify({ language })), lang);
      await page.setRequestInterception(true);
      page.on("request", request => {
        const path = new URL(request.url()).pathname;
        if (request.method() === "POST" && path === "/api/optimizations") {
          const body = JSON.parse(request.postData());
          submitted.push(body);
          job = syntheticJob(body, lang);
          return void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(job) });
        }
        // A completed synthetic job has no native event stream. 204 prevents automatic reconnection.
        if (path === `/api/runs/opt-band-browser-${lang}/events`) return void request.respond({ status: 204 });
        const launch = /^\/api\/(?:runs|sweeps|convergence|optimizations|research\/runs|render-jobs)(?:\/|$)/.test(path);
        const native = /^\/api\/(?:native-document(?:\/|$)|(?:research\/elmer\/install|blender\/open-download|open-feedback|renders\/[A-Za-z0-9_-]+\/open)\/?$)/.test(path);
        if (request.method() === "POST" && (launch || native)) {
          forbidden.push(path);
          return void request.respond({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "native work forbidden in this UI test" }) });
        }
        void request.continue();
      });
      const s = new Session(page, { lang, scenario: "optimize-band-radiation", url: stack.url, artifactDirectory: out });
      const downloads = join(out, lang);
      await mkdir(downloads, { recursive: true });
      await (await page.createCDPSession()).send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
      await withStartupDiagnostics(page, { directory: join(out, `startup-${lang}`), stack }, async () => {
        await page.goto(stack.url, { waitUntil: "domcontentloaded" });
        await s.wait(".home");
      });
      await s.ev(async language => {
        const store = await import("/src/designer/store.ts");
        await store.createDesign({ id: `opt_band_browser_${language}`, name: "Optimizer band control", template: "patch" });
      }, lang);
      await s.waitFor(async () => (await import("/src/runner/store.ts")).previewState() === "ready");
      await s.click("ribbon.tab.optimize", { sel: ".rb-tab" });
      await s.click("ribbon.optimize.optimizer", { sel: ".rb-btn" });
      await s.wait("[role=dialog] .op-form .rp-start-btn");
      const [rangeError, efficiencyError, gainLabel, efficiencyLabel] = await Promise.all([
        s.T("opt.err.frequencyRange"), s.T("opt.err.efficiency"),
        s.T("opt.goal.realizedGain"), s.T("opt.goal.efficiency"),
      ]);
      const goalSelect = async index => `[role=dialog] .op-form select[aria-label=${JSON.stringify(await s.T("opt.goalN", { n: index + 1 }))}]`;
      const disabled = () => page.$eval("[role=dialog] .rp-start-btn", el => el.disabled);
      await page.select(await goalSelect(0), "s11_max");
      await s.fill("#op-goal-0-target", "-10");
      await s.fill("#op-goal-0-at", "2.3");
      await s.fill("#op-goal-0-w", "2");
      assert.equal(await page.$eval("#op-goal-0-at-hi", el => el.value), "", "point default has no upper bound");
      assert.equal(await disabled(), false);
      assert.ok((await page.$eval(".op-form", el => el.textContent)).includes(await s.T("opt.band.hint")));
      for (const malformed of ["-", "1e", "2.4.5"]) {
        await s.fill("#op-goal-0-at-hi", malformed);
        assert.equal(await page.$eval("#op-goal-0-at-hi", el => el.dataset.badInput), "true");
        assert.equal(await disabled(), true, `malformed nonempty upper bound ${malformed} is not a point goal`);
        await s.fill("#op-goal-0-at-hi", "");
        assert.equal(await disabled(), false, "clearing the upper bound restores a valid point goal");
      }
      for (const upper of ["2.3", "2.2"]) {
        await s.fill("#op-goal-0-at-hi", upper);
        assert.equal(await disabled(), true);
        assert.ok((await page.$$eval(".op-form .rp-error", els => els.map(el => el.textContent))).some(text => text.includes(rangeError)));
      }
      await s.fill("#op-goal-0-at-hi", "2.5");
      assert.equal(await disabled(), false);
      await s.click("opt.addGoal", { within: "[role=dialog]", exact: true });
      await page.select(await goalSelect(1), "efficiency_min");
      await s.fill("#op-goal-1-at", "2.4");
      assert.equal(await page.$("#op-goal-1-at-hi"), null, "radiation goals are exact-frequency requests");
      for (const target of ["0", "100.1"]) {
        await s.fill("#op-goal-1-target", target);
        assert.equal(await disabled(), true);
        const errors = await page.$$eval(".op-form .rp-error", els => els.map(el => el.textContent));
        assert.ok(errors.some(text => text.includes(efficiencyError)));
      }
      await s.fill("#op-goal-1-target", "80");
      await s.click("opt.addGoal", { within: "[role=dialog]", exact: true });
      await page.select(await goalSelect(2), "realized_gain_min");
      await s.fill("#op-goal-2-target", "4");
      await s.fill("#op-goal-2-at", "2.4");
      assert.equal(await page.$("#op-goal-2-at-hi"), null);
      await s.click("opt.addGoal", { within: "[role=dialog]", exact: true });
      await page.select(await goalSelect(3), "s11_max");
      await s.fill("#op-goal-3-target", "-15");
      await s.fill("#op-goal-3-at", "2.6");
      await s.fill(".op-evals", "3");
      assert.equal(await disabled(), false);
      for (const width of [1280, 768]) {
        await page.setViewport({ width, height: 1000 });
        assert.deepEqual(await page.evaluate(auditInPage, ".op-form"), [], `${lang}/${width}: optimizer form geometry`);
        await page.screenshot({ path: join(out, `${lang}-${width}-form.png`) });
      }
      await page.setViewport({ width: 1280, height: 1000 });
      await s.clickSel("[role=dialog] .rp-start-btn");
      await s.gone("[role=dialog] .op-form");
      assert.equal(submitted.length, 1);
      assert.deepEqual(submitted[0].goals.map(g => [g.kind, g.target, g.at, g.at_hi ?? null, g.weight]), [
        ["s11_max", -10, 2.3, 2.5, 2], ["efficiency_min", 80, 2.4, null, 1],
        ["realized_gain_min", 4, 2.4, null, 1], ["s11_max", -15, 2.6, null, 1],
      ]);
      assert.ok(!("at_hi" in submitted[0].goals[3]), "blank upper bound is omitted from point submission");
      const events = history(job);
      // Load synthetic completed history through the real store used by OptimizeProgress.
      await s.ev(async ({ job, events }) => {
        const store = await import("/src/runner/store.ts");
        const designRun = await import("/src/runner/designRun.ts");
        store.detach();
        store.setLive({ job, events, connected: false });
        designRun.attachDesignOptimize(job);
      }, { job, events });
      if (await page.$(".rdk-collapse[aria-expanded=false]")) await s.clickSel(".rdk-collapse[aria-expanded=false]");
      await s.wait(".rp-progress .op-table tbody tr");
      const table = await page.$eval(".op-table", el => ({
        headers: [...el.querySelectorAll("thead th")].map(e => e.textContent),
        rows: [...el.querySelectorAll("tbody tr")].map(row => [...row.querySelectorAll("td")].map(e => e.textContent.trim())),
      }));
      const bandColumns = table.headers.flatMap((text, i) => text.includes("2.3..2.5") ? [i] : []);
      assert.ok(bandColumns.length >= 1);
      assert.equal(table.rows.length, 3);
      for (const index of bandColumns) {
        assert.equal(table.rows[0][index], "—", "explicit null never falls through to point -99");
        assert.equal(table.rows[1][index], "—", "historical point-only metrics never answer a band");
      }
      assert.ok(table.headers.some(text => text.includes(gainLabel) && text.includes("dBi")));
      assert.ok(table.headers.some(text => text.includes(efficiencyLabel) && text.includes("%")));
      await page.screenshot({ path: join(out, `${lang}-history.png`) });
      const before = new Set(await readdir(downloads));
      await s.click("opt.exportCsv", { within: ".rp-progress" });
      const csv = await downloadedCsv(downloads, before), rows = csvRows(csv.text);
      const bandIndex = rows[0].findIndex(text => text.includes("2.3..2.5 GHz"));
      const effIndex = rows[0].findIndex(text => text.includes("Radiation efficiency") && text.includes("%"));
      const gainIndex = rows[0].findIndex(text => text.includes("Peak realized gain") && text.includes("dBi"));
      assert.ok(bandIndex >= 0 && effIndex >= 0 && gainIndex >= 0, "CSV headers retain range, English labels and physical units");
      assert.equal(rows[1][bandIndex], "");
      assert.equal(rows[2][bandIndex], "");
      assert.equal(rows[3][bandIndex], "-12.25");
      assert.equal(rows[3][effIndex], "85");
      assert.equal(rows[3][gainIndex], "4.5");
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(forbidden, []);
      const retainedCsv = `${lang}-verified-history.csv`;
      await writeFile(join(out, retainedCsv), csv.text);
      outcomes.push({ lang, submitted: submitted[0], table, csv: csv.file, retainedCsv, pageErrors, consoleIssues: s.consoleIssues,
        source: "synthetic job response and injected completed history", solverRuns: 0 });
    } catch (error) {
      await page.screenshot({ path: join(out, `${lang}-failure.png`) }).catch(() => {});
      throw error;
    } finally { await context.close(); page = undefined; }
  }
  const actual = await fetch(`${stack.apiUrl}/api/runs`).then(response => response.json());
  assert.equal(actual.runs.length, 0, "isolated run server has no native jobs");
  console.log("Optimizer EN/TR: band form, radiation targets, request JSON, unavailable history and CSV passed; no solver");
} catch (error) {
  failure = { language: currentLanguage, message: safeDiagnosticText(error.stack || error.message) };
  if (page && !page.isClosed()) await page.screenshot({ path: join(out, `${currentLanguage}-failure.png`) }).catch(() => {});
  throw error;
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ outcomes, forbidden, failure, solver: "not run" }, null, 2));
  await browser?.close();
  await stack?.stop();
}
