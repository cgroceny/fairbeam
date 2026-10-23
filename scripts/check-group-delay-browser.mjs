// Browser/UI acceptance test. Runs in remote CI; local execution requires the user's permission.
// Authored for #229; pure mathematical controls are in check-sparam-phase*.mjs.
// No solver. startStack uses the existing isolated scenario workspace.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { startStack, chromePath, root } from './scenarios/stack.mjs';
import { Session, auditInPage } from './scenarios/harness.mjs';
import { cleanupBrowserScenario } from './scenarios/cleanup-browser.mjs';

if (process.env.CI !== 'true' && process.env.FAIRBEAM_ALLOW_LOCAL_BROWSER !== '1') {
  throw new Error('Browser acceptance runs in CI; local use requires explicit user permission.');
}

const out = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || join(tmpdir(), `fairbeam-group-delay-${Date.now()}`));
await mkdir(out, { recursive: true });
const template = JSON.parse(await readFile(join(root, 'public/projects/patch-antenna.json'), 'utf8'));
const makeFixture = (name, shift = 0) => {
  const b = structuredClone(template), f = Array.from({ length: 41 }, (_, i) => 1 + shift + i * .05);
  const re = f.map(x => .5 * Math.cos(-2 * Math.PI * .6 * x));
  const im = f.map(x => .5 * Math.sin(-2 * Math.PI * .6 * x));
  b.name = b.model.name = `SYNTHETIC ${name}`; b.run = null;
  b.ports = [{...b.ports[0], number:7, excite:true}]; delete b.ports[0].reference_impedance;
  b.results.frequency = f.map(x => x * 1e9); b.results.bands = []; b.results.farfield = [];
  const denominator=re.map((r,i)=>(1-r)**2+im[i]**2);
  b.results.ports = { '7': { s11_re: re, s11_im: im,
    zin_re:re.map((r,i)=>50*(1-r*r-im[i]*im[i])/denominator[i]),
    zin_im:im.map((v,i)=>100*v/denominator[i]), z_ref:50 } };
  b.results.sparams = { ports: [1], port_numbers: [7], z_ref: [50], excited: [1], s: { '1,1': { re, im } } };
  return b;
};
const stack = await startStack({ log: console.log });
let browser;
let failed = false;
const outcomes = [];
async function visibleDelayPlot(page, scope, count) {
  const measured = await page.$eval(scope, node => {
    const svg = node.querySelector('svg'), frame = svg?.getBoundingClientRect();
    const paths = [...node.querySelectorAll('path.c-line')].map(path => {
      const d = path.getAttribute('d') ?? '', box = path.getBoundingClientRect();
      return { d, width: box.width, length: path.getTotalLength(),
        visible: !!frame && box.left >= frame.left - 1 && box.right <= frame.right + 1 && box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1 };
    });
    const ticks = [...node.querySelectorAll('text.c-tick[text-anchor="end"]')].map(tick => ({ text: tick.textContent, y: Number(tick.getAttribute('y')) }));
    return { paths, ticks };
  });
  assert.equal(measured.paths.length, count, `${scope}: all expected delay traces are plotted`);
  for (const p of measured.paths) {
    assert.ok(p.d.includes('L') && !/NaN|Infinity/.test(p.d), `${scope}: finite connected SVG path`);
    assert.ok(p.width > 20 && Number.isFinite(p.length) && p.length > 20 && p.visible, `${scope}: trace is visible inside the chart`);
  }
  assert.ok(measured.ticks.length >= 2 && measured.ticks.every(t => Number.isFinite(t.y) && !/NaN|Infinity/.test(t.text)), `${scope}: visible finite y-axis ticks`);
  return measured;
}
try {
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(), args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  for (const lang of ['en', 'tr']) {
    const context = await browser.createBrowserContext();
    await context.overridePermissions(stack.url, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    const page = await context.newPage();
    const blockedStarts = [];
    await page.setRequestInterception(true);
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      const job = /^\/api\/(?:runs|sweeps|convergence|optimizations|research\/runs|render-jobs)(?:\/|$)/.test(path);
      const native = /^\/api\/(?:native-document(?:\/|$)|(?:research\/elmer\/install|blender\/open-download|open-feedback|renders\/[A-Za-z0-9_-]+\/open)\/?$)/.test(path);
      if (req.method() === 'POST' && (job || native)) {
        blockedStarts.push(path); void req.abort();
      } else void req.continue();
    });
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument(language => localStorage.setItem('fairbeam.generalSettings', JSON.stringify({ language })), lang);
    const s = new Session(page, { lang, scenario: 'group-delay', url: stack.url });
    await page.goto(stack.url, { waitUntil: 'domcontentloaded' }); await s.wait('.home');
    await s.fill(await s.field(await s.T('home.newProject.name')), `Delay ${lang}`, { blur: false });
    await s.click('home.newProject.create'); await s.wait('.rb');
    const own = await s.store((_, m) => JSON.parse(JSON.stringify(m.s.file())));
    await s.click('header.screen.examples'); await s.wait('.example-picker-trigger');
    await page.locator('.example-picker-trigger').click(); await s.wait('.example-picker-pop input');
    await page.type('.example-picker-pop input', 'Inset'); await page.keyboard.press('Enter');
    await s.waitFor(async () => (await import('/src/state.ts')).source() === 'inset-patch.json');
    const current = makeFixture('Pure 0.6 ns delay'), reference = makeFixture('Reference 0.6 ns', .025);
    await s.ev((b, m) => {
      const valid=m.v.validateBundle(b); if(!valid.bundle) throw new Error(JSON.stringify(valid.errors));
      m.st.setBundle(valid.bundle); m.st.setDockTab('reflection');
    }, current, { st: '/src/state.ts',v:'/src/lib/validate.ts' });
    await page.select('.dock .result-format', 'gd');
    await s.wait('.dock .group-delay-aperture select');
    await page.select('.dock .group-delay-aperture select', '11');
    await s.waitFor(async () => (await import('/src/designer/resultDataPreference.ts')).groupDelayAperture() === 11);
    await s.wait('.dock .chart-phase-notes', await s.T('sparams.phaseAssumption'));
    await s.click('results.toolbar.copyData', { within: '.dock' }); await s.wait('.dock-copy.copied');
    const readRows = async () => (await page.evaluate(() => navigator.clipboard.readText())).trim().split(/\r?\n/).map(r => r.split('\t'));
    let rows = await readRows(); assert.equal(rows[0][1], 'τg S11 [P7] (ns)');
    assert.ok(await page.$eval('.dock .chart-stack', e => e.textContent.includes('S11 [P7]')), 'one-port plot preserves physical port identity like CSV');
    rows.slice(1).forEach(row => assert.ok(Math.abs(Number(row[1]) - .6) < 1e-10));
    await s.click('results.tab.table', { within: '.dock', sel: 'button' });
    await s.wait('.dock table', 'τg S11 [P7] (ns)');
    await s.click('results.tab.table', { within: '.dock', sel: 'button' });
    await page.select('.dock .result-format', 'phase_unwrapped');
    await s.gone('.dock .group-delay-aperture select');
    await page.evaluate(() => navigator.clipboard.writeText('waiting'));
    await s.click('results.toolbar.copyData', { within: '.dock' });
    await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes('Unwrapped'));
    rows = await readRows(); assert.ok(Math.abs(Number(rows.at(-1)[1]) - Number(rows[1][1])) > 360);

    // Comparison exercises the actual selector, chart, copy path and different native grids.
    await s.ev((b, m) => m.c.setPinned([{ file: 'ref:reference', bundle: { ...b, reference: { label: 'Reference 0.6 ns', phaseKnown: true } } }]), reference, { c: '/src/compare/store.ts' });
    await page.select('.dock .result-format', 'gd');
    await page.evaluate(() => navigator.clipboard.writeText('waiting'));
    await s.click('results.toolbar.copyData', { within: '.dock' });
    await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes('Reference 0.6 ns'));
    rows = await readRows(); assert.equal(rows[0].length, 3); assert.equal(rows[1][2], '');
    for (const row of rows.slice(1)) for (const value of row.slice(1)) if (value !== '') assert.ok(Math.abs(Number(value) - .6) < 1e-10);
    const examplesPlot = await visibleDelayPlot(page, '.dock .chart-stack', 2);
    await page.screenshot({ path: join(out, `examples-group-delay-${lang}.png`) });
    assert.deepEqual(await page.evaluate(auditInPage, '.dock .chart-stack'), []);
    await s.ev((_, m) => m.c.setPinned([]), null, { c: '/src/compare/store.ts' });

    // Designer uses the same one-port selection and aperture, including its copy/export options.
    await s.click('header.screen.design', { sel: '.mode-switch button' }); await s.wait('.rb');
    current.model.id = own.design.model.id; current.created = new Date().toISOString();
    const file = `${own.id}--phase-fixture.json`;
    await writeFile(join(stack.projects,file),JSON.stringify(current));
    await s.ev(({ b, file }, m) => {
      const valid=m.v.validateBundle(b); if(!valid.bundle) throw new Error(JSON.stringify(valid.errors));
      m.st.setIndex([...m.st.index().filter(r => r.file !== file), { file, model: b.model.id, name: b.name, created: b.created, simulated: true, bands: [], params: [] }]);
      m.dr.setDesignResult({ file, bundle: valid.bundle });
      m.rf.focusResult({ file, view: 'sparams' }, 'main');
    }, { b: current, file }, { st: '/src/state.ts', dr: '/src/runner/designRun.ts', rf: '/src/designer/resultFocus.ts',v:'/src/lib/validate.ts' });
    await s.wait('.dw-result .result-format'); await page.select('.dw-result .result-format', 'gd');
    await s.wait('.dw-result .group-delay-aperture select');
    assert.equal(await page.$eval('.dw-result .group-delay-aperture select', e => e.value), '11');
    await page.select('.dw-result .group-delay-aperture select', '5');
    await page.evaluate(() => navigator.clipboard.writeText('waiting'));
    await s.click('results.toolbar.copyData', { within: '.dw-result' });
    await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes('τg S11'));
    rows = await readRows(); rows.slice(1).forEach(row => assert.ok(Math.abs(Number(row[1]) - .6) < 1e-10));
    const designerPlot = await visibleDelayPlot(page, '.dw-result .chart-stack', 1);
    await page.screenshot({ path: join(out, `designer-group-delay-${lang}.png`) });
    assert.deepEqual(await page.evaluate(auditInPage, '.dw-result .chart-stack'), []);
    assert.deepEqual(blockedStarts, [], 'post-processing never starts solver, study or render work');
    outcomes.push({ lang, examples: true, designer: true, comparison: true, table: true, clipboard: true, aperture: true, examplesPlot, designerPlot, attemptedStarts: blockedStarts });
    await context.close();
  }
  await writeFile(join(out, 'result.json'), JSON.stringify(outcomes, null, 2));
  console.log(JSON.stringify({ out, outcomes }, null, 2));
} catch (error) {
  failed = true;
  throw error;
} finally { await cleanupBrowserScenario(browser, stack, failed); }
