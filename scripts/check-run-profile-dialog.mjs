// Real dialog/store regression: selecting is inert, Apply is explicit, Cancel restores history,
// OK keeps an undoable edit, and manual mesh is protected. No solver is started.
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";
import { chromePath, startStack } from "./scenarios/stack.mjs";

let stack, browser;
try {
  stack = await startStack({ log: console.log, niceSolver: false });
  browser = await puppeteer.launch({ executablePath: await chromePath(), headless: true, args: ["--no-sandbox", "--enable-unsafe-swiftshader"] });
  for (const language of ["en", "tr"]) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument((language) => localStorage.setItem("fairbeam.generalSettings", JSON.stringify({ language })), language);
    await page.goto(stack.url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".home");
    const mark = () => page.evaluate(async () => (await import("/src/designer/store.ts")).historyMark());
    const open = async () => {
      await page.evaluate(async () => {
        const run = await import("/src/runner/designRun.ts");
        run.setSimSettingsSection("profile"); run.setSimSettingsOpen(true);
      });
      await page.waitForSelector("#ss-profile select");
    };
    await page.evaluate(async (language) => {
      const s = await import("/src/designer/store.ts");
      await s.createDesign({ id: `profile_${language}`, name: "Profile test", template: "dipole" });
      s.edit(d => { d.mesh.mode = "design"; d.mesh.overrides = { cells_per_wavelength: 17 }; d.simulation.end_criteria_db = -55; }, "fixture");
    }, language);
    const original = await mark();
    await open();
    await page.select("#ss-profile select", "quick");
    assert.deepEqual(await mark(), original, `${language}: selecting does not edit`);
    await page.click("#ss-profile button");
    const applied = await mark();
    // the Apply is confirmed with what it changed
    const confirmation = await page.$eval("#ss-profile .ss-applied", (e) => e.textContent);
    assert.match(confirmation, language === "en" ? /^Setup applied: Quick exploration, 10 cells per wavelength, stop at −40 dB\./ : /^Ayarlar uygulandı: .*10.*−40 dB/, `${language}: Apply setup confirms`);
    assert.equal(JSON.parse(applied.text).mesh.overrides.cells_per_wavelength, 10);
    assert.equal(JSON.parse(applied.text).simulation.end_criteria_db, -40, "Quick exploration stops at −40 dB, as the solver hint says");
    await page.click(".ss-dialog .dialog-actions button:first-child");
    await page.waitForSelector(".ss-dialog", { hidden: true });
    assert.deepEqual(await mark(), original, `${language}: Cancel restores draft and complete history`);
    await open();
    await page.select("#ss-profile select", "verification");
    await page.click("#ss-profile button");
    await page.click(".ss-dialog .dialog-actions button:last-child");
    await page.waitForSelector(".ss-dialog", { hidden: true });
    assert.equal(JSON.parse((await mark()).text).mesh.overrides.cells_per_wavelength, 30);
    await page.evaluate(async () => (await import("/src/designer/store.ts")).undo());
    assert.equal((await mark()).text, original.text, `${language}: OK edit can be undone once`);
    await page.evaluate(async () => (await import("/src/designer/store.ts")).edit(d => { d.mesh.mode = "manual"; d.mesh.lines = { x: [-1, 1], y: [-1, 1], z: [-1, 1] }; }, "manual-fixture"));
    const manual = await mark();
    await open();
    assert.equal(await page.$eval("#ss-profile select", e => e.disabled), true);
    assert.equal(await page.$eval("#ss-profile button", e => e.disabled), true);
    assert.ok((await page.$eval("#ss-profile button", e => e.title)).length > 20, `${language}: the disabled Apply says why`);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".ss-dialog", { hidden: true });
    assert.deepEqual(await mark(), manual, `${language}: manual mesh unchanged`);
    // Enter in a field commits it and closes the dialog, like OK
    await page.evaluate(async () => { const run = await import("/src/runner/designRun.ts"); run.setSimSettingsSection("solver"); run.setSimSettingsOpen(true); });
    await page.waitForSelector("#ss-solver input");
    await page.click("#ss-solver input");
    await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
    await page.keyboard.type("-45");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".ss-dialog", { hidden: true });
    assert.equal(JSON.parse((await mark()).text).simulation.end_criteria_db, -45, `${language}: Enter keeps the edit and closes`);
    await context.close();
  }
  console.log("run-profile dialog: EN/TR explicit apply, Cancel/history, OK/undo and manual mesh passed");
} finally {
  await browser?.close();
  await stack?.stop();
}
