// Authored UI acceptance; remote CI only unless the user expressly permits a local browser.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { startStack, chromePath, root } from './scenarios/stack.mjs';
import { Session, auditInPage } from './scenarios/harness.mjs';
import { cleanupBrowserScenario } from './scenarios/cleanup-browser.mjs';
if (process.env.CI !== 'true' && process.env.FAIRBEAM_ALLOW_LOCAL_BROWSER !== '1') throw new Error('Local browser requires explicit user permission.');
const out = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || join(tmpdir(), `fairbeam-matching-${Date.now()}`));
await mkdir(out, { recursive: true });
const template = JSON.parse(await readFile(join(root, 'public/projects/patch-antenna.json'), 'utf8'));
const fixture = () => {
  const b = structuredClone(template), f = Array.from({ length: 41 }, (_, i) => (1 + i * .05) * 1e9);
  b.name = b.model.name = 'SYNTHETIC analytical 25 ohm load'; b.run = null;
  b.ports = [{ ...b.ports[0], number: 7, excite: true }];
  delete b.ports[0].reference_impedance;
  b.results.frequency = f; b.results.bands = []; b.results.farfield = [];
  const re = f.map(() => -1/3), im = f.map(() => 0);
  b.results.ports = { '7': { z_ref: 50, s11_re: re, s11_im: im, zin_re: f.map(() => 25), zin_im: im } };
  b.results.sparams = { ports: [1], port_numbers: [7], z_ref: [50], excited: [1], s: { '1,1': { re, im } } };
  return b;
};
let stack, browser, activePage;
let failed = false;
const results = [];
try {
  stack = await startStack({ log: console.log });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(), args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  for (const lang of ['en', 'tr']) {
    const context = await browser.createBrowserContext(), page = activePage = await context.newPage();
    const starts = [];
    await page.setRequestInterception(true);
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      const job = /^\/api\/(?:runs|sweeps|convergence|optimizations|research\/runs|render-jobs)(?:\/|$)/.test(path);
      const native = /^\/api\/(?:native-document(?:\/|$)|(?:research\/elmer\/install|blender\/open-download|open-feedback|renders\/[A-Za-z0-9_-]+\/open)\/?$)/.test(path);
      if (req.method() === 'POST' && (job || native)) { starts.push(path); void req.abort(); }
      else void req.continue();
    });
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument(language => localStorage.setItem('fairbeam.generalSettings', JSON.stringify({ language })), lang);
    const s = new Session(page, { lang, scenario: 'matching', url: stack.url });
    await page.goto(stack.url, { waitUntil: 'domcontentloaded' }); await s.wait('.home');
    await s.fill(await s.field(await s.T('home.newProject.name')), `Matching ${lang}`, { blur: false });
    await s.click('home.newProject.create'); await s.wait('.rb');
    const own = await s.store((_, m) => JSON.parse(JSON.stringify(m.s.file())));
    const b = fixture(); b.model.id = own.design.model.id;
    const file = `${own.id}--matching-fixture.json`;
    const show = async (view, next = b) => {
      const saved = {...next, created:new Date().toISOString()};
      await writeFile(join(stack.projects,file),JSON.stringify(saved));
      await s.ev(({ b, file, view }, m) => {
        const valid=m.v.validateBundle(b); if(!valid.bundle) throw new Error(JSON.stringify(valid.errors));
        m.st.setIndex([...m.st.index().filter(r => r.file !== file), { file, model: b.model.id, name: b.name, created: b.created, simulated: true, bands: [], params: [] }]);
        m.dr.setDesignResult({ file, bundle: valid.bundle }); m.rf.focusResult({ file, view }, 'main');
      }, { b: saved, file, view }, { st: '/src/state.ts', dr: '/src/runner/designRun.ts', rf: '/src/designer/resultFocus.ts',v:'/src/lib/validate.ts' });
    };
    await show('impedance'); await s.wait('.dw-result .matching-enable input');
    await s.wait('.matching-panel', 'P7');
    assert.equal(await page.$eval('.matching-enable input', e => e.checked), false);
    await page.locator('.matching-enable input').click(); await s.wait('.matching-field select');
    await page.select('.matching-field select', 'shunt-input:1');
    await s.wait('[data-matching-components]', 'nH'); await s.wait('[data-matching-components]', 'pF');
    assert.equal(await page.$$eval('.matching-chart path.c-line', es => es.filter(e => e.getAttribute('d')).length), 2);
    await s.fill('[data-matching-sample]','21');
    await s.wait('[data-matching-frequency]', '2');
    await page.select('.matching-field select', 'quarter-wave');
    await s.wait('[data-matching-components]', '90°');
    await page.screenshot({ path: join(out, `matching-impedance-${lang}.png`) });
    assert.deepEqual(await page.evaluate(auditInPage, '.matching-panel'), []);
    await show('smith'); await s.wait('.matching-enable input');
    assert.equal(await page.$eval('.matching-enable input', e => e.checked), false, 'view changes reset what-if state');
    await page.locator('.matching-enable input').click(); await s.wait('.matching-chart');
    assert.equal(await page.$$eval('.rdk-split > .chart path.c-line', es => es.filter(e => e.getAttribute('d')).length), 2, 'Smith contains original and ideal traces');
    const ownScroll = await page.$eval('.matching-panel', async panel => {
      const side = panel.closest('.rdk-side'); side.scrollTop = side.scrollHeight;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const bounds = side.getBoundingClientRect(), chart = panel.querySelector('.matching-chart').getBoundingClientRect();
      const note = panel.lastElementChild.getBoundingClientRect();
      return { scrollTop: side.scrollTop, scrollHeight: side.scrollHeight, clientHeight: side.clientHeight,
        chartVisible: chart.top >= bounds.top - 1 && chart.bottom <= bounds.bottom + 1,
        finalNoteVisible: note.top >= bounds.top - 1 && note.bottom <= bounds.bottom + 1,
        paths: [...panel.querySelectorAll('.matching-chart path.c-line')].map(p => ({ d: p.getAttribute('d'), width: p.getBoundingClientRect().width })) };
    });
    assert.ok(ownScroll.scrollTop > 0 && ownScroll.scrollHeight > ownScroll.clientHeight, 'matching panel scrolls inside its own result area');
    assert.ok(ownScroll.chartVisible && ownScroll.finalNoteVisible, 'entire matching chart and reference-plane note are reachable without dock overlap');
    assert.equal(ownScroll.paths.length, 2);
    assert.ok(ownScroll.paths.every(p => p.width > 20 && p.d.includes('L') && !/NaN|Infinity/.test(p.d)), 'reachable overlay contains two finite visible traces');
    await page.screenshot({ path: join(out, `matching-smith-${lang}.png`) });
    const noPhase = fixture(); noPhase.model.id = b.model.id; noPhase.reference = { label: 'Magnitude only', phaseKnown: false };
    await show('impedance', noPhase); await s.wait('[data-matching-unavailable]'); await s.gone('.matching-enable');
    await show('impedance'); await s.wait('.matching-enable input');
    assert.equal(await page.$eval('.matching-enable input', e => e.checked), false, 'new result does not inherit prior circuit');
    assert.deepEqual(starts, []);
    results.push({ lang, impedance: true, smith: true, line: true, magnitudeOnlyRefused: true, reset: true, ownScroll, attemptedStarts: starts });
    await context.close(); activePage = undefined;
  }
  await writeFile(join(out, 'matching-result.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ out, results }));
} catch (error) {
  failed = true;
  await activePage?.screenshot({ path: join(out, 'matching-failure.png') }).catch(() => {});
  await writeFile(join(out, 'matching-failure.json'), JSON.stringify({ message: String(error), results }, null, 2));
  throw error;
} finally { await cleanupBrowserScenario(browser, stack, failed); }
