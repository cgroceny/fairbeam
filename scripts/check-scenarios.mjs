import assert from "node:assert/strict";
// Scenario checks: realistic new-user tasks driven through the real UI in headless Chrome, each in
// English and in Turkish (docs/DESIGNER.md, "Scenario checks"). Every step asserts the expected
// state and audits the visuals (no horizontal overflow, no clipped text without a tooltip, no raw
// i18n keys) and the console (no errors or warnings from our code).
//
//   npm run check:scenarios                      all scenarios, both languages
//   node scripts/check-scenarios.mjs S3 --lang en   only S3, only English
//   node scripts/check-scenarios.mjs --skip-run  skip S1's one coarse solver run
//
// It starts Vite and a run server on free ports over a temp folder and stops both by PID.
// FAIRBEAM_CHROME points at another Chrome/Edge; FAIRBEAM_PYTHON at the python with openEMS.
import { mkdirSync, rmdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { chromePath, root, startStack } from './scenarios/stack.mjs';
import { Session, auditSelfTest, failureDir } from './scenarios/harness.mjs';
import { interactionSelfTest } from './scenarios/harness-self-test.mjs';

const args = process.argv.slice(2);
const langs = args.includes('--lang') ? [args[args.indexOf('--lang') + 1]] : ['en', 'tr'];
// A hosted CI runner is slow and noisy: a failing scenario gets one clean retry there (reported).
const ATTEMPTS = process.env.CI ? 2 : 1;
const retried = [];
const only = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--lang').map((a) => a.toUpperCase());
const compact = args.includes("--compact"); // Rust fit_for: normal minimum 1024x700; 728px work area gives 1024x688.
const ribbonFileAudit = args.includes('--ribbon-file-audit'); // S9: supported desktop widths and actual file chooser.
const skipRun = args.includes('--skip-run');
const t0 = Date.now();
const stamp = t0.toString(36).slice(-4); // design names stay unique when a dev stack is reused

const SCENARIOS = [];
for (const file of ['s1-build-patch', 's2-import', 's3-sweep-optimize', 's4-results', 's5-python-edit', 's6-python-design', 's7-designer-workflow', 's8-ports-fieldmap', 's8-appearance-export', 's9-context-export', 's10-rf-workflows', 's11-python-folders', 's12-single-solid-tree', 's13-appearance-presets', 's14-home-design-actions', 's16-cross-project-overlays']) {
  SCENARIOS.push((await import(`./scenarios/${file}.mjs`)).default);
}

// Scoped recovery uses the real server identities and browser persistence, without a solver.
SCENARIOS.push({
  id: 'S17', title: 'Scoped draft recovery keeps legacy and older drafts available',
  async run(s, ctx) {
    let saved, legacyKey, olderKey, matchingKey, legacy, older, edited;
    const snapshot = () => s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft)));
    const retained = () => s.page.evaluate(keys => keys.map(key => localStorage.getItem(key)), [legacyKey, olderKey]);
    const reloadDesign = async () => { const accept = dialog => void dialog.accept(); s.page.on('dialog',accept); try { await s.page.reload({waitUntil:'domcontentloaded'}); await s.wait('.rb'); await s.waitFor(async id => (await import('/src/designer/store.ts')).file()?.id === id, saved.id); } finally { s.page.off('dialog',accept); } };
    const saveUi = async () => { await s.click('ribbon.tab.home',{sel:'.rb-tab'}); await s.click('common.save',{sel:'.rb-btn'}); await s.waitFor(async()=>!(await import('/src/designer/store.ts')).dirty()); };
    await s.step('create a saved design and seed unscoped and older-base draft backups', async () => {
      console.log(`  S17 owned stack PIDs: ${ctx.stack.pids.join(', ')}`);
      await s.page.evaluateOnNewDocument(() => {
        window.__recoveryDownloads=[]; window.__recoveryNames=[];
        const create=URL.createObjectURL.bind(URL), click=HTMLAnchorElement.prototype.click;
        URL.createObjectURL=blob=>{if(blob instanceof Blob)blob.text().then(text=>window.__recoveryDownloads.push(text));return create(blob);};
        HTMLAnchorElement.prototype.click=function(){if(this.download)window.__recoveryNames.push(this.download);return click.call(this);};
      });
      await s.page.goto(s.url,{waitUntil:'domcontentloaded'});await s.wait('.home');
      await s.fill(await s.field(await s.T('home.newProject.name')),`Recovery ${s.lang} ${ctx.stamp}`,{blur:false});await s.click('home.newProject.create');await s.wait('.rb');
      const id=await s.store((_,m)=>m.s.file().id);
      saved=await s.page.evaluate(async id=>{const response=await fetch(`/api/designs/${id}`);if(!response.ok)throw new Error(await response.text());return response.json();},id);
      assert.match(saved.backup_scope,/^models-v1:[a-f0-9]{64}$/);assert.ok(saved.hash);
      legacyKey=`fairbeam:draft:${saved.id}`;
      olderKey=`fairbeam:draft:v2:${saved.backup_scope}:${encodeURIComponent(saved.id)}:older-saved-base`;
      matchingKey=`fairbeam:draft:v2:${saved.backup_scope}:${encodeURIComponent(saved.id)}:${encodeURIComponent(saved.hash)}`;
      legacy={at:1700000000000,base:saved.hash,design:{...saved.design,model:{...saved.design.model,description:'Legacy recovery draft'}}};
      older={version:2,scope:saved.backup_scope,id:saved.id,at:1700000001000,base:'older-saved-base',design:{...saved.design,model:{...saved.design.model,description:'Older saved-base recovery draft'}}};
      await s.page.evaluate(({legacyKey,olderKey,legacy,older})=>{localStorage.setItem(legacyKey,JSON.stringify(legacy));localStorage.setItem(olderKey,JSON.stringify(older));},{legacyKey,olderKey,legacy,older});
      await reloadDesign();assert.deepEqual(await snapshot(),saved.design);assert.equal(await s.store((_,m)=>m.s.dirty()),false);
      await s.wait('.dw-right .dz-msg',await s.T('store.legacyBackup'));
      await s.wait('.dw-right .dz-msg',await s.T('store.olderBackup',{at:new Date(older.at).toLocaleString()}));
      assert.deepEqual(await retained(),[JSON.stringify(legacy),JSON.stringify(older)]);
    });
    await s.step('Download older draft exports each exact draft and leaves recovery records intact',async()=>{
      const buttons=await s.page.$$('.dw-right .dz-msg button');assert.equal(buttons.length,2);
      for(let i=0;i<buttons.length;i++){
        await buttons[i].click();await s.waitFor(n=>window.__recoveryDownloads.length>n,i);
      }
      const downloads=await s.page.evaluate(()=>({names:window.__recoveryNames,texts:window.__recoveryDownloads}));
      assert.deepEqual(downloads.names,[`${saved.id}.recovered-${legacy.at}.design.json`,`${saved.id}.recovered-${older.at}.design.json`]);
      assert.deepEqual(downloads.texts.map(text=>JSON.parse(text)),[legacy.design,older.design]);
      assert.deepEqual(await retained(),[JSON.stringify(legacy),JSON.stringify(older)]);assert.deepEqual(await snapshot(),saved.design);
    });
    await s.step('an actual matching scoped draft reloads and one Undo returns the saved design',async()=>{
      await s.store((_,m)=>m.s.edit(d=>d.model.description='Current scoped unsaved browser draft'));
      edited=await snapshot();await s.waitFor(key=>!!localStorage.getItem(key),matchingKey);
      const backup=await s.page.evaluate(key=>JSON.parse(localStorage.getItem(key)),matchingKey);
      assert.equal(backup.scope,saved.backup_scope);assert.equal(backup.base,saved.hash);assert.deepEqual(backup.design,edited);
      await reloadDesign();assert.deepEqual(await snapshot(),edited);assert.equal(await s.store((_,m)=>m.s.dirty()),true);
      await s.wait('.dw-right .dz-msg',await s.T('store.restored',{at:new Date(backup.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}));
      await s.click('ribbon.tab.home',{sel:'.rb-tab'});await s.click('ribbon.home.undo',{sel:'.rb-btn'});
      assert.deepEqual(await snapshot(),saved.design);assert.equal(await s.store((_,m)=>m.s.dirty()),false);
      await s.click('ribbon.home.redo',{sel:'.rb-btn'});assert.deepEqual(await snapshot(),edited);
      assert.deepEqual(await retained(),[JSON.stringify(legacy),JSON.stringify(older)]);
    });
    await s.step('saving and closing remove only the matching draft and preserve older recovery files',async()=>{
      await saveUi();assert.equal(await s.page.evaluate(key=>localStorage.getItem(key),matchingKey),null);
      assert.deepEqual(await retained(),[JSON.stringify(legacy),JSON.stringify(older)]);
      await s.click('ribbon.tab.home',{sel:'.rb-tab'});await s.click('common.close',{sel:'.rb-btn'});await s.wait('.home');
      assert.deepEqual(await retained(),[JSON.stringify(legacy),JSON.stringify(older)]);
      await s.page.locator(`[data-home-design="${saved.id}"] .home-item`).click();await s.wait('.rb');
      assert.deepEqual(await snapshot(),edited);assert.equal(await s.store((_,m)=>m.s.dirty()),false);
      await s.wait('.dw-right .dz-msg',await s.T('store.legacyBackup'));
      assert.deepEqual(await retained(),[JSON.stringify(legacy),JSON.stringify(older)]);
    });
    await s.step('an unverified server scope warns and a rejected save retains the edited draft',async()=>{
      const record=await s.page.evaluate(async id=>(await(await fetch(`/api/designs/${id}`)).json()),saved.id);
      await s.click('ribbon.tab.home',{sel:'.rb-tab'});await s.click('common.close',{sel:'.rb-btn'});await s.wait('.home');
      const session=await s.page.createCDPSession();
      await session.send('Fetch.enable',{patterns:[{urlPattern:`${s.url}api/designs/${saved.id}`,requestStage:'Request'}]});
      session.on('Fetch.requestPaused',event=>session.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify({...record,backup_scope:'unverified-server-scope'})).toString('base64')}));
      try{
        await s.page.locator(`[data-home-design="${saved.id}"] .home-item`).click();await s.wait('.rb');
        await s.wait('.dw-right .dz-msg',await s.T('store.backupScopeUnavailable'));
        assert.deepEqual(await snapshot(),record.design);
      }finally{await session.send('Fetch.disable');await session.detach();}
      await s.store((_,m)=>m.s.edit(d=>d.model.description='Must survive rejected scope save'));const attempted=await snapshot();
      s.consoleAllow.push(/Failed to load resource:.*409/);
      await s.click('ribbon.tab.home',{sel:'.rb-tab'});await s.click('common.save',{sel:'.rb-btn'});
      await s.wait('.dw-right .dz-msg',await s.T('store.workspaceChanged'));
      assert.deepEqual(await snapshot(),attempted);assert.equal(await s.store((_,m)=>m.s.dirty()),true);
      const after=await s.page.evaluate(async id=>(await(await fetch(`/api/designs/${id}`)).json()),saved.id);
      assert.equal(after.hash,record.hash);assert.deepEqual(after.design,record.design);
      assert.deepEqual(await retained(),[JSON.stringify(legacy),JSON.stringify(older)]);
      assert.equal(await s.page.evaluate(()=>Object.keys(localStorage).some(k=>k.includes('unverified-server-scope'))),false);
    });
  },
});

// Cross-process solver lock so two checks never run the solver at once: mkdir takes it, rmdir releases it
const LOCK = '/tmp/fairbeam-sim.lock';
function takeSimLock() {
  try { mkdirSync(LOCK); } catch { return null; }
  let held = true;
  const release = () => { if (held) { held = false; try { rmdirSync(LOCK); } catch { /* gone */ } } };
  process.once('exit', release);
  return release;
}

let stack, browser;
const cleanup = async () => {
  try { await browser?.close(); } catch { /* closed */ }
  browser = undefined;
  try { await stack?.stop(); } catch { /* stopped */ }
  stack = undefined;
};
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, async () => { await cleanup(); process.exit(130); });

const results = [];
try {
  const puppeteerModule = process.env.FAIRBEAM_PUPPETEER
    ? await import(pathToFileURL(process.env.FAIRBEAM_PUPPETEER).href)
    : await import(pathToFileURL(createRequire(import.meta.url).resolve('puppeteer-core')).href);
  const puppeteer = puppeteerModule.default ?? puppeteerModule;
  const reuse = process.env.FAIRBEAM_SCENARIO_STACK ? JSON.parse(process.env.FAIRBEAM_SCENARIO_STACK) : null;
  stack = reuse ? { ...reuse, stop: async () => {} } : await startStack({ log: (m) => console.log(m) });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(), args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  {
    const page = await browser.newPage();
    await auditSelfTest(page); console.log('Visual audit self-test passed.');
    await interactionSelfTest(page); console.log('Pointer interaction self-test passed.');
    // Vite's first request transforms the app's module graph. Check actual app readiness once,
    // before the scenario contexts, instead of spending a step's 15s wait on a cold dev server.
    await page.goto(stack.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('.home', { visible: true, timeout: 45000 });
    await page.close();
  }
  console.log(`Scenario checks (${langs.join(', ')}); failing screenshots go to ${failureDir}`);
  for (const scenario of SCENARIOS) {
    if (only.length && !only.includes(scenario.id)) continue;
    for (const lang of langs) for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      console.log(`\n${scenario.id} ${scenario.title} [${lang}]${attempt > 1 ? ` (retry ${attempt - 1} on CI)` : ''}`);
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      // CI hosts often have system animations off; the app then honours prefers-reduced-motion and
      // pauses animations (fieldPlaneClock.ts). Scenarios test the default, motion-enabled behaviour.
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
      await page.setViewport({ width: compact ? 1024 : 1440, height: compact ? 688 : 900 });
      page.setDefaultTimeout(process.env.CI ? 40000 : 20000); // hosted runners are much slower
      // The first browser navigation can overlap Vite's cold transform of the full TSX module graph.
      // Keep waits bounded at 20s while allowing that initial dev-server navigation to finish.
      page.setDefaultNavigationTimeout(45000);
      await page.evaluateOnNewDocument((l) => { try { const saved=JSON.parse(localStorage.getItem('fairbeam.generalSettings')||'{}'); localStorage.setItem('fairbeam.generalSettings', JSON.stringify({ ...saved, language: l })); } catch { /* blocked */ } }, lang);
      const s = new Session(page, { lang, scenario: scenario.id, url: stack.url });
      try {
        await scenario.run(s, { stack, root, skipRun, takeSimLock, stamp: attempt > 1 ? `${stamp}r${attempt}` : stamp, compact, ribbonFileAudit });
      } catch (e) {
        if (!e.fatalStep) { console.log(`  FAIL ${scenario.id}/${lang} scenario error: ${e.message}`); s.results.push({ scenario: scenario.id, lang, step: 'scenario', ok: false, problems: [e.stack ?? e.message], ms: 0 }); }
      }
      await context.close();
      const failed = s.results.some((r) => !r.ok);
      if (failed && attempt < ATTEMPTS) { retried.push(`${scenario.id}/${lang}`); continue; }
      results.push(...s.results);
      break;
    }
  }
} catch (e) {
  console.error(`Scenario setup failed: ${e.stack ?? e.message}`);
  results.push({ scenario: '-', lang: '-', step: 'setup', ok: false, problems: [e.message], ms: 0 });
} finally {
  await cleanup();
}

console.log('\nSummary');
for (const sc of SCENARIOS) for (const lang of langs) {
  const rs = results.filter((r) => r.scenario === sc.id && r.lang === lang);
  if (!rs.length) continue;
  const bad = rs.filter((r) => !r.ok);
  console.log(`  ${sc.id} ${lang}: ${bad.length ? `FAIL (${bad.length} of ${rs.length} steps: ${bad.map((b) => b.step).join('; ')})` : `ok (${rs.length} steps)`}`);
}
const failed = results.filter((r) => !r.ok).length;
if (retried.length) console.log(`Retried once on CI after a failure: ${retried.join(', ')}`);
console.log(`${failed ? 'FAILED' : 'PASSED'}: ${results.length} steps, ${failed} failing, ${Math.round((Date.now() - t0) / 1000)} s.`);
process.exit(failed ? 1 : 0);
