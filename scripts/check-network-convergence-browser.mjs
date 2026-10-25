// Opt-in Designer network criteria, EN/TR. Requires explicit permission to launch a browser.
// Uses an isolated design server; all convergence submissions are intercepted, so no solver runs.
// Synthetic reports test presentation only. Server persistence/evaluation has separate Python tests.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import puppeteer from "puppeteer-core";
import { withStartupDiagnostics } from "./scenarios/startup-diagnostics.mjs";
import { startStack, chromePath } from "./scenarios/stack.mjs";
import { Session, auditInPage } from "./scenarios/harness.mjs";

if (process.env.CI !== "true" && process.env.FAIRBEAM_ALLOW_LOCAL_BROWSER !== "1") {
  throw new Error("Local browser acceptance requires explicit user permission.");
}
const out = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS
  ? join(process.env.FAIRBEAM_TEST_ARTIFACTS, "network-convergence")
  : join(tmpdir(), `fairbeam-network-convergence-${Date.now()}`));
await mkdir(out, { recursive: true });
const results = [], forbidden = [];
let stack, browser, activePage;

function report(request, id) {
  const study = {
    schema: "fairbeam.study/1", id, name: "Synthetic network report", kind: "mesh-convergence", members: [],
    convergence: { densities: [15, 20], max_runs: 2, tolerances: { f_pct: 0.5, s11_db: 1, dmax_db: 0.2 },
      steps: [], done: true, converged: false, converged_at: null, next: null,
      reason: "exhausted", verdict: "not converged: refine further or check the model" },
  };
  if (!request.network_criteria) return study;
  const criteria = request.network_criteria.metrics.map(text => {
    const [kind, ids, tolerance] = text.split(":");
    return { key: `${kind}:${ids}`, kind, ports: ids.split(",").map(Number), tolerance: Number(tolerance), unit: kind === "phase" ? "deg" : "dB" };
  });
  const config = { frequency_hz: request.network_criteria.frequency_ghz * 1e9, criteria };
  study.network_criteria = config;
  study.excite = "all";
  study.members = [15, 20].map(density => ({ density, status: "done", metrics: {
    f_res: 2.4e9, s11_db: -20, dmax_dbi: null, zin_re: 50, zin_im: 0, cells: 1000, wall_time_s: 1,
    network: { ...config, solver_converged: true, values: criteria.map(() => ({ value: null, reason: "requested excitation column is absent" })) },
  } }));
  study.convergence.steps = [{ from: 15, to: 20, comparable: true, converged: false,
    df_pct: 0, ds11_db: 0, ddmax_db: null, ok: { f: true, s11: true, dmax: null }, quality: { energy: true, local_mesh: true },
    network: { converged: false, reason: null, checks: criteria.map(c => ({ ...c, before: null, after: null, delta: null, ok: false, reason: "requested excitation column is absent" })) },
  }];
  return study;
}

try {
  stack = await startStack({ log: console.log });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(),
    args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--mute-audio"] });
  for (const lang of ["en", "tr"]) {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    activePage = page;
    const submitted = [];
    let savedReport;
    try {
      await page.setViewport({ width: 1280, height: 900 });
      await page.evaluateOnNewDocument(language => localStorage.setItem("fairbeam.generalSettings", JSON.stringify({ language })), lang);
      await page.setRequestInterception(true);
      page.on("request", request => {
        const path = new URL(request.url()).pathname;
        if (path === "/api/convergence" && request.method() === "POST") {
          const body = JSON.parse(request.postData());
          submitted.push(body);
          savedReport = report(body, `cv-network-browser-${lang}`);
          return void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ study: savedReport, runs: [] }) });
        }
        if (path.startsWith("/api/convergence/cv-network-browser-")) {
          return void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(savedReport) });
        }
        // Defense in depth: a future dialog regression cannot start a different solver endpoint.
        const job = /^\/api\/(?:runs|sweeps|convergence|optimizations|research\/runs|render-jobs)(?:\/|$)/.test(path);
        const native = /^\/api\/(?:native-document(?:\/|$)|(?:research\/elmer\/install|blender\/open-download|open-feedback|renders\/[A-Za-z0-9_-]+\/open)\/?$)/.test(path);
        if (request.method() === "POST" && (job || native)) {
          forbidden.push(path);
          return void request.respond({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "solver launch forbidden in this UI test" }) });
        }
        void request.continue();
      });
      const s = new Session(page, { lang, scenario: "network-convergence", url: stack.url });
      await withStartupDiagnostics(page, { directory: join(out, `startup-${lang}`), stack }, async () => {
        await page.goto(stack.url, { waitUntil: "domcontentloaded" });
        await s.wait(".home");
      });
      await s.ev(async language => {
        const store = await import("/src/designer/store.ts");
        await store.createDesign({ id: `network_browser_${language}`, name: "Network criteria", template: "microstrip" });
      }, lang);
      await s.waitFor(async () => (await import("/src/runner/store.ts")).previewState() === "ready");
      const originalPorts = await s.store((_, m) => JSON.stringify(m.s.draft.ports));
      const open = () => s.ev(async () => (await import("/src/designer/ConvergenceDialog.tsx")).openMeshConvergence());
      await open();
      await s.wait(".cv-dialog");
      assert.equal(await page.$eval(".cv-network input[type=checkbox]", e => e.checked), false);
      await s.clickSel(".cv-actions .btn-primary");
      await s.waitFor(() => !!document.querySelector(".cv-actions .btn-ghost"));
      assert.equal(submitted.length, 1);
      assert.ok(!("network_criteria" in submitted[0]), "opt-out body omits the field");
      await s.click("conv.newStudy", { within: ".cv-dialog" });
      await s.clickSel(".cv-network input[type=checkbox]");
      await s.wait(".cv-network-row");
      const frequency = await s.field(await s.T("conv.net.frequency"), { within: ".cv-network" });
      await s.fill(frequency, "");
      assert.equal(await page.$eval(".cv-actions .btn-primary", e => e.disabled), true);
      assert.equal(await page.$eval("#cv-setup-error", e => e.textContent.trim()), await s.T("conv.net.err.frequency"));
      await s.fill(frequency, "2,4");
      assert.equal(await frequency.evaluate(e => e.value), "2.4");
      await s.click("conv.net.add", { within: ".cv-network" });
      assert.equal(await page.$eval(".cv-actions .btn-primary", e => e.disabled), true, "duplicate criteria block submission");
      await s.click("conv.net.remove", { within: ".cv-network", params: { n: 2 } });
      await page.select(".cv-network-row select", "phase_balance");
      assert.equal(await page.$eval(".cv-network-row select", e => e.value), "phase_balance");
      for (const width of [1280, 768]) {
        await page.setViewport({ width, height: 900 });
        assert.deepEqual(await page.evaluate(auditInPage, ".cv-dialog"), [], `${lang}/${width}: setup geometry`);
        await page.screenshot({ path: join(out, `${lang}-${width}-setup.png`) });
      }
      await s.clickSel(".cv-actions .btn-primary");
      await s.wait(".cv-network-report");
      assert.equal(submitted.length, 2);
      assert.deepEqual(submitted[1].network_criteria, { frequency_ghz: 2.4, metrics: ["phase:2,1,1:0.2"] });
      assert.equal(await s.store((_, m) => JSON.stringify(m.s.draft.ports)), originalPorts, "network setup leaves port excitation flags unchanged");
      const unavailable = await s.T("conv.net.unavailable"), reason = await s.T("conv.net.reason.column");
      const rows = await page.$$eval(".cv-network-report tbody tr", rows => rows.map(row => row.textContent));
      assert.equal(rows.length, 2);
      assert.ok(rows.every(row => row.includes(unavailable) && row.includes(reason)));
      assert.equal(await page.$(".cv-dialog .cluster-sm .btn-primary"), null, "unavailable measurements never offer Apply");
      await s.click("common.close", { within: ".cv-dialog" });
      await s.ev(async id => (await import("/src/designer/ConvergenceDialog.tsx")).openMeshConvergence(id), savedReport.id);
      await s.wait(".cv-network-report");
      assert.deepEqual(await page.evaluate(auditInPage, ".cv-dialog"), [], `${lang}: reopened report geometry`);
      assert.equal(await page.$$eval(".cv-network-report tbody tr", rows => rows.length), 2);
      await page.screenshot({ path: join(out, `${lang}-reopened-report.png`) });
      assert.deepEqual(forbidden, [], "only the two explicitly intercepted study requests are allowed");
      results.push({ lang, submitted, originalPorts, reportRows: rows, reportSource: "synthetic intercepted API response", solver: "not run" });
    } catch (error) {
      await activePage.screenshot({ path: join(out, `${lang}-failure.png`) }).catch(() => {});
      throw error;
    } finally { await context.close(); activePage = undefined; }
  }
  const actualRuns = await fetch(`${stack.apiUrl}/api/runs`).then(r => r.json());
  assert.equal(actualRuns.runs.length, 0, "isolated server queued no solver jobs");
  console.log("Network convergence: EN/TR opt-out, validation, port selection, request, unavailable results and reopen passed; no solver");
} finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ results, forbidden }, null, 2));
  await browser?.close();
  await stack?.stop();
}
