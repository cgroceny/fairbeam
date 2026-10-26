// Designer Array acceptance: existing synthetic fields only. No solver, native or renderer jobs.
import assert from 'node:assert/strict';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import puppeteer from 'puppeteer-core';
import {startStack,chromePath,root} from './scenarios/stack.mjs';
import {Session,auditInPage} from './scenarios/harness.mjs';
import {withStartupDiagnostics,safeDiagnosticText} from './scenarios/startup-diagnostics.mjs';
if(process.env.GITHUB_ACTIONS!=='true'&&process.env.FAIRBEAM_ALLOW_BROWSER_TEST!=='1')
  throw new Error('Browser test requires CI or explicit browser-test authorization.');
const out=resolve(process.env.FAIRBEAM_TEST_ARTIFACTS||join(tmpdir(),`fairbeam-designer-array-${Date.now()}`),'designer-array');
await mkdir(out,{recursive:true});
const fixture=JSON.parse(await readFile(join(root,'examples/synthetic/array2x1.json'),'utf8'));
// A second frequency is an intentionally copied analytical grid for state-lifetime controls,
// not a second simulation or a frequency-response/physical validation claim.
const f0=fixture.results.farfield[0].f,f1=f0+100e6;
fixture.results.element_patterns.push({...structuredClone(fixture.results.element_patterns[0]),f:f1});
fixture.results.farfield.push({...structuredClone(fixture.results.farfield[0]),f:f1});
fixture.name=fixture.model.name='Synthetic Array lifetime control';fixture.run=null;
let stack,browser,page,session,lang;const outcomes=[],forbidden=[];
const mods={a:'/src/designer/arraySession.ts',v:'/src/lib/arrayStore.ts',ca:'/src/lib/currentArray.ts',st:'/src/state.ts',dr:'/src/runner/designRun.ts',rf:'/src/designer/resultFocus.ts',rr:'/src/designer/runResults.ts',mt:'/src/designer/mainTabsState.ts'};
try {
 stack=await startStack({log:console.log});
 browser=await puppeteer.launch({headless:true,executablePath:await chromePath(),args:['--no-sandbox','--mute-audio','--enable-unsafe-swiftshader','--use-angle=swiftshader']});
 for(lang of ['en','tr']) {
  const context=await browser.createBrowserContext();await context.overridePermissions(stack.url,['clipboard-read','clipboard-write','clipboard-sanitized-write']);
  page=await context.newPage();await page.setViewport({width:1440,height:1000});
  await page.evaluateOnNewDocument(language=>localStorage.setItem('fairbeam.generalSettings',JSON.stringify({language})),lang);
  await page.setRequestInterception(true);page.on('request',request=>{
   const path=new URL(request.url()).pathname;
   if(request.method()==='POST'&&/^\/api\/(?:runs|sweeps|convergence|optimizations|research\/runs|render-jobs|native-document)(?:\/|$)/.test(path)){forbidden.push(path);void request.abort();}else void request.continue();
  });
  const s=session=new Session(page,{lang,scenario:'designer-array',url:stack.url,artifactDirectory:out});
  const downloads=join(out,lang);await mkdir(downloads,{recursive:true});
  await(await page.createCDPSession()).send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await withStartupDiagnostics(page,{directory:join(out,`startup-${lang}`),stack},async()=>{
   await page.goto(stack.url,{waitUntil:'domcontentloaded'});await s.wait('.home',undefined,{timeout:45000});
  });
  // Open a real imported viewer result, steer it, then create a separate Designer document.
  const importFile=join(out,`synthetic-${lang}.json`);await writeFile(importFile,JSON.stringify(fixture));
  await(await page.$('.app-header input[type=file]')).uploadFile(importFile);
  await s.waitFor(async()=>(await import('/src/lib/arrayStore.ts')).hasArray());
  await s.clickSel('.dock [data-tab="array"]');await s.fill('.array-scan .array-input','35');
  assert.ok((await s.ev((_,m)=>[...m.v.arrayWeights()],null,mods)).some(([,w])=>w.phaseDeg!==0));
  await s.click('header.screen.start',{within:'.mode-switch',exact:true});await s.wait('.home');
  await page.locator('input[name="home-template"][value="patch"]').click();
  await s.fill(await s.field(await s.T('home.newProject.name')),`Array control ${lang}`,{blur:false});
  await s.click('home.newProject.create');await s.wait('.rb');
  const own=await s.store((_,m)=>m.s.file());
  const a=structuredClone(fixture),b=structuredClone(fixture);a.model.id=b.model.id=own.design.model.id;
  b.name=b.model.name='Synthetic Array second run';
  const files=[`${own.id}--array-a.json`,`${own.id}--array-b.json`];
  await writeFile(join(stack.projects,files[0]),JSON.stringify(a));await writeFile(join(stack.projects,files[1]),JSON.stringify(b));
  await s.ev(({a,b,files},m)=>{
   m.st.setIndex([...m.st.index(),...[a,b].map((bundle,i)=>({file:files[i],model:bundle.model.id,name:bundle.name,created:bundle.created,simulated:true,bands:[],params:[]}))]);
   m.dr.setDesignResult({file:files[0],bundle:a});m.rr.ensureDesignRunBundles();m.rf.focusResult({file:files[0],view:'pattern'},'main');
  },{a,b,files},mods);
  await s.waitFor(async()=> (await import('/src/designer/ribbonResults.ts')).ribbonArray().ok);
  const folded=await s.find('.rb-group[data-collapsed] .rb-group-toggle',await s.T('ribbon.post.openTabs'),{exact:true});
  if(folded) await folded.click();
  await s.click('dock.results.array',{within:'.rb',sel:'button',exact:true});await s.wait('[data-designer-array] .array-scan');
  if(folded) await page.keyboard.press('Escape');
  const state=()=>s.ev((_,m)=>({file:m.dr.designResult()?.file,theta:m.a.designerArray.scanTheta(),weights:[...m.a.designerArray.weights()],viewer:[...m.v.arrayWeights()],set:m.a.designerArray.set()?.f,override:!!m.ca.arrayOverrideFor(m.st.bundle()),exportOwn:!!m.ca.arrayWeightsFor(m.dr.designResult().bundle),foreign:!!m.ca.arrayWeightsFor({...m.dr.designResult().bundle}),feedFrequency:m.ca.arrayFeedFor(m.dr.designResult().bundle)?.frequencyHz}),null,mods);
  let current=await state();assert.equal(current.theta,0);assert.ok(current.weights.every(([,w])=>w.phaseDeg===0));assert.deepEqual(current.viewer,[]);assert.ok(current.override&&current.exportOwn&&!current.foreign);
  // The tree exposes the same actual action, after its run has been expanded.
  const node=`.nt-tree [data-id="run:${files[0]}"]`;
  await s.wait(node);if(await page.$eval(node,e=>e.getAttribute('aria-expanded')==='false')) await page.$eval(`${node} .nt-twisty`,e=>e.click());
  const arrayNode=await s.wait(`.nt-tree [data-id="res:${files[0]}:array:${f0}"]`,await s.T('dock.results.array'),{exact:true});await arrayNode.click();
  assert.equal((await state()).file,files[0],'tree action keeps the explicitly selected run');
  await s.fill('[data-designer-array] .array-scan .array-input','25');
  current=await state();assert.equal(current.theta,25);assert.ok(current.weights.some(([,w])=>w.phaseDeg!==0));
  // Copy and actual CSV download describe the edited synthetic array, not a stored element.
  await s.click('results.toolbar.copyData',{within:'.dw-result'});await s.wait('.dw-result .rdk-copy.copied');
  const text=await page.evaluate(()=>navigator.clipboard.readText());
  const table=text.trimEnd().split(/\r?\n/).map(row=>row.split('\t'));assert.ok(table[0].includes('Directivity (dBi)'));
  const expected=await s.ev((_,m)=>m.a.designerArray.steered(),null,mods);
  const column=name=>{const i=table[0].indexOf(name);assert.ok(i>=0,`Missing column ${name}`);return i;};
  const directivity=column('Directivity (dBi)'),theta=column('theta (deg)'),phi=column('phi (deg)'),cut=column('Cut'),angle=column('Cut angle (deg)'),frequency=column('f (GHz)');
  // The toolbar exports the two plotted principal cuts, not the full spherical grid.
  assert.ok(!fixture.half_space);assert.equal(table.length-1,2*(2*expected.theta.length-1));
  const cuts=new Map();
  table.slice(1).forEach(row=>{
   const ti=expected.theta.indexOf(Number(row[theta])),pi=expected.phi.indexOf(Number(row[phi]));
   assert.ok(ti>=0&&pi>=0,'Principal-cut sample belongs to the stored angular grid');
   assert.ok(Math.abs(Number(row[directivity])-expected.directivity_dbi[ti][pi])<1e-10);
   assert.equal(Number(row[frequency]),f0/1e9);
   const values=cuts.get(row[cut])??[];values.push(Number(row[angle]));cuts.set(row[cut],values);
  });
  assert.equal(cuts.size,2);for(const angles of cuts.values())assert.deepEqual(angles,[...expected.theta.slice(1).reverse().map(t=>-t),...expected.theta]);
  const before=new Set(await readdir(downloads));await s.click('results.toolbar.csvTitle',{within:'.dw-result',sel:'button'});
  let csvFile;for(let i=0;i<100;i++){csvFile=(await readdir(downloads)).find(n=>!before.has(n)&&n.endsWith('.csv'));if(csvFile)break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(csvFile,'CSV download completed');const csv=await readFile(join(downloads,csvFile),'utf8');
  assert.equal(csv.charCodeAt(0),0xfeff);assert.deepEqual(csv.slice(1).trimEnd().split(/\r?\n/).map(row=>row.split(',')),table);
  for(const format of ['svg','png']) {
   const previous=new Set(await readdir(downloads));
   await s.click('results.figure.export',{within:'.dw-result',sel:'button'});
   await s.click('contextExport.figureFormat',{params:{format:format.toUpperCase()},within:'.result-figure-menu',sel:'button'});
   let saved;for(let i=0;i<100;i++){saved=(await readdir(downloads)).find(n=>!previous.has(n)&&n.endsWith(`.${format}`));if(saved)break;await new Promise(r=>setTimeout(r,100));}
   assert.ok(saved,`${format} figure download completed`);const bytes=await readFile(join(downloads,saved));
   if(format==='svg') {assert.match(bytes.toString('utf8'),/<svg\b/);assert.ok(bytes.toString('utf8').includes(await s.T('farfield.arrayTag')));}
   else assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  }
  assert.deepEqual(await page.evaluate(auditInPage,'[data-designer-array]'),[]);
  await page.screenshot({path:join(out,`designer-array-${lang}.png`)});
  assert.equal((await state()).theta,25,'export actions retain the current feed');
  // Distinct DOM identities also hold if two panels are mounted at the same time.
  await s.ev(async(_,m)=>{
   (await import('/scripts/scenarios/array-id-control.ts')).checkArrayPanelIds(m.a.designerArray);
  },null,mods);
  assert.equal((await state()).theta,25,'mounting another panel retains the current feed');
  // Same frequency: Pattern and 3D share the Designer session, including the validated viewport copy.
  await s.ev((f,m)=>m.rr.showView('pattern',f,'main'),f0,mods);await s.wait('.dw-result .freq-chips');assert.equal((await state()).theta,25);
  await s.click('results.toolbar.show3dTitle',{within:'.dw-result',sel:'button'});
  await s.waitFor(async()=> (await import('/src/designer/resultFocus.ts')).resultFocus()?.view==='pattern3d');assert.ok((await state()).override);
  await s.ev((f,m)=>m.rr.showView('array',f,'main'),f0,mods);await s.wait('[data-array-frequency]');
  await page.select('[data-array-frequency]',String(f1));current=await state();assert.equal(current.set,f1);assert.equal(current.feedFrequency,f1);assert.equal(current.theta,0);assert.ok(current.weights.every(([,w])=>w.phaseDeg===0));
  await s.fill('[data-designer-array] .array-scan .array-input','15');
  await s.ev(({files,f},m)=>m.rf.focusResult({file:files[0],view:'pattern',f,compare:[files[1]]},'main'),{files,f:f1},mods);
  await s.waitFor(async()=> !(await import('/src/lib/currentArray.ts')).arrayOverrideFor((await import('/src/state.ts')).bundle()));
  await s.ev((f,m)=>m.rr.showView('array',f,'main'),f1,mods);await s.wait('[data-designer-array]');
  // Selecting the other result loads its bytes through the normal result loader and resets the feed.
  assert.equal((await state()).file,files[0]);assert.equal((await state()).theta,15);
  await s.ev(({file,f},m)=>m.rf.focusResult({file,view:'array',f},'main'),{file:files[1],f:f0},mods);
  await s.waitFor(async file=>(await import('/src/runner/designRun.ts')).designResult()?.file===file,files[1]);
  current=await state();assert.equal(current.theta,0);assert.ok(current.weights.every(([,w])=>w.phaseDeg===0));
  await s.fill('[data-designer-array] .array-scan .array-input','-20');await s.ev((_,m)=>m.mt.closeMainTab('array'),null,mods);
  assert.equal(await s.ev((_,m)=>m.a.designerArray.source(),null,mods),null);
  await s.ev((f,m)=>m.rr.showView('array',f,'main'),f0,mods);await s.wait('[data-designer-array]');assert.equal((await state()).theta,0);
  await s.ev((f,m)=>m.rr.showView('array',f,'main'),f0+1e9,mods);await s.wait('[data-designer-array]',await s.T('array.noPatterns'));
  assert.equal(await s.ev((_,m)=>m.a.designerArray.steered(),null,mods),null);assert.equal((await state()).exportOwn,false);
  await s.ev((f,m)=>m.rr.showView('array',f,'main'),f0,mods);await s.wait('[data-designer-array] .array-scan');
  await s.click('header.screen.start',{within:'.mode-switch',exact:true});await s.wait('.home');
  assert.equal(await s.ev((_,m)=>m.a.designerArray.source(),null,mods),null);
  assert.deepEqual(forbidden,[]);assert.deepEqual(s.consoleIssues,[]);
  outcomes.push({lang,syntheticOnly:true,tree:true,ribbon:true,copyCsv:true,svgPng:true,uniqueIds:true,viewerDesignerIsolation:true,viewportCopyMapped:true,frequencyReset:true,comparisonStored:true,runReset:true,closeReopenReset:true,missingFrequency:true});
  await context.close();
 }
 await writeFile(join(out,'result.json'),JSON.stringify({outcomes,forbidden},null,2));console.log(JSON.stringify({out,outcomes},null,2));
}catch(error){
 await page?.screenshot({path:join(out,'failure.png')}).catch(()=>{});
 await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error?.stack||error),lang,url:page?.url(),console:session?.consoleIssues,forbidden,outcomes,children:stack?.diagnostics()},(_key,value)=>typeof value==='string'?safeDiagnosticText(value):value,2));throw error;
}finally{try{await browser?.close();}finally{await stack?.stop();}}
