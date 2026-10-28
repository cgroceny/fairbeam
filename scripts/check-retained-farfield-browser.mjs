// Synthetic local-job UI contract. Every solver/transform POST is intercepted;
// this starts no FDTD/native job and uses a fresh, muted headless browser only.
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { root, startStack, chromePath } from './scenarios/stack.mjs';
import { Session, auditInPage } from './scenarios/harness.mjs';
import { withStartupDiagnostics } from './scenarios/startup-diagnostics.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' && process.env.FAIRBEAM_ALLOW_BROWSER_TEST !== '1')
  throw new Error('Browser test requires CI or explicit browser-test authorization.');
const out = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || join(tmpdir(), `fairbeam-nf2ff-${Date.now()}`), 'retained-farfield');
await mkdir(out, { recursive: true });
const original = JSON.parse(await readFile(join(root, 'public/projects/helix-axial.json'), 'utf8'));
const cap = { available: true, parent_sha256: 'a'.repeat(64), raw_bytes: 1024, max_frequencies: 16,
  max_cells_per_frequency: 65536, max_total_cells_per_port: 262144,
  ports: [{ port: 1, domain: 'TD', band_hz: [1e9, 3e9], recorded_frequencies_hz: [] }] };
const outcomes = [], forbidden = [];
let stack, browser, page, lang;
try {
  stack = await startStack({ log: console.log });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(),
    args: ['--no-sandbox', '--mute-audio', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  for (lang of ['en', 'tr']) {
    const context = await browser.createBrowserContext();
    page = await context.newPage(); await page.setViewport({ width: 1280, height: 1000 });
    await page.evaluateOnNewDocument(language => localStorage.setItem('fairbeam.generalSettings', JSON.stringify({ language })), lang);
    let source, submitted, runRequest, capability = structuredClone(cap);
    await page.setRequestInterception(true);
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      const respond = body => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/runs' && request.method() === 'GET') return void respond({ runs: source ? [source] : [] });
      if (path === '/api/runs/nf2ff-source/farfield' && request.method() === 'GET') return void respond(capability);
      if (path === '/api/runs/nf2ff-source/farfield' && request.method() === 'POST') {
        submitted = JSON.parse(request.postData());
        // Deliberate refusal keeps the form visible so its error path is checked.
        return void request.respond({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic transform refusal; no native execution' }) });
      }
      if (path === '/api/runs' && request.method() === 'POST') {
        runRequest = JSON.parse(request.postData());
        return void request.respond({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic run refusal; no solver execution' }) });
      }
      if (request.method() === 'POST' && /^\/api\/(?:sweeps|convergence|optimizations|research\/runs|render-jobs|native-document)(?:\/|$)/.test(path)) {
        forbidden.push(path); return void request.abort();
      }
      void request.continue();
    });
    const s = new Session(page, { lang, scenario: 'retained-farfield', url: stack.url, artifactDirectory: out });
    await withStartupDiagnostics(page, { directory: join(out, `startup-${lang}`), stack }, async () => {
      await page.goto(stack.url, { waitUntil: 'domcontentloaded' }); await s.wait('.home', undefined, { timeout: 45000 });
    });
    await page.locator('input[name="home-template"][value="patch"]').click();
    await s.fill(await s.field(await s.T('home.newProject.name')), `Retained field control ${lang}`, { blur: false });
    await s.click('home.newProject.create'); await s.wait('.rb');
    await s.ev(async () => (await import('/src/runner/designRun.ts')).setRunDialogOpen(true)); await s.wait('.rd-dialog');
    assert.equal(await page.$eval('input[name="retain-nf2ff"]', e => e.checked), false);
    await page.click('input[name="retain-nf2ff"]'); await page.click('.rd-dialog button[form="rd-form"]');
    await s.wait('.rd-dialog [role="alert"]', 'Synthetic run refusal');
    assert.equal(runRequest.retain_nf2ff, true);
    await s.click('common.close', { within: '.rd-dialog' });
    const own = await s.ev(async () => (await import('/src/designer/store.ts')).file());
    const fixture = structuredClone(original); fixture.model.id = own.design.model.id;
    fixture.name = 'Synthetic retained NF2FF source'; fixture.run = null;
    const file = `${own.id}--retained.json`;
    await writeFile(join(stack.projects, file), JSON.stringify(fixture));
    const indexPath = join(stack.projects, 'index.json'), index = JSON.parse(await readFile(indexPath, 'utf8'));
    index.projects.push({ file, model: fixture.model.id, name: fixture.name, created: fixture.created, simulated: true, bands: [], params: [], cells: fixture.mesh.total_cells });
    index.updated = new Date().toISOString(); await writeFile(`${indexPath}.nf2ff.tmp`, JSON.stringify(index)); await rename(`${indexPath}.nf2ff.tmp`, indexPath);
    source = { id: 'nf2ff-source', model: own.id, model_id: fixture.model.id, kind: 'run', status: 'done', phase: 'done', bundle: file,
      retain_nf2ff: true, retained_nf2ff: { root: 'synthetic-not-a-real-path', sha256: 'a'.repeat(64) }, name: fixture.name,
      label: null, params: {}, overrides: {}, threads: 1, stats: {}, info: {}, sweep: null, created: 1, finished: 2, duration_s: 1 };
    await s.ev(async () => {
      await (await import('/src/runner/store.ts')).refreshRuns();
      await (await import('/src/state.ts')).loadIndex();
      (await import('/src/designer/runResults.ts')).ensureDesignRunBundles();
    });
    await s.waitFor(async file => !!(await import('/src/designer/runResults.ts')).designRunBundle(file), file);
    await s.ev(async file => {
      const r = await import('/src/designer/runResults.ts');
      (await import('/src/runner/designRun.ts')).setDesignResult({ file, bundle: r.designRunBundle(file), jobId: 'nf2ff-source' });
      (await import('/src/designer/resultFocus.ts')).focusResult({ file, view: 'pattern' }, 'main');
    }, file);
    await s.wait('.dw-result [data-retained-farfield]'); await page.click('.dw-result [data-retained-farfield] summary');
    await s.wait('input[name="nf2ff-frequencies"]');
    await s.fill('input[name="nf2ff-frequencies"]', '4');
    assert.equal(await page.$eval('[data-retained-farfield] button[type=submit]', e => e.disabled), true);
    await s.fill('input[name="nf2ff-frequencies"]', '2, 2.45');
    await s.fill('input[name="nf2ff-theta-step"]', '0.25'); await s.fill('input[name="nf2ff-phi-step"]', '0.25');
    assert.equal(await page.$eval('[data-retained-farfield] button[type=submit]', e => e.disabled), true);
    await s.fill('input[name="nf2ff-theta-step"]', '3'); await s.fill('input[name="nf2ff-phi-step"]', '5');
    await page.click('[data-retained-farfield] button[type=submit]');
    await s.wait('[data-retained-farfield] [role=alert]', 'Synthetic transform refusal');
    assert.deepEqual(submitted, { frequencies_hz: [2e9, 2.45e9], theta_step: 3, phi_step: 5 });
    assert.deepEqual(await page.evaluate(auditInPage, '[data-retained-farfield]'), []);
    for (const width of [1280, 768]) {
      await page.setViewport({ width, height: 1000 });
      const bounds = await page.$eval('[data-retained-farfield]', e => ({ width: e.clientWidth, scroll: e.scrollWidth }));
      assert.ok(bounds.width > 150 && bounds.scroll <= bounds.width + 1, JSON.stringify(bounds));
      await page.screenshot({ path: join(out, `${lang}-${width}.png`) });
    }
    // Viewer permits a linked local project but not an imported file with the same basename.
    await s.ev(async file => {
      (await import('/src/workspace.ts')).setAppMode('results');
      const state = await import('/src/state.ts');
      await state.loadProject(file); state.setDockTab('pattern');
    }, file);
    await s.wait('.dock [data-retained-farfield]');
    await page.click('.dock [data-retained-farfield] summary');
    await s.wait('.dock input[name="nf2ff-frequencies"]');
    await s.fill('.dock input[name="nf2ff-frequencies"]', '2.45');
    await page.click('.dock [data-retained-farfield] button[type=submit]');
    await s.wait('.dock [data-retained-farfield] [role=alert]', 'Synthetic transform refusal');
    assert.equal(submitted.frequencies_hz[0], 2.45e9);
    assert.deepEqual(await page.evaluate(auditInPage, '.dock [data-retained-farfield]'), []);
    const imported = join(out, file); await writeFile(imported, JSON.stringify(fixture));
    await (await page.$('.app-header input[type=file]')).uploadFile(imported);
    await s.waitFor(async file => {
      const state = await import('/src/state.ts');
      return state.sourceOrigin() === 'local-file' && state.source() === file;
    }, file);
    await s.wait('.dock [data-retained-farfield]', await s.T('nf2ff.unavailable'));
    assert.equal(await page.$$eval('.dock [data-retained-farfield] button[type=submit]', nodes => nodes.length), 0);
    await s.ev(async file => { await (await import('/src/state.ts')).loadProject(file); }, file);
    await s.wait('.dock input[name="nf2ff-frequencies"]');
    // Remove authority without changing the selected bundle: stale local jobs may not keep the action enabled.
    source = { ...source, retained_nf2ff: null };
    await s.ev(async () => (await import('/src/runner/store.ts')).refreshRuns());
    await s.wait('[data-retained-farfield]', await s.T('nf2ff.unavailable'));
    assert.equal(await page.$$eval('[data-retained-farfield] button[type=submit]', nodes => nodes.length), 0);
    outcomes.push({ lang, syntheticOnly: true, runRetentionDefaultOffAndPayload: true, requestAdmission: true,
      refusal: true, designerAndLinkedViewer: true, importedSameNameRefused: true, staleAuthorityDisabled: true, widths: [1280, 768] });
    await context.close();
  }
  assert.deepEqual(forbidden, []);
  await writeFile(join(out, 'result.json'), JSON.stringify({ outcomes, forbidden }, null, 2));
  console.log(JSON.stringify({ out, outcomes }, null, 2));
} catch (error) {
  await writeFile(join(out, 'failure.json'), JSON.stringify({ error: String(error?.stack || error), lang, forbidden, outcomes }, null, 2));
  throw error;
} finally { try { await browser?.close(); } finally { await stack?.stop(); } }
