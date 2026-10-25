// Remote acceptance with explicitly synthetic scalars; no solver/renderer/native actions.
// Authored for root's serial remote queue, never launched locally without permission.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import puppeteer from 'puppeteer-core';
import {root, startStack, chromePath, pythonPath} from './scenarios/stack.mjs';
import {Session, auditInPage} from './scenarios/harness.mjs';
import {safeDiagnosticText, withStartupDiagnostics} from './scenarios/startup-diagnostics.mjs';
if(process.env.GITHUB_ACTIONS!=='true'&&process.env.FAIRBEAM_ALLOW_BROWSER_TEST!=='1')
  throw new Error('Browser test requires remote CI or explicit user permission (FAIRBEAM_ALLOW_BROWSER_TEST=1).');
const out=resolve(process.env.FAIRBEAM_TEST_ARTIFACTS||join(tmpdir(),`fairbeam-radiation-${Date.now()}`),'radiation-frequency');
await mkdir(out,{recursive:true});
const records=JSON.parse(execFileSync(pythonPath(),[join(root,'python/tests/test_radiation_frequency.py'),'--json'],{encoding:'utf8'}));
const original=JSON.parse(await readFile(join(root,'public/projects/helix-axial.json'),'utf8'));
const fixture=()=>{
  const b=structuredClone(original);b.name=b.model.name='Synthetic radiation scalar control';b.model.id='synthetic-radiation';b.results.farfield=[];
  b.run=null; // Synthetic scalars must not inherit the source example's historical Metal run.
  const a=structuredClone(records.find(r=>r.name==='baseline'));a.reliable=[true,false,true];a.pacc_error=[.02,.2,.04];
  const p=structuredClone(a);p.port=19;p.radiation.realized_peak_dbi=[-31,-32,-33];p.radiation.ar_boresight_db=[2,null,4];
  // Only the bundle envelope is reused. No historical geometry, mesh, resonance,
  // S-matrix, timing or source attribution is part of this analytic control.
  b.created='2026-10-24T00:00:00Z';b.generator={name:'synthetic-browser-control',version:'1',openems:null,csxcad:null,python:'not a solver run'};
  b.model.description='Synthetic scalar and reflection samples; no physical simulation or convergence claim.';
  delete b.model.reference;b.model.params=[];b.parts=[];b.half_space=null;b.nf2ff_box=null;b.nf2ff_center=null;b.focus=null;
  b.domain={min:[-1,-1,-1],max:[1,1,1]};
  b.mesh={x:[-1,0,1],y:[-1,0,1],z:[-1,0,1],cells:[2,2,2],total_cells:8,min_cell:1,max_cell:1};
  b.ports=[7,19].map(number=>({number,type:'lumped',R:50,direction:'z',start:[0,0,-1],stop:[0,0,1],excite:true}));
  const port=()=>({s11_re:[.1,.2,.3],s11_im:[0,0,0],zin_re:[50*1.1/.9,75,50*1.3/.7],zin_im:[0,0,0],z_ref:50});
  b.results={frequency:a.f,ports:{'7':port(),'19':port()},bands:[],farfield:[],signals:{},efficiency:[a,p]};
  return b;
};
let stack,browser,page,session,activeLang;
const outcomes=[],forbidden=[];
try{
  stack=await startStack({log:console.log});
  browser=await puppeteer.launch({headless:true,executablePath:await chromePath(),args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader']});
  for(const lang of ['en','tr']){
    activeLang=lang;const context=await browser.createBrowserContext();
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
    const s=session=new Session(page,{lang,scenario:'radiation-frequency',url:stack.url,artifactDirectory:out});
    await withStartupDiagnostics(page, {directory:join(out, `startup-${lang}`), stack}, async () => {
      await page.goto(stack.url,{waitUntil:'domcontentloaded'});await s.wait('.home',undefined,{timeout:45000});
    });
    const b=fixture(),file=join(out,`synthetic-${lang}.json`);await writeFile(file,JSON.stringify(b));
    await (await page.$('.app-header input[type=file]')).uploadFile(file);
    await s.waitFor(async()=>(await import('/src/state.ts')).bundle()?.model.id==='synthetic-radiation');
    await s.wait('.dock [data-tab="radiation"]');await page.click('.dock [data-tab="radiation"]');
    const verify=async(surface)=>{
      const select=`${surface} .radiation-select select`;
      await page.select(select,'realized_peak_dbi');
      await s.wait(`${surface} [data-radiation-frequency]`,await s.T('radiation.note'));
      assert.ok((await page.$$eval(`${surface} .line-chart-legend .legend-item`,els=>els.map(e=>e.textContent))).some(t=>t.includes('P7')));
      assert.ok((await page.$$eval(`${surface} .line-chart-legend .legend-item`,els=>els.map(e=>e.textContent))).some(t=>t.includes('P19')));
      await page.select(select,'ar_boresight_db');
      await s.wait(`${surface} [data-radiation-frequency]`,await s.T('radiation.arNote'));
      const axis=await page.$$eval(`${surface} [data-radiation-frequency] .c-label[transform]`,els=>els.map(e=>e.textContent).join(' '));
      assert.ok(axis.includes('dB')&&!axis.includes('dBi'),`${surface} AR axis has no dBi`);
      // Details expose exact samples and a gap; inspect actual DOM values, not a data helper.
      await page.$$eval(`${surface} [data-radiation-frequency] details`,els=>els.forEach(e=>{e.open=true;}));
      const rows=await page.$$eval(`${surface} [data-radiation-frequency] details tbody tr`,els=>els.map(r=>[...r.querySelectorAll('td')].map(c=>c.textContent.trim())));
      assert.equal(rows.length,6);assert.equal(rows[1][1],'—');assert.equal(rows[4][1],'—');assert.match(rows[0][1],/^0[.,]00$/);
      await s.wait(surface,await s.T('radiation.boundary.gap'));
      // The dock is resizable. Expand it through its keyboard control, then prove
      // the actual SVG fits the surface instead of accepting an off-screen size.
      if(surface==='.dock'){
        await page.focus('.dock .dock-resize');await page.keyboard.press('End');
      }else{
        // Designer's main plot and its Runs dock share the vertical space. Use
        // the supported keyboard minimum, and verify the resulting layout state.
        await page.focus('.rdk .dock-resize');await page.keyboard.press('Home');
        await s.waitFor(()=>document.querySelector('.rdk .dock-resize')?.getAttribute('aria-valuenow')==='120');
      }
      await s.waitFor(surface=>{
        const root=document.querySelector(surface),chart=root?.querySelector('[data-radiation-frequency] .chart'),body=root?.querySelector('.dock-body')||root;
        if(!chart||!body)return false;
        const c=chart.getBoundingClientRect(),b=body.getBoundingClientRect();
        return c.top>=b.top-1&&c.bottom<=Math.min(b.bottom,innerHeight)+1&&c.left>=b.left-1&&c.right<=b.right+1;
      },surface);
      assert.deepEqual(await page.evaluate(auditInPage,`${surface} [data-radiation-frequency]`),[]);
      const bounds=await page.$eval(`${surface} [data-radiation-frequency] .chart`,e=>{const r=e.getBoundingClientRect();return {width:r.width,height:r.height};});
      assert.ok(bounds.width>200&&bounds.height>100,'visible chart has usable area');
      await page.screenshot({path:join(out,`${surface==='.dock'?'viewer':'designer'}-${lang}.png`)});
      outcomes.push({lang,surface,gaps:true,physicalPorts:[7,19],arUnit:'dB',syntheticOnly:true});
    };
    await verify('.dock');
    await s.click('results.toolbar.copyData',{within:'.dock'});await s.wait('.dock-copy.copied');
    const rows=(await page.evaluate(()=>navigator.clipboard.readText())).trimEnd().split(/\r?\n/).map(r=>r.split('\t'));
    const ar=rows[0].indexOf('ar_boresight_db (dB)'),raw=rows[0].indexOf('ar_boresight_db raw (dB)');
    assert.ok(ar>=0&&raw>=0);assert.equal(rows[2][ar],'');assert.equal(rows[2][raw],'0');assert.equal(rows[4][0],'19');
    // Reopen saved result through the file input: scalars survive real strict-JSON import.
    await (await page.$('.app-header input[type=file]')).uploadFile(file);
    await s.waitFor(async()=>(await import('/src/state.ts')).bundle()?.results?.efficiency?.[1]?.port===19);
    await s.click('header.screen.start',{within:'.mode-switch',exact:true});await s.wait('.home');
    await page.locator('input[name="home-template"][value="patch"]').click();
    await s.fill(await s.field(await s.T('home.newProject.name')),`Radiation control ${lang}`,{blur:false});
    await s.click('home.newProject.create');await s.wait('.rb');
    const own=await s.store((_,m)=>m.s.file());b.model.id=own.design.model.id;
    const runFile=`${own.id}--synthetic-radiation.json`;await writeFile(join(stack.projects,runFile),JSON.stringify(b));
    // Register the saved synthetic result as existing data; no run/solver endpoint is called.
    await s.ev(({b,file},m)=>{
      m.st.setIndex([...m.st.index().filter(r=>r.file!==file),{file,model:b.model.id,name:b.name,created:b.created,simulated:true,bands:[],params:[]}]);
      m.dr.setDesignResult({file,bundle:b});m.rr.ensureDesignRunBundles();m.rf.focusResult({file,view:'efficiency'},'main');
    },{b,file:runFile},{st:'/src/state.ts',dr:'/src/runner/designRun.ts',rr:'/src/designer/runResults.ts',rf:'/src/designer/resultFocus.ts'});
    await s.wait('.dw-result .radiation-select');await verify('.dw-result');
    // Default efficiency mode remains available in Designer.
    await page.select('.dw-result .radiation-select select','efficiency');
    await s.wait('.dw-result [role="radiogroup"]',await s.T('efficiency.unit'));
    assert.deepEqual(forbidden,[]);assert.deepEqual(s.consoleIssues,[]);
    await context.close();
  }
  await writeFile(join(out,'result.json'),JSON.stringify({outcomes,forbidden,syntheticOnly:true},null,2));
  console.log(JSON.stringify({out,outcomes},null,2));
}catch(error){
  let screenshotError;await page?.screenshot({path:join(out,'failure.png')}).catch(e=>{screenshotError=String(e);});
  const layout=await page?.evaluate(()=>({viewport:{width:innerWidth,height:innerHeight},dockHeight:localStorage.getItem('fairbeam.dock-height'),rects:['.dock','.dock .dock-body','.dw-result','.dw-result [data-radiation-frequency] .chart','.rdk'].map(selector=>({selector,rect:document.querySelector(selector)?.getBoundingClientRect().toJSON()})),separators:[...document.querySelectorAll('.dock-resize')].map(e=>({now:e.getAttribute('aria-valuenow'),max:e.getAttribute('aria-valuemax')}))})).catch(()=>null);
  await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error?.stack||error),lang:activeLang,url:page?.url(),screenshotError,layout,console:session?.consoleIssues,forbidden,completed:outcomes,children:stack?.diagnostics()},(_key,value)=>typeof value==='string'?safeDiagnosticText(value):value,2));
  throw error;
}finally{try{await browser?.close();}finally{await stack?.stop();}}
