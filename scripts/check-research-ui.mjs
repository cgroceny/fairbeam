// Targeted UI contract regression using explicitly synthetic API responses, never solver evidence.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
import puppeteer from "puppeteer-core";
import { chromePath } from "./scenarios/stack.mjs";

const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, optimizeDeps: { entries: ["index.html"] }, logLevel: "error" });
let browser;
const evidence = new URL("../.impeccable/review/", import.meta.url);
const screenshots = !process.argv.includes("--no-screenshots");
await mkdir(evidence, { recursive: true });
try {
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await puppeteer.launch({ executablePath: await chromePath(), headless: true, args: ["--no-sandbox", "--enable-unsafe-swiftshader"] });
  for (const language of ["en", "tr"]) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument(language => localStorage.setItem("fairbeam.generalSettings", JSON.stringify({ language })), language);
    let available = false, unavailable = false, detailConflict = false, jobs = [], submitted;
    const requests = [];
    await page.setRequestInterception(true);
    page.on("request", request => {
      const pathname = new URL(request.url()).pathname;
      if (!pathname.startsWith("/api/")) return void request.continue();
      const respond = (data, status = 200) => request.respond({ status, contentType: "application/json", body: JSON.stringify(data) });
      if (pathname.startsWith("/api/research/")) {
        requests.push(pathname);
        if (unavailable) return void respond({ error: "Synthetic server unavailable" }, 503);
        if (pathname.endsWith("/probe")) return void respond({ backend: "periodic", available, reason: available ? undefined : "Synthetic capability unavailable" });
        if (request.method() === "POST" && pathname.endsWith("/cancel")) { jobs[0].status = "cancelled"; return void respond(jobs[0]); }
        if (request.method() === "POST") {
          submitted = JSON.parse(request.postData());
          const job = { id: `synthetic-${language}`, kind: "research", status: "queued", phase: "queued", created: 1, created_iso: "2026-10-09T12:00:00Z", error: null, bundle: null, result: null, research: { backend: submitted.backend, path: submitted.path, settings: submitted.settings, snapshot_sha256: "synthetic-fixture" } };
          jobs = [job]; return void respond(job);
        }
        if (pathname === "/api/research/runs") return void respond({ runs: jobs });
        if (detailConflict) return void respond({ error: "Synthetic result checksum mismatch" }, 409);
        const found = jobs.find(job => job.id === decodeURIComponent(pathname.split("/").at(-1)));
        return void respond(found ?? { error: "Synthetic run no longer exists" }, found ? 200 : 404);
      }
      if (pathname === "/api/health") return void respond({ ok: true, api: 1, engines: ["cpu"], queue: { running: null, queued: 0 }, cpu_count: 4, research: true });
      if (pathname === "/api/runs") return void respond({ runs: [] });
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
    assert.ok(await page.$(".research-results .status-warn"), "unvalidated exports are explicitly labeled");
    assert.ok(await page.$(".research-results [role=alert]"), "failed run remains failed even when curves are exported");
    await page.click(".research-results details summary");
    assert.equal(await page.$$eval(".research-table tbody tr", rows => rows.length), 3);
    if (screenshots) await page.screenshot({ path: new URL(`research-${language}-desktop.png`, evidence).pathname.replace(/^\/(\w:)/, "$1") });
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
    await page.select(".research-options select", "elmer");
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
    if (screenshots) await page.screenshot({ path: new URL(`research-${language}-mobile.png`, evidence).pathname.replace(/^\/(\w:)/, "$1") });
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
    await context.close();
  }
  console.log("check-research-ui: EN/TR capability gates, queue/cancel, reopening, isolation, result warnings, tables, mobile layout and unavailable server passed (synthetic API)");
} finally { await browser?.close(); await server.close(); }
