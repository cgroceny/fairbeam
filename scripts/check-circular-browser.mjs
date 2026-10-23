// Remote-only acceptance: real Designer save/reopen plus explicitly synthetic CP results.
// No solver, renderer job or native action. Do not run locally without user permission.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import puppeteer from 'puppeteer-core';
import {root, startStack, chromePath, pythonPath} from './scenarios/stack.mjs';
import {Session, auditInPage} from './scenarios/harness.mjs';
import {safeDiagnosticText} from './scenarios/startup-diagnostics.mjs';

if(process.env.GITHUB_ACTIONS!=='true'&&process.env.FAIRBEAM_ALLOW_BROWSER_TEST!=='1')
  throw new Error('Browser test requires remote CI or explicit user permission (FAIRBEAM_ALLOW_BROWSER_TEST=1).');
const out=resolve(process.env.FAIRBEAM_TEST_ARTIFACTS||join(tmpdir(),`fairbeam-circular-${Date.now()}`),'circular');
await mkdir(out,{recursive:true});
const fixtureFields=JSON.parse(execFileSync(pythonPath(),[join(root,'python/tests/test_designer_circular.py'),'--json'],{encoding:'utf8'}));
const original=JSON.parse(await readFile(join(root,'public/projects/helix-axial.json'),'utf8'));
let stack,browser,page,session,activeLang;
const outcomes=[],forbidden=[];
try {
  stack=await startStack({log:console.log});
  browser=await puppeteer.launch({headless:true,executablePath:await chromePath(),args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader']});
  for(const lang of ['en','tr']){
    activeLang=lang;
    const context=await browser.createBrowserContext();
    await context.overridePermissions(stack.url,['clipboard-read','clipboard-write','clipboard-sanitized-write']);
    page=await context.newPage();await page.setViewport({width:1440,height:1000});
    await page.evaluateOnNewDocument(language=>localStorage.setItem('fairbeam.generalSettings',JSON.stringify({language})),lang);
    await page.setRequestInterception(true);
    page.on('request',request=>{
      const path=new URL(request.url()).pathname;
      const job=/^\/api\/(?:runs|sweeps|convergence|optimizations|research\/runs|render-jobs)(?:\/|$)/.test(path);
      const native=/^\/api\/(?:native-document(?:\/|$)|(?:research\/elmer\/install|blender\/open-download|open-feedback|renders\/[A-Za-z0-9_-]+\/open)\/?$)/.test(path);
      if(request.method()==='POST'&&(job||native)){forbidden.push(request.url());void request.abort();}else void request.continue();
    });
    const s=session=new Session(page,{lang,scenario:'circular',url:stack.url,artifactDirectory:out});
    await page.goto(stack.url,{waitUntil:'domcontentloaded'});await s.wait('.home',undefined,{timeout:45000});
    await page.locator('input[name="home-template"][value="patch"]').click();
    await s.fill(await s.field(await s.T('home.newProject.name')),`Circular settings ${lang}`,{blur:false});
    await s.click('home.newProject.create');await s.wait('.rb');
    const openMonitors=async()=>{await s.ev(async()=>(await import('/src/designer/simSettingsState.ts')).openSimSettings('monitors'));await s.wait('.ss-dialog');};
    await openMonitors();
    // Native checkbox semantics plus actual draft transaction: Discard rolls it back.
    let control=await s.field(await s.T('sim.mon.circular'));
    assert.equal(await control.evaluate(e=>e.checked),false);
    await control.click();
    await s.click('sim.discard',{within:'.ss-dialog'});
    await s.waitFor(async()=>(await import('/src/designer/store.ts')).draft.far_field.circular!==true);
    await openMonitors();control=await s.field(await s.T('sim.mon.circular'));await control.click();
    assert.equal(await control.evaluate(e=>e.checked),true);
    await s.wait('.ss-dialog',await s.T('sim.mon.circularNote'));
    assert.deepEqual(await page.evaluate(auditInPage,'.ss-dialog'),[]);
    await page.screenshot({path:join(out,`settings-${lang}.png`)});
    await s.click('common.ok',{within:'.ss-dialog'});
    const id=await s.store((_,m)=>m.s.file().id);
    await s.click('ribbon.tab.home',{sel:'.rb-tab'});await s.click('common.save',{sel:'.rb-btn'});
    await s.waitFor(async()=>{const m=await import('/src/designer/store.ts');return !m.dirty()&&!m.saving();});
    await page.reload({waitUntil:'domcontentloaded'});await s.wait('.rb');
    await s.waitFor(async id=>{const m=await import('/src/designer/store.ts');return m.file()?.id===id&&m.draft.far_field.circular===true;},id);
    outcomes.push({lang,settingsDefault:false,discard:true,saveReopen:true});
    const readout=async key=>{
      const label=await s.T(key);
      return page.$eval('.dock', (dock,label)=>[...dock.querySelectorAll('dt')].find(e=>e.textContent===label)?.nextElementSibling?.textContent,label);
    };
    // These are analytical field fixtures, not new EM runs or antenna qualification.
    for(const name of ['rhcp','linear','elliptical','null-boresight','off-boresight','low-directivity','zero','missing']){
      const ff=structuredClone(fixtureFields.find(f=>f.name===(name==='missing'?'rhcp':name)));
      if(name==='missing')delete ff.cp;
      const b=structuredClone(original);b.run=null;b.model.id=`synthetic-cp-${name}`;b.model.name=`Synthetic CP ${name}`;b.results.farfield=[ff];
      const file=join(out,`${name}-${lang}.json`);await writeFile(file,JSON.stringify(b));
      await (await page.$('.app-header input[type=file]')).uploadFile(file);
      await s.waitFor(async id=>(await import('/src/state.ts')).bundle()?.model.id===id,b.model.id);
      await s.wait('.dock [data-tab="pattern"]');await page.click('.dock [data-tab="pattern"]');
      await page.select('.dock [data-pattern-cut=kind]','principal');
      const select=await s.wait('.dock select[aria-label]',await s.T('farfield.quantityAria'));
      const unavailable=['zero','missing'].includes(name);
      assert.equal(await select.evaluate(e=>e.querySelector('option[value="axial_ratio"]').disabled),unavailable);
      if(!unavailable){
        await select.select('axial_ratio');
        await s.waitFor(async()=>(await import('/src/lib/patternQuantityStore.ts')).patternQuantity()==='axial_ratio');
        await s.wait('.dock',await s.T('farfield.arNote',{threshold:20,cap:60}));
        const legend=await page.$eval('.dock .polar-chart .legend-note',e=>e.textContent);
        assert.ok(legend.includes('dB')&&!legend.includes('dBi'),'AR polar axis uses dB');
        if(['null-boresight','off-boresight'].includes(name))assert.equal(await readout('farfield.arBoresight'),'—');
        if(name==='linear')assert.match(await readout('farfield.arPeak'),/≥\s*60[.,]00\s*dB/);
        if(name==='rhcp')assert.match(await readout('farfield.arPeak'),/^0[.,]00\s*dB$/);
        await page.select('.dock [data-pattern-cut=kind]','conical');
        await s.fill('.dock [data-pattern-cut=angle]',String(name==='low-directivity'?0:45));
        await s.wait('.dock [data-pattern-metrics]',await s.T('patternCuts.reason.quantity'));
        await s.click('results.toolbar.copyData',{within:'.dock'});await s.wait('.dock-copy.copied');
        const rows=(await page.evaluate(()=>navigator.clipboard.readText())).trimEnd().split(/\r?\n/).map(r=>r.split('\t'));
        const arColumn=rows[0].indexOf('Axial ratio (dB)'),phiColumn=rows[0].indexOf('phi (deg)');
        assert.ok(arColumn>=0);
        assert.ok(rows.slice(1).every(row=>row[rows[0].indexOf('HPBW status')]==='quantity'));
        if(name==='low-directivity'){assert.equal(rows.find((r,i)=>i>0&&Number(r[phiColumn])===90)[arColumn],'0');assert.equal(rows.find((r,i)=>i>0&&Number(r[phiColumn])===180)[arColumn],'');}
        await page.select('.dock [data-pattern-cut=projection]','cartesian');
        await s.wait('.dock .pattern-analyzer .chart-container');
        await page.select('.dock [data-pattern-cut=projection]','polar');
        await page.click('.dock .freq-chips button');await s.wait('.ff-card');
        assert.equal(await page.$eval('.ff-card select',e=>e.value),'axial_ratio');
        assert.equal(await page.$eval('.ff-card .ff-scale-unit',e=>e.textContent),await s.T('farfield.arScale'));
        assert.deepEqual(await page.$$eval('.ff-card .colorbar-ticks-round > span',els=>els.map(e=>e.textContent.trim())),['0','30','60 dB']);
        assert.deepEqual(await page.evaluate(auditInPage,'.ff-card'),[]);
        await page.screenshot({path:join(out,`${name}-${lang}.png`)});
      } else {
        assert.equal(await select.evaluate(e=>e.value),'directivity');
        if(name==='zero')assert.equal(await readout('farfield.arPeak'),'—');
      }
      assert.deepEqual(await page.evaluate(auditInPage,'.dock'),[]);
      outcomes.push({lang,synthetic:name,arAvailable:!unavailable});
    }
    assert.deepEqual(forbidden,[],'no solver/native actions requested');
    assert.deepEqual(s.consoleIssues,[],'no unexpected app console issue');
    await context.close();
  }
  await writeFile(join(out,'result.json'),JSON.stringify({outcomes,forbidden,syntheticOnly:true},null,2));
  console.log(JSON.stringify({out,outcomes},null,2));
}catch(error){
  let screenshotError;await page?.screenshot({path:join(out,'failure.png')}).catch(e=>{screenshotError=String(e);});
  await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error?.stack||error),lang:activeLang,url:page?.url(),screenshotError,console:session?.consoleIssues,forbidden,completed:outcomes,children:stack?.diagnostics()},(_key,value)=>typeof value==='string'?safeDiagnosticText(value):value,2)).catch(e=>console.error(safeDiagnosticText(e)));
  throw error;
}finally{try{await browser?.close();}finally{await stack?.stop();}}
