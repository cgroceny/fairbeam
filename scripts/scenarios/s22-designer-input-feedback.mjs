// Designer input/feedback regressions. Geometry previews are allowed; no solver starts.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default {
 id:'S22',title:'Designer numeric entry, feedback and metadata edits',
 async run(s,ctx){
  const modules={r:'/src/runner/store.ts',d:'/src/runner/designRun.ts',a:'/src/runner/api.ts',s:'/src/designer/store.ts'};
  await s.step('create a patch for input and preparation checks',async()=>{
   await s.page.goto(s.url,{waitUntil:'domcontentloaded'});await s.wait('.home');
   await s.fill(await s.field(await s.T('home.newProject.name')),`Feedback ${s.lang} ${ctx.stamp}`,{blur:false});
   await(await s.wait('label, .home-tpl',await s.T('templates.patch.name'))).click();
   await s.click('home.newProject.create');await s.wait('.rb');
   await s.waitFor(async()=>{const r=await import('/src/runner/store.ts');return r.previewState()==='ready';});
  });
  await s.step('manual threads stay visible when empty, and the hint does not change Auto',async()=>{
   await s.ev((_,m)=>{m.r.setThreads(2);m.d.setRunDialogOpen(true);},null,modules);await s.wait('#rd-form');
   const input=await s.wait('#rd-form .gs-check + input');await s.fill(input,'',{blur:false});
   assert.equal(await input.evaluate(el=>el.isConnected),true,'clearing manual threads must not turn on Auto');
   assert.equal(await s.page.$eval('#rd-form .gs-check input',el=>el.checked),false);
   assert.equal(await input.evaluate(el=>el.getAttribute('aria-invalid')),'true');
   assert.equal(await s.ev((_,m)=>m.r.threads(),null,modules),2,'an invalid edit does not overwrite the remembered count');
   await s.fill(input,'3');await s.clickSel('#rd-threads-hint');
   assert.equal(await s.page.$eval('#rd-form .gs-check input',el=>el.checked),false,'clicking guidance is not a checkbox action');
   assert.equal(await input.evaluate(el=>el.value),'3');
   await s.clickSel('#rd-form .gs-check input');assert.equal(await s.page.$('#rd-threads'),null);
   await s.clickSel('#rd-form .gs-check input');assert.equal(await s.page.$eval('#rd-threads',el=>el.value),'3');
   await s.click('common.close',{within:'.rd-dialog'});
  });
  await s.step('convergence decimal commas normalize and invalid values are described',async()=>{
   await s.ev(async()=>{(await import('/src/designer/ConvergenceDialog.tsx')).openMeshConvergence();});await s.wait('.cv-dialog');
   for(const key of ['conv.tol.f.aria','conv.tol.s11.aria','conv.tol.dmax.aria']){
    const input=await s.wait(`.cv-dialog input[aria-label=${JSON.stringify(await s.T(key))}]`);await s.fill(input,'0,5');
    assert.equal(await input.evaluate(el=>el.value),'0.5');assert.equal(await input.evaluate(el=>el.getAttribute('aria-invalid')),'false');
   }
   const max=await s.field(await s.T('conv.maxRuns'),{within:'.cv-dialog'});await s.fill(max,'2.5');
   assert.equal(await max.evaluate(el=>el.getAttribute('aria-invalid')),'true');
   assert.equal(await max.evaluate(el=>document.getElementById(el.getAttribute('aria-describedby'))?.getAttribute('role')),'alert');
   await s.fill(max,'3');await s.click('common.close',{within:'.cv-dialog'});
  });
  await s.step('sweep metadata stays editable and undoable without another preview request',async()=>{
   await s.ev(async(_,m)=>{await m.s.save();await(await import('/src/designer/SweepDialog.tsx')).openDesignerSweep();},null,modules);await s.wait('.sd-dialog');
   await s.waitFor(async()=>!(await import('/src/designer/store.ts')).saving());
   await s.ev((_,m)=>{window.__previewCalls=0;window.__previewOriginal=m.a.api.previewDesign;m.a.api.previewDesign=(...args)=>{window.__previewCalls++;return window.__previewOriginal(...args);};},null,modules);
   assert.equal(await (await s.field(await s.T('sweep.sequenceName'),{within:'.sd-dialog'})).evaluate(el=>el.value),await s.T('sweep.sequenceN',{n:1}));
   await s.click('sweep.addParameter',{within:'.sd-dialog'});
   const name=await s.field(await s.T('sweep.sequenceName'),{within:'.sd-dialog'});
   await s.fill(name,'Local sweep plan');
   await new Promise(resolve=>setTimeout(resolve,700));
   assert.equal(await s.page.evaluate(()=>window.__previewCalls),0);
   assert.equal(await s.store((_,m)=>m.s.dirty()),true);
   await s.store((_,m)=>m.s.undo());await s.store((_,m)=>m.s.redo());
   await new Promise(resolve=>setTimeout(resolve,350));assert.equal(await s.page.evaluate(()=>window.__previewCalls),0);
   await s.ev((_,m)=>{m.a.api.previewDesign=window.__previewOriginal;},null,modules);
   await s.click('common.close',{within:'.sd-dialog'});
  });
  await s.step('optimizer immediately announces preparation and closing prevents a late reopen',async()=>{
   await s.ev(async(_,m)=>{
    await m.s.save();window.__modelsOriginal=m.a.api.models;
    window.__modelsGate=new Promise(resolve=>window.__modelsRelease=resolve);
    m.a.api.models=async()=>{await window.__modelsGate;return window.__modelsOriginal();};
    window.__optimizePending=(await import('/src/designer/OptimizeDialog.tsx')).openDesignerOptimize();
   },null,modules);
   assert.ok(await s.page.$('#od-title'),'preparation must open the dialog before it resolves');await s.wait('[role=status]',await s.T('opt.dialog.preparing'),{within:'.rd-dialog'});
   assert.equal(await s.page.$('.rd-dialog .rp-start-btn'),null,'the editable optimizer is not mounted before its model is ready');
   await s.click('common.close',{within:'.rd-dialog'});
   await s.ev(async(_,m)=>{window.__modelsRelease();await window.__optimizePending;m.a.api.models=window.__modelsOriginal;},null,modules);
   assert.equal(await s.page.$('#od-title'),null);
  });
  await s.step('optimizer failure is an alert and retry recovers the form',async()=>{
   await s.ev(async(_,m)=>{m.a.api.models=async()=>[];await(await import('/src/designer/OptimizeDialog.tsx')).openDesignerOptimize();},null,modules);
   await s.wait('.rd-dialog [role=alert]');assert.equal(await s.page.$('.rd-dialog .rp-start-btn'),null);
   await s.ev((_,m)=>{m.a.api.models=window.__modelsOriginal;},null,modules);
   await s.click('opt.dialog.retry',{within:'.rd-dialog'});await s.wait('.rd-dialog .rp-start-btn');
   await s.click('common.close',{within:'.rd-dialog'});
  });
  await s.step('RLC check links focus the actual field and optional blanks remain absent',async()=>{
   s.consoleAllow.push(/Failed to load resource:.*422/);
   await s.store((_,m)=>{m.s.edit(d=>d.resistors.push({name:'RLC_feedback',start:[0,0,0],stop:[0,0,1],direction:'z',R:0}));m.s.focusPath('resistors[0].R');});
   const r=await s.wait('#dz-resistors-0--R');
   await s.waitFor(()=>document.activeElement?.id==='dz-resistors-0--R');
   assert.equal(await r.evaluate(el=>el.getAttribute('aria-invalid')),'true');
   assert.ok(await r.evaluate(el=>document.getElementById(el.getAttribute('aria-describedby'))?.textContent.trim()));
   await s.fill(r,'50');const l=await s.wait('#dz-resistors-0--L');await s.fill(l,'1e-9');await s.fill(l,'');
   assert.equal(await l.evaluate(el=>el.getAttribute('aria-invalid')),'false');
   assert.equal(await s.store((_,m)=>Object.hasOwn(m.s.draft.resistors[0],'L')),false);
   await s.fill(l,'unknown_inductance');assert.equal(await l.evaluate(el=>el.getAttribute('aria-invalid')),'true');
   // Force the server-error state before correcting it: otherwise fast typing can miss
   // the stale-diagnostic bug and leave this assertion dependent on preview timing.
   await s.waitFor(async()=>Boolean((await import('/src/designer/store.ts')).serverErrors()['resistors[0].L']));
   await s.fill(l,'1e-9');assert.equal(await l.evaluate(el=>el.getAttribute('aria-invalid')),'false');
  });
  await s.step('RLC symbol selection is visual, undoable and persists',async()=>{
   const field=await s.wait('#dz-resistors-0--symbol');
   const before=await s.store((_,m)=>JSON.stringify(m.s.draft.resistors[0]));
   for(const value of ['capacitor','inductor','network','resistor','auto']) {
    await field.select(value);
    assert.equal(await s.store((_,m)=>m.s.draft.resistors[0].symbol),value);
   }
   await field.select('capacitor');
   const after=await s.store((_,m)=>JSON.stringify(m.s.draft.resistors[0]));
   const a=JSON.parse(before),b=JSON.parse(after);delete a.symbol;delete b.symbol;assert.deepEqual(a,b);
   await s.store((_,m)=>m.s.undo());assert.equal(await field.evaluate(el=>el.value),'auto');
   await s.store((_,m)=>m.s.redo());assert.equal(await field.evaluate(el=>el.value),'capacitor');
   await s.store(async(_,m)=>m.s.save());
   const id=await s.store((_,m)=>m.s.file().id);
   const saved=await s.page.evaluate(async id=>(await(await fetch(`/api/designs/${id}`)).json()).design,id);
   assert.equal(saved.resistors[0].symbol,'capacitor');
  });
  await s.step('new parameter and import diagnostics use the selected UI language',async()=>{
   s.consoleAllow.push(/Failed to load resource:.*422/);
   await s.store((_,m)=>m.s.setParamAsks([{key:'for'}]));await s.wait('.np');
   const keyword=await s.T('checks.sub.structure.why.keyword');
   await s.wait('.np .dz-bad',keyword.charAt(0).toLocaleUpperCase(s.lang==='tr'?'tr-TR':'en-US')+keyword.slice(1));
   await s.fill(await s.field(await s.T('newParam.value'),{within:'.np'}),'Missing/2');
   await s.click('newParam.create',{within:'.np'});
   const message=await s.page.$$eval('.np .dz-bad',els=>els.map(el=>el.textContent));
   assert.ok(message.some(value=>value.includes('Missing')));
   if(s.lang==='tr')assert.ok(message.every(value=>!value.toLowerCase().includes('unknown name')));
   await s.click('common.close',{within:'.np'});
   await s.ev(async()=>{(await import('/src/designer/dockState.ts')).openParametersTab();});
   await s.click('params.import',{within:'.param-dock'});await s.wait('.parameter-transfer-dialog');
   const bad=join(ctx.stack.dir,`bad-parameters-${s.lang}.json`);writeFileSync(bad,'{');
   await(await s.wait('.parameter-transfer-dialog input[type=file]')).uploadFile(bad);
   await s.wait('.parameter-transfer-dialog [role=alert]',await s.T('checks.msg.parameter-import.json'));
   await s.click('common.close',{within:'.parameter-transfer-dialog'});
  });
 }
};
