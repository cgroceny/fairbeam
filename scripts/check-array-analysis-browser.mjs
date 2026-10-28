// #243: real shared viewer/Designer controls with declared synthetic matched-wave data.
// No solver/native/render job is allowed. Root schedules this browser check serially.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { startStack, chromePath, root } from './scenarios/stack.mjs';
import { Session, auditInPage } from './scenarios/harness.mjs';
import { withStartupDiagnostics, safeDiagnosticText } from './scenarios/startup-diagnostics.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' && process.env.FAIRBEAM_ALLOW_BROWSER_TEST !== '1')
  throw new Error('Browser test requires CI or explicit browser-test authorization.');
const out = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || join(tmpdir(), `fairbeam-array-analysis-${Date.now()}`), 'array-analysis');
await mkdir(out, { recursive: true });
const f0 = 1e9, f1 = 1.1e9, physical = [2, 7, 11, 19, 42], matrixPhysical = [42, 2, 19, 7, 11];
const theta = [0, 30, 60, 90, 120, 150, 180], phi = [0, 45, 90, 135, 180, 225, 270, 315];
const normalization = 'far-field E (V/m) at radius_m per unit incident power wave a = 1 sqrt(W) at the port (a = U_inc / sqrt(Z_ref), peak phasor); all other incident waves zero; F = E A^-1';
const base = JSON.parse(await readFile(join(root, 'examples/synthetic/array2x1.json'), 'utf8'));
function fixture() {
  const b = structuredClone(base);
  b.name = b.model.name = 'SYNTHETIC five-port analysis control'; b.model.id = 'synthetic-array-analysis';
  b.model.description = 'Constructed low-power matched-wave field samples and diagonal S only. Not an antenna simulation or physical qualification.';
  b.model.reference = 'scripts/check-array-analysis-browser.mjs'; b.model.params = []; b.parts = []; b.run = null;
  b.units = { length: 'mm', length_m: .001, frequency: 'Hz' }; delete b.half_space; b.nf2ff_center = [0, 0, 0];
  b.domain = { min: [-200, -100, -50], max: [200, 100, 100] };
  b.mesh = { x: [-200, -120, -60, 0, 60, 120, 200], y: [-100, 0, 100], z: [-50, 0, 1.524, 100],
    cells: [6, 2, 3], total_cells: 36, min_cell: 1.524, max_cell: 100 };
  b.solver.boundaries = Object.fromEntries(['x-', 'x+', 'y-', 'y+', 'z-', 'z+'].map(k => [k, 'PML_8']));
  b.solver.excitation.f_min = .9e9; b.solver.excitation.f_max = 1.2e9;
  b.ports = physical.map((number, i) => ({ number, type: 'lumped', R: 50, direction: 'z', excite: true,
    start: [(i - 2) * 60, 0, 0], stop: [(i - 2) * 60, 0, 1.524] }));
  const frequency = [.9e9, f0, f1, 1.2e9], trace = value => frequency.map(() => value);
  const encoded = values => { const bytes = Buffer.alloc(values.length * 4); values.forEach((v, i) => bytes.writeFloatLE(v, i * 4)); return bytes.toString('base64'); };
  const fields = (x, f) => {
    const phase = theta.flatMap(t => phi.map(p => 2 * Math.PI * f / 299792458 * x * .001 * Math.sin(t * Math.PI / 180) * Math.cos(p * Math.PI / 180)));
    // Small finite amplitude makes power admission well separated from its upper bound.
    return { f, e_theta_re: encoded(phase.map(p => .2 * Math.cos(p))), e_theta_im: encoded(phase.map(p => .2 * Math.sin(p))),
      e_phi_re: encoded(phase.map(() => 0)), e_phi_im: encoded(phase.map(() => 0)) };
  };
  b.results = { frequency, bands: [], signals: {},
    ports: Object.fromEntries(physical.map(p => [p, { s11_re: trace(.1), s11_im: trace(0), zin_re: trace(61.111111111111), zin_im: trace(0), z_ref: 50 }])),
    farfield: [f0, f1].map(f => ({ f, theta, phi, directivity_dbi: theta.map(() => phi.map(() => 0)), dmax_dbi: 0,
      rad_efficiency: null, prad_w: null, pacc_w: null, mirror_planes: 0 })),
    element_patterns: { normalization, basis: 'matched-incident-waves', radius_m: 1, encoding: 'f32le-base64',
      shape: [theta.length, phi.length], theta, phi, frequencies: [f0, f1], decimation: 1, mirror_planes: 0, phase_center: [0, 0, 0],
      ports: b.ports.map(p => ({ port: p.number, position: [p.start[0], 0, .762], fields: [fields(p.start[0], f0), fields(p.start[0], f1)] })) },
    sparams: { ports: [1, 2, 3, 4, 5], port_numbers: matrixPhysical, excited: [1, 2, 3, 4, 5], complete: true,
      method: 'B A^-1', z_ref: [50, 50, 50, 50, 50], s: Object.fromEntries([1, 2, 3, 4, 5].flatMap(i => [1, 2, 3, 4, 5].map(j =>
        [`${i},${j}`, { re: trace(i === j ? .1 : 0), im: trace(0) }]))) } };
  return b;
}
const modules = { v: '/src/lib/arrayStore.ts', a: '/src/designer/arraySession.ts', st: '/src/state.ts', validation: '/src/lib/validate.ts',
  admission: '/src/lib/patternAdmission.ts', analysis: '/src/lib/arrayAnalysis.ts', csv: '/src/export/arrayScan.ts',
  dr: '/src/runner/designRun.ts', rf: '/src/designer/resultFocus.ts', rr: '/src/designer/runResults.ts' };
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const outcomes = [], forbidden = []; let stack, browser, page, session, lang;
try {
  stack = await startStack({ log: console.log });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(), args: ['--no-sandbox', '--mute-audio', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  for (lang of ['en', 'tr']) {
    const context = await browser.createBrowserContext(); page = await context.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument(language => localStorage.setItem('fairbeam.generalSettings', JSON.stringify({ language })), lang);
    await page.setRequestInterception(true); page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && /^\/api\/(?:runs|sweeps|convergence|optimizations|research\/runs|render-jobs|native-document)(?:\/|$)/.test(path)) {
        forbidden.push(path); void request.abort();
      } else void request.continue();
    });
    const s = session = new Session(page, { lang, scenario: 'array-analysis', url: stack.url, artifactDirectory: out });
    const downloadSession = await page.createCDPSession();
    await withStartupDiagnostics(page, { directory: join(out, `startup-${lang}`), stack }, async () => {
      await page.goto(stack.url, { waitUntil: 'domcontentloaded' }); await s.wait('.home', undefined, { timeout: 45000 });
    });
    const b = fixture(), importPath = join(out, `synthetic-${lang}.json`); await writeFile(importPath, JSON.stringify(b));
    await (await page.$('.app-header input[type=file]')).uploadFile(importPath);
    await s.waitFor(async () => (await import('/src/lib/arrayStore.ts')).arrayWeights().size === 5);
    assert.deepEqual(await s.ev((_, m) => m.st.loadWarnings(), null, modules), [], 'synthetic full-sphere import requires no validator repair');
    await s.clickSel('.dock [data-tab="array"]'); await s.wait('.dock [data-array-analysis]');

    async function exercise(surface, panel) {
      // Both surfaces intentionally export the same product filename. Preserve
      // each real download in its own directory so overwrite is not a false miss.
      const downloads = join(out, lang, surface); await mkdir(downloads, { recursive: true });
      await downloadSession.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
      const analysis = `${panel} [data-array-analysis]`, select = `${analysis} [data-array-taper]`;
      const state = () => s.ev((surface, m) => {
        const a = surface === 'viewer' ? m.v.viewerArray : m.a.designerArray, b = a.source(), f = a.set()?.f;
        const identity = m.admission.strictElementPatternsAt(b, f), power = m.analysis.arrayPower(b, a.weights(), f);
        return { id: b.model.id, f, phi: a.scanPhi(), theta: a.scanTheta(), weights: [...a.weights()], identity: identity.ok,
          power: power.ok, positions: identity.ok ? [...identity.positions] : [], portMap: b.results.sparams.port_numbers };
      }, surface, modules);
      let current = await state(); assert.equal(current.identity, true); assert.equal(current.power, true);
      assert.deepEqual(current.portMap, matrixPhysical); assert.deepEqual(current.weights.map(([p]) => p), physical);
      assert.deepEqual(current.positions, physical.map((p, i) => [p, [(i - 2) * 60, 0, .762]]));
      assert.equal(await page.$eval(`${analysis} h3`, e => e.textContent), await s.T('array.analysis.title'));
      const fill = async (key, value, within = analysis) => s.fill(await s.field(await s.T(key), { within }), value);
      await fill('array.analysis.phi', '37.456', panel);
      await s.fill(await s.need('input', await s.T('array.scanAngleAria'), { within: panel, exact: true }), '-23.123');
      current = await state(); near(current.phi, 37.456); near(current.theta, -23.123);
      // Independent geometry/phase expression; negative theta is represented by phi+180.
      current.weights.forEach(([p, w], i) => {
        let expected = -360 * current.f / 299792458 * (i * .06) * Math.sin(23.123 * Math.PI / 180) * Math.cos(217.456 * Math.PI / 180);
        expected = ((expected + 180) % 360 + 360) % 360 - 180;
        near(w.phaseDeg, expected, 1e-8);
      });
      const phases = current.weights.map(([, w]) => w.phaseDeg);
      const beta = Math.cosh(Math.acosh(10 ** (30 / 20)) / 4), center = 3 * beta ** 4 - 4 * beta ** 2 + 1;
      const references = { uniform: [1, 1, 1, 1, 1], binomial: [1 / 6, 4 / 6, 1, 4 / 6, 1 / 6],
        chebyshev: [.5 * beta ** 4, 2 * beta ** 4 - 2 * beta ** 2, center, 2 * beta ** 4 - 2 * beta ** 2, .5 * beta ** 4].map(v => v / center),
        // Retained independent SciPy taylor(5,nbar=4,sll=30,norm=True,sym=True), peak-normalized.
        taylor: [.33249694817359937, .7720145794704376, 1, .7720145794704376, .33249694817359937] };
      for (const kind of ['uniform', 'chebyshev', 'taylor', 'binomial']) {
        await page.select(select, kind); await s.clickSel(`${analysis} [data-array-apply-taper]`);
        current = await state(); current.weights.forEach(([, w], i) => { near(w.ampDb, 20 * Math.log10(references[kind][i]), 1e-8); near(w.phaseDeg, phases[i]); });
      }
      // Input bounds must refuse, never silently return a table under stale prior limits.
      await page.select(select, 'chebyshev'); await fill('array.analysis.target', '61');
      assert.equal(await page.$eval(`${analysis} [data-array-apply-taper]`, e => e.disabled), true);
      await s.wait(`${analysis} [role=alert]`, await s.T('array.analysis.reason.range'));
      await fill('array.analysis.target', '30'); await page.select(select, 'binomial');
      await s.clickSel(`${analysis} details > summary`);
      await fill('array.analysis.from', '-20'); await fill('array.analysis.to', '20'); await fill('array.analysis.step', '10');
      const calculate = () => s.clickSel(`${analysis} [data-array-calculate-scan]`);
      const csvButton = () => s.need('button', awaitText, { within: analysis, exact: true });
      const awaitText = await s.T('array.analysis.csv');
      const emptyTable = async () => { assert.equal(await page.$(`${analysis} tbody`), null); assert.equal(await (await csvButton()).evaluate(e => e.disabled), true); };
      await calculate(); await s.wait(`${analysis} tbody`);
      assert.equal(await page.$$eval(`${analysis} tbody tr`, rows => rows.length), 5);
      const expected = await s.ev((surface, m) => {
        const a = surface === 'viewer' ? m.v.viewerArray : m.a.designerArray;
        const result = m.analysis.scanTable(a.source(), a.weights(), a.set().f, a.scanPhi(), -20, 20, 10);
        if (!result.ok) throw new Error(`synthetic scan refused: ${result.reason}`);
        return { csv: m.csv.arrayScanCsv(result.value), rows: result.value.rows };
      }, surface, modules);
      assert.ok(expected.rows.every(row => row.gainDbi !== null && row.totalEfficiency > 0 && row.totalEfficiency <= 1));
      near(expected.rows[2].scanLossDb, 0); expected.rows.forEach(row => row.activeDb.forEach(([, gamma]) => near(gamma, -20)));
      const visible = await page.$$eval(`${analysis} tbody tr`, rows => rows.map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent.trim())));
      const formatted = await s.ev(async rows => {
        const { fmt } = await import('/src/i18n/index.ts');
        return rows.map(row => [fmt.fixed(row.theta, 1), fmt.fixed(row.gainDbi, 2), fmt.fixed(row.scanLossDb, 2), ...row.activeDb.map(([, gamma]) => fmt.fixed(gamma, 2))]);
      }, expected.rows);
      assert.deepEqual(visible, formatted, 'visible localized scan cells agree with the exported snapshot');
      const previous = new Set(await readdir(downloads)); await (await csvButton()).click();
      let saved;
      for (let i = 0; i < 100; i++) { saved = (await readdir(downloads)).find(n => !previous.has(n) && n.endsWith('.csv')); if (saved) break; await new Promise(r => setTimeout(r, 100)); }
      assert.ok(saved, 'actual scan CSV download completed'); const csv = (await readFile(join(downloads, saved), 'utf8')).replace(/^\uFEFF/, '');
      assert.equal(csv, expected.csv, 'download is the calculated immutable scan snapshot');
      const rows = csv.trimEnd().split(/\r?\n/).map(row => row.split(',')), header = rows.shift();
      assert.equal(rows.length, 5); assert.deepEqual(rows.map(row => Number(row[header.indexOf('theta_deg')])), [-20, -10, 0, 10, 20]);
      for (const row of rows) {
        assert.equal(Number(row[header.indexOf('frequency_Hz')]), current.f); near(Number(row[header.indexOf('phi_deg')]), 37.456);
        assert.equal(row[header.indexOf('baseline')], 'same-amplitudes-zero-phase');
        physical.forEach(p => near(Number(row[header.indexOf(`P${p}_active_reflection_dB`)]), -20));
      }
      await page.screenshot({ path: join(out, `${lang}-${surface}-scan-table.png`) });
      await s.fill(await s.need('input', await s.T('array.amplitudeAria', { port: 2 }), { within: panel, exact: true }), '-8');
      await emptyTable(); await calculate(); await s.wait(`${analysis} tbody`);
      await fill('array.analysis.phi', '42', panel); await emptyTable();
      await fill('array.analysis.step', '0'); assert.equal(await page.$eval(`${analysis} [data-array-calculate-scan]`, e => e.disabled), true);
      await s.wait(`${analysis} [role=alert]`, await s.T('array.analysis.reason.range')); await emptyTable();
      await fill('array.analysis.step', '1'); await fill('array.analysis.from', '-90'); await fill('array.analysis.to', '90');
      await calculate(); await s.wait(`${analysis} [role=alert]`, await s.T('array.analysis.reason.budget')); await emptyTable();
      await fill('array.analysis.from', '20'); await fill('array.analysis.to', '-20'); await fill('array.analysis.step', '10');
      await calculate(); await s.wait(`${analysis} [role=alert]`, await s.T('array.analysis.reason.range')); await emptyTable();
      await fill('array.analysis.from', '-20'); await fill('array.analysis.to', '20'); await calculate(); await s.wait(`${analysis} tbody`);
      if (surface === 'designer') await page.select('[data-array-frequency]', String(f1));
      else await s.ev((_, m) => m.st.setFarfieldIndex(1), null, modules);
      await emptyTable(); current = await state(); assert.equal(current.f, f1); near(current.theta, 0);
      assert.ok(current.weights.every(([, w]) => w.ampDb === 0 && w.phaseDeg === 0));
      assert.deepEqual(await page.evaluate(auditInPage, analysis), []);
      await page.screenshot({ path: join(out, `${lang}-${surface}.png`) });
      outcomes.push({ lang, surface, strictMatchedIdentity: true, sparsePortMap: true, tapers: Object.keys(references), arbitraryPhi: true,
        negativeTheta: true, csv: join(lang, surface, saved), scanTableScreenshot: `${lang}-${surface}-scan-table.png`,
        rangeRefusal: true, budgetRefusal: true, amplitudePhiFrequencyInvalidation: true, syntheticOnly: true });
    }

    await exercise('viewer', '.dock .array-panel');
    await s.clickSel('.dock [data-array-calculate-scan]'); await s.wait('.dock [data-array-analysis] tbody');
    // Replacement identity/refusal in the actual imported viewer, retaining legacy display.
    const replace = async value => {
      await s.ev((b, m) => m.st.openBundle(b, 'synthetic-array-replacement.json'), value, modules);
      await s.wait('.dock [data-array-analysis]');
    };
    const irregular = fixture(); irregular.ports[2].start[1] = irregular.ports[2].stop[1] = 10;
    irregular.results.element_patterns.ports[2].position[1] = 10;
    await replace(irregular);
    assert.equal(await page.$('.dock [data-array-analysis] tbody'), null, 'source replacement clears the previous scan');
    assert.equal(await page.$eval('.dock [data-array-apply-taper]', e => e.disabled), true);
    await s.wait('.dock [data-array-analysis] .note', await s.T('array.analysis.reason.layout'));
    for (const mutation of ['basis', 'position', 'phaseCenter', 'band']) {
      const bad = fixture();
      if (mutation === 'basis') delete bad.results.element_patterns.basis;
      if (mutation === 'position') bad.results.element_patterns.ports[0].position[0] += 1;
      if (mutation === 'phaseCenter') bad.results.element_patterns.phase_center[0] = 1;
      if (mutation === 'band') bad.results.frequency = [2e9, 2.1e9, 2.2e9, 2.3e9];
      await replace(bad);
      assert.equal(await s.ev((_, m) => m.admission.strictElementPatternsAt(m.st.bundle(), 1e9).ok, null, modules), false);
      await s.wait('.dock [data-array-analysis] .note', await s.T(`array.analysis.reason.${mutation === 'basis' ? 'basis' : 'fields'}`));
      const details = '.dock [data-array-analysis] details'; if (!await page.$eval(details, e => e.open)) await s.clickSel(`${details} > summary`);
      await s.clickSel('.dock [data-array-calculate-scan]');
      await s.wait('.dock [data-array-analysis] [role=alert]', await s.T(`array.analysis.reason.${mutation === 'basis' ? 'basis' : 'fields'}`));
      assert.equal(await page.$('.dock [data-array-analysis] tbody'), null);
    }
    await replace(fixture());
    // Create an actual Designer document, then register its synthetic result through normal result state.
    await s.click('header.screen.start', { within: '.mode-switch', exact: true }); await s.wait('.home');
    await page.locator('input[name="home-template"][value="patch"]').click();
    await s.fill(await s.field(await s.T('home.newProject.name')), `Array analysis ${lang}`, { blur: false });
    await s.click('home.newProject.create'); await s.wait('.rb');
    const own = await s.store((_, m) => m.s.file()), result = fixture(); result.model.id = own.design.model.id;
    const resultFile = `${own.id}--array-analysis.json`; await writeFile(join(stack.projects, resultFile), JSON.stringify(result));
    await s.ev(({ b, file, f }, m) => {
      m.st.setIndex([...m.st.index(), { file, model: b.model.id, name: b.name, created: b.created, simulated: true, bands: [], params: [] }]);
      m.dr.setDesignResult({ file, bundle: b }); m.rr.ensureDesignRunBundles(); m.rf.focusResult({ file, view: 'array', f }, 'main');
    }, { b: result, file: resultFile, f: f0 }, modules);
    await s.wait('[data-designer-array] [data-array-analysis]');
    const designBefore = await s.store((_, m) => JSON.stringify(m.s.draft));
    await exercise('designer', '[data-designer-array] .array-panel');
    assert.equal(await s.store((_, m) => JSON.stringify(m.s.draft)), designBefore, 'postprocessing never mutates Design');
    assert.deepEqual(forbidden, []); assert.deepEqual(s.consoleIssues, []); await context.close();
  }
  await writeFile(join(out, 'result.json'), JSON.stringify({ outcomes, forbidden, nativeSolver: false }, null, 2));
  console.log(JSON.stringify({ out, outcomes }, null, 2));
} catch (error) {
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  await writeFile(join(out, 'failure.json'), JSON.stringify({ error: String(error?.stack || error), lang, url: page?.url(),
    console: session?.consoleIssues, forbidden, outcomes, children: stack?.diagnostics() }, (_key, value) => typeof value === 'string' ? safeDiagnosticText(value) : value, 2));
  throw error;
} finally { try { await browser?.close(); } finally { await stack?.stop(); } }
