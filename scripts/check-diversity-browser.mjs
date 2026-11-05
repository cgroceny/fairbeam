// Real viewer/Designer paths with explicitly synthetic passive S data. No solver jobs.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { startStack, chromePath, root } from './scenarios/stack.mjs';
import { Session } from './scenarios/harness.mjs';
import { withStartupDiagnostics, safeDiagnosticText } from './scenarios/startup-diagnostics.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' && process.env.FAIRBEAM_ALLOW_BROWSER_TEST !== '1')
  throw new Error('Browser test requires CI or explicit browser-test authorization.');
const out = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || join(tmpdir(), `fairbeam-diversity-${Date.now()}`), 'diversity');
await mkdir(out, { recursive: true });
const fixture = JSON.parse(await readFile(join(root, 'public/projects/dipole.json'), 'utf8'));
fixture.name = fixture.model.name = 'Synthetic MIMO identity control'; fixture.run = null;
fixture.ports = [7, 42, 99].map(number => ({ ...structuredClone(fixture.ports[0]), number, excite: true }));
const sampleCount = 803;
fixture.results = { frequency: Array.from({ length: sampleCount }, (_, i) => 1e9 + i * 1e6), ports: {}, bands: [], farfield: [],
  sparams: { ports: [1, 2, 3], port_numbers: [7, 42, 99], excited: [1, 2, 3], z_ref: [50, 50, 50], complete: true,
    method: 'B A^-1', s: Object.fromEntries([1, 2, 3].flatMap(i => [1, 2, 3].map(j => [`${i},${j}`, { re: Array(sampleCount).fill(i === j ? i / 10 : 0), im: Array(sampleCount).fill(0) }]))) } };
const mods = { st: '/src/state.ts', dr: '/src/runner/designRun.ts', rf: '/src/designer/resultFocus.ts', rr: '/src/designer/runResults.ts', ex: '/src/components/exportContext.ts' };
let stack, browser, page, session, lang;
const outcomes = [], forbidden = [];
try {
  stack = await startStack({ log: console.log });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(),
    args: ['--no-sandbox', '--mute-audio', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  for (lang of ['en', 'tr']) {
    const context = await browser.createBrowserContext();
    page = await context.newPage(); await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument(language => localStorage.setItem('fairbeam.generalSettings', JSON.stringify({ language })), lang);
    await page.setRequestInterception(true);
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && /^\/api\/(?:runs|sweeps|convergence|optimizations|research\/runs|render-jobs|native-document)(?:\/|$)/.test(path)) {
        forbidden.push(path); void request.abort();
      } else void request.continue();
    });
    const s = session = new Session(page, { lang, scenario: 'diversity', url: stack.url, artifactDirectory: out });
    const downloads = join(out, lang); await mkdir(downloads, { recursive: true });
    await (await page.createCDPSession()).send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await withStartupDiagnostics(page, { directory: join(out, `startup-${lang}`), stack }, async () => {
      await page.goto(stack.url, { waitUntil: 'domcontentloaded' }); await s.wait('.home', undefined, { timeout: 45000 });
    });
    const importFile = join(out, `synthetic-${lang}.json`); await writeFile(importFile, JSON.stringify(fixture));
    await (await page.$('.app-header input[type=file]')).uploadFile(importFile);
    await s.wait('.dock [data-tab="diversity"]'); await s.clickSel('.dock [data-tab="diversity"]');
    const panel = '.dock [data-result-diversity]'; await s.wait(`${panel} [data-mimo-real="7"]`);
    const firstPaint = await page.$eval(panel, element => ({ rows: element.querySelectorAll('[data-mimo-frequency]').length, cells: element.querySelectorAll('tbody td, tbody th').length, elements: element.querySelectorAll('*').length }));
    await writeFile(join(out, `${lang}-table-counts.json`), JSON.stringify(firstPaint, null, 2));
    assert.equal(firstPaint.rows, 50, 'Large stored-sample tables render one page');
    const observedFrequencies = [];
    for (let p = 0; p < Math.ceil(sampleCount / 50); p++) {
      const frequencies = await page.$$eval(`${panel} [data-mimo-frequency]`, rows => rows.map(row => Number(row.dataset.mimoFrequency)));
      assert.ok(frequencies.length > 0 && frequencies.length <= 50);
      observedFrequencies.push(...frequencies);
      if (p + 1 < Math.ceil(sampleCount / 50)) await s.clickSel(`${panel} [data-mimo-next]`);
    }
    assert.deepEqual(observedFrequencies, fixture.results.frequency, 'Every stored frequency is reachable once in order');
    assert.equal(await page.$eval(`${panel} [data-mimo-next]`, button => button.disabled), true);
    assert.equal(await page.$eval(`${panel} [data-mimo-last]`, button => button.disabled), true);
    await s.clickSel(`${panel} [data-mimo-previous]`);
    assert.equal(await page.$eval(`${panel} [data-mimo-frequency]`, row => Number(row.dataset.mimoFrequency)), fixture.results.frequency[750]);
    await s.clickSel(`${panel} [data-mimo-first]`);
    assert.equal(await page.$eval(`${panel} [data-mimo-previous]`, button => button.disabled), true);
    assert.deepEqual(await page.$$eval(`${panel} [data-mimo-pair] option`, options => options.map(o => o.value)), ['7,42', '7,99', '42,99']);
    await page.select(`${panel} [data-mimo-pair]`, '42,99');
    await s.fill(`${panel} [data-mimo-real="7"]`, '0');
    await s.fill(`${panel} [data-mimo-imag="42"]`, '-2,5');
    assert.equal(await page.$eval(`${panel} [data-mimo-imag="42"]`, input => input.value), '-2.5', 'Excitation entry normalizes comma decimals in both languages');
    await s.fill(`${panel} [data-mimo-imag="42"]`, '-2');
    assert.equal(await page.$eval(`${panel} [data-mimo-pair]`, select => select.value), '42,99', 'Weight edits preserve the displayed selected pair');
    await page.focus(`${panel} [data-mimo-last]`); await page.keyboard.press('Enter');
    assert.equal(await page.$$eval(`${panel} [data-mimo-frequency]`, rows => rows.length), 3, 'Last page is reachable with the keyboard');
    const before = new Set(await readdir(downloads)); await s.click('mimo.csv', { within: panel, sel: 'button', exact: true });
    let csvName;
    for (let i = 0; i < 100; i++) { csvName = (await readdir(downloads)).find(name => !before.has(name) && name.endsWith('.csv')); if (csvName) break; await new Promise(r => setTimeout(r, 100)); }
    assert.ok(csvName, 'Edited excitation CSV downloaded');
    const csv = await readFile(join(downloads, csvName), 'utf8');
    assert.match(csv, /P42 \/ P99/); assert.match(csv, /P7=0\+j\(0\); P42=1\+j\(-2\); P99=1\+j\(0\)/);
    assert.doesNotMatch(csv, /P7 \/ P42|NaN|Infinity/);
    assert.equal(csv.trim().split(/\r?\n/).length, 1 + sampleCount * 9, 'CSV keeps every frequency and all nine selected metrics');
    assert.ok(csv.includes(String(fixture.results.frequency.at(-1))), 'CSV includes the final page');
    await s.fill(`${panel} [data-mimo-real="7"]`, '1e');
    assert.equal(await page.$eval(`${panel} [data-mimo-real="7"]`, input => input.getAttribute('aria-invalid')), 'true');
    assert.equal(await page.$eval(`${panel} [data-mimo-frequency] td:nth-of-type(5)`, cell => cell.textContent.trim()), '—', 'Incomplete excitation is unavailable instead of zero');
    await s.fill(`${panel} [data-mimo-real="7"]`, '');
    assert.equal(await page.$eval(`${panel} [data-mimo-frequency] td:nth-of-type(5)`, cell => cell.textContent.trim()), '—');
    assert.ok(await page.$eval(`${panel} [data-mimo-frequency] td:nth-of-type(5)`, cell => !!cell.getAttribute('aria-label')));
    assert.equal(await page.$$eval('.dock .dock-tools .result-format, .dock .dock-copy', elements => elements.length), 0);
    assert.equal(await s.ev((_, m) => m.ex.contextualExportActions().some(a => a.id === 'result-touchstone' || a.id === 'result-csv'), null, mods), false);
    await page.screenshot({ path: join(out, `${lang}-viewer.png`) });

    // Replace the source while the same panel stays mounted on its last page.
    // 503 samples would clamp to page 11, so page 1 proves a reset, not a clamp.
    await page.$eval(panel, element => { element.dataset.testInstance = 'retained'; });
    const replacement = structuredClone(fixture);
    replacement.results.frequency = replacement.results.frequency.slice(0, 503).map(f => f + 1e9);
    for (const series of Object.values(replacement.results.sparams.s)) { series.re = series.re.slice(0, 503); series.im = series.im.slice(0, 503); }
    await s.ev((bundle, m) => m.st.openBundle(bundle, 'synthetic-replacement.json'), replacement, mods);
    assert.equal(await page.$eval(panel, element => element.dataset.testInstance), 'retained', 'The same diversity panel receives the replacement');
    assert.equal(await page.$eval(`${panel} [data-mimo-frequency]`, row => Number(row.dataset.mimoFrequency)), 2e9);
    assert.equal(await page.$eval(`${panel} [data-mimo-previous]`, button => button.disabled), true);
    assert.equal(await page.$eval(`${panel} [data-mimo-range]`, element => element.textContent), await s.T('mimo.sampleRange', { first: 1, last: 50, total: 503 }));
    assert.equal(await page.$eval(`${panel} [data-mimo-pair]`, select => select.value), '7,42');
    assert.equal(await page.$eval(`${panel} [data-mimo-real="7"]`, input => input.value), '1');
    assert.equal(await page.$eval(`${panel} [data-mimo-imag="42"]`, input => input.value), '0');
    await page.setViewport({ width: 768, height: 1000 });
    await page.$eval(`${panel} [data-mimo-range]`, element => element.scrollIntoView({ block: 'center' }));
    const pagingBounds = await page.$eval(`${panel} [data-mimo-range]`, element => { const group = element.parentElement; return { width: group.clientWidth, scroll: group.scrollWidth }; });
    assert.ok(pagingBounds.width > 200 && pagingBounds.scroll <= pagingBounds.width + 1, JSON.stringify(pagingBounds));
    await page.screenshot({ path: join(out, `${lang}-paging-768.png`) });
    await page.setViewport({ width: 1440, height: 1000 });
    replacement.results.frequency = replacement.results.frequency.slice(0, 3);
    for (const series of Object.values(replacement.results.sparams.s)) { series.re = series.re.slice(0, 3); series.im = series.im.slice(0, 3); }
    await s.ev((bundle, m) => m.st.openBundle(bundle, 'synthetic-small-replacement.json'), replacement, mods);
    assert.equal(await page.$eval(panel, element => element.dataset.testInstance), 'retained');
    assert.equal(await page.$$eval(`${panel} [data-mimo-frequency]`, rows => rows.length), 3);
    assert.equal(await page.$$eval(`${panel} [data-mimo-next]`, buttons => buttons.length), 0);

    // A new Designer run uses real project files/index admission and resets viewer edits.
    await s.click('header.screen.start', { within: '.mode-switch', exact: true }); await s.wait('.home');
    await page.locator('input[name="home-template"][value="patch"]').click();
    await s.fill(await s.field(await s.T('home.newProject.name')), `MIMO control ${lang}`, { blur: false });
    await s.click('home.newProject.create'); await s.wait('.rb');
    const own = await s.store((_, m) => m.s.file()), originalDesign = JSON.stringify(own.design);
    const a = structuredClone(fixture), b = structuredClone(fixture); a.model.id = b.model.id = own.design.model.id;
    a.results.frequency = a.results.frequency.slice(0, 3);
    for (const series of Object.values(a.results.sparams.s)) { series.re = series.re.slice(0, 3); series.im = series.im.slice(0, 3); }
    b.name = b.model.name = 'Synthetic partial MIMO refusal'; b.results.sparams.complete = false;
    const files = [`${own.id}--mimo-a.json`, `${own.id}--mimo-b.json`];
    for (const [i, data] of [a, b].entries()) await writeFile(join(stack.projects, files[i]), JSON.stringify(data));
    const indexPath = join(stack.projects, 'index.json'), index = JSON.parse(await readFile(indexPath, 'utf8'));
    // The synthetic fixtures have run:null, so the real writer would omit engine.
    // An invented CPU label would correctly fail immutable index identity admission.
    index.projects.push(...[a, b].map((bundle, i) => ({ file: files[i], model: bundle.model.id, name: bundle.name, created: bundle.created, simulated: true, bands: [], params: [], cells: bundle.mesh.total_cells })));
    index.updated = new Date().toISOString(); await writeFile(`${indexPath}.mimo.tmp`, JSON.stringify(index)); await rename(`${indexPath}.mimo.tmp`, indexPath);
    await s.ev(async (_, m) => { await m.st.loadIndex(); if (m.st.indexLoadError()) throw new Error(m.st.indexLoadError()); m.rr.ensureDesignRunBundles(); }, null, mods);
    await s.waitFor(async files => { const rr = await import('/src/designer/runResults.ts'); return files.some(file => rr.designRunBundleLoadState(file) === 'error') || files.every(file => !!rr.designRunBundle(file)); }, files);
    assert.deepEqual(await s.ev((files, m) => files.map(file => ({ file, loaded: !!m.rr.designRunBundle(file), state: m.rr.designRunBundleLoadState(file) ?? null })), files, mods), files.map(file => ({ file, loaded: true, state: null })));
    await s.ev((files, m) => { m.dr.setDesignResult({ file: files[0], bundle: m.rr.designRunBundle(files[0]) }); m.rf.focusResult({ file: files[0], view: 'diversity', compare: [files[1]] }, 'main'); }, files, mods);
    const designPanel = '.dw-result [data-result-diversity]'; await s.wait(`${designPanel} [data-mimo-real="7"]`);
    assert.equal(await page.$eval(`${designPanel} [data-mimo-real="7"]`, input => input.value), '1');
    assert.equal(await page.$eval(`${designPanel} [data-mimo-pair]`, select => select.value), '7,42');
    assert.equal(await page.$$eval(`${designPanel} [data-mimo-frequency]`, rows => rows.length), 3, 'Small replacement shows every sample');
    assert.equal(await page.$$eval(`${designPanel} [data-mimo-next]`, buttons => buttons.length), 0, 'Small tables do not expose redundant page controls');
    assert.equal(await page.$$eval('.dw-result-bar .rdk-compare-control, .dw-result-bar .result-format, .dw-result-bar .rdk-copy', elements => elements.length), 0);
    assert.equal(await s.ev((_, m) => m.ex.contextualExportActions().length, null, mods), 0);
    for (const width of [1280, 768]) {
      await page.setViewport({ width, height: 1000 });
      const geometry = await page.$eval(designPanel, element => ({ width: element.clientWidth, scroll: element.scrollWidth, tableWidth: element.querySelector('.mimo-table').clientWidth }));
      assert.ok(geometry.width > 200 && geometry.scroll <= geometry.width + 1, JSON.stringify(geometry));
      const overlaps = await page.$eval(designPanel, element => {
        const clip = element.closest('.dw-result-plot').getBoundingClientRect();
        const strips = [...document.querySelectorAll('.workspace.design-mode > .dw-strip')].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').map(e => e.getBoundingClientRect());
        return [...element.querySelectorAll('svg text, input, select, button')].filter(e => {
          const b = e.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && b.bottom > clip.top && b.top < clip.bottom && strips.some(s => Math.min(b.right, s.right) > Math.max(b.left, s.left) && Math.min(b.bottom, s.bottom, clip.bottom) > Math.max(b.top, s.top, clip.top));
        }).map(e => e.textContent || e.getAttribute('aria-label'));
      });
      assert.deepEqual(overlaps, [], 'Visible chart labels and controls clear compact side handles');
      await page.screenshot({ path: join(out, `${lang}-designer-${width}.png`) });
    }
    await s.ev((file, m) => m.rf.focusResult({ file, view: 'diversity' }, 'main'), files[1], mods);
    await s.wait(`${designPanel} .panel-empty`);
    assert.equal(await page.$$eval(`${designPanel} [data-mimo-frequency]`, rows => rows.length), 0);
    assert.equal(JSON.stringify(await s.store((_, m) => m.s.file().design)), originalDesign);
    assert.deepEqual(forbidden, []); assert.deepEqual(s.consoleIssues, []);
    outcomes.push({ lang, viewerAndDesigner: true, physicalPairAndWeights: true, csv: true, invalidWeights: true, partialRefusal: true, reset: true, sameComponentReplacement: true, oneRunWithComparisonPresent: true, responsive: [1280, 768], designUnchanged: true, syntheticOnly: true });
    await context.close();
  }
  await writeFile(join(out, 'result.json'), JSON.stringify({ outcomes, forbidden }, null, 2));
  console.log(JSON.stringify({ out, outcomes }, null, 2));
} catch (error) {
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  await writeFile(join(out, 'failure.json'), JSON.stringify({ error: String(error?.stack || error), lang, url: page?.url(), console: session?.consoleIssues, forbidden, outcomes, children: stack?.diagnostics() }, (_key, value) => typeof value === 'string' ? safeDiagnosticText(value) : value, 2));
  throw error;
} finally { try { await browser?.close(); } finally { await stack?.stop(); } }
