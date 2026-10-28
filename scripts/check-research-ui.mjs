// Targeted UI contract regression using explicitly synthetic API responses, never solver evidence.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import puppeteer from "puppeteer-core";
import { chromePath } from "./scenarios/stack.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, optimizeDeps: { entries: ["index.html"] }, logLevel: "error" });
let browser;
const evidence = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || fileURLToPath(new URL("../.impeccable/review/", import.meta.url)));
const screenshots = !process.argv.includes("--no-screenshots");
await mkdir(evidence, { recursive: true });
try {
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await puppeteer.launch({ executablePath: await chromePath(), headless: true, args: ["--no-sandbox", "--mute-audio", "--enable-unsafe-swiftshader"] });
  for (const language of ["en", "tr"]) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument(language => localStorage.setItem("fairbeam.generalSettings", JSON.stringify({ language })), language);
    let available = false, unavailable = false, detailConflict = false, ordinaryUnavailable = false, jobs = [], submitted;
    const requests = [];
    const historyQueries = [], ordinaryQueries = [];
    const summaryRows = () => jobs.map(({ result, ...metadata }) => metadata);
    await page.setRequestInterception(true);
    page.on("request", request => {
      const requestUrl = new URL(request.url()), pathname = requestUrl.pathname;
      if (!pathname.startsWith("/api/")) return void request.continue();
      const respond = (data, status = 200) => request.respond({ status, contentType: "application/json", body: JSON.stringify(data) });
      if (pathname.startsWith("/api/research/")) {
        requests.push(pathname);
        if (unavailable) return void respond({ error: "Synthetic server unavailable" }, 503);
        if (pathname.endsWith("/probe")) return void respond({ backend: JSON.parse(request.postData()).backend, available, reason: available ? undefined : "Synthetic capability unavailable" });
        if (request.method() === "POST" && pathname.endsWith("/cancel")) { jobs[0].status = "cancelled"; return void respond(jobs[0]); }
        if (request.method() === "POST") {
          submitted = JSON.parse(request.postData());
          const job = { id: `synthetic-${language}`, kind: "research", status: "queued", phase: "queued", created: 1, created_iso: "2026-10-09T12:00:00Z", error: null, bundle: null, result: null, research: { backend: submitted.backend, path: submitted.path, settings: submitted.settings, snapshot_sha256: "synthetic-fixture" } };
          jobs = [job]; return void respond(job);
        }
        if (pathname === "/api/research/runs") {
          historyQueries.push(requestUrl.search);
          return void respond({ runs: requestUrl.searchParams.get("summary") === "1" ? summaryRows() : jobs });
        }
        if (detailConflict) return void respond({ error: "Synthetic result checksum mismatch" }, 409);
        const found = jobs.find(job => job.id === decodeURIComponent(pathname.split("/").at(-1)));
        return void respond(found ?? { error: "Synthetic run no longer exists" }, found ? 200 : 404);
      }
      if (pathname === "/api/health") return void respond({ ok: true, api: 1, engines: ["cpu"], queue: { running: null, queued: 0 }, cpu_count: 4, research: true });
      if (pathname === "/api/runs") {
        ordinaryQueries.push(requestUrl.search);
        if (ordinaryUnavailable) return void respond({ error: "Synthetic polling failure" }, 503);
        return void respond({ runs: requestUrl.searchParams.get("summary") === "1" ? summaryRows() : jobs });
      }
      if (pathname === "/api/models") return void respond({ models: [] });
      return void respond({ error: "Synthetic test: no endpoint" }, 404);
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".home");
    const before = await page.evaluate(async () => JSON.stringify((await import("/src/designer/store.ts")).draft));
    const open = async () => {
      await page.evaluate(async () => (await import("/src/runner/researchState.ts")).openResearch());
      await page.waitForSelector(".research-dialog");
      await page.waitForFunction(() => document.activeElement?.matches(".research-options select"));
    };
    await open();
    assert.equal(await page.$$eval('.research-guide li', rows => rows.length), 3);
    assert.match(await page.$eval('.research-guide', e => e.textContent), /revision-4|revizyon-4/);
    assert.equal(await page.$eval('.research-guide a', e => e.href), `https://fairbeam.org/docs/${language === "tr" ? "tr/" : ""}experimental-solvers.html`);
    assert.deepEqual(await page.evaluate(async () => {
      const calls = [];
      window.__TAURI_INTERNALS__ = { invoke: async (...args) => { calls.push(args); } };
      try { document.querySelector('.research-guide a').click(); await Promise.resolve(); return calls; }
      finally { delete window.__TAURI_INTERNALS__; }
    }), [['open_external_link', { link: language === 'tr' ? 'research-tr' : 'research' }]], 'desktop guide uses the fixed native link key for its language');
    const start = '.research-dialog button[type="submit"]';
    assert.equal(await page.$eval(start, e => e.disabled), true, "unprobed solver cannot submit");
    await page.click(".research-options > button");
    await page.waitForSelector(".research-options .status-warn");
    assert.equal(await page.$eval(start, e => e.disabled), true, "unavailable solver cannot submit");
    available = true;
    await page.click(".research-options > button");
    await page.waitForSelector(".research-options .status-good");
    assert.equal(await page.$eval(start, e => e.disabled), false);
    await page.$eval(".research-settings label:nth-child(5) input", e => { e.value = "20"; e.dispatchEvent(new Event("input", { bubbles: true })); });
    assert.equal(await page.$eval(start, e => e.disabled), true, "inverted frequency range cannot submit");
    await page.$eval(".research-settings label:nth-child(5) input", e => { e.value = "1"; e.dispatchEvent(new Event("input", { bubbles: true })); });
    const frontInput = ".research-settings label:nth-child(3) input";
    await page.click(frontInput, { clickCount: 3 });
    await page.keyboard.press("Backspace");
    assert.equal(await page.$eval(frontInput, e => e.value), "", "clearing a coordinate keeps it blank");
    assert.equal(await page.$eval(start, e => e.disabled), true, "blank front coordinate cannot submit as zero");
    await page.keyboard.type("-");
    assert.equal(await page.$eval(frontInput, e => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").get.call(e)), "-", "negative sign survives the intermediate edit");
    assert.equal(await page.$eval(start, e => e.disabled), true);
    await page.keyboard.type("1");
    assert.equal(await page.$eval(frontInput, e => e.valueAsNumber), -1, "negative coordinate can be typed normally");
    assert.equal(await page.$eval(start, e => e.disabled), false);
    await page.$eval(frontInput, e => { e.value = "10"; e.dispatchEvent(new Event("input", { bubbles: true })); });
    assert.equal(await page.$eval(start, e => e.disabled), true, "zero-depth slab fixture cannot submit");
    await page.evaluate(async () => {
      const store = await import("/src/designer/store.ts");
      store.setFile({ id: "synthetic-sheet", file: "synthetic-sheet.design.json", design: { ...store.draft, model: { id: "synthetic-sheet", name: "Synthetic sheet" } }, hash: "synthetic", readonly: false });
    });
    await page.select(".research-options > label:nth-of-type(3) select", "design");
    const designHint = await page.$eval(".research-options > label:nth-of-type(3) .note", e => ({ text: e.textContent, visible: e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== "hidden" }));
    const expectedHint = await page.evaluate(async () => (await import("/src/i18n/index.ts")).t("research.designHint"));
    assert.equal(designHint.text, expectedHint);assert.equal(designHint.visible, true, "Design reuse scope is visible before submitting");
    assert.match(designHint.text, language === "en" ? /simulation settings and monitors are not used/ : /simülasyon ayarları ve monitörleri kullanılmaz/);
    assert.equal(await page.$eval(start, e => e.disabled), false, "zero-depth current design reaches backend validation for supported PEC sheets");
    await page.select(".research-options > label:nth-of-type(3) select", "fixture");
    await page.$eval(frontInput, e => { e.value = "0"; e.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.click(start);
    await page.waitForSelector(".research-results .status");
    assert.equal(submitted.settings.fixture, "slab");
    assert.equal(submitted.settings.front_mm, 0);
    assert.equal(submitted.settings.back_mm, 10);
    assert.equal(submitted.design, undefined);
    await page.click(".research-results .cluster[aria-live] button");
    await page.waitForFunction(() => !document.querySelector(".research-results .cluster[aria-live] button"));
    assert.equal(jobs[0].status, "cancelled");
    // Research rows must never attach to ordinary antenna progress or alter the current draft.
    await page.evaluate(async job => { (await import("/src/runner/store.ts")).attach(job); }, jobs[0]);
    assert.equal(await page.evaluate(async () => (await import("/src/runner/store.ts")).live.job), null);
    assert.equal(await page.evaluate(async () => JSON.stringify((await import("/src/designer/store.ts")).draft)), before);
    jobs[0] = { ...jobs[0], status: "failed", phase: "done", error: "Synthetic validation failure", result: { status: "results_exported", frequency_hz: [1e9, 5e9, 10e9], s11_real: [0.1, 0.3, 0.2], s11_imag: [0, 0, 0], s21_real: [0.9, 0.8, 0.9], s21_imag: [0, 0, 0] } };
    await page.click(".research-results > .cluster button");
    await page.waitForSelector(".research-chart svg");
    assert.deepEqual(await page.evaluate(async () => {
      const runner = await import("/src/runner/store.ts");
      await runner.refreshRuns();
      return runner.jobs().map(job => ({ id: job.id, status: job.status, hasResult: Object.hasOwn(job, "result") }));
    }), [{ id: jobs[0].id, status: "failed", hasResult: false }], "ordinary polling keeps research status without fetching historical arrays");
    ordinaryUnavailable = true;
    await page.evaluate(async () => (await import("/src/runner/store.ts")).refreshRuns());
    assert.deepEqual(await page.evaluate(async () => (await import("/src/runner/store.ts")).jobs().map(job => job.id)),
      [jobs[0].id], "failed summary poll retains the previous run list");
    ordinaryUnavailable = false;
    assert.ok(await page.$(".research-results .status-warn"), "unvalidated exports are explicitly labeled");
    assert.ok(await page.$(".research-results [role=alert]"), "failed run remains failed even when curves are exported");
    await page.click(".research-results details summary");
    assert.equal(await page.$$eval(".research-table tbody tr", rows => rows.length), 3);
    assert.ok(requests.includes(`/api/research/runs/${jobs[0].id}`), "the selected chart loads its full result from the detail route");
    // The main integration must retain both compact polling and the caller's
    // cancellation signal. Exercise the real API method/call chain with one
    // controlled fetch rejection; unrelated browser requests keep their fetch.
    assert.deepEqual(await page.evaluate(async () => {
      const { api } = await import("/src/runner/api.ts");
      const controller = new AbortController();
      const originalFetch = window.fetch;
      let observed = null;
      window.fetch = (input, init) => {
        if (init?.signal !== controller.signal) return originalFetch(input, init);
        observed = { url: String(input), method: init.method, body: init.body ?? null };
        return new Promise((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
          controller.abort();
        });
      };
      try {
        await api.runs(controller.signal);
        return { observed, rejected: false };
      } catch (error) {
        return { observed, rejected: true, name: error.name, originalReason: error === controller.signal.reason };
      } finally { window.fetch = originalFetch; }
    }), { observed: { url: "/api/runs?summary=1", method: "GET", body: null }, rejected: true, name: "AbortError", originalReason: true },
    "ordinary summary polling forwards the caller's AbortSignal and preserves its abort reason");
    assert.ok(await page.$(".research-chart svg"), "cancelled ordinary API request leaves the selected full result visible");
    if (screenshots) await page.screenshot({ path: join(evidence, `research-${language}-desktop.png`) });
    await page.keyboard.press("Escape");
    await page.waitForSelector(".research-dialog", { hidden: true });
    const closedCount = requests.length;
    await new Promise(resolve => setTimeout(resolve, 2700));
    assert.equal(requests.length, closedCount, "closed dialog stops polling");
    await open();
    await page.waitForSelector(".research-chart svg");
    detailConflict = true;
    await page.click(".research-results > .cluster button");
    await page.waitForFunction(() => document.querySelector(".research-results")?.textContent.includes("Synthetic result checksum mismatch"));
    assert.equal(await page.$(".research-chart"), null, "detail integrity failure removes the previous result chart");
    detailConflict = false;
    await page.click(".research-results > .cluster button");
    await page.waitForSelector(".research-chart svg");
    await page.select(".research-options select", "stock");
    assert.equal(await page.$eval(start, e => e.disabled), true, "stock selection requires its own capability check");
    assert.match(await page.$eval('.research-guide', e => e.textContent), /PEC\/PMC/);
    await page.click(".research-options > button");
    await page.waitForSelector(".research-options .status-good");
    await page.click('[data-stock-nrw]');
    await page.click(start);
    await page.waitForFunction(() => document.querySelector(".research-results .cluster[aria-live] button"));
    assert.equal(submitted.backend, "stock");
    assert.equal(submitted.settings.nrw, true);
    assert.equal(submitted.settings.nrw_sin_floor, .3);
    assert.equal(submitted.settings.fixture, "slab");
    jobs[0] = { ...jobs[0], status: "done", phase: "done", result: { backend: "stock", schema: "fairbeam.stock-result/1", status: "results_exported",
      frequency_hz: [1e9, 2e9, 3e9], s11_real: [-1, 0, .5], s11_imag: [0, 0, 0], s21_real: [0, 1, .5], s21_imag: [0, 0, 0],
      reflection_phase_deg: [180, null, 0], material: { requested: true, available: true, qualified: false, thickness_mm: 10,
        reliable: [true, false, true], eps_real: [4, null, 4], eps_imag: [0, null, 0], mu_real: [1, null, 1], mu_imag: [0, null, 0] },
      provenance: { synthetic: true, phasor_convention: "exp(+j omega t)", reflection_phase_reference: "front sample face" } } };
    await page.click(".research-results > .cluster button");
    await page.waitForSelector('[data-stock-results]');
    assert.ok(await page.$('.research-results .status-warn'), "stock completion is not a validated/mesh-converged badge");
    await page.click('[data-stock-results] details summary');
    assert.equal(await page.$$eval('[data-stock-results] tbody tr:nth-child(2) td', cells => cells.slice(1, 5).map(e => e.textContent).join('')), '————', "unreliable NRW values remain unavailable");
    assert.equal(await page.evaluate(async () => JSON.stringify((await import("/src/designer/store.ts")).draft)), before, "stock research does not replace Design data");
    await page.select(".research-options select", "elmer");
    assert.match(await page.$eval('.research-guide', e => e.textContent), /cavity|kavite/);
    assert.equal(await page.$eval(start, e => e.disabled), true, "backend change invalidates capability");
    await page.click(".research-options > button");
    await page.waitForSelector(".research-options .status-good");
    await page.click(start);
    await page.waitForFunction(() => document.querySelector(".research-results .cluster[aria-live] button"));
    assert.deepEqual(submitted.settings, { mesh_size: 0.025 });
    assert.equal(submitted.design, undefined);
    jobs[0] = { ...jobs[0], status: "done", result: { status: "results_validated", frequency_hz: [2.4e9, 3e9], mode1: { family: "TE101", analytic_frequency_hz: 2.39e9, relative_frequency_error: 0.004, complex_field_shape_correlation: 0.999 }, precision_converged: false } };
    await page.click(".research-results > .cluster button");
    await page.waitForFunction(() => document.querySelector(".research-results")?.textContent.includes("TE101"));
    await page.setViewport({ width: 390, height: 844 });
    assert.equal(await page.$eval(".research-dialog", e => e.scrollWidth <= e.clientWidth), true, "mobile dialog has no horizontal overflow");
    if (screenshots) await page.screenshot({ path: join(evidence, `research-${language}-mobile.png`) });
    jobs = [{ ...jobs[0], id: `replacement-${language}` }];
    await page.click(".research-results > .cluster button");
    await page.waitForFunction(id => document.querySelector(".research-results select")?.value === id, {}, jobs[0].id);
    await page.waitForFunction(() => document.querySelector(".research-results")?.textContent.includes("TE101"));
    assert.equal(await page.$(".research-results [role=alert]"), null, "removed selection falls back to an existing run");
    jobs = [];
    await page.click(".research-results > .cluster button");
    await page.waitForFunction(() => !document.querySelector(".research-results select"));
    assert.equal(await page.$(".research-results .table"), null, "empty history removes previous result");
    assert.equal(await page.evaluate(async () => (await import("/src/runner/researchState.ts")).researchSelectedId()), null, "empty history clears persisted selection");
    unavailable = true;
    await page.click(".research-results > .cluster button");
    await page.waitForSelector(".research-results [role=alert]");
    assert.ok(ordinaryQueries.length > 0 && ordinaryQueries.every(query => query === "?summary=1"), "all ordinary polls opt into summaries");
    assert.ok(historyQueries.length > 0 && historyQueries.every(query => query === "?summary=1"), "research history polls opt into summaries while detail stays full");
    await context.close();
  }
  console.log("check-research-ui: EN/TR capability gates, queue/cancel, summary polling/AbortSignal/error retention, selected full results, reopening, isolation, result warnings, tables, mobile layout and unavailable server passed (synthetic API)");
} finally { await browser?.close(); await server.close(); }
