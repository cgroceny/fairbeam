// Real Designer UI/export paths on analytical RLC fixtures. No EM/native/renderer jobs.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { startStack, chromePath } from './scenarios/stack.mjs';
import { Session, auditInPage } from './scenarios/harness.mjs';
import { withStartupDiagnostics, safeDiagnosticText } from './scenarios/startup-diagnostics.mjs';
import { smallAntennaFixture, parseDelimited } from './scenarios/small-antenna-fixture.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' && process.env.FAIRBEAM_ALLOW_BROWSER_TEST !== '1')
  throw new Error('Browser test requires CI or explicit browser-test authorization.');
const out = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || join(tmpdir(), `fairbeam-small-antenna-${Date.now()}`), 'small-antenna');
await mkdir(out, { recursive: true });
const mods = { a: '/src/designer/smallAntennaSession.ts', math: '/src/lib/smallAntenna.ts', st: '/src/state.ts',
  dr: '/src/runner/designRun.ts', rf: '/src/designer/resultFocus.ts', rr: '/src/designer/runResults.ts',
  pp: '/src/designer/portProcessingSession.ts', data: '/src/designer/resultData.ts', locale: '/src/i18n/index.ts' };
let stack, browser, page, session, lang;
const outcomes = [], forbidden = [], projectReads = [], projectReadTasks = [], layouts = [];

// Measure visible glyphs and controls, not just their containing panel's overflow.
function edgeHandleLayout(selector) {
  const panel = document.querySelector(selector), result = panel.closest('.dw-result');
  const box = rect => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  const resultRect = result.getBoundingClientRect(), bodyRect = panel.closest('.rs').getBoundingClientRect();
  const toolbar = result.querySelector('.dw-result-bar')?.getBoundingClientRect();
  const clip = { left: Math.max(0, resultRect.left, bodyRect.left), right: Math.min(innerWidth, resultRect.right, bodyRect.right),
    top: Math.max(0, resultRect.top, bodyRect.top, toolbar?.bottom ?? 0), bottom: Math.min(innerHeight, resultRect.bottom, bodyRect.bottom) };
  const visible = rect => {
    const clipped = { left: Math.max(rect.left, clip.left), right: Math.min(rect.right, clip.right),
      top: Math.max(rect.top, clip.top), bottom: Math.min(rect.bottom, clip.bottom) };
    return clipped.right > clipped.left && clipped.bottom > clipped.top ? clipped : null;
  };
  const strips = [...document.querySelectorAll('.workspace.design-mode > .dw-strip')]
    .filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
    .map(element => ({ side: element.classList.contains('dw-strip-left') ? 'left' : 'right', rect: box(element.getBoundingClientRect()) }));
  const text = [...panel.querySelectorAll('dt, .mono, label > span, summary')].flatMap(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const metric = element.closest('[data-small-metric]')?.dataset.smallMetric ?? (element.tagName === 'DT' ? 'label' : null);
    return [...range.getClientRects()].map(visible).filter(Boolean).map(rect => ({ kind: 'text', metric,
      label: element.textContent.trim().slice(0, 100), rect }));
  });
  const controls = [...panel.querySelectorAll('input, select, button')].flatMap(element => {
    const rect = visible(element.getBoundingClientRect());
    return rect ? [{ kind: 'control', label: element.id || element.textContent.trim(), rect }] : [];
  });
  const overlapY = (a, b) => Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
  const collisions = strips.flatMap(strip => [...text, ...controls].filter(item => overlapY(item.rect, strip.rect) &&
    Math.min(item.rect.right, strip.rect.right) > Math.max(item.rect.left, strip.rect.left))
    .map(item => ({ side: strip.side, ...item })));
  return { strips, text, controls, collisions, alignedMetrics: strips.map(strip => ({ side: strip.side,
    count: text.filter(item => item.metric && overlapY(item.rect, strip.rect)).length })), clip,
    heading: box(panel.querySelector('.small-antenna-panel > summary').getBoundingClientRect()),
    ka: box(panel.querySelector('[data-small-metric="ka"] .mono').getBoundingClientRect()) };
}

try {
  stack = await startStack({ log: console.log });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(),
    args: ['--no-sandbox', '--mute-audio', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  for (lang of ['en', 'tr']) {
    const context = await browser.createBrowserContext();
    await context.overridePermissions(stack.url, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    page = await context.newPage(); await page.setViewport({ width: 1280, height: 1000 });
    await page.evaluateOnNewDocument(language => localStorage.setItem('fairbeam.generalSettings', JSON.stringify({ language })), lang);
    const fixturePaths = new Set(), language = lang;
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (!fixturePaths.has(path)) return;
      const record = { lang: language, path, status: response.status(), contentType: response.headers()['content-type'] ?? '' };
      projectReads.push(record);
      projectReadTasks.push(response.text().then(body => {
        try { const data = JSON.parse(body); record.json = { model: data.model?.id, created: data.created, name: data.name }; }
        catch { record.bodyError = 'not JSON'; record.prefix = body.slice(0, 160); }
      }, error => { record.bodyError = String(error); }));
    });
    page.on('requestfailed', request => {
      const path = new URL(request.url()).pathname;
      if (fixturePaths.has(path)) projectReads.push({ lang: language, path, requestError: request.failure()?.errorText ?? 'unknown' });
    });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && /^\/api\/(?:runs|sweeps|convergence|optimizations|research\/runs|render-jobs|native-document)(?:\/|$)/.test(path)) {
        forbidden.push(path); void request.abort();
      } else void request.continue();
    });
    const s = session = new Session(page, { lang, scenario: 'small-antenna', url: stack.url, artifactDirectory: out });
    const downloads = join(out, lang); await mkdir(downloads, { recursive: true });
    await (await page.createCDPSession()).send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await withStartupDiagnostics(page, { directory: join(out, `startup-${lang}`), stack }, async () => {
      await page.goto(stack.url, { waitUntil: 'domcontentloaded' }); await s.wait('.home', undefined, { timeout: 45000 });
    });
    await page.locator('input[name="home-template"][value="patch"]').click();
    await s.fill(await s.field(await s.T('home.newProject.name')), `Small antenna control ${lang}`, { blur: false });
    await s.click('home.newProject.create'); await s.wait('.rb');
    const own = await s.store((_, m) => m.s.file()), designBefore = JSON.stringify(own.design);
    const a = smallAntennaFixture(), b = smallAntennaFixture({ f0: 1.2e9, q: 30, scale: 2, name: 'Synthetic second RLC run' });
    const c = smallAntennaFixture({ multiple: true, name: 'Synthetic two-crossing image control' });
    c.half_space = { axis: 'z', side: 'min', position: -0.2, kind: 'PEC' }; c.solver.boundaries['z-'] = 'PEC';
    a.model.id = b.model.id = c.model.id = own.design.model.id;
    const files = [`${own.id}--small-a.json`, `${own.id}--small-b.json`, `${own.id}--small-c.json`];
    files.forEach(file => fixturePaths.add(`/projects/${encodeURIComponent(file)}`));
    await writeFile(join(stack.projects, files[0]), JSON.stringify(a)); await writeFile(join(stack.projects, files[1]), JSON.stringify(b));
    await writeFile(join(stack.projects, files[2]), JSON.stringify(c));
    // Publish the same index identity the real writer gives these CPU fixtures. The app reads
    // this temp index normally; no partial in-memory entry or metadata retry hides a failed read.
    const entries = [a, b, c].map((bundle, i) => ({ file: files[i], model: bundle.model.id, name: bundle.name,
      created: bundle.created, simulated: true, bands: [], params: [], cells: bundle.mesh.total_cells, engine: 'CPU' }));
    const indexPath = join(stack.projects, 'index.json'), fixtureIndex = JSON.parse(await readFile(indexPath, 'utf8'));
    fixtureIndex.projects = [...fixtureIndex.projects.filter(entry => !files.includes(entry.file)), ...entries];
    fixtureIndex.updated = new Date().toISOString();
    await writeFile(`${indexPath}.small-antenna.tmp`, JSON.stringify(fixtureIndex));
    await rename(`${indexPath}.small-antenna.tmp`, indexPath);
    await s.ev(async (entries, m) => {
      const index = await m.st.loadIndex();
      if (m.st.indexLoadError()) throw new Error(`Fixture index failed: ${m.st.indexLoadError()}`);
      for (const expected of entries) {
        const actual = index.find(entry => entry.file === expected.file);
        if (!actual || Object.keys(expected).some(key => JSON.stringify(actual[key]) !== JSON.stringify(expected[key])))
          throw new Error(`Fixture index identity differs: ${expected.file}`);
      }
      m.rr.ensureDesignRunBundles();
    }, entries, mods);
    await s.waitFor(async files => {
      const m = await import('/src/designer/runResults.ts');
      return files.some(file => m.designRunBundleLoadState(file) === 'error') || files.every(file => !!m.designRunBundle(file));
    }, files, { what: 'all three synthetic bundles admitted, or an explicit read error' });
    const admission = await s.ev((files, m) => files.map(file => ({ file, state: m.rr.designRunBundleLoadState(file) ?? null,
      model: m.rr.designRunBundle(file)?.model.id, created: m.rr.designRunBundle(file)?.created,
      name: m.rr.designRunBundle(file)?.name })), files, mods);
    await Promise.allSettled(projectReadTasks);
    assert.deepEqual(admission, entries.map(entry => ({ file: entry.file, state: null, model: entry.model,
      created: entry.created, name: entry.name })), `Fixture read admission failed: ${JSON.stringify(projectReads)}`);
    await s.ev((files, m) => {
      m.dr.setDesignResult({ file: files[0], bundle: m.rr.designRunBundle(files[0]) });
      m.rf.focusResult({ file: files[0], view: 'impedance' }, 'main');
    }, files, mods);
    const panel = '.dw-result [data-small-antenna]';
    const openPanel = async () => {
      await s.wait(panel);
      if (!await page.$eval(`${panel} > details`, element => element.open)) await s.clickSel(`${panel} > details > summary`);
    };
    const state = () => s.ev((_, m) => {
      const a = m.a.designerSmallAntenna, run = m.dr.designResult();
      return { file: run?.file, owned: a.source() === m.pp.displayedPortResult(run?.bundle), options: a.options(),
        analysis: a.analysis(), revision: a.revision(), invalid: a.invalidVswr(), editable: a.editable() };
    }, null, mods);
    await openPanel();
    let current = await state();
    assert.ok(current.owned); assert.ok(Math.abs(current.analysis.q.qz - 20) < 0.01);
    assert.equal(current.analysis.provenance.port, 7); assert.equal(current.analysis.efficiency.value, 0.8);
    await s.fill(`${panel} [data-small-vswr]`, '1.5');
    await s.clickSel(`${panel} .small-antenna-geometry > summary`);
    await page.focus(`${panel} [data-small-part="1"]`); await page.keyboard.press('Space');
    current = await state(); assert.deepEqual(current.options.selectedPartIndices, [0]);
    assert.equal(current.analysis.geometry.radiusM, 0.0025); assert.equal(current.options.vswr, 1.5);
    const selectedAnalysis = current.analysis, revision = current.revision;
    await s.ev((_, m) => m.rr.showView('summary', undefined, 'main'), null, mods); await openPanel();
    assert.equal((await state()).revision, revision); assert.equal((await state()).analysis.q.qz, selectedAnalysis.q.qz);
    assert.equal((await state()).options.vswr, 1.5);
    const visibleQ = await page.$eval(`${panel} [data-small-metric="qz"] .mono`, element => element.textContent.trim());
    const expectedQ = await s.ev((_, m) => m.locale.fmt.num(m.a.designerSmallAntenna.analysis().q.qz, 4), null, mods);
    assert.equal(visibleQ, expectedQ);

    await s.click('results.toolbar.copyData', { within: '.dw-result' }); await s.wait('.dw-result .rdk-copy.copied');
    const copied = parseDelimited(await page.evaluate(() => navigator.clipboard.readText()), '\t');
    assert.equal(copied.length, 2);
    const expected = await s.ev((_, m) => m.math.smallAntennaColumns(m.a.designerSmallAntenna.analysis()), null, mods);
    expected.header.forEach((name, i) => {
      const column = copied[0].indexOf(name); assert.ok(column >= 0, name);
      assert.equal(copied[1][column], expected.row[i] == null ? '' : String(expected.row[i]), name);
    });
    const previous = new Set(await readdir(downloads));
    await s.click('results.toolbar.csvTitle', { within: '.dw-result', sel: 'button' });
    let csvName;
    for (let i = 0; i < 100; i++) { csvName = (await readdir(downloads)).find(name => !previous.has(name) && name.endsWith('.csv')); if (csvName) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.ok(csvName, 'Summary CSV downloaded');
    const csv = await readFile(join(downloads, csvName), 'utf8'); assert.equal(csv.charCodeAt(0), 0xfeff);
    assert.deepEqual(parseDelimited(csv), copied);
    await writeFile(join(out, `${lang}-summary.tsv`), await page.evaluate(() => navigator.clipboard.readText()));

    // Invalid numeric drafts remain visible and cannot export a stale valid bandwidth.
    await s.fill(`${panel} [data-small-vswr]`, '', { blur: false });
    assert.ok((await state()).invalid); assert.equal((await state()).analysis.bandwidth.predicted.hz, null);
    assert.equal(await page.$eval(`${panel} [data-small-vswr]`, element => element.getAttribute('aria-invalid')), 'true');
    await s.fill(`${panel} [data-small-vswr]`, '1.5');
    // Two mounted surfaces never reuse label/description IDs or change owned choices.
    const ids = await s.ev(async (_, m) => {
      return (await import('/scripts/scenarios/small-antenna-id-control.tsx')).checkSmallAntennaPanelIds(m.a.designerSmallAntenna);
    }, null, mods);
    assert.ok(ids.count > 0); assert.equal(ids.count, ids.unique); assert.equal((await state()).options.vswr, 1.5);

    for (const width of [1280, 768]) {
      await page.setViewport({ width, height: 1000 });
      await page.evaluate(async selector => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const panel = document.querySelector(selector), scroll = panel.closest('.rs'), result = panel.closest('.dw-result');
        const toolbar = result.querySelector('.dw-result-bar').getBoundingClientRect();
        scroll.scrollTop += panel.querySelector('.small-antenna-panel > summary').getBoundingClientRect().top -
          Math.max(scroll.getBoundingClientRect().top, toolbar.bottom) - 8;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, panel);
      assert.deepEqual(await page.evaluate(auditInPage, panel), []);
      const layout = await page.evaluate(edgeHandleLayout, panel); layouts.push({ lang, width, ...layout });
      assert.deepEqual(layout.collisions, [], `${lang}/${width}: actual panel glyph/control intersection with an edge handle`);
      assert.ok(layout.heading.top >= layout.clip.top - 0.5 && layout.heading.bottom <= layout.clip.bottom,
        `${lang}/${width}: panel heading is visible below the toolbar`);
      assert.ok(layout.ka.top >= layout.clip.top && layout.ka.bottom <= layout.clip.bottom,
        `${lang}/${width}: ka digits are visible with the panel heading`);
      if (width === 768) {
        assert.deepEqual(layout.strips.map(strip => strip.side).sort(), ['left', 'right']);
        assert.ok(layout.alignedMetrics.every(item => item.count > 0), 'both handles are vertically aligned with actual metric text');
      }
      const readsBeforeCapture = await s.ev((files, m) => files.map(file => ({ file,
        loaded: !!m.rr.designRunBundle(file), state: m.rr.designRunBundleLoadState(file) ?? null })), files, mods);
      assert.deepEqual(readsBeforeCapture, files.map(file => ({ file, loaded: true, state: null })));
      await page.screenshot({ path: join(out, `${lang}-${width}-summary.png`) });
    }
    await page.setViewport({ width: 1280, height: 1000 });
    // Comparison retains the current selection only for its source. Other runs use defaults.
    await s.ev(files => import('/src/designer/resultFocus.ts').then(m => m.focusResult({ file: files[0], view: 'summary', compare: [files[1]] }, 'main')), files);
    await s.wait('.dw-result [data-small-comparison]');
    await s.waitFor(async () => (await import('/src/designer/runResults.ts')).comparisonReady());
    assert.equal((await state()).editable, false); assert.equal((await state()).options.vswr, 1.5);
    const compareColumns = await s.ev((files, m) => {
      const run = m.dr.designResult(), others = m.rr.comparedRuns(), all = [run, ...others].map(item => ({ ...item, bundle: m.pp.displayedPortResult(item.bundle) }));
      const snapshots = all.map(item => m.a.designerSmallAntenna.snapshot(item.bundle, item.file));
      return snapshots.map(snapshot => ({ file: snapshot.file, selection: snapshot.selection, vswr: snapshot.analysis.bandwidth.vswr,
        qz: snapshot.analysis.q.qz, radius: snapshot.analysis.geometry.radiusM }));
    }, files, mods);
    assert.equal(compareColumns[0].vswr, 1.5); assert.equal(compareColumns[1].vswr, 2);
    assert.ok(Math.abs(compareColumns[1].qz - 30) < 0.01); assert.notEqual(compareColumns[0].radius, compareColumns[1].radius);
    await s.ev((file, m) => m.rf.focusResult({ file, view: 'impedance' }, 'main'), files[0], mods); await openPanel();
    assert.equal((await state()).options.vswr, 1.5);
    await s.click('results.toolbar.copyData', { within: '.dw-result' }); await s.wait('.dw-result .rdk-copy.copied');
    const impedance = parseDelimited(await page.evaluate(() => navigator.clipboard.readText()), '\t');
    assert.equal(impedance.length - 1, a.results.frequency.length);
    expected.header.forEach((name, i) => assert.equal(impedance[1][impedance[0].indexOf(name)], expected.row[i] == null ? '' : String(expected.row[i]), name));

    // A displayed reference-plane change is rejected; original metrics cannot remain behind it.
    await s.ev((_, m) => { const run = m.dr.designResult(); const error = m.pp.portProcessingSession.apply(run.bundle, { referenceOhm: 75, delayPs: { 7: 10 } }); if (error) throw new Error(error); }, null, mods);
    assert.equal((await state()).analysis.reason, 'projected-plane'); assert.equal((await state()).analysis.q.qz, null);
    await s.wait(panel, await s.T('smallAntenna.reason.projected-plane'));
    await s.ev((_, m) => m.pp.portProcessingSession.reset(m.dr.designResult().bundle), null, mods);
    assert.equal((await state()).options.vswr, 2); assert.deepEqual((await state()).options.selectedPartIndices, [0, 1]);
    // Pending replacement of the same filename retains no active analysis or data action.
    await s.ev((file, m) => m.dr.setDesignResultLoading(file), files[0], mods);
    assert.equal((await state()).analysis, null);
    const enabledCopy = await page.$$eval('.dw-result .rdk-copy', elements => elements.some(element => !element.disabled));
    assert.equal(enabledCopy, false);
    await s.ev((_, m) => m.dr.setDesignResultLoading(null), null, mods); await openPanel();
    await s.ev((file, m) => m.rf.focusResult({ file, view: 'summary' }, 'main'), files[1], mods);
    await s.waitFor(async file => (await import('/src/runner/designRun.ts')).designResult()?.file === file, files[1]);
    await openPanel(); assert.ok(Math.abs((await state()).analysis.q.qz - 30) < 0.01);
    assert.equal((await state()).options.vswr, 2); assert.deepEqual((await state()).options.selectedPartIndices, [0, 1]);
    await s.ev((file, m) => m.rf.focusResult({ file, view: 'summary' }, 'main'), files[2], mods);
    await s.waitFor(async file => (await import('/src/runner/designRun.ts')).designResult()?.file === file, files[2]);
    await openPanel(); current = await state();
    assert.equal(current.analysis.reason, 'choose-resonance'); assert.equal(current.analysis.q.qz, null);
    const chosen = current.analysis.candidates.filter(candidate => candidate.available)[1]; assert.ok(chosen);
    await page.select(`${panel} [data-small-resonance]`, chosen.id);
    current = await state(); assert.equal(current.analysis.selectedCandidateId, chosen.id);
    assert.ok(Math.abs(current.analysis.q.f0Hz - 1.04e9) < 1);
    assert.equal(current.analysis.geometry.enclosure, 'pec-image'); assert.equal(current.analysis.geometry.planeM, -0.0002);
    assert.equal(current.analysis.reference.ratio, null); assert.equal(current.analysis.reference.ratioReason, 'image-reference');
    assert.equal(current.analysis.efficiency.value, null, 'a nearby efficiency sample cannot be borrowed');
    await s.clickSel(`${panel} .small-antenna-geometry > summary`);
    await page.select(`${panel} [data-small-enclosure]`, 'finite');
    assert.equal((await state()).analysis.reference.ratio, null, 'finite selection cannot erase a PEC boundary');
    const currentDesign = await s.store((_, m) => m.s.file().design); assert.equal(JSON.stringify(currentDesign), designBefore);
    assert.deepEqual(forbidden, []); assert.deepEqual(s.consoleIssues, []);
    outcomes.push({ lang, syntheticOnly: true, q: 20, sparsePort: 7, sharedViews: true, selection: true,
      copyCsv: true, fullPrecision: true, invalidDraft: true, uniqueIds: true, responsive: [1280, 768],
      independentCompare: true, projectedPlaneRejected: true, pendingReset: true, runReset: true,
      explicitResonance: true, imageConvention: true, missingExactEfficiency: true, designUnchanged: true });
    await context.close();
  }
  await Promise.allSettled(projectReadTasks);
  await writeFile(join(out, 'result.json'), JSON.stringify({ outcomes, forbidden, projectReads, layouts }, null, 2));
  console.log(JSON.stringify({ out, outcomes }, null, 2));
} catch (error) {
  await Promise.allSettled(projectReadTasks);
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  await writeFile(join(out, 'failure.json'), JSON.stringify({ error: String(error?.stack || error), lang, url: page?.url(),
    console: session?.consoleIssues, forbidden, outcomes, projectReads, layouts, children: stack?.diagnostics() }, (_key, value) => typeof value === 'string' ? safeDiagnosticText(value) : value, 2));
  throw error;
} finally { try { await browser?.close(); } finally { await stack?.stop(); } }
