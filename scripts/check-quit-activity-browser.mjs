// Native close protocol exercised in the real browser UI; no solver or native window is closed.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { chromePath, startStack } from "./scenarios/stack.mjs";

let stack, browser, page;
const diagnostics = [];
const record = entry => { diagnostics.push(entry); if (diagnostics.length > 40) diagnostics.shift(); };
try {
  stack = await startStack({ log: console.log, niceSolver: false });
  browser = await puppeteer.launch({ executablePath: await chromePath(), headless: true, args: ["--no-sandbox", "--enable-unsafe-swiftshader"] });
  for (const lang of ["en", "tr"]) {
    const context = await browser.createBrowserContext();
    page = await context.newPage();
    page.on("console", message => { if (message.type() === "error") record({ console: message.text().slice(0, 2000) }); });
    page.on("pageerror", error => record({ pageerror: String(error?.stack || error).slice(0, 4000) }));
    page.on("requestfailed", request => record({ url: request.url(), failure: request.failure() }));
    page.on("response", response => { if (response.status() >= 400) record({ url: response.url(), status: response.status() }); });
    await page.setViewport({ width: lang === "en" ? 1440 : 760, height: 900 });
    await page.evaluateOnNewDocument(lang => {
      localStorage.setItem("fairbeam.generalSettings", JSON.stringify({ language: lang }));
      const fetch = window.fetch.bind(window);
      window.__activeForQuit = [
        { id: "external", status: "running", kind: "simulation" },
        { id: "queued-elmer", status: "queued", kind: "simulation" },
        { id: "done", status: "done" }, { id: "failed", status: "failed" }, { id: "cancelled", status: "cancelled" },
      ];
      window.__quitReads = 0;
      window.fetch = async (url, init) => {
        if (String(url) !== "/api/close-activity") return fetch(url, init);
        window.__quitReads++;
        if (window.__quitUnavailable) throw new TypeError("offline fixture");
        if (window.__quitHttpFailure) return new Response("{}", { status: 500 });
        const response = window.__quitMalformed ? { activity: [{ kind: "render", id: "unknown", status: "future" }] }
          : { activity: window.__activeForQuit.filter(job => !["done", "failed", "cancelled", "interrupted"].includes(job.status)) };
        return new Response(JSON.stringify(response), { headers: { "Content-Type": "application/json" } });
      };
    }, lang);
    await page.goto(stack.url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".home");
    const text = key => page.evaluate(async key => (await import("/src/i18n/index.ts")).t(key), key);
    const begin = id => page.evaluate(id => {
      window.__quitAnswer = null;
      const poll = () => {
        const answer = window.fairbeamWindowClose("quit", id);
        if (answer !== "pending") { window.__quitAnswer = answer; clearInterval(window.__quitTimer); }
      };
      window.__quitTimer = setInterval(poll, 30);
      poll();
    }, id);
    const answered = async expected => {
      await page.waitForFunction(() => window.__quitAnswer !== null);
      assert.equal(await page.evaluate(() => window.__quitAnswer), expected);
    };

    const runningDescription = count => lang === "en"
      ? (count === 1 ? "1 simulation is running or queued. Quitting cancels it." : `${count} simulations are running or queued. Quitting cancels them.`)
      : `${count} simülasyon çalışıyor veya sırada. Çıkarsanız iptal edilir.`;
    const renderDescription = count => lang === "en"
      ? (count === 1 ? "1 Blender render is running or queued. Quitting cancels it." : `${count} Blender renders are running or queued. Quitting cancels them.`)
      : `${count} Blender render işlemi çalışıyor veya sırada. Çıkarsanız iptal edilir.`;
    await page.evaluate(() => { window.__queuedForQuit = window.__activeForQuit.splice(1, 1)[0]; });
    await begin(26200);
    await page.waitForSelector("#close-runs-title");
    assert.equal(await page.$eval("#close-runs-description", e => e.textContent), runningDescription(1), `${lang}: one active run uses singular wording`);
    if (process.env.FAIRBEAM_SCREENSHOT_DIR) {
      mkdirSync(process.env.FAIRBEAM_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.FAIRBEAM_SCREENSHOT_DIR, `quit-runs-one-${lang}.png`) });
    }
    await page.keyboard.press("Escape");
    await answered("cancel");
    assert.equal(await page.evaluate(() => window.__activeForQuit.length), 4, "Cancel preserves the single run and terminal history");
    await page.evaluate(() => { window.__activeForQuit.splice(1, 0, window.__queuedForQuit); });
    await begin(26201);
    await page.waitForSelector("#close-runs-title");
    assert.equal(await page.$eval("#close-runs-title", e => e.textContent), await text("closeRuns.title"));
    assert.equal(await page.$eval("#close-runs-description", e => e.textContent), runningDescription(2), `${lang}: running and queued runs use plural wording`);
    assert.equal(await page.evaluate(() => document.activeElement.textContent), await text("common.cancel"), "Cancel has safe initial focus");
    assert.equal(await page.$eval("#close-runs-title", e => {
      const dialog = e.closest(".dialog");
      return dialog.scrollWidth <= dialog.clientWidth && dialog.getBoundingClientRect().height < 400;
    }), true, "short confirmation stays compact without horizontal overflow");
    if (process.env.FAIRBEAM_SCREENSHOT_DIR) {
      mkdirSync(process.env.FAIRBEAM_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.FAIRBEAM_SCREENSHOT_DIR, `quit-runs-${lang}.png`) });
    }
    await page.keyboard.press("Escape");
    await answered("cancel");
    assert.equal(await page.evaluate(() => window.__activeForQuit.length), 5, "Cancel never cancels or removes a run");

    await page.evaluate(() => { window.__savedSimulations = window.__activeForQuit; });
    for (const count of [1, 2]) {
      await page.evaluate(count => {
        window.__activeForQuit = Array.from({ length: count }, (_, i) => ({ kind: "render", id: `render-${i}`, status: i ? "queued" : "running" }));
      }, count);
      await begin(26300 + count);
      await page.waitForSelector("#close-runs-title");
      assert.equal(await page.$eval("#close-runs-title", e => e.textContent), await text("closeRuns.renders.title"));
      assert.equal(await page.$eval("#close-runs-description", e => e.textContent), renderDescription(count));
      assert.equal(await page.evaluate(() => document.activeElement.textContent), await text("common.cancel"));
      await page.keyboard.press("Escape"); await answered("cancel");
      assert.equal(await page.evaluate(() => window.__activeForQuit.length), count, "Cancel preserves queued/running renders");
    }
    await page.evaluate(() => { window.__activeForQuit = [...window.__savedSimulations,
      { kind: "render", id: "external", status: "running" }, { kind: "render", id: "queued-render", status: "queued" }]; });
    await begin(26303);
    await page.waitForSelector("#close-runs-title");
    assert.equal(await page.$eval("#close-runs-title", e => e.textContent), await text("closeRuns.mixed.title"));
    assert.equal(await page.$eval("#close-runs-description", e => e.textContent), `${runningDescription(2)} ${renderDescription(2)}`);
    assert.equal(await page.$eval("#close-runs-title", e => {
      const dialog = e.closest(".dialog");
      return dialog.scrollWidth <= dialog.clientWidth && dialog.getBoundingClientRect().bottom <= innerHeight;
    }), true, "mixed EN/TR copy fits without clipping");
    if (process.env.FAIRBEAM_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.FAIRBEAM_SCREENSHOT_DIR, `quit-mixed-${lang}.png`) });
    await page.click(".dialog .dialog-actions button:first-child"); await answered("close");
    await page.evaluate(() => { window.__activeForQuit = window.__savedSimulations; });

    await page.evaluate(async lang => {
      const store = await import("/src/designer/store.ts");
      await store.createDesign({ id: `quit_${lang}`, name: `Quit ${lang}`, template: "dipole" });
      store.edit(d => { d.model.description = "Keep this after Cancel"; });
    }, lang);
    await begin(26202);
    await page.waitForSelector("#close-runs-title");
    await page.click("#close-runs-title + p"); // description does not approve
    await page.click(".dialog .dialog-actions button:first-child");
    await page.waitForSelector("#close-project-title");
    await page.evaluate(() => window.__activeForQuit.push({ id: "external", kind: "render", status: "queued" }));
    await page.click(".close-project-dialog .dialog-actions button:first-child"); // Don't save
    await page.waitForSelector("#close-runs-title");
    assert.equal(await page.$eval("#close-runs-description", e => e.textContent), `${runningDescription(2)} ${renderDescription(1)}`, "new render cannot reuse consent for the same simulation ID");
    await page.keyboard.press("Escape");
    await answered("cancel");
    assert.equal(await page.evaluate(async () => (await import("/src/designer/store.ts")).draft.model.description), "Keep this after Cancel");
    assert.equal(await page.evaluate(async () => (await import("/src/designer/store.ts")).dirty()), true);

    await page.evaluate(async () => { (await import("/src/designer/store.ts")).closeDesign(); window.__quitUnavailable = true; });
    await begin(26203);
    await page.waitForSelector("#close-runs-title");
    assert.equal(await page.$eval("#close-runs-title", e => e.textContent), await text("closeRuns.unknown.title"));
    assert.equal(await page.$eval("#close-runs-description", e => e.textContent), await text("closeRuns.unknown.description"));
    await page.keyboard.press("Escape");
    await answered("cancel");
    await page.evaluate(() => { window.__quitUnavailable = false; window.__activeForQuit = []; });
    for (const failure of ["__quitHttpFailure", "__quitMalformed"]) {
      await page.evaluate(failure => { window[failure] = true; }, failure);
      await begin(failure === "__quitHttpFailure" ? 26304 : 26305);
      await page.waitForSelector("#close-runs-title");
      assert.equal(await page.$eval("#close-runs-description", e => e.textContent), await text("closeRuns.unknown.description"));
      await page.keyboard.press("Escape"); await answered("cancel");
      await page.evaluate(failure => { window[failure] = false; }, failure);
    }
    await begin(26204);
    await answered("close");
    assert.ok(await page.evaluate(() => window.__quitReads >= 7), "every new exit obtains fresh server activity");
    console.log(`${lang}: simulation/render/mixed singular/plural counts, Cancel focus/Escape, typed-ID final recheck, unknown/HTTP/malformed status and compact layout pass`);
    await context.close();
  }
} catch (error) {
  const out = join("fairbeam-scenario-failures", "quit-activity");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "error.txt"), String(error?.stack || error));
  writeFileSync(join(out, "diagnostics.json"), JSON.stringify({ browser: diagnostics, children: stack?.diagnostics() }, null, 2));
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await stack?.stop();
}
