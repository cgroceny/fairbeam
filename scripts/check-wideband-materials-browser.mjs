// Remote CI acceptance only. Authoring/syntax may be checked locally, but running
// this script launches a browser and requires the user's explicit UI permission.
// All solver and render start families are intercepted and must remain unused.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { chromePath, startStack } from "./scenarios/stack.mjs";

if (process.env.CI !== "true" && process.env.FAIRBEAM_ALLOW_LOCAL_BROWSER !== "1") {
  throw new Error("Local browser acceptance requires explicit user permission.");
}
const out = join(process.env.FAIRBEAM_TEST_ARTIFACTS || "fairbeam-scenario-failures", "wideband-materials");
mkdirSync(out, { recursive: true });
let stack, browser, page;
const starts = [], errors = [], outcomes = [];
try {
  stack = await startStack({ log: console.log, niceSolver: false });
  browser = await puppeteer.launch({ executablePath: await chromePath(), headless: true, args: ["--no-sandbox", "--enable-unsafe-swiftshader"] });
  for (const lang of ["en", "tr"]) {
    const context = await browser.createBrowserContext();
    page = await context.newPage();
    await page.setRequestInterception(true);
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      const job = /^\/api\/(?:runs|sweeps|convergence|optimizations|research\/runs|render-jobs)(?:\/|$)/.test(path);
      const native = /^\/api\/(?:native-document(?:\/|$)|(?:research\/elmer\/install|blender\/open-download|open-feedback|renders\/[A-Za-z0-9_-]+\/open)\/?$)/.test(path);
      if (request.method() === "POST" && (job || native)) {
        starts.push({ method: request.method(), path });
        void request.abort("blockedbyclient");
      } else void request.continue();
    });
    page.on("pageerror", error => errors.push(String(error)));
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument(language => localStorage.setItem("fairbeam.generalSettings", JSON.stringify({ language })), lang);
    await page.goto(stack.url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".home", { timeout: 45000 });
    await page.evaluate(async lang => {
      const store = await import("/src/designer/store.ts");
      await store.createDesign({ id: `wideband_${lang}`, name: `Wideband ${lang}`, template: "dipole" });
      store.edit(d => {
        d.materials.push({ name: "Laminate", kind: "dielectric", eps_r: 4.3, tan_d: 0.02, tan_d_freq: 1 });
        d.parts.push({ name: "Laminate", material: "Laminate", primitives: [{ kind: "box", start: [-3, -3, -1], stop: [3, 3, 1] }] });
        d.params.push({ key: "lower_corner", default: 4 });
        d.simulation.f_min = 0.5; d.simulation.f_max = 5;
      });
      store.setSelection({ type: "material", i: store.draft.materials.length - 1 });
    }, lang);
    const model = "#dz-materials-Laminate-dispersion";
    await page.waitForSelector(model);
    await page.select(model, "ds");
    const translated = key => page.evaluate(async key => (await import("/src/i18n/index.ts")).t(key), key);
    assert.equal(await page.$eval(`${model} option:checked`, e => e.textContent), await translated("props.material.ds"));
    assert.ok(await page.evaluate(text => document.body.textContent.includes(text), await translated("props.material.dsNote")));
    const fields = ["m1", "m2", "n_poles"];
    await page.evaluate(() => { document.querySelector("#dz-materials-Laminate-dispersion-m1").closest("details").open = true; });
    assert.deepEqual(await page.evaluate(fields => fields.map(k => document.querySelector(`#dz-materials-Laminate-dispersion-${k}`).value), fields), ["4", "12", ""]);
    const fill = async (selector, value) => {
      await page.focus(selector); await page.keyboard.down("Control"); await page.keyboard.press("A"); await page.keyboard.up("Control");
      await page.keyboard.type(value); await page.keyboard.press("Tab");
    };
    await fill("#dz-materials-Laminate-dispersion-m1", "lower_corner");
    await fill("#dz-materials-Laminate-dispersion-n_poles", "8");
    const fitAt = async (lo, hi) => page.waitForFunction(async (lo, hi) => {
      const store = await import("/src/runner/store.ts");
      const part = store.draftPreview()?.parts.find(p => p.name === "Laminate");
      const d = part?.material?.dispersion;
      return d?.source?.report?.f_min === lo * 1e9 && d?.source?.report?.f_max === hi * 1e9 &&
        d.source.designer_material?.input?.dispersion?.m1 === "lower_corner" && d.source.designer_material?.resolved?.dispersion?.n_poles === 8;
    }, { timeout: 45000 }, lo, hi);
    await fitAt(0.5, 5);
    const originalFit = await page.evaluate(async () => (await import("/src/runner/store.ts")).draftPreview().parts.find(p => p.name === "Laminate").material.dispersion);
    assert.equal(originalFit.model, "lorentz");
    assert.equal(originalFit.source.report.poles, originalFit.eps_poles.length);
    assert.ok(originalFit.eps_poles.every(p => p.type === "lorentz"));
    await fill("#dz-materials-Laminate-dispersion-m2", "3");
    await page.waitForFunction(async () => (await import("/src/designer/store.ts")).checks().some(c => c.code === "dispersion" && c.severity === "error"));
    assert.ok(await page.evaluate(text => document.body.textContent.toLocaleLowerCase().includes(text.toLocaleLowerCase()), await translated("checks.msg.dispersion.passive")));
    await fill("#dz-materials-Laminate-dispersion-m2", "12");
    await page.evaluate(async () => (await import("/src/designer/store.ts")).edit(d => { d.simulation.f_min = 2; d.simulation.f_max = 6; }));
    await fitAt(2, 6);
    await page.waitForFunction(async () => (await import("/src/designer/store.ts")).checks().some(c => c.code === "dispersion-band" && !c.fix));
    const revisedFit = await page.evaluate(async () => (await import("/src/runner/store.ts")).draftPreview().parts.find(p => p.name === "Laminate").material.dispersion);
    assert.notDeepEqual(revisedFit, originalFit, "band change invalidates actual fitted identity");
    const saved = await page.evaluate(async () => {
      const store = await import("/src/designer/store.ts");
      await store.save();
      if (store.dirty()) throw new Error("save did not complete");
      const id = store.file().id, material = JSON.parse(JSON.stringify(store.draft.materials.find(m => m.name === "Laminate")));
      await store.openDesign(id);
      return { before: material, after: JSON.parse(JSON.stringify(store.draft.materials.find(m => m.name === "Laminate"))) };
    });
    assert.deepEqual(saved.after, saved.before, "save/reopen preserves expressions, reference and pole intent");
    await page.screenshot({ path: join(out, `editor-${lang}.png`) });
    assert.deepEqual(starts, [], "no solver or renderer start attempts");
    assert.deepEqual(errors, [], "no browser exceptions");
    outcomes.push({ lang, editor: true, expressions: true, invalidCornersRefused: true,
      savedIntent: saved, originalFit, revisedFit, solverRun: false });
    console.log(`${lang}: DS editor/defaults/expressions/errors, actual band fit identity, warning and save/reopen passed; zero solver/render starts`);
    await context.close();
  }
  writeFileSync(join(out, "result.json"), JSON.stringify({ outcomes, starts, errors }, null, 2));
} catch (error) {
  writeFileSync(join(out, "error.txt"), String(error?.stack || error));
  writeFileSync(join(out, "diagnostics.json"), JSON.stringify({ starts, errors, children: stack?.diagnostics() }, null, 2));
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await stack?.stop();
}
