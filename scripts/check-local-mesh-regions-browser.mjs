// Real preview/editor acceptance. No EM solve: every run/study/render POST is intercepted and fails.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { startStack, chromePath } from './scenarios/stack.mjs';
import { Session, auditInPage } from './scenarios/harness.mjs';
import { withStartupDiagnostics } from './scenarios/startup-diagnostics.mjs';
if (process.env.GITHUB_ACTIONS !== 'true' && process.env.FAIRBEAM_ALLOW_BROWSER_TEST !== '1') {
  throw new Error('Browser test requires remote CI or explicit user permission (FAIRBEAM_ALLOW_BROWSER_TEST=1).');
}
const out = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || join(tmpdir(), 'fairbeam-scenario-failures'), 'local-mesh-regions');
await mkdir(out, { recursive: true });
const results = [];
let stack, browser, page, session;
try {
  stack = await startStack({ log: console.log, niceSolver: false });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(),
    args: ['--no-sandbox', '--mute-audio', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  for (const lang of ['en', 'tr']) {
    const id = `local_regions_${lang}`, otherId = `local_regions_empty_${lang}`;
    for (const name of [id, otherId]) {
      const response = await fetch(`${stack.apiUrl}/api/designs`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: name, name, template: 'dipole' }) });
      assert.equal(response.status, 201, await response.text());
    }
    const context = await browser.createBrowserContext();
    page = await context.newPage(); await page.setViewport({ width: 1280, height: 950 });
    await page.evaluateOnNewDocument(language => localStorage.setItem('fairbeam.generalSettings', JSON.stringify({ language })), lang);
    let submissions = 0, held = null, holdPreview = false;
    const refusals = [], networkErrors = [];
    await page.setRequestInterception(true);
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (/^\/api\/(?:runs|sweeps|convergence|optimizations|research\/runs|render-jobs)(?:\/|$)/.test(path) && request.method() === 'POST') {
        submissions++; void request.abort();
      } else if (path === '/api/preview' && request.method() === 'POST' && holdPreview) {
        assert.equal(held, null, 'one deliberately held preview, no duplicate request'); held = request;
      } else void request.continue();
    });
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.status() >= 400 && path === '/api/preview') refusals.push({ status: response.status(), body: response.request().postData() });
      else if (response.status() >= 400 && path.startsWith('/api/')) networkErrors.push({ status: response.status(), path });
    });
    const s = new Session(page, { lang, scenario: 'local-mesh-regions', url: stack.url, artifactDirectory: out }); session = s;
    await withStartupDiagnostics(page, { directory: join(out, `startup-${lang}`), stack }, async () => {
      await page.goto(stack.url, { waitUntil: 'domcontentloaded' }); await s.wait('.home');
    });
    const openDesign = async name => {
      await s.clickSel(`[data-home-design="${name}"] .home-item`);
      await s.waitFor(async id => { const m = await import('/src/designer/store.ts'); return !m.loading() && m.file()?.id === id; }, name);
    };
    const ready = async (count = 0) => s.waitFor(async count => {
      const r = await import('/src/runner/store.ts'), l = await import('/src/designer/localMeshReport.ts');
      return r.meshFreshness() === 'current' && !!r.draftPreview() &&
        (count ? l.localMeshReport(r.draftPreview())?.regions.length === count : !r.draftPreview().mesh.auto?.local_refinement);
    }, count);
    const openSettings = async () => {
      await s.ev((_, m) => m.sim.focusSimSettings('mesh.local_regions'), null, { sim: '/src/designer/simSettingsState.ts' });
      await s.wait('#ss-title'); await s.wait('[data-local-mesh-editor]');
    };
    const input = async path => `#${await s.store((path, m) => m.s.fieldId(path), path)}`;
    const regionState = () => s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft.mesh.local_regions ?? [])));
    const overlay = () => page.evaluate(() => {
      const obj = window.__fairbeam?.scene.getObjectByName('mesh-local-regions');
      return obj ? { ids: obj.userData.regionIds, vertices: obj.geometry.attributes.position.count } : null;
    });
    await openDesign(id); await ready(); await openSettings();
    assert.deepEqual(await regionState(), [], 'new designs do not acquire a default refinement region');
    await s.clickSel('[data-local-mesh-add]'); await ready(1);
    const initial = await regionState(); assert.equal(initial.length, 1);
    await s.click('sim.discard', { within: '[aria-labelledby="ss-title"]' }); await s.gone('#ss-title');
    assert.deepEqual(await regionState(), [], 'Discard removes an uncommitted region'); await ready();
    await openSettings(); await s.clickSel('[data-local-mesh-add]'); await ready(1);
    const nameInput = await input('mesh.local_regions[0].name'), capInput = await input('mesh.local_regions[0].cell_size');
    await s.fill(nameInput, `Feed ${lang}`); await ready(1);
    const live = await regionState(), cap = live[0].cell_size;
    // Explicit test parameter setup; subsequent expression editing and rename use the normal history.
    await s.store((cap, m) => m.s.edit(d => { d.params.push({ key: 'localCap', default: cap, unit: 'mm' }); }, 'fixture-local-cap'), cap);
    await s.fill(capInput, 'localCap'); await ready(1);
    await s.store((_, m) => {
      const index = m.s.draft.params.findIndex(p => p.key === 'localCap');
      const error = m.s.renameParam(index, 'regionCap'); if (error) throw new Error(error);
    });
    await ready(1); assert.equal(await page.$eval(capInput, e => e.value), 'regionCap');
    assert.equal((await regionState())[0].name, `Feed ${lang}`, 'renaming a parameter leaves display names intact');
    await s.click('common.ok', { within: '[aria-labelledby="ss-title"]' }); await s.gone('#ss-title');
    await s.store((_, m) => m.s.undo()); await ready(1); assert.equal((await regionState())[0].cell_size, 'localCap');
    await s.store((_, m) => m.s.redo()); await ready(1); assert.equal((await regionState())[0].cell_size, 'regionCap');
    await s.ev((_, m) => m.st.setLayers('mesh', true), null, { st: '/src/state.ts' });
    await s.waitFor(() => !!window.__fairbeam?.scene.getObjectByName('mesh-local-regions'));
    assert.deepEqual(await overlay(), { ids: [live[0].id], vertices: 24 });
    await page.screenshot({ path: join(out, `overlay-${lang}-1280.png`) });
    await openSettings();
    await s.clickSel('[data-local-mesh-report] > summary');
    const report = await s.ev((_, m) => {
      const b = m.r.draftPreview(), report = m.l.localMeshReport(b);
      return { report, axes: [b.mesh.x, b.mesh.y, b.mesh.z], unit: b.units.length_m };
    }, null, { r: '/src/runner/store.ts', l: '/src/designer/localMeshReport.ts' });
    assert.equal(report.report.final.total_cells, report.axes.reduce((n, axis) => n * (axis.length - 1), 1));
    for (const region of report.report.regions) for (let k = 0; k < 3; k++) {
      const widths = report.axes[k].slice(1).flatMap((stop, i) => report.axes[k][i] < region.stop[k] && stop > region.start[k] ? [stop - report.axes[k][i]] : []);
      assert.equal(Math.max(...widths), region.max_width[k]); assert.ok(widths.length > 0);
    }
    assert.deepEqual(await page.evaluate(auditInPage, '[aria-labelledby="ss-title"]'), []);
    await page.$eval('[data-local-mesh-editor]', e => e.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: join(out, `editor-${lang}-1280.png`) });
    await page.setViewport({ width: 768, height: 950 });
    assert.deepEqual(await page.evaluate(auditInPage, '[aria-labelledby="ss-title"]'), []);
    await page.screenshot({ path: join(out, `editor-${lang}-768.png`) });
    await page.setViewport({ width: 1280, height: 950 });
    // A request in flight must never associate the old resolved box with the edited draft.
    holdPreview = true;
    const heldRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/preview' && request.method() === 'POST', { timeout: 15000 });
    await s.fill(nameInput, `Pending ${lang}`);
    await s.waitFor(async () => (await import('/src/runner/store.ts')).meshFreshness() === 'updating');
    await s.gone('[data-local-mesh-report]');
    await s.waitFor(() => !window.__fairbeam?.scene.getObjectByName('mesh-local-regions'));
    await heldRequest;
    assert.ok(held, 'a real edited preview request is held at the network boundary');
    holdPreview = false; await held.continue(); held = null; await ready(1);
    await s.waitFor(() => !!window.__fairbeam?.scene.getObjectByName('mesh-local-regions'));
    // A real out-of-domain refusal is a diagnosed product check, not a mocked success.
    const stopInput = await input('mesh.local_regions[0].stop[0]');
    const previousStop = (await regionState())[0].stop[0];
    const badPreview = page.waitForResponse(response => {
      if (new URL(response.url()).pathname !== '/api/preview' || response.status() !== 422) return false;
      try { return JSON.parse(response.request().postData()).design.mesh.local_regions[0].stop[0] === 1e12; } catch { return false; }
    }, { timeout: 15000 });
    await s.fill(stopInput, '1e12');
    const rejection = await (await badPreview).json();
    assert.ok(rejection.checks?.some(c => c.code === 'mesh-local-region' && c.message === 'region must lie inside the mesh domain'));
    await s.waitFor(async () => (await import('/src/runner/store.ts')).meshFreshness() === 'stale');
    await s.gone('[data-local-mesh-report]'); assert.equal(await overlay(), null);
    await s.waitFor(async () => (await import('/src/designer/store.ts')).checks().some(c => c.code === 'mesh-local-region' && c.message === 'region must lie inside the mesh domain'));
    const localized = await s.ev((_, m) => m.text.checkTitle({ code: 'mesh-local-region', message: 'region must lie inside the mesh domain' }), null,
      { text: '/src/designer/checkText.ts' });
    assert.equal(await page.$eval(stopInput, e => document.getElementById(e.getAttribute('aria-describedby').split(' ')[0])?.textContent), localized);
    await s.ev((_, m) => m.sim.focusSimSettings('mesh.local_regions[0].stop[0]'), null, { sim: '/src/designer/simSettingsState.ts' });
    await s.waitFor(selector => document.activeElement === document.querySelector(selector), stopInput);
    assert.ok((await page.$eval('[data-local-mesh-editor]', e => e.textContent)).includes(await s.T('localMesh.reportUnavailable')));
    await s.fill(stopInput, String(previousStop)); await ready(1);
    // A captured manual source is an explicit setup, with the existing current axes and settings.
    await s.click('common.ok', { within: '[aria-labelledby="ss-title"]' }); await s.gone('#ss-title');
    const retained = await regionState();
    await s.store((_, m) => {
      const b = m.r.draftPreview();
      m.s.edit(d => { const current = JSON.parse(JSON.stringify(d.mesh));
        d.mesh = { mode: 'manual', axis_precision: 'float64', lines: { x: b.mesh.x, y: b.mesh.y, z: b.mesh.z },
          automatic: { ...current, local_regions: [{ ...current.local_regions[0], name: 'OBSOLETE STASH' }] },
          local_regions: current.local_regions, thin_metal: current.thin_metal };
      }, 'fixture-captured-manual-grid');
    }, null, { r: '/src/runner/store.ts' });
    await ready(); await openSettings(); await s.wait('[data-local-mesh-inactive]');
    await s.fill(capInput, 'unknownInactive'); await ready();
    assert.notEqual(await page.$eval(capInput, e => e.getAttribute('aria-invalid')), 'true', 'manual inactive expressions are not evaluated');
    await s.fill(capInput, 'regionCap'); await ready();
    await s.fill(nameInput, `Manual edit ${lang}`); await ready();
    await page.select('#dz-mesh-mode', 'design'); await ready(1);
    assert.equal((await regionState())[0].name, `Manual edit ${lang}`, 'automatic restoration uses the current list, not the obsolete stash');
    assert.equal((await regionState())[0].cell_size, retained[0].cell_size);
    await s.click('common.ok', { within: '[aria-labelledby="ss-title"]' }); await s.gone('#ss-title');
    await s.click('ribbon.tab.home', { sel: '.rb-tab' }); await s.click('common.save', { sel: '.rb-btn', exact: true });
    await s.waitFor(async () => { const m = await import('/src/designer/store.ts'); return !m.saving() && !m.dirty(); });
    const saved = await (await fetch(`${stack.apiUrl}/api/designs/${id}`)).json();
    assert.deepEqual(saved.design.mesh.local_regions, await regionState());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await s.waitFor(async id => { const m = await import('/src/designer/store.ts'); return !m.loading() && m.file()?.id === id; }, id);
    await ready(1); assert.deepEqual(await regionState(), saved.design.mesh.local_regions, 'real reload preserves exact expressions and stable IDs');
    await openSettings();
    await s.click('localMesh.remove', { params: { name: `Manual edit ${lang}` }, within: '[data-local-mesh-editor]' });
    await ready(); assert.deepEqual(await regionState(), []); assert.equal(await overlay(), null);
    await s.click('common.ok', { within: '[aria-labelledby="ss-title"]' }); await s.gone('#ss-title');
    await s.store((_, m) => m.s.undo()); await ready(1);
    await s.click('ribbon.tab.home', { sel: '.rb-tab' }); await s.click('common.save', { sel: '.rb-btn', exact: true });
    await s.waitFor(async () => { const m = await import('/src/designer/store.ts'); return !m.saving() && !m.dirty(); });
    await s.click('header.screen.start', { sel: '.mode-switch button', exact: true }); await s.wait('.home');
    await openDesign(otherId); await ready(); assert.equal(await overlay(), null, 'another document cannot inherit boxes');
    assert.equal(submissions, 0); assert.deepEqual(networkErrors, []);
    assert.equal(refusals.length, 1); assert.equal(refusals[0].status, 422);
    const expected = 'console error: Failed to load resource: the server responded with a status of 422 (Unprocessable Content)';
    assert.deepEqual(s.consoleIssues, [expected], 'only the exact intentional out-of-domain preview refusal is allowed');
    results.push({ lang, realPreview: true, noSolver: true, savedRegions: saved.design.mesh.local_regions,
      insertion: report.report.insertion, final: report.report.final, pendingClearsBoxes: true, domainRefusal: true,
      manualInactive: true, currentListRestored: true, undoRedo: true, reloaded: true, newDocumentClearsBoxes: true });
    await context.close();
  }
  await writeFile(join(out, 'result.json'), JSON.stringify({ fixture: 'generated dipole Design; mesh previews only, no EM solve', results }, null, 2));
  console.log('Local mesh browser: EN/TR add/edit/discard/history/rename, real axes/report/overlay, pending and refused preview, inactive manual settings, save/reopen and document isolation passed.');
} catch (error) {
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  await writeFile(join(out, 'failure.json'), JSON.stringify({ error: String(error?.stack || error), results, console: session?.consoleIssues, stack: stack?.diagnostics() }, null, 2));
  throw error;
} finally { await browser?.close(); await stack?.stop(); }
