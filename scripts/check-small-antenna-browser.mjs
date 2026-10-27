// Real Designer UI/export paths on analytical RLC fixtures. No EM/native/renderer jobs.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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
const outcomes = [], forbidden = [];
try {
  stack = await startStack({ log: console.log });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(),
    args: ['--no-sandbox', '--mute-audio', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  for (lang of ['en', 'tr']) {
    const context = await browser.createBrowserContext();
    await context.overridePermissions(stack.url, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    page = await context.newPage(); await page.setViewport({ width: 1280, height: 1000 });
    await page.evaluateOnNewDocument(language => localStorage.setItem('fairbeam.generalSettings', JSON.stringify({ language })), lang);
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
    await writeFile(join(stack.projects, files[0]), JSON.stringify(a)); await writeFile(join(stack.projects, files[1]), JSON.stringify(b));
    await writeFile(join(stack.projects, files[2]), JSON.stringify(c));
    await s.ev(({ a, b, c, files }, m) => {
      m.st.setIndex([...m.st.index(), ...[a, b, c].map((bundle, i) => ({ file: files[i], model: bundle.model.id,
        name: bundle.name, created: bundle.created, simulated: true, bands: [], params: [] }))]);
      m.dr.setDesignResult({ file: files[0], bundle: a }); m.rr.ensureDesignRunBundles();
      m.rf.focusResult({ file: files[0], view: 'impedance' }, 'main');
    }, { a, b, c, files }, mods);
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
      assert.deepEqual(await page.evaluate(auditInPage, panel), []);
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
  await writeFile(join(out, 'result.json'), JSON.stringify({ outcomes, forbidden }, null, 2));
  console.log(JSON.stringify({ out, outcomes }, null, 2));
} catch (error) {
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  await writeFile(join(out, 'failure.json'), JSON.stringify({ error: String(error?.stack || error), lang, url: page?.url(),
    console: session?.consoleIssues, forbidden, outcomes, children: stack?.diagnostics() }, (_key, value) => typeof value === 'string' ? safeDiagnosticText(value) : value, 2));
  throw error;
} finally { try { await browser?.close(); } finally { await stack?.stop(); } }
