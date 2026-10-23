// Actual Designer UI acceptance using an explicitly synthetic circuit, not an EM run.
// Authoring/syntax checks do not establish browser or assistive-technology coverage.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { root, startStack, chromePath } from './scenarios/stack.mjs';
import { Session, auditInPage } from './scenarios/harness.mjs';
import { safeDiagnosticText } from './scenarios/startup-diagnostics.mjs';
import { PORT_CONTROL_DELAYS, portProcessingBrowserFixture } from './fixtures/port-postprocessing-browser.mjs';
import { parseCsv } from '../src/export/csv.ts';
import { parseTouchstoneNPort } from '../src/export/touchstone.ts';

if (process.env.GITHUB_ACTIONS !== 'true' && process.env.FAIRBEAM_ALLOW_BROWSER_TEST !== '1')
  throw new Error('Browser test requires root scheduling (FAIRBEAM_ALLOW_BROWSER_TEST=1) or remote CI.');
const out = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || join(tmpdir(), `fairbeam-port-processing-${Date.now()}`), 'port-postprocessing');
await mkdir(out, { recursive: true });
const circuit = JSON.parse(await readFile(join(root, 'scripts/fixtures/port-postprocess-circuit.json'), 'utf8'));
const geometry = JSON.parse(await readFile(join(root, 'public/projects/branchline-coupler.json'), 'utf8'));
const delays = PORT_CONTROL_DELAYS;
const fixture = () => portProcessingBrowserFixture(geometry, circuit);
const near = (a, b) => assert.ok(Math.abs(Number(a) - b) < 2e-10, `${a} != ${b}`);
function checkTable(rows) {
  const header = rows[0], ri = header.findIndex(x => x.startsWith('Re S11')), ii = header.findIndex(x => x.startsWith('Im S11'));
  const pi = header.indexOf('Port processing');
  assert.ok(ri > 0 && ii > 0 && pi > 0, 'actual visible S11 export includes complex values and provenance');
  assert.ok(header[ri].includes('P7'), 'physical port mapping is in the displayed/exported pair label');
  assert.equal(rows.length, circuit.frequency_hz.length + 1);
  rows.slice(1).forEach((row, k) => {
    near(row[0], circuit.frequency_hz[k] / 1e9);
    near(row[ri], circuit.target[k][0][0][0]); near(row[ii], circuit.target[k][0][0][1]);
    assert.match(row[pi], /Postprocessed:/); assert.match(row[pi], /75/); assert.match(row[pi], /P7/); assert.match(row[pi], /31/);
  });
}
async function download(directory, extension) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const names = (await readdir(directory)).filter(name => name.endsWith(extension));
    if (names.length === 1) return { name: names[0], text: await readFile(join(directory, names[0]), 'utf8') };
    assert.ok(names.length < 2, 'one download per requested export');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${extension} download did not complete within 5000 ms`);
}
let stack, browser, page, session, activeLang;
const outcomes = [], forbidden = [];
try {
  stack = await startStack({ log: console.log });
  browser = await puppeteer.launch({ headless: true, userDataDir: join(stack.dir, 'port-processing-chrome'), executablePath: await chromePath(),
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  for (const lang of ['en', 'tr']) {
    activeLang = lang;
    const context = await browser.createBrowserContext();
    await context.overridePermissions(stack.url, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    page = await context.newPage(); await page.setViewport({ width: 1440, height: 1000 });
    const downloads = join(out, lang); await mkdir(downloads, { recursive: true });
    await (await page.createCDPSession()).send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await page.evaluateOnNewDocument(language => localStorage.setItem('fairbeam.generalSettings', JSON.stringify({ language })), lang);
    await page.setRequestInterception(true);
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      const job = /^\/api\/(?:runs|sweeps|convergence|optimizations|research\/runs|render-jobs)(?:\/|$)/.test(path);
      const native = /^\/api\/(?:native-document(?:\/|$)|(?:research\/elmer\/install|blender\/open-download|open-feedback|renders\/[A-Za-z0-9_-]+\/open)\/?$)/.test(path);
      if ((request.method() === 'POST' && job) || native) { forbidden.push({ method: request.method(), path }); void request.abort(); }
      else void request.continue();
    });
    const s = session = new Session(page, { lang, scenario: 'port-postprocessing', url: stack.url, artifactDirectory: out });
    await page.goto(stack.url, { waitUntil: 'domcontentloaded' }); await s.wait('.home', undefined, { timeout: 45000 });
    await page.locator('input[name="home-template"][value="patch"]').click();
    await s.fill(await s.field(await s.T('home.newProject.name')), `Port control ${lang}`, { blur: false });
    await s.click('home.newProject.create'); await s.wait('.rb');
    const own = await s.store((_, m) => m.s.file());
    const a = fixture(), b = fixture(), incomplete = fixture();
    a.model.id = b.model.id = incomplete.model.id = own.design.model.id;
    b.created = '2026-10-24T00:00:01Z'; incomplete.created = '2026-10-24T00:00:02Z';
    b.name += ' B'; incomplete.name += ' incomplete'; delete incomplete.results.sparams.s['1,2'];
    const records = [a, b, incomplete].map((bundle, i) => ({ file: `${own.id}--synthetic-ports-${i}.json`, bundle }));
    for (const r of records) await writeFile(join(stack.projects, r.file), JSON.stringify(r.bundle));
    // Admit three existing synthetic objects once. Switching uses the actual result view with
    // those same loaded identities, not a processing-helper/UI surrogate or user workspace.
    await s.ev((records, m) => {
      window.__portControls = records.map(r => {
        const v = m.v.validateBundle(r.bundle); if (!v.bundle) throw new Error(JSON.stringify(v.errors));
        return { file: r.file, bundle: v.bundle };
      });
      window.__portRawSnapshots = window.__portControls.map(r => JSON.stringify(r.bundle));
      const entries = window.__portControls.map(r => ({ file: r.file, model: r.bundle.model.id,
        name: r.bundle.name, created: r.bundle.created, simulated: true, bands: [], params: [] }));
      entries.forEach((entry, i) => {
        const bundle = window.__portControls[i].bundle;
        if (!m.identity.matchesResultIndex(entry, bundle)) throw new Error('Synthetic fixture failed result identity admission');
        const matrix = m.sp.sMatrix(bundle);
        if (!matrix || JSON.stringify(matrix.ports.map(p => m.sp.physicalPortNumber(matrix, p))) !== JSON.stringify(bundle.ports.map(p => p.number)))
          throw new Error('Synthetic fixture physical-port identity changed on validation');
      });
      m.st.setIndex([...m.st.index(), ...entries]);
      m.dr.setDesignResult(window.__portControls[0]); m.rr.ensureDesignRunBundles();
      m.rf.focusResult({ file: records[0].file, view: 'sparams' }, 'main');
    }, records, { st: '/src/state.ts', v: '/src/lib/validate.ts', dr: '/src/runner/designRun.ts', rr: '/src/designer/runResults.ts', rf: '/src/designer/resultFocus.ts', identity: '/src/lib/resultIdentity.ts', sp: '/src/lib/sparams.ts' });
    const panel = '.dw-result .port-processing-panel';
    const open = async () => { await s.wait(`${panel} summary`); if (!(await page.$eval(panel, e => e.open))) await page.locator(`${panel} summary`).click(); };
    const select = async index => {
      await s.ev((index, m) => { const r = window.__portControls[index]; m.dr.setDesignResult(r); m.rf.focusResult({ file: r.file, view: 'sparams' }, 'main'); }, index,
        { dr: '/src/runner/designRun.ts', rf: '/src/designer/resultFocus.ts' });
      await s.waitFor(async index => (await import('/src/runner/designRun.ts')).designResult()?.file === window.__portControls[index].file, index);
      await open();
    };
    await open();
    assert.ok((await page.$eval(panel, e => e.textContent)).includes(await s.T('portProcessing.reference')));
    for (let i = 0; i < 3; i++) assert.ok((await page.$eval(panel, e => e.textContent)).includes(await s.T('portProcessing.delay', { port: circuit.physical_ports[i], index: i + 1 })));
    const inputs = `${panel} input`;
    const fillNamed = async (name,value) => s.fill(await page.$(`${panel} input[name="${name}"]`),String(value));
    assert.equal(await page.$$eval(`${panel} input[inputmode="decimal"]`,els=>els.length),5,'locale-proof NumberField controls');
    assert.deepEqual(await page.$$eval(inputs, els => els.map(e => e.value)), ['35', '0', '0', '0', '0', '']);
    await fillNamed('port-reference-real',75);
    for (let i = 0; i < 3; i++) await fillNamed(`port-delay-${circuit.physical_ports[i]}`,delays[i]);
    await s.click('portProcessing.apply', { within: panel });
    await s.wait('.dw-result-bar .chip', await s.T('portProcessing.badge'));
    await s.wait('.port-processing-notice', await s.T('portProcessing.originalContext'));
    await page.locator(`${panel} summary`).click();
    await s.wait('.dw-result-bar .chip', await s.T('portProcessing.badge')); // survives closing the settings
    await page.select('.dw-result .result-format', 're_im');
    const copy = async () => {
      const pending = `port-control-copy-${Date.now()}`;
      await page.evaluate(value => navigator.clipboard.writeText(value), pending);
      await s.click('results.toolbar.copyData', { within: '.dw-result' }); await s.wait('.rdk-copy.copied');
      await s.waitFor(async value => (await navigator.clipboard.readText()) !== value, pending);
      return page.evaluate(() => navigator.clipboard.readText());
    };
    const copied = await copy(); checkTable(copied.trimEnd().split(/\r?\n/).map(row => row.split('\t')));
    await s.click('results.toolbar.csvTitle', { within: '.dw-result' });
    const csv = await download(downloads, '.csv'); assert.match(csv.name, /_postprocessed/); checkTable(parseCsv(csv.text));
    await s.click('results.toolbar.touchstoneTitle', { within: '.dw-result' });
    const ts = await download(downloads, '.s3p'); assert.match(ts.name, /_postprocessed/);
    assert.match(ts.text, /Postprocessed:/); assert.match(ts.text, /1 -> 7, 2 -> 2, 3 -> 19/);
    const network = parseTouchstoneNPort(ts.text, 3); assert.equal(network.z0, 75); assert.deepEqual(network.f, circuit.frequency_hz);
    network.s.forEach((matrix, k) => matrix.forEach((row, i) => row.forEach((z, j) => z.forEach((value, c) => near(value, circuit.target[k][i][j][c])))));
    await open(); await fillNamed('port-reference-real',-1);
    await s.click('portProcessing.apply', { within: panel }); await s.wait(`${panel} [role=alert]`, await s.T('portProcessing.error.settings'));
    assert.equal(await copy(), copied, 'invalid draft cannot change the displayed or exported matrix');
    await select(1);
    await s.gone('.port-processing-notice');
    assert.deepEqual(await page.$$eval(inputs, els => els.map(e => e.value)), ['35', '0', '0', '0', '0', '']);
    assert.ok(!(await copy()).includes('Postprocessed:'), 'another result starts at its stored reference');
    await select(0);
    await s.wait('.port-processing-notice');
    assert.deepEqual(await page.$$eval(inputs, els => els.map(e => e.value)), ['75', '0', '31', '77', '-18', '']);
    assert.equal(await copy(), copied, 'returning to the same loaded object retains its applied settings');
    const visual = await page.evaluate(auditInPage, panel); assert.deepEqual(visual, []);
    await page.screenshot({ path: join(out, `processed-${lang}.png`) });
    // Same actual panel, real mixed-mode basis. Physical IDs 7,19 map to original
    // canonical indices 1,3; D1's expected value is an explicit independent sum.
    await fillNamed('port-mixed-pairs','7,19');
    await s.click('portProcessing.apply', { within: panel });
    await s.wait('.port-result-body','Sdd11');
    const modalCopied=await copy(), modalRows=modalCopied.trimEnd().split(/\r?\n/).map(row=>row.split('\t'));
    const modalRe=modalRows[0].findIndex(h=>h.startsWith('Re Sdd11')), modalIm=modalRows[0].findIndex(h=>h.startsWith('Im Sdd11'));
    assert.ok(modalRe>0 && modalIm>0); assert.match(modalRows[0][modalRe],/P7-P19/);
    modalRows.slice(1).forEach((row,k)=>[0,1].forEach(q=>near(row[q?modalIm:modalRe],(circuit.target[k][0][0][q]-circuit.target[k][0][2][q]-circuit.target[k][2][0][q]+circuit.target[k][2][2][q])/2)));
    await s.click('results.toolbar.touchstoneTitle', { within: '.dw-result' });
    const modalFile=await download(downloads,'.ts');
    assert.match(modalFile.text,/^\[Version\] 2\.0/m); assert.match(modalFile.text,/^\[Mixed-Mode Order\] D1,3 C1,3 S2/m);
    assert.match(modalFile.text,/^\[Reference\] 75 75 75/m);
    const exportedRows=modalFile.text.split('[Network Data]\n')[1].split('[End]')[0].trim().split('\n').map(line=>line.split(/\s+/).map(Number));
    exportedRows.forEach((row,k)=>{ near(row[0],circuit.frequency_hz[k]); near(row[1],Number(modalRows[k+1][modalRe])); near(row[2],Number(modalRows[k+1][modalIm])); });
    await fillNamed('port-mixed-pairs','7,19;19,2');
    await s.click('portProcessing.apply', { within: panel }); await s.wait(`${panel} [role=alert]`,await s.T('portProcessing.error.pairs'));
    assert.equal(await copy(),modalCopied,'overlapping pairs leave the applied matrix unchanged');
    // Complex target retains typed coordinates, refuses standards-incompatible output,
    // and never draws a physical VSWR or Smith impedance grid for power waves.
    await fillNamed('port-mixed-pairs','7,19'); await fillNamed('port-reference-imaginary',25);
    await s.click('portProcessing.apply', { within: panel });
    await s.wait(panel,await s.T('portProcessing.complexLimits'));
    assert.match(await copy(),/target=75\+j25/);
    const filesBefore=await readdir(downloads);
    await s.click('results.toolbar.touchstoneTitle', { within: '.dw-result' });
    await s.wait('.toast-error',await s.T('portProcessing.touchstoneComplex'));
    assert.deepEqual(await readdir(downloads),filesBefore,'refused complex export writes no file');
    for(const view of ['smith','vswr']) {
      await s.ev((view,m)=>m.rf.focusResult({file:window.__portControls[0].file,view},'main'),view,{rf:'/src/designer/resultFocus.ts'});
      await s.wait('.port-result-body',await s.T('portProcessing.complexLimits'));
      assert.equal(await page.$('.port-result-body .chart svg'),null);
    }
    await select(0); await open();
    await s.click('portProcessing.reset', { within: panel }); await s.gone('.port-processing-notice');
    assert.ok(!(await copy()).includes('Postprocessed:'), 'reset returns original evidence');
    await select(2); await s.wait(panel, await s.T('portProcessing.error.matrix'));
    assert.equal(await page.$(`${panel} form`), null, 'incomplete matrix has no Apply path');
    await page.screenshot({ path: join(out, `incomplete-${lang}.png`) });
    assert.deepEqual(forbidden, []); assert.deepEqual(s.consoleIssues, []);
    assert.equal(await page.evaluate(() => window.__portControls.every((r, i) => JSON.stringify(r.bundle) === window.__portRawSnapshots[i])), true,
      'processing cannot mutate any loaded original object');
    // All persisted fixture bytes remain original after Apply, refusal, switching and Reset.
    for (const r of records) assert.deepEqual(JSON.parse(await readFile(join(stack.projects, r.file), 'utf8')), r.bundle);
    outcomes.push({ lang, physicalPorts: circuit.physical_ports, targetOhm: 75, delayPs: delays, copied,
      csv: csv.name, touchstone: ts.name, mixedTouchstone:modalFile.name, complexExportRefused:true,
      mixedPhysicalMapping:true, overlappingPairsRefused:true, complexSmithVswrUnavailable:true,
      invalidRefused: true, incompleteRefused: true, identityIsolated: true, rawUnchanged: true, visual });
    await context.close();
  }
  await writeFile(join(out, 'result.json'), JSON.stringify({ outcomes, forbidden, syntheticOnly: true, speechTested: false }, null, 2));
  console.log(JSON.stringify({ out, languages: outcomes.map(r => r.lang), syntheticOnly: true, forbidden }, null, 2));
} catch (error) {
  let screenshotError; await page?.screenshot({ path: join(out, 'failure.png') }).catch(e => { screenshotError = String(e); });
  await writeFile(join(out, 'failure.json'), JSON.stringify({ error: String(error?.stack || error), lang: activeLang, screenshotError,
    console: session?.consoleIssues, forbidden, completed: outcomes, children: stack?.diagnostics() },
  (_key, value) => typeof value === 'string' ? safeDiagnosticText(value) : value, 2));
  throw error;
} finally { try { await browser?.close(); } finally { await stack?.stop(); } }
