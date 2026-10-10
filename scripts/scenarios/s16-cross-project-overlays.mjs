import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {root,pythonPath} from './stack.mjs';
export default {
 id:'S16',title:'Other project results are safe Design comparison overlays',
 async run(s,ctx){
  let current,foreignId,localFile,foreignFile,before,history;
  const otherName=`Other project ${s.lang} ${ctx.stamp} · Long microwave comparison project name`;
  const snapshot=()=>s.store((_,m)=>JSON.parse(JSON.stringify(m.s.draft)));
  const focus=()=>s.ev((_,m)=>m.r.resultFocus(),null,{r:'/src/designer/resultFocus.ts'});
  const compared=()=>s.ev((_,m)=>m.r.comparedRuns().map(run=>run.file),null,{r:'/src/designer/runResults.ts'});
  const capture=async state=>{if(ctx.compact){await s.page.$eval('#rdk-compare-popover',(menu,state)=>menu.querySelector(`[data-compare-state="${state}"]`)?.scrollIntoView({block:'nearest'}),state);await s.page.screenshot({path:join(tmpdir(),`S16-${s.lang}-compact-${state}.png`)});}};
  const openCompare=async()=>{await s.click('results.toolbar.compare',{within:'.dw-result-bar'});await s.wait('#rdk-compare-popover');await capture('picker');};
  await s.step('prepare current and foreign result fixtures without simulation',async()=>{
   await s.page.evaluateOnNewDocument(()=>{
    window.__overlayDownloads=[];window.__overlayFilenames=[];const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){if(this.download)window.__overlayFilenames.push(this.download);return click.call(this);};const original=URL.createObjectURL.bind(URL);
    URL.createObjectURL=blob=>{if(blob instanceof Blob)blob.text().then(text=>window.__overlayDownloads.push(text));return original(blob);};
   });
   await s.page.goto(s.url,{waitUntil:'domcontentloaded'});await s.wait('.home');
   await s.fill(await s.field(await s.T('home.newProject.name')),`Overlay ${s.lang} ${ctx.stamp}`,{blur:false});await s.click('home.newProject.create');await s.wait('.rb');
   current=await s.store((_,m)=>JSON.parse(JSON.stringify(m.s.file())));
   foreignId=`overlay_other_${s.lang}_${ctx.stamp}`;
   const other=await s.page.evaluate(async body=>{const r=await fetch('/api/designs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text());return r.json();},{id:foreignId,name:otherName,template:'empty'});
   localFile=`${current.id}--local.json`;foreignFile=`${foreignId}--foreign.json`;
   for(const [file,id,name,source] of [[localFile,current.design.model.id,'Local RF run','patch-antenna.json'],[foreignFile,other.design.model.id,'Foreign RF run','inset-patch.json']]){
    const bundle=JSON.parse(readFileSync(join(root,'public/projects',source),'utf8'));bundle.model.id=id;bundle.name=name;writeFileSync(join(ctx.stack.projects,file),JSON.stringify(bundle));
   }
   execFileSync(pythonPath(),['-m','fairbeam','index',ctx.stack.projects],{cwd:join(root,'python'),env:{...process.env,PYTHONPATH:join(root,'python')},windowsHide:true,stdio:'ignore'});
   await s.ev(async(_,m)=>{await m.state.loadIndex();await m.runner.refreshModels();},null,{state:'/src/state.ts',runner:'/src/runner/store.ts'});
   await s.store((_,m)=>m.s.edit(d=>d.model.description='Unsaved edit must survive result overlays'));
   before=await snapshot();history=await s.store((_,m)=>m.s.historyMark());
   if(ctx.compact)await s.showDesignPanel('tree');
   await s.page.locator(`.nt-row[data-id="run:${localFile}"]`).click();
   await s.ev((_,m)=>m.r.showView('sparams',undefined,'main'),null,{r:'/src/designer/runResults.ts'});await s.wait('.dw-result-bar');
   await s.waitFor(async file=>(await import('/src/runner/designRun.ts')).designResult()?.file===file,localFile);
  });
  await s.step('foreign checkbox overlays curves without changing the primary or draft',async()=>{
   let foreignLoads=0;const onRequest=request=>{if(request.url().endsWith('/projects/'+foreignFile))foreignLoads++;};s.page.on('request',onRequest);
   await openCompare();assert.ok((await s.text('#rdk-compare-popover')).includes(await s.T('results.compare.otherProjects')));
   if(ctx.compact){
    const geometry=await s.page.evaluate(()=>{const menu=document.querySelector('#rdk-compare-popover'),box=menu.getBoundingClientRect(),input=menu.querySelector('input'),r=input.getBoundingClientRect();return {viewport:[innerWidth,innerHeight],inside:box.left>=0&&box.top>=0&&box.right<=innerWidth&&box.bottom<=innerHeight,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===input,treeVisible:document.querySelector('.panel-left').getBoundingClientRect().width>25};});
    assert.deepEqual(geometry.viewport,[1024,688]);assert.equal(geometry.inside,true);assert.equal(geometry.treeVisible,true);assert.equal(geometry.hit,true,'portal checkbox receives the pointer above the compact tree');
    await capture('tree-open');
   }
   assert.equal(foreignLoads,0,'opening the picker must not load foreign bundles eagerly');
   const check=`input[data-compare-overlay="${foreignFile}"]`;
   assert.ok(await s.page.$eval(check,e=>e.parentElement.textContent.includes('Foreign RF run')&&e.parentElement.textContent.includes('Other project')));
   await s.page.locator(check).click();await s.waitFor(async file=>(await import('/src/designer/runResults.ts')).comparedRuns().some(run=>run.file===file),foreignFile);
   assert.equal((await focus()).file,localFile);assert.deepEqual(await compared(),[foreignFile]);
   await s.page.locator('#rdk-compare-popover input:not([data-compare-overlay])').click();
   assert.equal((await focus()).file,localFile,'removing the last local must not promote the foreign run');
   assert.deepEqual(await snapshot(),before);assert.deepEqual(await s.store((_,m)=>m.s.historyMark()),history);
   await s.page.keyboard.press('Escape');await s.gone('#rdk-compare-popover');
   assert.equal(await s.page.$eval('.rdk-compare-control>button',e=>e===document.activeElement),true,'Escape returns focus to Compare');
   if(ctx.compact)await s.clickSel('[data-layout-focus="tree-collapse"]');
   await s.page.locator('.dw-result-bar button[title="'+await s.T('results.toolbar.csvTitle')+'"]').click();
   await s.waitFor(()=>window.__overlayDownloads.length>0);const csv=await s.page.evaluate(()=>window.__overlayDownloads.at(-1));
   assert.ok(csv.startsWith('run,label,'),'different grids retain file and full label columns');
   assert.ok(csv.includes('Local RF run')&&csv.includes('Foreign RF run')&&csv.includes(otherName),'CSV retains both run labels and foreign project identity: '+csv.slice(0,600));
   s.page.off('request',onRequest);
  });
  await s.step('removing a foreign overlay restores the single current-project result',async()=>{
   await openCompare();await s.page.locator(`input[data-compare-overlay="${foreignFile}"]`).click();
   await s.waitFor(async()=>!(await import('/src/designer/runResults.ts')).comparedRuns().length);
   assert.equal((await focus()).file,localFile);assert.deepEqual((await focus()).compare??[],[]);
   assert.deepEqual(await snapshot(),before);assert.deepEqual(await s.store((_,m)=>m.s.historyMark()),history);
   await s.page.keyboard.press('Escape');
  });
  await s.step('Open result views the foreign bundle and exports it while retaining draft and Undo',async()=>{
   await openCompare();await s.page.locator(`[data-open-result="${foreignFile}"]`).click();
   await s.waitFor(async file=>(await import('/src/workspace.ts')).appMode()==='results'&&(await import('/src/state.ts')).source()===file,foreignFile);
   assert.equal(await s.ev((_,m)=>m.state.bundle().model.id,null,{state:'/src/state.ts'}),foreignId.replaceAll('_','-'));
   assert.deepEqual(await snapshot(),before);assert.deepEqual(await s.store((_,m)=>m.s.historyMark()),history);
   assert.equal(await s.ev((_,m)=>m.r.designResult().file,null,{r:'/src/runner/designRun.ts'}),localFile);
   assert.ok(await s.page.$eval('.mode-switch [aria-current="page"]',(e,label)=>e.textContent===label,await s.T('header.screen.results')));
   await s.ev((_,m)=>m.state.setDockTab('reflection'),null,{state:'/src/state.ts'});
   const count=await s.page.evaluate(()=>window.__overlayDownloads.length);
   await s.page.locator('.dock button[title="'+await s.T('results.toolbar.csvTitle')+'"]').click();
   await s.waitFor(n=>window.__overlayDownloads.length>n,count);
   const csv=await s.page.evaluate(()=>window.__overlayDownloads.at(-1));
   const firstFrequency=await s.ev((_,m)=>m.state.bundle().results.frequency[0],null,{state:'/src/state.ts'});
   assert.ok(csv.split('\n')[1].startsWith(String(firstFrequency / 1e9)+','),'CSV uses the viewed foreign result frequency grid');
   const filename=await s.page.evaluate(()=>window.__overlayFilenames.at(-1));assert.ok(filename.startsWith(foreignId.replaceAll('_','-')+'-')&&filename.includes('foreign'),'CSV filename retains the foreign model and run identity: '+filename);
   await s.click('header.screen.design',{sel:'.mode-switch button'});await s.wait('.rb');
   assert.deepEqual(await snapshot(),before);assert.deepEqual(await s.store((_,m)=>m.s.historyMark()),history);
   await s.store((_,m)=>m.s.undo());assert.notDeepEqual(await snapshot(),before);
   await s.store((_,m)=>m.s.redo());assert.deepEqual(await snapshot(),before);
   await s.ev((_,m)=>m.r.showView('sparams',undefined,'main'),null,{r:'/src/designer/runResults.ts'});await s.wait('.dw-result-bar');
  });
  await s.step('failed opens retry explicitly and a delayed open cannot override navigation',async()=>{
   s.consoleAllow.push(/Failed to load resource:.*404/);
   const session=await s.page.createCDPSession();let paused,resolve;
   await session.send('Fetch.enable',{patterns:[{urlPattern:`${s.url}projects/${foreignFile}`,requestStage:'Request'}]});
   session.on('Fetch.requestPaused',event=>session.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:404,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from('{}').toString('base64')}));
   try{
    await openCompare();await s.page.locator(`[data-open-result="${foreignFile}"]`).click();await s.wait('#rdk-compare-popover [role="alert"]');
    assert.deepEqual(await snapshot(),before);assert.equal(await s.ev((_,m)=>m.w.appMode(),null,{w:'/src/workspace.ts'}),'design');
    await session.send('Fetch.disable');await s.page.locator(`[data-open-result="${foreignFile}"]`).click();
    await s.waitFor(async()=>(await import('/src/workspace.ts')).appMode()==='results');
    await s.click('header.screen.design',{sel:'.mode-switch button'});await s.wait('.rb');
    await s.ev((_,m)=>m.r.showView('sparams',undefined,'main'),null,{r:'/src/designer/runResults.ts'});await s.wait('.dw-result-bar');
    session.removeAllListeners('Fetch.requestPaused');const held=new Promise(r=>resolve=r);
    await session.send('Fetch.enable',{patterns:[{urlPattern:`${s.url}projects/${foreignFile}`,requestStage:'Response'}]});
    session.on('Fetch.requestPaused',event=>{paused=event;resolve();});
    await openCompare();await s.page.locator(`[data-open-result="${foreignFile}"]`).click();let timer;try{await Promise.race([held,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('open reply not intercepted')),15000))]);}finally{clearTimeout(timer);}
    await s.click('header.screen.start',{sel:'.mode-switch button'});await s.wait('.home');
    const completed=s.page.waitForResponse(r=>r.url().endsWith('/projects/'+foreignFile));await session.send('Fetch.continueResponse',{requestId:paused.requestId});paused=null;await(await completed).buffer();
    await s.page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    assert.equal(await s.ev((_,m)=>m.w.appMode(),null,{w:'/src/workspace.ts'}),'home');assert.deepEqual(await snapshot(),before);
    await s.click('header.screen.design',{sel:'.mode-switch button'});await s.wait('.rb');await s.ev((_,m)=>m.r.showView('sparams',undefined,'main'),null,{r:'/src/designer/runResults.ts'});await s.wait('.dw-result-bar');
   }finally{if(paused)await session.send('Fetch.continueResponse',{requestId:paused.requestId});await session.send('Fetch.disable');await session.detach();}
  });
  await s.step('failed and invalid foreign bundles are explicit and can be retried or removed',async()=>{
   s.consoleAllow.push(/Failed to load resource:.*404/);
   await openCompare();const session=await s.page.createCDPSession();let status=404;
   await session.send('Fetch.enable',{patterns:[{urlPattern:`${s.url}projects/${foreignFile}`,requestStage:'Request'}]});
   session.on('Fetch.requestPaused',event=>session.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from('{}').toString('base64')}));
   try{
    await s.page.locator(`input[data-compare-overlay="${foreignFile}"]`).click();await s.wait('[data-compare-state="error"]');
    await capture('error');
    assert.equal(await s.ev((_,m)=>m.e.screenshotAvailable(),null,{e:'/src/components/exportContext.ts'}),false,'failed selections disable screenshots');
    const downloads=await s.page.evaluate(()=>window.__overlayDownloads.length);await s.page.locator('.dw-result-bar button[title="'+await s.T('results.toolbar.csvTitle')+'"]').click();await s.wait('.toast-error');assert.equal(await s.page.evaluate(()=>window.__overlayDownloads.length),downloads,'CSV failure produces no partial comparison');
    await s.gone('#rdk-compare-popover');await openCompare();
    assert.deepEqual(await compared(),[]);assert.ok((await s.text('#rdk-compare-popover')).includes(await s.T('results.compare.failed')));
    status=200;const invalidReply=s.page.waitForResponse(response=>response.url().endsWith('/projects/'+foreignFile));await s.click('results.compare.retry',{within:'#rdk-compare-popover'});await(await invalidReply).buffer();await s.wait('[data-compare-state="error"]');
    assert.deepEqual(await compared(),[],'invalid JSON never creates a trace');
    await session.send('Fetch.disable');const validReply=s.page.waitForResponse(response=>response.url().endsWith('/projects/'+foreignFile));await s.click('results.compare.retry',{within:'#rdk-compare-popover'});await(await validReply).buffer();
    await s.waitFor(async file=>(await import('/src/designer/runResults.ts')).comparedRuns().some(run=>run.file===file),foreignFile);
    await s.page.locator(`input[data-compare-overlay="${foreignFile}"]`).click();assert.deepEqual(await compared(),[],'removed traces disappear immediately');
    assert.deepEqual(await snapshot(),before);assert.deepEqual(await s.store((_,m)=>m.s.historyMark()),history);await s.page.keyboard.press('Escape');
   }finally{await session.send('Fetch.disable');await session.detach();}
  });
  await s.step('switching project clears overlays and ignores an old foreign response',async()=>{
   await s.store((_,m)=>m.s.save());await s.page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   if(ctx.compact)await s.showDesignPanel('tree');
   await s.page.locator(`.nt-row[data-id="run:${localFile}"]`).click();if(ctx.compact)await s.clickSel('[data-layout-focus="tree-collapse"]');await s.ev((_,m)=>m.r.showView('sparams',undefined,'main'),null,{r:'/src/designer/runResults.ts'});await s.wait('.dw-result-bar');await openCompare();
   const session=await s.page.createCDPSession();let paused,resolve;const held=new Promise(r=>resolve=r);
   await session.send('Fetch.enable',{patterns:[{urlPattern:`${s.url}projects/${foreignFile}`,requestStage:'Response'}]});
   session.on('Fetch.requestPaused',event=>{paused=event;resolve();});
   try{
    await s.page.locator(`input[data-compare-overlay="${foreignFile}"]`).click();
    let timer;try{await Promise.race([held,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('foreign reply not intercepted')),15000))]);}finally{clearTimeout(timer);}
    assert.deepEqual(await compared(),[]);assert.ok(await s.page.$('[data-compare-state="loading"]'));
    await capture('loading');
    assert.equal(await s.ev((_,m)=>m.e.screenshotAvailable(),null,{e:'/src/components/exportContext.ts'}),false,'pending overlays disable screenshots');
    await s.page.keyboard.press('Escape');await s.click('header.screen.start',{sel:'.mode-switch button'});await s.wait('.home');
    await s.page.locator(`[data-home-design="${foreignId}"] .home-item`).click();await s.wait('.rb');
    assert.equal(await s.store((_,m)=>m.s.file().id),foreignId);const next=await snapshot();
    const finished=s.page.waitForResponse(response=>response.url().endsWith('/projects/'+foreignFile),{timeout:10000});
    await session.send('Fetch.continueResponse',{requestId:paused.requestId});paused=null;await (await finished).buffer();await s.page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.deepEqual(await compared(),[]);assert.equal(await focus(),null);assert.deepEqual(await snapshot(),next);
   }finally{if(paused)await session.send('Fetch.continueResponse',{requestId:paused.requestId});await session.send('Fetch.disable');await session.detach();}
  });
 }
};
