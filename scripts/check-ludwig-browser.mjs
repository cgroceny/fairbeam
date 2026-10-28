// Synthetic complex fields through real settings, viewer, Designer and export paths.
// This test starts no FDTD/native jobs and never controls an existing user browser.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { root, startStack, chromePath, pythonPath } from './scenarios/stack.mjs';
import { Session, auditInPage } from './scenarios/harness.mjs';
import { withStartupDiagnostics, safeDiagnosticText } from './scenarios/startup-diagnostics.mjs';
import { parseCsv } from '../src/export/csv.ts';

if (process.env.GITHUB_ACTIONS !== 'true' && process.env.FAIRBEAM_ALLOW_BROWSER_TEST !== '1')
  throw new Error('Browser test requires CI or explicit browser-test authorization.');
const out = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || join(tmpdir(), `fairbeam-ludwig-${Date.now()}`), 'ludwig');
await mkdir(out, { recursive: true });
const fields = JSON.parse(execFileSync(pythonPath(), ['python/tests/test_farfield_fields.py', '--json'], { cwd: root, encoding: 'utf8' }));
const fixture = JSON.parse(await readFile(join(root, 'public/projects/helix-axial.json'), 'utf8'));
fixture.name = fixture.model.name = 'Synthetic fixed-reference Ludwig control'; fixture.run = null;
fixture.results.farfield = [fields.find(f => f.name === 'linear-x')]; delete fixture.results.element_patterns;
const mods = { pq: '/src/lib/patternQuantityStore.ts', st: '/src/state.ts', dr: '/src/runner/designRun.ts', rf: '/src/designer/resultFocus.ts', rr: '/src/designer/runResults.ts' };
let stack, browser, page, session, lang;
const outcomes = [], forbidden = [];
const bounded = async (operation, ms, label) => {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
  })]); } finally { clearTimeout(timer); }
};

/** One observation of the existing missing-fields transition. No navigation retry,
 * recovery, timeout extension, input substitution or application-state write.
 * The outer 15 s deadline also bounds a blocked CDP evaluation inside Session.wait. */
async function observeMissingFields(action) {
  const directory = join(out, `missing-fields-${lang}`); await mkdir(directory, { recursive: true });
  const started = Date.now(), events = [], scripts = new Map(), writeErrors = [];
  let dropped = 0, writing = Promise.resolve(), cancelled = false, profiling = false;
  const safe = (_key, value) => typeof value === 'string' ? safeDiagnosticText(value) : value;
  const record = (type, data = {}) => {
    const event = { ms: Date.now() - started, type, ...data };
    // Keep bounded event traffic, but reserve room for the terminal diagnostics.
    const terminal = /^(transition-|capture-error|frame-tree|target-info|paused)/.test(type);
    if (events.length >= (terminal ? 3050 : 3000)) { dropped++; return; }
    events.push(event);
    // Append now, so a stalled renderer/process cannot erase the last completed stage.
    writing = writing.then(() => appendFile(join(directory, 'events.jsonl'), JSON.stringify(event, safe) + '\n'))
      .catch(error => { if (writeErrors.length < 10) writeErrors.push(String(error)); });
  };
  const cdp = await page.createCDPSession();
  const listeners = {
    'Page.frameNavigated': e => record('frame-navigated', e),
    'Page.frameStartedLoading': e => record('frame-started', e),
    'Page.frameStoppedLoading': e => record('frame-stopped', e),
    'Page.frameDetached': e => record('frame-detached', e),
    'Page.lifecycleEvent': e => record('lifecycle', e),
    'Runtime.executionContextCreated': e => record('context-created', { context: e.context }),
    'Runtime.executionContextDestroyed': e => record('context-destroyed', e),
    'Runtime.executionContextsCleared': () => record('contexts-cleared'),
    'Inspector.targetCrashed': () => record('target-crashed'),
    'Inspector.detached': e => record('inspector-detached', e),
    'Runtime.bindingCalled': e => { if (e.name === '__ludwigDiagnostic') { try { record('page-observation', JSON.parse(e.payload)); } catch { record('invalid-observation'); } } },
    'Debugger.scriptParsed': e => { if (scripts.size < 3000) scripts.set(e.scriptId, { url: e.url, hash: e.hash, startLine: e.startLine, startColumn: e.startColumn, endLine: e.endLine, endColumn: e.endColumn }); },
    'Debugger.paused': e => record('paused', { reason: e.reason, frames: e.callFrames.map(f => ({ functionName: f.functionName, location: f.location, functionLocation: f.functionLocation, script: scripts.get(f.location.scriptId) })) }),
  };
  for (const [event, listener] of Object.entries(listeners)) cdp.on(event, listener);
  const capture = async (label, operation, ms = 3000) => {
    try { return await bounded(operation, ms, `diagnostic ${label}`); }
    catch (error) { record('capture-error', { operation: label, error: String(error) }); return null; }
  };
  let failure;
  try {
    for (const method of ['Page.enable', 'Runtime.enable', 'Inspector.enable', 'Debugger.enable', 'Profiler.enable'])
      await bounded(() => cdp.send(method), 3000, `diagnostic setup ${method}`);
    await bounded(() => cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }), 3000, 'diagnostic lifecycle setup');
    await bounded(() => cdp.send('Runtime.addBinding', { name: '__ludwigDiagnostic' }), 3000, 'diagnostic observer binding');
    await bounded(() => page.evaluate(async () => {
      const st = await import('/src/state.ts'), workspace = await import('/src/workspace.ts'), focus = await import('/src/designer/resultFocus.ts');
      const emit = data => window.__ludwigDiagnostic(JSON.stringify(data));
      let last = '', ticks = 0;
      const snapshot = reason => {
        const b = st.bundle(), ff = b?.results?.farfield?.[0];
        const state = { mode: workspace.appMode(), revision: workspace.appModeRevision(), source: st.source(), model: b?.model.id,
          fieldCount: b?.results?.farfield?.length ?? 0, hasComplexFields: !!ff?.fields, loadError: st.loadError(), focus: focus.resultFocus(),
          readyState: document.readyState, bodyChildren: document.body.children.length, dock: !!document.querySelector('.dock'),
          designer: !!document.querySelector('.rb'), designerResult: !!document.querySelector('.dw-result'), header: !!document.querySelector('.app-header'),
          patternTabs: document.querySelectorAll('.dock [data-tab="pattern"]').length, visibility: document.visibilityState };
        const key = JSON.stringify(state); if (key !== last || reason === 'heartbeat') { last = key; emit({ reason, state }); }
      };
      const changing = event => { if (event.target instanceof HTMLInputElement && event.target.type === 'file') emit({ reason: 'file-change', files: [...event.target.files].map(f => ({ name: f.name, bytes: f.size })) }); };
      const beforeUnload = () => emit({ reason: 'beforeunload' });
      document.addEventListener('change', changing, true); window.addEventListener('beforeunload', beforeUnload);
      const observer = new MutationObserver(() => snapshot('DOM-change')); observer.observe(document.body, { childList: true, subtree: true });
      const timer = setInterval(() => { ticks++; snapshot(ticks % 4 === 0 ? 'heartbeat' : 'poll'); }, 250);
      window.__stopLudwigDiagnostic = () => { clearInterval(timer); observer.disconnect(); document.removeEventListener('change', changing, true); window.removeEventListener('beforeunload', beforeUnload); };
      snapshot('installed');
    }), 3000, 'diagnostic page observer setup');
    await bounded(() => cdp.send('Profiler.start'), 3000, 'diagnostic profiler start'); profiling = true;
    record('transition-start');
    const stage = name => { if (cancelled) throw new Error('Missing-fields observation already ended'); record('action-stage', { name }); };
    await bounded(() => action(stage), 15000, 'missing-fields import and viewer mount');
    record('transition-passed');
  } catch (error) {
    cancelled = true; failure = error; record('transition-failed', { error: String(error?.stack || error) });
    const frameTree = await capture('frame tree', () => cdp.send('Page.getFrameTree'));
    if (frameTree) record('frame-tree', frameTree);
    const target = await capture('target info', () => cdp.send('Target.getTargetInfo'));
    if (target) record('target-info', target);
    // Pause only the test-owned target, and always resume. Script-ID mapping is
    // retained so an anonymous helper frame is distinguishable from product code.
    await capture('pause', () => cdp.send('Debugger.pause'));
    await capture('resume', () => cdp.send('Debugger.resume'));
  } finally {
    cancelled = true;
    const profile = profiling ? await capture('CPU profile', () => cdp.send('Profiler.stop')) : null;
    if (profile) await writeFile(join(directory, 'transition.cpuprofile'), JSON.stringify(profile.profile, safe));
    await capture('observer cleanup', () => page.evaluate(() => window.__stopLudwigDiagnostic?.()), 1000);
    for (const [event, listener] of Object.entries(listeners)) cdp.off(event, listener);
    await capture('detach', () => cdp.detach(), 1000);
    await writing;
    await writeFile(join(directory, 'observation.json'), JSON.stringify({ error: failure ? String(failure) : null, elapsedMs: Date.now() - started,
      dropped, writeErrors, events, scripts: Object.fromEntries(scripts) }, safe, 2));
  }
  if (failure) throw failure;
}
try {
  stack = await startStack({ log: console.log });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(), args: ['--no-sandbox', '--mute-audio', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  for (lang of ['en', 'tr']) {
    const context = await browser.createBrowserContext();
    await context.overridePermissions(stack.url, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    page = await context.newPage(); await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument(language => localStorage.setItem('fairbeam.generalSettings', JSON.stringify({ language })), lang);
    await page.setRequestInterception(true);
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (req.method() === 'POST' && /^\/api\/(?:runs|sweeps|convergence|optimizations|research\/runs|render-jobs|native-document)(?:\/|$)/.test(path)) { forbidden.push(path); void req.abort(); }
      else void req.continue();
    });
    const s = session = new Session(page, { lang, scenario: 'ludwig', url: stack.url, artifactDirectory: out });
    const downloads = join(out, lang); await mkdir(downloads, { recursive: true });
    await (await page.createCDPSession()).send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await withStartupDiagnostics(page, { directory: join(out, `startup-${lang}`), stack }, async () => {
      await page.goto(stack.url, { waitUntil: 'domcontentloaded' }); await s.wait('.home', undefined, { timeout: 45000 });
    });
    await page.locator('input[name="home-template"][value="patch"]').click();
    await s.fill(await s.field(await s.T('home.newProject.name')), `Ludwig control ${lang}`, { blur: false });
    await s.click('home.newProject.create'); await s.wait('.rb');
    const openMonitors = async () => { await s.ev(async () => (await import('/src/designer/simSettingsState.ts')).openSimSettings('monitors')); await s.wait('.ss-dialog'); };
    await openMonitors();
    let setting = await s.field(await s.T('sim.mon.complexFields'));
    assert.equal(await setting.evaluate(e => e.checked), false); await setting.click();
    await s.click('sim.discard', { within: '.ss-dialog' });
    assert.equal(await s.store((_, m) => m.s.draft.far_field.complex_fields === true), false);
    await openMonitors(); setting = await s.field(await s.T('sim.mon.complexFields')); await setting.click();
    await s.click('common.ok', { within: '.ss-dialog' });
    await s.click('ribbon.tab.home', { sel: '.rb-tab' }); await s.click('common.save', { sel: '.rb-btn' });
    await s.waitFor(async () => { const m = await import('/src/designer/store.ts'); return !m.dirty() && !m.saving(); });
    const own = await s.store((_, m) => m.s.file());
    await page.reload({ waitUntil: 'domcontentloaded' }); await s.wait('.rb');
    assert.equal(await s.store((_, m) => m.s.draft.far_field.complex_fields), true);

    const importFile = join(out, `linear-${lang}.json`); await writeFile(importFile, JSON.stringify(fixture));
    await (await page.$('.app-header input[type=file]')).uploadFile(importFile);
    await s.wait('.dock [data-tab="pattern"]'); await s.clickSel('.dock [data-tab="pattern"]');
    await s.wait('.dock .ludwig-panel');
    const checkPanel = async scope => {
      const control = `${scope} input[name="ludwig-reference-deg"]`;
      const read = () => page.$$eval(`${scope} .ludwig-panel tbody tr:first-child td`, cells => cells.map(e => e.textContent.trim()));
      await s.fill(control, '0'); assert.deepEqual(await read(), ['10.00', '-50.00', '≥60']);
      await page.select(`${scope} select:has(option[value="co"])`, 'co');
      await s.fill(control, '90'); assert.deepEqual(await read(), ['-50.00', '10.00', '≤−60']);
      await s.fill(control, '45');
      const row = await read(); assert.equal(row[0], '6.99'); assert.equal(row[1], '6.99'); assert.equal(row[2], '0.00');
      await s.fill(control, ''); assert.equal(await page.$eval(control, e => e.value), '45', 'empty angle preserves explicit reference');
      await page.select(`${scope} [data-pattern-cut=kind]`, 'conical'); await s.fill(`${scope} [data-pattern-cut=angle]`, '60');
      await page.select(`${scope} [data-pattern-cut=projection]`, 'cartesian');
      await s.click('results.toolbar.copyData', { within: scope });
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      const table = copied.trimEnd().split(/\r?\n/).map(row => row.split('\t'));
      const reference = table[0].indexOf('Ludwig reference (deg)');
      assert.ok(reference >= 0 && table.length > 1); assert.ok(table.slice(1).every(row => Number(row[reference]) === 45));
      assert.ok(copied.includes('complex rotation before power'));
      const before = new Set(await readdir(downloads)); await s.click('results.toolbar.csvTitle', { within: scope, sel: 'button' });
      let name;
      for (let i = 0; i < 100; i++) { name = (await readdir(downloads)).find(f => !before.has(f) && f.endsWith('.csv')); if (name) break; await new Promise(r => setTimeout(r, 100)); }
      assert.ok(name, 'actual cut CSV download');
      assert.deepEqual(parseCsv((await readFile(join(downloads, name), 'utf8')).replace(/^\uFEFF/, '')), table);
      await page.select(`${scope} select:has(option[value="co"])`, 'xpd');
      await s.wait(`${scope} [data-pattern-metrics]`, await s.T('patternCuts.reason.quantity'));
      await page.select(`${scope} select:has(option[value="co"])`, 'co');
      assert.deepEqual(await page.evaluate(auditInPage, `${scope} .ludwig-panel`), []);
    };
    await checkPanel('.dock');
    // Verify actual scene mesh invalidation, not just its signal value.
    await page.click('.dock .freq-chips button'); await s.wait('.ff-card');
    await s.fill('.dock input[name="ludwig-reference-deg"]', '0');
    const mesh = () => page.evaluate(() => {
      const found = []; window.__fairbeam?.scene.traverse(o => { if (o.isMesh && o.material?.opacity === .88) found.push({ id: o.uuid, position: Array.from(o.geometry.attributes.position.array) }); });
      return found;
    });
    const beforeMesh = await mesh(); assert.equal(beforeMesh.length, 1);
    await s.fill('.dock input[name="ludwig-reference-deg"]', '90');
    await s.waitFor(id => { let changed = false; window.__fairbeam?.scene.traverse(o => { if (o.isMesh && o.material?.opacity === .88 && o.uuid !== id) changed = true; }); return changed; }, beforeMesh[0].id);
    assert.notDeepEqual((await mesh())[0].position, beforeMesh[0].position);
    await page.screenshot({ path: join(out, `${lang}-viewer.png`) });

    await s.click('header.screen.start', { within: '.mode-switch', exact: true }); await s.wait('.home');
    await s.ev(async id => { const s = await import('/src/designer/store.ts'); await s.openDesign(id); }, own.id);
    await s.click('header.screen.design', { within: '.mode-switch', exact: true });
    await s.wait('.rb');
    const bundle = structuredClone(fixture); bundle.model.id = own.design.model.id;
    const file = `${own.id}--ludwig.json`; await writeFile(join(stack.projects, file), JSON.stringify(bundle));
    const indexPath = join(stack.projects, 'index.json'), index = JSON.parse(await readFile(indexPath, 'utf8'));
    index.projects.push({ file, model: bundle.model.id, name: bundle.name, created: bundle.created, simulated: true, bands: [], params: [], cells: bundle.mesh.total_cells });
    index.updated = new Date().toISOString(); await writeFile(`${indexPath}.ludwig.tmp`, JSON.stringify(index)); await rename(`${indexPath}.ludwig.tmp`, indexPath);
    await s.ev(async (_, m) => { await m.st.loadIndex(); m.rr.ensureDesignRunBundles(); }, null, mods);
    await s.waitFor(async file => { const r = await import('/src/designer/runResults.ts'); return !!r.designRunBundle(file) || r.designRunBundleLoadState(file) === 'error'; }, file);
    assert.equal(await s.ev((file, m) => !!m.rr.designRunBundle(file), file, mods), true);
    await s.ev((file, m) => { m.dr.setDesignResult({ file, bundle: m.rr.designRunBundle(file) }); m.rf.focusResult({ file, view: 'pattern' }, 'main'); }, file, mods);
    await s.wait('.dw-result .ludwig-panel'); await checkPanel('.dw-result');
    for (const width of [1280, 768]) {
      await page.setViewport({ width, height: 1000 });
      const bounds = await page.$eval('.dw-result .ludwig-panel', e => ({ width: e.clientWidth, scroll: e.scrollWidth }));
      assert.ok(bounds.width > 150 && bounds.scroll <= bounds.width + 1, JSON.stringify(bounds));
      await page.screenshot({ path: join(out, `${lang}-designer-${width}.png`) });
    }
    const noFields = structuredClone(fixture); delete noFields.results.farfield[0].fields;
    const absent = join(out, `absent-${lang}.json`); await writeFile(absent, JSON.stringify(noFields));
    await observeMissingFields(async stage => {
      stage('upload-start');
      await (await page.$('.app-header input[type=file]')).uploadFile(absent);
      stage('upload-complete');
      await s.wait('.dock [data-tab="pattern"]');
      stage('pattern-tab-found');
      await s.clickSel('.dock [data-tab="pattern"]');
      stage('pattern-tab-clicked');
    });
    assert.equal(await page.$$eval('.dock .ludwig-panel', panels => panels.length), 0);
    assert.equal(await page.$eval('.dock select:has(option[value="co"]) option[value="co"]', e => e.disabled), true);
    assert.equal(await page.$eval('.dock select:has(option[value="co"])', e => e.value), 'directivity');
    assert.deepEqual(forbidden, []); assert.deepEqual(s.consoleIssues, []);
    outcomes.push({ lang, syntheticOnly: true, settingsDefaultOffDiscardSaveReload: true, viewerDesigner: true, referenceAngles: [0, 45, 90], clipboardAndCsv: true, sceneMeshRedraw: true, noFieldsRefusal: true, widths: [1280, 768] });
    await context.close();
  }
  await writeFile(join(out, 'result.json'), JSON.stringify({ outcomes, forbidden }, null, 2)); console.log(JSON.stringify({ out, outcomes }, null, 2));
} catch (error) {
  await writeFile(join(out, 'failure.json'), JSON.stringify({ error: String(error?.stack || error), lang, console: session?.consoleIssues, forbidden, outcomes, children: stack?.diagnostics() }, (_key, value) => typeof value === 'string' ? safeDiagnosticText(value) : value, 2));
  await bounded(() => page?.screenshot({ path: join(out, 'failure.png') }), 5000, 'failure screenshot').catch(() => {});
  throw error;
} finally { try { await browser?.close(); } finally { await stack?.stop(); } }
