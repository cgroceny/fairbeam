// Authored remote acceptance: explicit synthetic data; no solver/render start is permitted.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { startStack, chromePath, root } from './scenarios/stack.mjs';
import { Session, auditInPage } from './scenarios/harness.mjs';
if (process.env.GITHUB_ACTIONS !== 'true' && process.env.FAIRBEAM_ALLOW_BROWSER_TEST !== '1') throw new Error('Browser test requires remote CI or explicit user permission.');
const out = resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || join(tmpdir(), 'fairbeam-scenario-failures'), 'pattern-cuts');
await mkdir(out, { recursive: true });
const template = JSON.parse(await readFile(join(root, 'public/projects/patch-antenna.json'), 'utf8'));
const fixture = () => {
  const b = structuredClone(template), theta = Array.from({length:19}, (_, i) => i * 10), phi = Array.from({length:36}, (_, i) => i * 10);
  const grid = theta.map(t => phi.map(p => 20 * Math.cos(t * Math.PI / 180) + 5 * Math.sin(t * Math.PI / 180) * Math.cos(p * Math.PI / 180)));
  b.name = 'SYNTHETIC cut analyzer'; b.model.name = b.name;
  b.model.description = 'Analytic synthetic angular data for UI acceptance; no simulation or measurement.';
  b.half_space = null; b.run = null;
  const ff = { ...b.results.farfield[0], theta, phi, directivity_dbi: grid, dmax_dbi: 20, rad_efficiency: 0.5, gain_dbi: 20 + 10*Math.log10(0.5) };
  ff.cp = { rhcp_dbi: grid.map(r => r.map(v => v-4)), lhcp_dbi: grid.map(r => r.map(v => v-7)), axial_ratio_db: grid.map(r => r.map(() => 3)),
    peak: {theta:0,phi:0,rhcp_dbi:16,lhcp_dbi:13,axial_ratio_db:3}, boresight: {theta:0,phi:0,rhcp_dbi:16,lhcp_dbi:13,axial_ratio_db:3} };
  b.results.farfield = [ff]; delete b.results.element_patterns;
  return b;
};
let stack, browser, activePage, session;
const outcomes = [];
try {
  stack = await startStack({ log: console.log, niceSolver: false });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(), args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  for (const lang of ['en', 'tr']) {
    const context = await browser.createBrowserContext(), page = activePage = await context.newPage(), starts = [];
    await page.setRequestInterception(true);
    page.on('request', req => {
      const path = new URL(req.url()).pathname;
      if (req.method() === 'POST' && /^\/api\/(?:runs|sweeps|convergence|optimizations|research\/runs|render-jobs)(?:\/|$)/.test(path)) { starts.push(path); void req.abort(); }
      else void req.continue();
    });
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument(language => localStorage.setItem('fairbeam.generalSettings', JSON.stringify({language})), lang);
    const s = session = new Session(page, {lang, scenario:'pattern-cuts', url:stack.url, artifactDirectory:out});
    await page.goto(stack.url, {waitUntil:'domcontentloaded'}); await s.wait('.home');
    await s.fill(await s.field(await s.T('home.newProject.name')), `Pattern cuts ${lang}`, {blur:false});
    await s.click('home.newProject.create'); await s.wait('.rb');
    const own = await s.store((_, m) => JSON.parse(JSON.stringify(m.s.file())));
    const b = fixture(); b.model.id = own.design.model.id;
    const file = `${own.id}--SYNTHETIC-pattern-cuts.json`;
    const showDesign = async next => {
      // Focus resolves a saved run through the normal loader. Persist the explicit
      // synthetic fixture and give each replacement its own index generation.
      const saved = {...next, created:new Date().toISOString()};
      await writeFile(join(stack.projects,file),JSON.stringify(saved));
      await s.ev(({b,file}, m) => {
        const validated = m.v.validateBundle(b); if (!validated.bundle) throw new Error(JSON.stringify(validated.errors));
        if (JSON.stringify(validated.bundle.half_space) !== JSON.stringify(b.half_space)) throw new Error('Synthetic half-space fixture was not preserved by admission');
        m.st.setIndex([...m.st.index().filter(r => r.file !== file), {file,model:b.model.id,name:b.name,created:b.created,simulated:true,bands:[],params:[]}]);
        m.dr.setDesignResult({file,bundle:validated.bundle}); m.rf.focusResult({file,view:'pattern'}, 'main');
      }, {b:saved,file}, {st:'/src/state.ts',dr:'/src/runner/designRun.ts',rf:'/src/designer/resultFocus.ts',v:'/src/lib/validate.ts'});
    };
    await showDesign(b); await s.wait('.dw-result .pattern-analyzer');
    const checkControls = async scope => {
      const kind = `${scope} [data-pattern-cut="kind"]`, angle = `${scope} [data-pattern-cut="angle"]`, projection = `${scope} [data-pattern-cut="projection"]`;
      await page.select(kind, 'elevation'); await s.fill(angle, '17.5');
      await s.waitFor(async () => (await import('/src/compare/store.ts')).cutPhi() === 17.5);
      await s.wait(`${scope} [data-pattern-metrics]`, '17.5'); // cut coordinates retain their explicit numeric identity
      await s.fill(angle, '17,5');
      assert.equal(await page.$eval(angle, e => e.value), '17.5', 'decimal comma normalizes to a point');
      await page.focus(angle); await page.keyboard.press('ArrowUp');
      await s.waitFor(async () => (await import('/src/compare/store.ts')).cutPhi() === 18.5);
      await page.keyboard.press('ArrowDown');
      await s.waitFor(async () => (await import('/src/compare/store.ts')).cutPhi() === 17.5);
      await page.select(kind, 'conical'); await s.fill(angle, '60');
      await s.waitFor(async () => (await import('/src/lib/patternCutStore.ts')).cutTheta() === 60);
      await page.select(projection, 'cartesian');
      await s.wait(`${scope} svg`, 'φ (°)');
      const fb = (20 + 5*Math.sqrt(3)).toFixed(2).replace('.', lang === 'tr' ? ',' : '.');
      await s.wait(`${scope} [data-pattern-metrics]`, fb);
      await s.fill(angle, '181', {blur:false});
      assert.equal(await s.ev((_,m) => m.p.cutTheta(), null, {p:'/src/lib/patternCutStore.ts'}),60,'typing a partial angle does not change the committed cut');
      await page.keyboard.press('Tab'); await s.waitFor(sel => document.querySelector(sel)?.getAttribute('aria-invalid') === 'true', angle);
      assert.equal(await s.ev((_,m) => m.p.cutTheta(), null, {p:'/src/lib/patternCutStore.ts'}),60,'invalid input preserves the last valid cut');
      assert.ok((await page.$eval(`${scope} [role="alert"]`, e => e.textContent)).includes(await s.T('patternCuts.invalid',{max:180})));
      await s.click('patternCuts.azimuth',{within:scope,exact:true});
      assert.equal(await page.$eval(angle,e=>e.value),'90');
      await s.fill(angle,'60'); await page.select(projection,'polar');
      await s.wait(`${scope} svg`, '60°');
      assert.deepEqual(await page.evaluate(auditInPage,scope),[]);
      await page.screenshot({path:join(out,`cuts-${scope.includes('dw-result')?'design':'examples'}-${lang}.png`)});
    };
    await checkControls('.dw-result .pattern-analyzer');
    for (const q of ['rhcp','lhcp','gain','realized','directivity']) {
      await page.select('.dw-result .ff-quantity',q);
      await s.wait('.dw-result [data-pattern-metrics]',await s.T(`farfield.quantity.${q}`));
    }
    const half = structuredClone(b); half.half_space = {axis:'z',side:'min',position:0,kind:'PEC'};
    await showDesign(half); await s.wait('.dw-result [data-pattern-metrics]',await s.T('patternCuts.reason.halfSpace'));
    await s.fill('.dw-result [data-pattern-cut="angle"]','120');
    await s.wait('.dw-result .pattern-analyzer',await s.T('patternCuts.noCoverage'));
    await showDesign(b);
    await s.click('header.screen.examples',{sel:'.mode-switch button',exact:true}); await s.wait('.example-picker-trigger');
    await s.ev((b,m)=>m.st.openBundle(m.v.validateBundle(b).bundle,'SYNTHETIC-pattern-cuts.json'),b,{st:'/src/state.ts',v:'/src/lib/validate.ts'});
    await s.clickSel('.dock [data-tab="pattern"]'); await s.wait('.dock .pattern-analyzer');
    await checkControls('.dock .pattern-analyzer');
    const compared = fixture(); compared.name = 'SYNTHETIC compared cut'; compared.model.id = 'synthetic-compared-cut';
    compared.results.farfield[0].f *= 1.02;
    await s.ev((b,m)=>m.c.setPinned([{file:'SYNTHETIC-compared-cut.json',bundle:m.v.validateBundle(b).bundle,error:null}]),compared,{c:'/src/compare/store.ts',v:'/src/lib/validate.ts'});
    await s.waitFor(()=>document.querySelectorAll('.dock [data-pattern-metrics]').length === 2);
    assert.equal(await page.$$eval('.dock [data-pattern-cut="kind"] option[value="principal"]',e=>e.length),0,'comparison retains one selected cut per run');
    const exported = await s.ev((_,m)=>m.d.resultDataTable(m.st.bundle(),'pattern',undefined,{patternCut:m.p.patternCutChoice(),patternPrincipalAvailable:false,patternFallbackPhi:m.c.cutPhi()}),null,
      {d:'/src/designer/resultData.ts',st:'/src/state.ts',p:'/src/lib/patternCutStore.ts',c:'/src/compare/store.ts'});
    assert.ok(exported.header.includes('Peak / 3D antipode (dB)'));
    assert.ok(exported.rows.every(row=>row[exported.header.indexOf('theta (deg)')]===60));
    await page.setViewport({width:700,height:900});
    assert.deepEqual(await page.evaluate(auditInPage,'.dock .pattern-analyzer'),[]);
    await page.screenshot({path:join(out,`cuts-narrow-${lang}.png`)});
    assert.deepEqual(starts,[],'no solver or render submission attempted');
    assert.deepEqual(s.consoleIssues,[]);
    outcomes.push({lang,designs:true,examples:true,compare:true,arbitraryPhi:17.5,conicalTheta:60,halfSpaceRefused:true,invalidInputRetained:true,attemptedStarts:starts});
    await context.close(); activePage=undefined;
  }
  await writeFile(join(out,'result.json'),JSON.stringify({fixture:'synthetic analytic data; no solver',outcomes},null,2));
  console.log('Pattern cuts browser: EN/TR Designs/Examples controls, conical antipode, half-space refusal, compare, quantities, CSV and narrow layout passed.');
} catch(error) {
  await activePage?.screenshot({path:join(out,'failure.png')}).catch(()=>{});
  await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error?.stack||error),outcomes,console:session?.consoleIssues,stack:stack?.diagnostics()},null,2));
  throw error;
} finally { await browser?.close(); await stack?.stop(); }
