// Remote acceptance for Design angular resolution. No solver: intercepted run POSTs fail the test.
// Browser execution is intentionally scheduled by Windows CI, never by the pure unit gate.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { startStack, chromePath, root } from './scenarios/stack.mjs';
import { Session, auditInPage } from './scenarios/harness.mjs';

const out = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || join(tmpdir(), 'fairbeam-scenario-failures'), 'pattern-resolution');
await mkdir(out, { recursive: true });
const original = JSON.parse(await readFile(join(root, 'examples/synthetic/array2x1.json'), 'utf8'));
const synthetic = structuredClone(original);
const source = original.results.element_patterns[0];
const ti = source.theta.map((_, i) => i).filter(i => i % 2 === 0 || i === source.theta.length - 1);
const pi = source.phi.map((_, i) => i).filter(i => i % 2 === 0);
const encode = grid => {
  const bytes = Buffer.alloc(ti.length * pi.length * 4);
  ti.forEach((i, row) => pi.forEach((j, col) => bytes.writeFloatLE(grid[i][j], (row * pi.length + col) * 4)));
  return bytes.toString('base64');
};
synthetic.model.id = 'synthetic-angular-resolution';
synthetic.model.name = 'SYNTHETIC angular-resolution acceptance fixture';
synthetic.model.description = 'Analytic synthetic fields, deliberately reduced for a UI warning test. No solver or measurement.';
synthetic.run = null;
synthetic.results.element_patterns = {
  encoding: 'f32le-base64', shape: [ti.length, pi.length],
  theta: ti.map(i => source.theta[i]), phi: pi.map(i => source.phi[i]), frequencies: [source.f],
  source_shape: [source.theta.length, source.phi.length], requested_steps: [3, 5], decimation: 2,
  mirror_planes: 0, phase_center: [0, 0, 0],
  ports: source.elements.map(e => ({ port: e.port, position: [0, 0, 0], fields: [{ f: source.f,
    e_theta_re: encode(e.e_theta.re), e_theta_im: encode(e.e_theta.im),
    e_phi_re: encode(e.e_phi.re), e_phi_im: encode(e.e_phi.im),
  }] })),
};
const outcomes = [];
let stack, browser, page, session;
try {
  stack = await startStack({ log: console.log, niceSolver: false });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(),
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  for (const lang of ['en', 'tr']) {
    const id = `pattern_resolution_${lang}`;
    const created = await fetch(`${stack.apiUrl}/api/designs`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name: `Angular resolution ${lang}`, template: 'dipole' }) });
    assert.equal(created.status, 201, await created.text());
    const context = await browser.createBrowserContext();
    page = await context.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument(language => localStorage.setItem('fairbeam.generalSettings', JSON.stringify({ language })), lang);
    let runPosts = 0, designReads = 0;
    await page.setRequestInterception(true);
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path === `/api/designs/${id}` && request.method() === 'GET') designReads++;
      if (path === '/api/runs' && request.method() === 'POST') {
        runPosts++;
        void request.abort(); // test guard: this regression must never start a solver
      } else void request.continue();
    });
    const s = new Session(page, { lang, scenario: 'pattern-resolution', url: stack.url, artifactDirectory: out });
    session = s;
    await page.goto(stack.url, { waitUntil: 'domcontentloaded' });
    await s.wait('.home');
    const openDesign = async () => {
      await s.clickSel(`[data-home-design="${id}"] .home-item`);
      await s.waitFor(async id => { const m = await import('/src/designer/store.ts'); return !m.loading() && m.file()?.id === id; }, id);
      await s.wait('.rb');
    };
    const openSettings = async () => {
      await s.click('ribbon.tab.sim', { sel: '.rb-tab' });
      const toggle = await s.find('.rb-group-toggle', await s.T('ribbon.sim.monitors'));
      if (toggle && await toggle.evaluate(e => e.getAttribute('aria-expanded') !== 'true')) await toggle.click();
      await s.click('ribbon.sim.farField', { sel: '.rb-btn', exact: true });
      await s.wait('#ss-title');
      await s.wait('#dz-far_field-theta_step');
    };
    const thetaInput = '#dz-far_field-theta_step', phiInput = '#dz-far_field-phi_step';
    await openDesign();
    await openSettings();
    assert.equal(await page.$eval(thetaInput, e => e.value), '3');
    assert.equal(await page.$eval(phiInput, e => e.value), '5');
    assert.equal(await (await s.field(await s.T('sim.mon.thetaStep'), { within: '[aria-labelledby="ss-title"]' })).evaluate(e => e.id), thetaInput.slice(1));
    assert.equal(await (await s.field(await s.T('sim.mon.phiStep'), { within: '[aria-labelledby="ss-title"]' })).evaluate(e => e.id), phiInput.slice(1));
    await s.fill(thetaInput, '7');
    await s.fill(phiInput, '11');
    await s.click('sim.discard', { within: '[aria-labelledby="ss-title"]' });
    await s.gone('#ss-title');
    await openSettings();
    assert.equal(await page.$eval(thetaInput, e => e.value), '3', 'discard restores the omitted theta default');
    assert.equal(await page.$eval(phiInput, e => e.value), '5', 'discard restores the omitted phi default');
    await s.fill(thetaInput, '0');
    await s.waitFor(() => document.querySelector('#dz-far_field-theta_step')?.getAttribute('aria-invalid') === 'true');
    const error = await page.$eval(thetaInput, e => document.getElementById(e.getAttribute('aria-describedby').split(' ')[0])?.textContent);
    const expectedError = await s.ev((_, m) => m.text.checkTitle({ code: 'ff-step', message: 'angular step must be from 0.25 to 90 degrees' }), null,
      { text: '/src/designer/checkText.ts' });
    assert.equal(error, expectedError, `${lang}: localized range error is associated with the input`);
    await s.click('common.ok', { within: '[aria-labelledby="ss-title"]' });
    await s.gone('#ss-title');
    const runToggle = await s.find('.rb-group-toggle', await s.T('ribbon.sim.run'));
    if (runToggle && await runToggle.evaluate(e => e.getAttribute('aria-expanded') !== 'true')) await runToggle.click();
    await s.click('ribbon.sim.run', { sel: '.rb-btn', exact: true });
    await s.wait('#rd-form');
    assert.equal(await page.$eval('button[form="rd-form"][type="submit"]', e => e.disabled), true, 'range error blocks simulation submission');
    assert.ok((await page.$eval('.rd-errors', e => e.textContent)).includes(expectedError));
    await s.click('common.cancel', { within: '[role="dialog"]' });
    await s.gone('#rd-form');
    await openSettings();
    await s.fill(thetaInput, 'f0 / 2');
    await s.fill(phiInput, '11');
    await s.waitFor(() => ['#dz-far_field-theta_step', '#dz-far_field-phi_step']
      .every(sel => document.querySelector(sel)?.getAttribute('aria-invalid') === 'false'));
    assert.deepEqual(await s.store((_, m) => [m.s.draft.far_field.theta_step, m.s.draft.far_field.phi_step]), ['f0 / 2', 11]);
    assert.deepEqual(await page.evaluate(auditInPage, '[aria-labelledby="ss-title"]'), []);
    await page.screenshot({ path: join(out, `settings-${lang}.png`) });
    await s.click('common.ok', { within: '[aria-labelledby="ss-title"]' });
    await s.gone('#ss-title');
    await s.click('ribbon.tab.home', { sel: '.rb-tab' });
    await s.click('common.save', { sel: '.rb-btn', exact: true });
    await s.waitFor(async () => { const m = await import('/src/designer/store.ts'); return !m.saving() && !m.dirty(); });
    const savedResponse = await fetch(`${stack.apiUrl}/api/designs/${id}`);
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.deepEqual([saved.design.far_field.theta_step, saved.design.far_field.phi_step], ['f0 / 2', 11]);
    await s.click('header.screen.start', { sel: '.mode-switch button', exact: true });
    await s.wait('.home');
    const readsBeforeReload = designReads;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await s.wait('.home');
    await openDesign();
    assert.ok(designReads > readsBeforeReload, 'reopening loads the saved design from the server');
    await openSettings();
    assert.equal(await page.$eval(thetaInput, e => e.value), 'f0 / 2');
    assert.equal(await page.$eval(phiInput, e => e.value), '11');
    await s.click('common.ok', { within: '[aria-labelledby="ss-title"]' });
    await s.gone('#ss-title');
    await s.click('header.screen.start', { sel: '.mode-switch button', exact: true });
    await s.wait('.home');
    await s.click('header.screen.examples', { sel: '.mode-switch button', exact: true });
    await s.wait('.example-picker-trigger');
    await s.waitFor(async () => { const m = await import('/src/state.ts'); return !!m.bundle() && m.sourceOrigin() === 'project'; });
    await s.ev((b, m) => m.st.openBundle(m.v.validateBundle(b).bundle, 'SYNTHETIC-angular-resolution.json'), synthetic,
      { st: '/src/state.ts', v: '/src/lib/validate.ts' });
    await s.waitFor(async () => (await import('/src/state.ts')).bundle()?.model.id === 'synthetic-angular-resolution'
      && (await import('/src/lib/arrayStore.ts')).hasArray());
    await s.clickSel('.dock [data-tab="array"]');
    await s.wait('.array-panel [role="note"]');
    const notice = await s.T('array.decimated', { theta: ti.length, phi: pi.length });
    assert.equal(await page.$eval('.array-panel [role="note"]', e => e.textContent), notice);
    const grids = await s.ev((_, m) => ({ sourceShape: m.st.bundle().results.element_patterns.source_shape,
      storedShape: [m.arr.arraySet().theta.length, m.arr.arraySet().phi.length],
      lastTheta: m.st.bundle().results.element_patterns.theta.at(-1) }), null,
      { st: '/src/state.ts', arr: '/src/lib/arrayStore.ts' });
    assert.deepEqual(grids.storedShape, [ti.length, pi.length]);
    assert.deepEqual(grids.sourceShape, [source.theta.length, source.phi.length]);
    assert.equal(grids.lastTheta, 180);
    assert.deepEqual(await page.evaluate(auditInPage, '.array-panel'), []);
    await page.screenshot({ path: join(out, `synthetic-decimation-${lang}.png`) });
    assert.equal(runPosts, 0, 'no simulation submission occurred');
    assert.deepEqual(s.consoleIssues, [], 'no unexpected console or page errors');
    outcomes.push({ lang, defaults: [3, 5], discard: true, localizedErrorBlocksRun: true,
      saved: ['f0 / 2', 11], serverReopened: true, runPosts, syntheticDecimationNotice: true,
      storedShape: [ti.length, pi.length], sourceShape: [source.theta.length, source.phi.length] });
    await context.close();
  }
  await writeFile(join(out, 'result.json'), JSON.stringify({ fixture: 'explicitly synthetic; no solver', outcomes }, null, 2));
  console.log('Pattern resolution browser: EN/TR defaults, discard, expressions, range-error run blocking, save/reopen and synthetic decimation notice passed.');
} catch (error) {
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  await writeFile(join(out, 'failure.json'), JSON.stringify({ error: String(error?.stack || error), outcomes,
    console: session?.consoleIssues, stack: stack?.diagnostics() }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await stack?.stop();
}
