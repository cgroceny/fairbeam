// Remote browser acceptance for the mesh inspector. Synthetic stored mesh; no solver run.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { chromePath, startStack } from "./scenarios/stack.mjs";
if (process.env.CI !== "true" && process.env.FAIRBEAM_ALLOW_LOCAL_BROWSER !== "1")
  throw new Error("Browser acceptance runs in CI; local use requires explicit root scheduling.");
const out = join(process.env.FAIRBEAM_TEST_ARTIFACTS || "fairbeam-scenario-failures", "mesh-bottlenecks");
let stack, browser, page;
const errors = [];
const forbiddenStarts = [];
try {
  stack = await startStack({ log: console.log, niceSolver: false });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(), args: ["--no-sandbox", "--enable-unsafe-swiftshader"] });
  for (const lang of ["en", "tr"]) {
    const context = await browser.createBrowserContext();
    page = await context.newPage();
    page.on("pageerror", e => errors.push(String(e.stack || e)));
    let previewMode = "pass";
    const heldPreviews = [];
    await page.setRequestInterception(true);
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      // These are the actual server submission routes, not the preview mesher. Never run a
      // solver, study, optimization, Blender render or native action if an interaction regresses.
      const job = /^\/api\/(?:runs|sweeps|convergence|optimizations|research\/runs|render-jobs)(?:\/|$)/.test(path);
      const native = /^\/api\/(?:native-document(?:\/|$)|(?:research\/elmer\/install|blender\/open-download|open-feedback|renders\/[A-Za-z0-9_-]+\/open)\/?$)/.test(path);
      if ((request.method() === "POST" && job) || native) {
        forbiddenStarts.push({ method: request.method(), path });
        void request.abort("blockedbyclient").catch(e => errors.push(String(e)));
      } else if (request.method() === "POST" && path === "/api/preview" && previewMode === "hold") heldPreviews.push(request);
      else void request.continue().catch(e => errors.push(String(e)));
    });
    await page.setViewport({ width: lang === "en" ? 1440 : 760, height: 900 });
    await page.evaluateOnNewDocument(lang => localStorage.setItem("fairbeam.generalSettings", JSON.stringify({ language: lang })), lang);
    await page.goto(stack.url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".home");
    await page.evaluate(async lang => {
      const store = await import("/src/designer/store.ts");
      await store.createDesign({ id: `mesh_inspector_${lang}`, name: `Mesh inspector ${lang}`, template: "dipole" });
    }, lang);
    await page.waitForFunction(async () => (await import("/src/runner/store.ts")).previewState() === "ready");
    await page.evaluate(async () => (await import("/src/designer/MeshView.tsx")).setMeshView(true));
    // Exercise the real quickBundle -> showQuickPreview -> validateBundle path while its server
    // request is delayed, then failed. Old lines remain useful; new boxes are never blamed.
    previewMode = "hold";
    const pendingPreview = page.waitForRequest(r => r.method() === "POST" && new URL(r.url()).pathname === "/api/preview");
    await page.evaluate(async () => {
      const store = await import("/src/designer/store.ts");
      store.edit(d => { d.parts[0].transforms = [...(d.parts[0].transforms ?? []), { type: "move", offset: [0.1, 0, 0] }]; }, "parts[0].transforms");
    });
    await pendingPreview;
    await page.waitForSelector("[data-mesh-carried]");
    await page.click('[data-mesh-jump="x"]');
    const noAttribution = async () => {
      assert.equal(await page.evaluate(async () => {
        const { t } = await import("/src/i18n/index.ts");
        const selected = document.querySelector("[data-mesh-highlight]")?.textContent ?? "";
        return !selected.includes(t("results.mesh.bboxOnly")) && !selected.includes(t("results.mesh.bboxTransformed")) && !selected.includes(t("results.mesh.likelyNone"));
      }), true, "carried mesh suppresses attribution instead of asserting no source");
    };
    await noAttribution();
    assert.equal(heldPreviews.length, 1, "one delayed preview, no retry");
    previewMode = "pass";
    await heldPreviews[0].respond({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Intentional mesh provenance fixture failure" }) });
    await page.waitForFunction(async () => (await import("/src/runner/store.ts")).previewState() === "error");
    assert.ok(await page.$("[data-mesh-carried]")); await noAttribution();
    await page.evaluate(async () => (await import("/src/runner/store.ts")).setPreviewState("idle"));
    assert.ok(await page.$("[data-mesh-carried]")); await noAttribution();
    await page.evaluate(async () => (await import("/src/designer/store.ts")).retryPreview());
    await page.waitForFunction(async () => (await import("/src/runner/store.ts")).previewState() === "ready" && !document.querySelector("[data-mesh-carried]"));
    await page.evaluate(async () => {
      const state = await import("/src/state.ts");
      const b = structuredClone(state.bundle());
      b.name = "Synthetic saved mesh"; b.model.id = "synthetic_saved_mesh";
      b.mesh = { x: [0, 0.035, 1], y: [-2, 0, 2], z: [-1, 0, 1], total_cells: 8 };
      b.domain = { min: [0, -2, -1], max: [1, 2, 1] }; delete b.focus;
      b.parts = [{ name: "copper", type: "Metal", bbox: [[0, -1, 0], [0.035, 1, 0.2]], primitives: [] }];
      b.ports = []; b.results = null;
      state.setBundle(b);
      (await import("/src/designer/MeshView.tsx")).setMeshView(true);
      window.__meshTestBundle = b;
    });
    await page.waitForSelector('[data-mesh-source="synthetic_saved_mesh"]');
    const text = key => page.evaluate(async key => (await import("/src/i18n/index.ts")).t(key), key);
    assert.ok((await page.$eval(".mv-panel", e => e.textContent)).includes("0.035"), "shown mesh, not the different draft preview, supplies intervals");
    await page.evaluate(() => {
      const { camera, controls } = window.__fairbeam;
      camera.position.add({ x: 10000, y: -10000, z: 10000 });
      controls.target.set(10000, -10000, 10000); controls.update();
    });
    await page.click('[data-mesh-jump="x"]');
    await page.waitForSelector('[data-mesh-highlight="x:0:1"]');
    await page.waitForFunction(() => !!window.__fairbeam?.scene.getObjectByName("mesh-bottleneck"));
    const highlight = await page.evaluate(() => [...window.__fairbeam.scene.getObjectByName("mesh-bottleneck").geometry.attributes.position.array]);
    assert.equal(highlight.length, 24);
    for (let i = 0; i < highlight.length; i += 3) {
      assert.ok(Math.abs(highlight[i]) < 1e-8 || Math.abs(highlight[i] - 0.035) < 1e-8);
      assert.equal(highlight[i + 2], 0);
    }
    assert.ok((await page.$eval('[data-mesh-highlight]', e => e.textContent)).includes("copper"));
    const target = await page.evaluate(() => window.__fairbeam.controls.target.toArray());
    assert.ok(Math.abs(target[0] - 0.0175) < 1e-10, "selection centers the actual interval");
    assert.equal(target[1], 0, "off-domain pan is reset on the remaining axis");
    assert.equal(target[2], 0, "camera target lies on the chosen plane");
    await page.click("[data-mesh-grading]");
    await page.waitForSelector('[data-mesh-highlight="x:0:2"]');
    assert.equal(await page.evaluate(() => window.__fairbeam.scene.getObjectByName("mesh-bottleneck").geometry.attributes.position.count), 10);
    assert.equal(await page.$eval(".mv-panel", e => e.scrollWidth <= e.clientWidth), true, "panel has no horizontal overflow");
    assert.equal(await page.$eval(".mv-panel", e => { const b = e.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth && b.bottom <= innerHeight; }), true);
    mkdirSync(out, { recursive: true });
    await page.screenshot({ path: join(out, `mesh-${lang}.png`) });

    // New source invalidates old indices, even when its mesh values happen to be equal.
    await page.evaluate(async () => {
      const state = await import("/src/state.ts"), b = structuredClone(window.__meshTestBundle);
      b.name = "Ambiguous transformed fixture";
      b.parts.push({ ...b.parts[0], name: "rotated", primitives: [{ kind: "bbox", source_kind: "box", exact: false, transformed: true, priority: 1, bbox: b.parts[0].bbox }] });
      state.setBundle(b);
    });
    await page.waitForFunction(() => !document.querySelector("[data-mesh-highlight]") && !window.__fairbeam.scene.getObjectByName("mesh-bottleneck"));
    await page.click('[data-mesh-jump="x"]');
    assert.ok((await page.$eval("[data-mesh-highlight]", e => e.textContent)).includes(await text("results.mesh.bboxTransformed")));
    assert.ok((await page.$eval("[data-mesh-highlight]", e => e.textContent)).includes("rotated"));
    await page.evaluate(async () => { const state = await import("/src/state.ts"); state.setBundle({ ...state.bundle(), parts: [] }); });
    await page.click('[data-mesh-jump="x"]');
    assert.ok((await page.$eval("[data-mesh-highlight]", e => e.textContent)).includes(await text("results.mesh.likelyNone")));
    const before = await page.evaluate(async () => JSON.stringify((await import("/src/designer/store.ts")).draft.mesh));
    await page.click("[data-mesh-thin-link]");
    await page.waitForFunction(() => document.activeElement?.id === "dz-mesh-thin_metal");
    assert.equal(await page.evaluate(async () => JSON.stringify((await import("/src/designer/store.ts")).draft.mesh)), before, "review link never changes thin-metal policy");
    await page.keyboard.press("Escape");
    console.log(`${lang}: delayed/failed preview provenance, displayed source, exact interval/pair, off-domain camera target, source replacement, bbox qualifications, layout and thin-metal focus passed`);
    await context.close();
  }
  assert.deepEqual(errors, [], "no page exceptions");
  assert.deepEqual(forbiddenStarts, [], "no solver, study, optimization, render or native action was attempted");
} catch (error) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "failure.json"), JSON.stringify({ error: String(error.stack || error), errors, forbiddenStarts, children: stack?.diagnostics() }, null, 2));
  await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await stack?.stop();
}
