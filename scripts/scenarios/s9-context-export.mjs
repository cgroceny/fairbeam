import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {pythonPath,root} from './stack.mjs';
async function menu(s){
 const label=await s.T('contextExport.label');
 assert.equal(await s.page.$eval('.header-cst',e=>e.getAttribute('aria-label')),label);
 assert.equal(await s.page.$eval('.header-cst',e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'export trigger is reachable by pointer');
 await s.clickSel('.header-cst');await s.wait('.context-export-menu');
}
async function exportItem(s,id){await menu(s);await s.clickSel(`[data-export-action="${id}"]`);}
export default {id:'S9',title:'Export the active visible surface',async run(s,ctx){
 let id;
 await s.step('Start and an empty design disable screenshots despite a retained bundle',async()=>{
  await s.page.evaluateOnNewDocument(()=>{window.__exports=[];const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{if(blob instanceof Blob)blob.text().then(text=>window.__exports.push({type:blob.type,text}));return create(blob);};const click=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){window.__exports.push({name:this.download,url:this.href});return click.call(this);};});
  await s.page.goto(s.url,{waitUntil:'domcontentloaded'});await s.wait('.home');
  const camera=await s.wait('.header-secondary button',await s.T('header.screenshot.aria'),{attr:'aria-label'});
  assert.equal(await camera.evaluate(e=>e.disabled),true);assert.match(await camera.evaluate(e=>e.title),new RegExp((await s.T('contextExport.noView')).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  await s.page.evaluate(()=>window.dispatchEvent(new Event('fairbeam:screenshot')));await s.sleep(100);assert.equal(await s.page.evaluate(()=>window.__exports.length),0);
  await s.fill(await s.field(await s.T('home.newProject.name')),`Context exports ${s.lang} ${ctx.stamp}`);
  await s.click('home.newProject.create');await s.wait('.rb');
  id=await s.store((_,m)=>m.s.draft.model.id);
  assert.equal(await camera.evaluate(e=>e.disabled),true);
  await menu(s);await s.press('Escape');await s.page.focus('.header-cst');await s.press('ArrowDown');await s.wait('.context-export-menu');assert.equal(await s.page.$eval('[data-export-action="geometry"]',e=>e.disabled),true);
  assert.equal(await s.page.$eval('[data-export-action="design-json"]',e=>e.disabled),false);
  const focused=await s.page.evaluateHandle(()=>document.activeElement);
  // Availability updates must preserve focus: Escape cannot reach a detached menu item.
  await s.store((_,m)=>m.s.edit(d=>d.parts.push({name:'focus_probe',material:d.materials[0].name,primitives:[{kind:'box',start:[0,0,0],stop:[1,1,1]}]})));
  assert.equal(await focused.evaluate(e=>e.isConnected&&e===document.activeElement),true,'action refresh retains the focused item');
  await s.press('Escape');await s.gone('.context-export-menu');
  await s.store((_,m)=>m.s.undo());
  await menu(s);await s.press('Escape');await s.gone('.context-export-menu');
 });
 await s.step('current unsaved geometry enables 3D screenshot and contextual design exports',async()=>{
  await s.store((_,m)=>m.s.edit(d=>d.parts.push({name:'offset_patch',material:d.materials[0].name,primitives:[{kind:'box',start:[-11,-17,1],stop:[21,23,1]}]})));
  await s.waitFor(async()=>!!(await import('/src/state.ts')).bundle()?.parts.length,null,{what:'the unsaved preview'});
  await s.waitFor(()=>!document.querySelector('.header-secondary button[aria-label]')?.disabled,null,{what:'enabled screenshot'});
  await exportItem(s,'design-json');await s.sleep(250);
  assert.ok(await s.page.evaluate(()=>window.__exports.some(e=>e.text?.includes('offset_patch'))));
  await s.click('header.screenshot.aria',{sel:'.header-secondary button',attr:'aria-label'});await s.sleep(250);
  assert.ok(await s.page.evaluate(()=>window.__exports.some(e=>e.url?.startsWith('data:image/png'))));
 });
 await s.step('result-tab exports use actual chart and data, never the hidden 3D canvas',async()=>{
  const fixture=JSON.parse(readFileSync(join(root,'public/projects/patch-antenna.json'),'utf8'));fixture.model.id=id;writeFileSync(join(ctx.stack.projects,`${id}--run-a.json`),JSON.stringify(fixture));
  execFileSync(pythonPath(),['-m','fairbeam','index',ctx.stack.projects],{cwd:join(root,'python'),env:{...process.env,PYTHONPATH:join(root,'python')},stdio:'ignore',windowsHide:true});
  await s.click('ribbon.tab.home',{sel:'.rb-tab'});await s.click('common.save',{sel:'.rb-btn'});await s.sleep(300);await s.page.reload({waitUntil:'domcontentloaded'});await s.wait('.rb');
  await s.showDesignPanel();await (await s.wait('.nt-row[data-id^="run:"]')).click();await s.click('ribbon.tab.post',{sel:'.rb-tab'});await s.click('ribbon.post.sparams',{sel:'.rb-btn'});await s.wait('.dw-result-plot .chart svg');
  await menu(s);assert.equal(await s.page.$$eval('[data-export-action="geometry"]',e=>e.length),0);assert.equal(await s.page.$eval('[data-export-action="result-csv"]',e=>e.disabled),false);await s.press('Escape');
  await exportItem(s,'result-csv');await s.sleep(150);assert.ok(await s.page.evaluate(()=>window.__exports.some(e=>/_sparams_.*\.csv$/.test(e.name??''))));
  await exportItem(s,'figure-svg');await s.sleep(150);assert.ok(await s.page.evaluate(()=>window.__exports.some(e=>e.type==='image/svg+xml'&&e.text?.includes('<svg'))));
  const before=await s.page.evaluate(()=>window.__exports.filter(e=>e.url?.startsWith('data:image/png')).length);
  await s.click('header.screenshot.aria',{sel:'.header-secondary button',attr:'aria-label'});await s.sleep(750);
  assert.equal(await s.page.evaluate(()=>window.__exports.filter(e=>e.url?.startsWith('data:image/png')).length),before,'result screenshot never calls hidden3D');
  assert.ok(await s.page.evaluate(()=>window.__exports.some(e=>/_sparams_.*\.png$/.test(e.name??''))));
 });
 await s.step('Drawing exports route to the visible sheet and report a global outcome',async()=>{
  await menu(s);
  await s.ev((_,m)=>{m.w.setAppMode('results');m.state.setCenterView('drawing');},null,{w:'/src/workspace.ts',state:'/src/state.ts'});
  await s.gone('.context-export-menu');
  await s.wait('.dv-export');await menu(s);const ids=await s.page.$$eval('[data-export-action]',es=>es.map(e=>e.dataset.exportAction));assert.deepEqual(ids,['drawing-svg','drawing-pdf','drawing-png']);await s.press('Escape');
  await exportItem(s,'drawing-svg');await s.sleep(150);assert.ok(await s.page.evaluate(()=>window.__exports.some(e=>e.name?.includes('_drawing_')&&e.name.endsWith('.svg'))));
  const before=await s.page.evaluate(()=>window.__exports.filter(e=>e.url?.startsWith('data:image/png')).length);
  await s.click('header.screenshot.aria',{sel:'.header-secondary button',attr:'aria-label'});await s.sleep(750);
  assert.equal(await s.page.evaluate(()=>window.__exports.filter(e=>e.url?.startsWith('data:image/png')).length),before);
  assert.ok(await s.page.evaluate(()=>window.__exports.some(e=>e.name?.includes('_drawing_')&&e.name.endsWith('.png'))));
 });
 await s.step('compact Header More uses the same visible-surface screenshot action',async()=>{
  await s.page.setViewport({width:768,height:900});await s.sleep(200);
  await s.click('header.more.aria',{sel:'.header-more-trigger'});
  const before=await s.page.evaluate(()=>window.__exports.filter(e=>e.url?.startsWith('data:image/png')).length);
  await s.click('header.screenshot.aria',{within:'#header-more-menu'});await s.sleep(750);
  assert.equal(await s.page.evaluate(()=>window.__exports.filter(e=>e.url?.startsWith('data:image/png')).length),before);
  await menu(s);assert.deepEqual(await s.page.$$eval('[data-export-action]',es=>es.map(e=>e.dataset.exportAction)),['drawing-svg','drawing-pdf','drawing-png']);await s.press('Escape');
 });
 if(ctx.ribbonFileAudit) await s.step('File opening and ribbon baselines at supported desktop widths',async()=>{
  await s.ev((_,m)=>m.w.setAppMode('design'),null,{w:'/src/workspace.ts'});
  for(const width of [1024,1280,1440]){
   await s.page.setViewport({width,height:700});await s.sleep(250);
   assert.equal(await s.page.$$eval('.header-secondary [aria-label]',es=>es.some(e=>e.getAttribute('aria-label')==='Open a result file'||e.getAttribute('aria-label')==='Sonuç dosyası aç')),false);
   for(const tab of ['view','sim']){
    await s.click(`ribbon.tab.${tab}`,{sel:'.rb-tab'});await s.sleep(200);
    const ys=await s.page.$$eval('.rb:not([hidden]) .rb-toolbar > .rb-group:not(.rb-extra)',gs=>gs.map(g=>g.hasAttribute('data-collapsed')?g.querySelector('.rb-group-toggle'):g.querySelector('.rb-items > .rb-btn')).filter(e=>e&&e.getClientRects().length).map(e=>e.querySelector('svg').getBoundingClientRect().y));
    assert.ok(Math.max(...ys)-Math.min(...ys)<=2,`${width}/${tab}: ${ys}`);
   }
   await s.page.screenshot({path:join(tmpdir(),`fairbeam-ribbon-${s.lang}-${width}.png`)});
  }
  await s.click('header.more.aria',{sel:'.header-more-trigger'});
  const chooser=s.page.waitForFileChooser();await s.click('header.open.label',{within:'#header-more-menu'});await (await chooser).accept([join(root,'public/projects/patch-antenna.json')]);
  await s.waitFor(async()=>{const m=await import('/src/workspace.ts');const st=await import('/src/state.ts');return m.appMode()==='results'&&!!st.bundle()?.results;},null,{what:'external result opened through More'});
 });
}};
