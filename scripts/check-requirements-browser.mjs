// Requirements authoring and immutable result ownership through the real Designer UI.
// Synthetic stored result only; every solver/study/optimizer/render POST is aborted.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { startStack, chromePath } from './scenarios/stack.mjs';
import { Session, auditInPage } from './scenarios/harness.mjs';
import { withStartupDiagnostics } from './scenarios/startup-diagnostics.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' && process.env.FAIRBEAM_ALLOW_BROWSER_TEST !== '1')
  throw new Error('Browser test requires CI or explicit browser-test authorization.');
const out=resolve(process.env.FAIRBEAM_TEST_ARTIFACTS || join(tmpdir(),`fairbeam-requirements-${Date.now()}`),'requirements');
await mkdir(out,{recursive:true});
const seed=JSON.parse(await readFile(new URL('../public/projects/dipole.json',import.meta.url),'utf8'));
const frequency=seed.results.frequency[Math.floor(seed.results.frequency.length/2)]/1e9;
const outcomes=[],forbidden=[];
let stack,browser,page,session,language;
try {
  stack=await startStack({log:console.log,niceSolver:false});
  browser=await puppeteer.launch({headless:true,executablePath:await chromePath(),
    args:['--no-sandbox','--mute-audio','--enable-unsafe-swiftshader','--use-angle=swiftshader']});
  for(const lang of ['en','tr']) {
    language=lang;
    const id=`requirements_${lang}`, response=await fetch(`${stack.apiUrl}/api/designs`,{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({id,name:id,template:'dipole'})});
    assert.equal(response.status,201,await response.text());
    const context=await browser.createBrowserContext();page=await context.newPage();
    await page.setViewport({width:1280,height:950});
    await page.evaluateOnNewDocument(language=>localStorage.setItem('fairbeam.generalSettings',JSON.stringify({language})),lang);
    let previews=0;
    await page.setRequestInterception(true);
    page.on('request',request=>{
      const path=new URL(request.url()).pathname;
      if(request.method()==='POST' && /^\/api\/(runs|sweeps|convergence|optimizations|research\/runs|render-jobs)(\/|$)/.test(path)) {
        forbidden.push({lang,path});void request.abort();
      } else { if(path==='/api/preview' && request.method()==='POST')previews++;void request.continue(); }
    });
    const s=new Session(page,{lang,scenario:'requirements',url:stack.url,artifactDirectory:out});session=s;
    await withStartupDiagnostics(page,{directory:join(out,`startup-${lang}`),stack},async()=>{
      await page.goto(stack.url,{waitUntil:'domcontentloaded'});await s.wait('.home');
    });
    await s.clickSel(`[data-home-design="${id}"] .home-item`);
    await s.waitFor(async id=>{const st=await import('/src/designer/store.ts'),r=await import('/src/runner/store.ts');
      return !st.loading()&&st.file()?.id===id&&r.meshFreshness()==='current';},id);
    const openEditor=async()=>{
      await s.ev((_,m)=>m.sim.openSimSettings('requirements'),null,{sim:'/src/designer/simSettingsState.ts'});
      await s.wait('[data-requirements-editor]');
      await s.clickSel('[data-requirements-editor] > details > summary');
    };
    await openEditor();const before=previews;
    await s.click('requirements.add',{within:'[data-requirements-editor]'});
    await s.fill('[data-requirements-editor] input[id$="-at"]',String(frequency));
    await s.fill('[data-requirements-editor] input[id$="-label"]',`Saved mask ${lang}`);
    assert.equal(await page.$eval('.ss-dialog .dialog-foot .btn-primary',el=>el.disabled),true,'unapplied edits cannot be silently kept');
    await s.click('requirements.apply',{within:'[data-requirements-editor]'});
    const masks=await s.store((_,m)=>JSON.parse(JSON.stringify(m.s.draft.requirements)));
    assert.equal(masks.items[0].goal.at,frequency);
    assert.equal(previews,before,'requirement metadata does not trigger geometry preview');
    assert.deepEqual(await page.evaluate(auditInPage,'[aria-labelledby="ss-title"]'),[]);
    await page.screenshot({path:join(out,`editor-${lang}-1280.png`)});
    await page.setViewport({width:768,height:950});
    assert.deepEqual(await page.evaluate(auditInPage,'[aria-labelledby="ss-title"]'),[]);
    await page.screenshot({path:join(out,`editor-${lang}-768.png`)});
    await page.setViewport({width:1280,height:950});
    await s.click('common.ok',{within:'[aria-labelledby="ss-title"]'});await s.gone('#ss-title');
    await s.store((_,m)=>m.s.undo());assert.equal(await s.store((_,m)=>m.s.draft.requirements??null),null);
    await s.store((_,m)=>m.s.redo());assert.deepEqual(await s.store((_,m)=>JSON.parse(JSON.stringify(m.s.draft.requirements))),masks);
    await openEditor();await s.click('requirements.useGoals',{within:'[data-requirements-editor]'});
    await s.wait('#od-title');await s.wait('.op-form');
    const goals=await s.ev((_,m)=>JSON.parse(JSON.stringify(m.opt.goals)),null,{opt:'/src/runner/optimize.ts'});
    assert.equal(goals.length,1);assert.equal(Number(goals[0].target),-10);assert.equal(Number(goals[0].at),frequency);
    await s.click('common.close',{within:'[aria-labelledby="od-title"]'});await s.gone('#od-title');
    const saved=await(await fetch(`${stack.apiUrl}/api/designs/${id}`)).json();assert.deepEqual(saved.design.requirements,masks);
    await page.reload({waitUntil:'domcontentloaded'});
    await s.waitFor(async id=>{const st=await import('/src/designer/store.ts');return !st.loading()&&st.file()?.id===id;},id);
    assert.deepEqual(await s.store((_,m)=>JSON.parse(JSON.stringify(m.s.draft.requirements))),masks);

    // Declare a synthetic immutable producer snapshot. These are historical dipole fixture RF
    // samples, not a new measured/simulated run of the editor geometry.
    const b=structuredClone(seed);b.name=`Synthetic requirement snapshot ${lang}`;b.model.id=saved.design.model.id;
    const inputHash=createHash('sha256').update(JSON.stringify(saved.design)).digest('hex');
    const identity=createHash('sha256').update(JSON.stringify({input_sha256:inputHash,resolved_parameters:{}})).digest('hex');
    b.requirements_source={schema:'fairbeam.requirement-source/1',source_id:identity,input_sha256:inputHash,resolved_parameters:{}};
    b.requirements_snapshot={schema:'fairbeam.requirement-snapshot/1',source_id:identity,input_sha256:inputHash,requirements:masks};
    const file=`${id}--requirements.json`;await writeFile(join(stack.projects,file),JSON.stringify(b));
    const indexPath=join(stack.projects,'index.json'),index=JSON.parse(await readFile(indexPath,'utf8'));
    index.projects=[...index.projects.filter(e=>e.file!==file),{file,model:b.model.id,name:b.name,created:b.created,
      simulated:true,bands:[],params:[],cells:b.mesh.total_cells,engine:'CPU'}];index.updated=new Date().toISOString();
    await writeFile(`${indexPath}.requirements.tmp`,JSON.stringify(index));await rename(`${indexPath}.requirements.tmp`,indexPath);
    const mods={st:'/src/state.ts',rr:'/src/designer/runResults.ts',dr:'/src/runner/designRun.ts',rf:'/src/designer/resultFocus.ts',req:'/src/lib/requirementsSnapshot.ts'};
    await s.ev(async(_,m)=>{await m.st.loadIndex();if(m.st.indexLoadError())throw Error(m.st.indexLoadError());m.rr.ensureDesignRunBundles();},null,mods);
    await s.waitFor(async file=>!!(await import('/src/designer/runResults.ts')).designRunBundle(file),file);
    const show=async view=>s.ev(({file,view},m)=>{m.dr.setDesignResult({file,bundle:m.rr.designRunBundle(file)});m.rf.focusResult({file,view},'main');},{file,view},mods);
    await show('summary');await s.wait('.dw-result [data-requirements-summary]');
    const evaluation=await s.ev((file,m)=>m.req.savedRequirements(m.rr.designRunBundle(file)),file,mods);
    assert.equal(evaluation.mesh,'unknown');assert.equal(evaluation.status,'unknown');
    assert.ok((await page.$eval('.dw-result [data-requirements-summary]',el=>el.textContent)).includes(`Saved mask ${lang}`));
    await page.screenshot({path:join(out,`summary-${lang}.png`)});
    await show('sparams');await s.wait('.dw-result .c-limit-segment');
    await page.screenshot({path:join(out,`mask-${lang}.png`)});
    await s.store((_,m)=>m.s.editRequirements({schema:'fairbeam.requirements/1',items:[{id:'new-editor-mask',goal:{kind:'s11_max',target:-80,at:1}}]}));
    const after=await s.ev((file,m)=>m.req.savedRequirements(m.rr.designRunBundle(file)),file,mods);
    assert.deepEqual(after,evaluation,'editing current design cannot replace historical snapshot');
    assert.deepEqual(forbidden,[]);assert.deepEqual(s.consoleIssues,[]);
    outcomes.push({lang,savedAndReloaded:true,undoRedo:true,geometryPreviewUnchanged:true,optimizerPreparedOnly:true,
      resultSourceId:identity,metric:evaluation.metric,mesh:'unknown',qualified:'unknown',historicalIsolation:true});
    await context.close();
  }
  await writeFile(join(out,'result.json'),JSON.stringify({fixture:'historical dipole samples with explicitly synthetic source snapshot',outcomes,forbidden},null,2));
  console.log('Requirements browser passed EN/TR editor, save/reload/history, prepare-only goals, bounded masks and immutable result ownership. No solver run.');
} catch(error) {
  await page?.screenshot({path:join(out,'failure.png')}).catch(()=>{});
  await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error?.stack||error),language,outcomes,forbidden,
    console:session?.consoleIssues,stack:stack?.diagnostics()},null,2));throw error;
} finally {await browser?.close();await stack?.stop();}
