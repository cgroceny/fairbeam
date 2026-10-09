// Real saved-design rename/reopen/undo and reveal transport; no solver.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {root, pythonPath} from './stack.mjs';
export default {
 id:'S14', title:'Saved design context actions preserve identity and results',
 async run(s,ctx){
  let before,runPath,runBytes;
  const renamed=`Renamed ${s.lang} ${ctx.stamp}`, duplicate=`Other ${s.lang} ${ctx.stamp}`;
  const backend=()=>s.page.evaluate(async id=>(await(await fetch(`/api/designs/${id}`)).json()),before.id);
  const row=()=>`[data-home-design="${before.id}"]`;
  const openRename=async()=>{await s.page.click(row(),{button:'right'});await s.wait('[role=menu]');await s.click('home.designs.rename',{sel:'[role=menuitem]'});await s.wait('.home-rename-dialog');};
  const saveName=async name=>{await openRename();await s.fill('#home-rename-name',name);await s.click('home.designs.renameSave',{within:'.home-rename-dialog'});await s.gone('.home-rename-dialog');};
  await s.step('create Empty Design and attach an existing result fixture',async()=>{
   console.log(`  S14 owned stack PIDs: ${ctx.stack.pids.join(', ')}`);
   await s.page.goto(s.url,{waitUntil:'domcontentloaded'});await s.wait('.home');
   await s.fill(await s.field(await s.T('home.newProject.name')),`Empty ${s.lang} ${ctx.stamp}`,{blur:false});await s.click('home.newProject.create');await s.wait('.rb');
   before=await s.store((_,m)=>JSON.parse(JSON.stringify(m.s.file())));
   const bundle=JSON.parse(readFileSync(join(root,'public/projects/sierpinski-monopole--iterations-0.json'),'utf8'));
   bundle.model.id=before.design.model.id;
   runPath=join(ctx.stack.projects,`${before.id}--run-home.json`);runBytes=JSON.stringify(bundle);writeFileSync(runPath,runBytes);
   execFileSync(pythonPath(),['-m','fairbeam','index',ctx.stack.projects],{cwd:join(root,'python'),env:{...process.env,PYTHONPATH:join(root,'python')},windowsHide:true,stdio:'ignore'});
   await s.ev((_,m)=>m.state.loadIndex(),null,{state:'/src/state.ts'});
   assert.ok((await s.ev((_,m)=>m.r.designRuns(),null,{r:'/src/designer/runResults.ts'})).some(r=>r.file===`${before.id}--run-home.json`));
   await s.page.evaluate(async ({id,name})=>{const r=await fetch('/api/designs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,name,template:'empty'})});if(!r.ok)throw new Error(await r.text());},{id:`other_${s.lang}_${ctx.stamp}`,name:duplicate});
   await s.click('header.screen.start',{sel:'.mode-switch button'});await s.wait('.home');await s.ev((_,m)=>m.r.refreshModels(),null,{r:'/src/runner/store.ts'});
  });
  await s.step('keyboard menu, blank/duplicate validation and cancel preserve saved design',async()=>{
   await s.page.focus(`${row()} .home-item`);await s.page.keyboard.down('Shift');await s.page.keyboard.press('F10');await s.page.keyboard.up('Shift');await s.wait('[role=menu]');
   await s.page.keyboard.press('ArrowDown');assert.equal(await s.page.evaluate(()=>document.activeElement.textContent),await s.T('home.designs.reveal'));
   await s.page.keyboard.press('Escape');await s.gone('[role=menu]');assert.equal(await s.page.$eval(`${row()} .home-item`,e=>e===document.activeElement),true);
   await openRename();assert.equal(await s.page.$eval('#home-rename-name',e=>e.autocomplete),'off');
   await s.fill('#home-rename-name','');assert.equal(await s.page.$eval('.home-rename-dialog button[type=submit]',e=>e.disabled),true);
   await s.fill('#home-rename-name',duplicate);assert.equal(await s.page.$eval('.home-rename-dialog button[type=submit]',e=>e.disabled),true);
   await s.click('common.cancel',{within:'.home-rename-dialog'});await s.gone('.home-rename-dialog');assert.deepEqual((await backend()).design,before.design);
  });
  await s.step('rename is reversible, keeps filename and changes only display name',async()=>{
   await saveName(renamed);const after=await backend();assert.equal(after.id,before.id);assert.equal(after.file,before.file);
   assert.deepEqual(after.design,{...before.design,model:{...before.design.model,name:renamed}});
   await s.click('ribbon.home.undo',{within:'.home-design-action-note'});await s.waitFor(async id=>{const r=await(await fetch(`/api/designs/${id}`)).json();return r.design.model.name.startsWith('Empty ');},before.id);
   assert.deepEqual((await backend()).design,before.design);await saveName(renamed);
  });
  await s.step('Explorer browser fallback is honest; native transport uses resolved path',async()=>{
   await s.page.click(row(),{button:'right'});await s.click('home.designs.reveal',{sel:'[role=menuitem]'});await s.waitFor(text=>document.querySelector('.home-design-action-note')?.textContent.includes(text),await s.T('home.designs.revealDesktop'));
   await s.page.evaluate(()=>{window.__revealCalls=[];window.__TAURI_INTERNALS__={invoke:async(command,args)=>{window.__revealCalls.push({command,args});}};});
   try{await s.page.click(row(),{button:'right'});await s.click('home.designs.reveal',{sel:'[role=menuitem]'});await s.waitFor(()=>window.__revealCalls.length===1);
    const call=await s.page.evaluate(()=>window.__revealCalls[0]);const location=await s.page.evaluate(async id=>(await(await fetch(`/api/designs/${id}/location`)).json()),before.id);
    assert.deepEqual(call,{command:'reveal_design',args:{id:before.id,path:location.path}});
   }finally{await s.page.evaluate(()=>{delete window.__TAURI_INTERNALS__;delete window.__revealCalls;});}
  });
  await s.step('reopen retains renamed display, geometry, model identity and result association',async()=>{
   await s.page.click(`${row()} .home-item`);await s.wait('.rb');const file=await s.store((_,m)=>JSON.parse(JSON.stringify(m.s.file())));
   assert.equal(file.id,before.id);assert.equal(file.file,before.file);assert.deepEqual(file.design,{...before.design,model:{...before.design.model,name:renamed}});
   assert.equal(await s.store((_,m)=>m.s.draft.model.name),renamed);
   assert.ok((await s.ev((_,m)=>m.r.designRuns(),null,{r:'/src/designer/runResults.ts'})).some(r=>r.file===`${before.id}--run-home.json`));assert.equal(readFileSync(runPath,'utf8'),runBytes);
  });
  await s.step('saved geometry Undo and Redo preserve a later Home display rename',async()=>{
   await s.store((_,m)=>m.s.edit(d=>d.parts.push({name:'history_geometry',material:d.materials[0].name,primitives:[{kind:'box',start:[0,0,0],stop:[1,1,1]}]})));
   await s.click('ribbon.tab.home',{sel:'.rb-tab'});await s.click('common.save',{sel:'.rb-btn'});
   await s.waitFor(async()=>!(await import('/src/designer/store.ts')).dirty(),null,{what:'clean saved geometry'});
   assert.equal(await s.store((_,m)=>m.s.canUndo()),true);
   const mark=await s.store((_,m)=>m.s.historyMark());
   await s.click('header.screen.start',{sel:'.mode-switch button'});await s.wait('.home');
   const historyName=`History name ${s.lang} ${ctx.stamp}`;await saveName(historyName);
   await s.clickSel(`${row()} .home-item`);await s.wait('.rb');
   assert.equal(await s.store((mark,m)=>m.s.rollbackTo(mark),mark),false,'a pre-rename modal mark cannot restore old metadata');
   const rebased=await s.store((_,m)=>m.s.historyMark());
   assert.equal(rebased.position,mark.position);assert.equal(rebased.undo.length,mark.undo.length);
   const renamedSnapshot=text=>{const d=JSON.parse(text);d.model.name=historyName;return JSON.stringify(d);};
   assert.deepEqual(rebased.undo,mark.undo.map(renamedSnapshot));
   assert.deepEqual(rebased.history,mark.history.map(entry=>({...entry,text:renamedSnapshot(entry.text)})));
   assert.equal(await s.store((_,m)=>m.s.syncSavedDesignName(m.s.file().id,'Stale response','stale-result-hash','stale-base-hash')),false);
   assert.deepEqual(await s.store((_,m)=>m.s.historyMark()),rebased,'stale response leaves all history unchanged');
   await s.click('ribbon.home.undo',{sel:'.rb-btn'});
   assert.equal(await s.store((_,m)=>m.s.draft.model.name),historyName,'geometry Undo must not revert the saved display name');
   assert.equal(await s.store((_,m)=>m.s.draft.parts.some(p=>p.name==='history_geometry')),false);
   assert.equal(await s.store((_,m)=>m.s.syncSavedDesignName(m.s.file().id,'Dirty response','dirty-result-hash',m.s.file().hash)),false);
   await s.click('ribbon.tab.home',{sel:'.rb-tab'});await s.click('ribbon.home.redo',{sel:'.rb-btn'});
   assert.equal(await s.store((_,m)=>m.s.draft.model.name),historyName);
   assert.equal(await s.store((_,m)=>m.s.draft.parts.some(p=>p.name==='history_geometry')),true);
   // A clean saved state can retain a future geometry step in Redo.
   await s.click('ribbon.home.undo',{sel:'.rb-btn'});await s.click('common.save',{sel:'.rb-btn'});
   await s.waitFor(async()=>!(await import('/src/designer/store.ts')).dirty(),null,{what:'clean state retaining Redo'});
   assert.equal(await s.store((_,m)=>m.s.canRedo()),true);
   await s.click('header.screen.start',{sel:'.mode-switch button'});await s.wait('.home');await saveName(`Redo name ${s.lang} ${ctx.stamp}`);
   await s.click('ribbon.home.undo',{within:'.home-design-action-note'});
   await s.wait('.home-design-action-note',await s.T('home.designs.renameUndone'));
   await s.waitFor(async name=>(await import('/src/designer/store.ts')).draft.model.name===name,historyName);
   await s.clickSel(`${row()} .home-item`);await s.wait('.rb');await s.click('ribbon.tab.home',{sel:'.rb-tab'});await s.click('ribbon.home.redo',{sel:'.rb-btn'});
   assert.equal(await s.store((_,m)=>m.s.draft.model.name),historyName,'Home rename Undo also rebases a retained Redo');
   assert.equal(await s.store((_,m)=>m.s.draft.parts.some(p=>p.name==='history_geometry')),true);
   await s.click('common.save',{sel:'.rb-btn'});
   await s.waitFor(async()=>!(await import('/src/designer/store.ts')).dirty(),null,{what:'saved Redo geometry'});
   assert.equal((await backend()).design.model.name,historyName);
  });
  await s.step('unchanged Home names preserve designer name Undo and history marks',async()=>{
   const previous=await s.store((_,m)=>m.s.draft.model.name);
   const current=`Designer name ${s.lang} ${ctx.stamp}`;
   await s.store((name,m)=>m.s.edit(d=>d.model.name=name),current);
   await s.click('ribbon.tab.home',{sel:'.rb-tab'});await s.click('common.save',{sel:'.rb-btn'});
   await s.waitFor(async()=>!(await import('/src/designer/store.ts')).dirty());
   const mark=await s.store((_,m)=>m.s.historyMark());
   const saved=await backend();let renameRequests=0;
   const count=request=>{if(new URL(request.url()).pathname.endsWith('/rename'))renameRequests++;};
   s.page.on('request',count);
   try {
    await s.click('header.screen.start',{sel:'.mode-switch button'});await s.wait('.home');await openRename();
    assert.equal(await s.page.$eval('.home-rename-dialog button[type=submit]',e=>e.disabled),true);
    await s.fill('#home-rename-name',` ${current} `);
    assert.equal(await s.page.$eval('.home-rename-dialog button[type=submit]',e=>e.disabled),true);
    // Exercise defensive submit handling even though the visible Save button is disabled.
    await s.page.$eval('.home-rename-dialog',e=>e.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    await s.gone('.home-rename-dialog');assert.equal(renameRequests,0);
   } finally {s.page.off('request',count);}
   assert.deepEqual(await s.store((_,m)=>m.s.historyMark()),mark);
   assert.equal(await s.store((_,m)=>m.s.syncSavedDesignName(m.s.file().id,m.s.draft.model.name,m.s.file().hash,m.s.file().hash)),true);
   assert.deepEqual(await s.store((_,m)=>m.s.historyMark()),mark,'idempotent sync preserves snapshots and revision');
   assert.equal(await s.store((mark,m)=>m.s.rollbackTo(mark),mark),true,'unchanged name does not invalidate an existing mark');
   assert.deepEqual(await backend(),saved);
   await s.clickSel(`${row()} .home-item`);await s.wait('.rb');await s.click('ribbon.tab.home',{sel:'.rb-tab'});
   await s.click('ribbon.home.undo',{sel:'.rb-btn'});
   assert.equal(await s.store((_,m)=>m.s.draft.model.name),previous,'designer name edit remains undoable');
   await s.click('ribbon.home.redo',{sel:'.rb-btn'});
   assert.equal(await s.store((_,m)=>m.s.draft.model.name),current);
  });
  await s.step('delayed save success and conflict replies cannot overwrite a later Home rename',async()=>{
   s.consoleAllow.push(/Failed to load resource.*409/);
   for(const status of [200,409]){
   const session=await s.page.createCDPSession();let paused,resolvePaused;
   const held=new Promise(resolve=>resolvePaused=resolve);
   const urlPattern=`${s.url}api/designs/${before.id}`;
   await session.send('Fetch.enable',{patterns:[{urlPattern,requestStage:'Response'},...(status===409?[{urlPattern,requestStage:'Request'}]:[])]});
   session.on('Fetch.requestPaused',async event=>{
    if(event.responseStatusCode===undefined){
     if(event.request.method==='PUT'){
      const body=JSON.parse(event.request.postData);body.base_hash='deliberately-stale-save-base';
      await session.send('Fetch.continueRequest',{requestId:event.requestId,postData:Buffer.from(JSON.stringify(body)).toString('base64')});
     }else await session.send('Fetch.continueRequest',{requestId:event.requestId});
     return;
    }
    if(event.request.method==='PUT'){paused=event;resolvePaused(event);}
    else await session.send('Fetch.continueResponse',{requestId:event.requestId});
   });
   try{
    await s.store((_,m)=>{window.__delayedHomeSaveDone=false;window.__delayedHomeSave=m.s.save().then(value=>{window.__delayedHomeSaveDone=true;return value;});});
    let timeout;try{await Promise.race([held,new Promise((_,reject)=>timeout=setTimeout(()=>reject(new Error('save response was not intercepted')),15000))]);}finally{clearTimeout(timeout);}
    assert.equal(paused.responseStatusCode,status,'the real backend completed the expected save/conflict');
    assert.equal(await s.store((_,m)=>m.s.saving()),true);
    await s.click('header.screen.start',{sel:'.mode-switch button'});await s.wait('.home');
    const name=`Delayed save ${status} ${s.lang} ${ctx.stamp}`;await saveName(name);
    const renamedFile=await s.store((_,m)=>JSON.parse(JSON.stringify(m.s.file())));
    const renamedHistory=await s.store((_,m)=>m.s.historyMark());
    await session.send('Fetch.continueResponse',{requestId:paused.requestId});paused=null;
    await s.waitFor(()=>window.__delayedHomeSaveDone);
    assert.deepEqual(await s.store((_,m)=>JSON.parse(JSON.stringify(m.s.file()))),renamedFile,'old save reply must not restore old file metadata/hash');
    assert.deepEqual(await s.store((_,m)=>m.s.historyMark()),renamedHistory,'rebased Undo/Redo remain intact');
    assert.equal(await s.store((_,m)=>m.s.dirty()),false);assert.equal(await s.store((_,m)=>m.s.saving()),false);
    assert.equal(await s.store((_,m)=>m.s.conflict()),null,'stale conflict must not set an obsolete override hash');
    assert.equal(await s.page.evaluate(()=>window.__delayedHomeSave),false,'superseded save reports no current success');
    assert.deepEqual((await backend()).design,renamedFile.design);
    assert.equal(renamedFile.design.model.id,before.design.model.id);
   }finally{
    if(paused)await session.send('Fetch.continueResponse',{requestId:paused.requestId});
    await session.send('Fetch.disable');await session.detach();
    await s.page.evaluate(()=>{delete window.__delayedHomeSave;delete window.__delayedHomeSaveDone;});
   }
   }
  });
 }
};
