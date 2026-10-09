// Native construction only: transport actual exported Python through Edit/Apply; no FDTD.
import assert from 'node:assert/strict';
const draftOf = s => s.store((_,m)=>JSON.parse(JSON.stringify(m.s.draft)));
// Exact box vertices in world coordinates, rounded to native import's 1e-6 mm precision.
const geometryOf = s => s.ev((_,m)=>{
  const d=m.s.draft,names=m.e.paramValues(d.params).names;
  return d.parts.flatMap(part=>m.g.maps(part.transforms,names).flatMap(map=>part.primitives.map(prim=>{
    if(prim.kind!=='box') throw new Error('acceptance fixture must contain only boxes');
    const lo=prim.start.map(v=>m.e.evaluate(v,names)),hi=prim.stop.map(v=>m.e.evaluate(v,names));
    const vertices=Array.from({length:8},(_,mask)=>{
      const local=lo.map((value,k)=>mask&(1<<k)?hi[k]:value);
      return [0,1,2].map(k=>Math.round((map.t[k]+(map.linear?map.linear[k].reduce((sum,f,j)=>sum+f*local[j],0):map.s[k]*local[map.a[k]]))*1e6)/1e6);
    }).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return vertices;
  }))).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
},null,{s:'/src/designer/store.ts',g:'/src/designer/geometry.ts',e:'/src/designer/expr.ts'});
const portsOf = s => s.ev((_,m)=>{
 const names=m.e.paramValues(m.s.draft.params).names;
 return m.s.draft.ports.map(p=>({number:p.number,type:p.type,direction:p.direction,start:p.start.map(v=>m.e.evaluate(v,names)),stop:p.stop.map(v=>m.e.evaluate(v,names))}));
},null,{s:'/src/designer/store.ts',e:'/src/designer/expr.ts'});
export default {
 id:'S11',title:'Python Apply preserves source folders across transformed copies',
 async run(s,ctx){
  let before,geometry,ports,history;
  await s.step('prepare rotated-copy and literal suffix-name fixture, then Edit exported Python',async()=>{
   await s.page.goto(s.url,{waitUntil:'domcontentloaded'});await s.wait('.home');
   await s.fill(await s.field(await s.T('home.newProject.name')),`Python folders ${s.lang} ${ctx.stamp}`,{blur:false});
   await (await s.wait('label, .home-tpl',await s.T('templates.patch.name'))).click();
   await s.click('home.newProject.create');await s.wait('.rb');
   await s.waitFor(async()=> (await import('/src/designer/store.ts')).draft.parts?.length>=3,null,{what:'patch fixture'});
   await s.store((_,m)=>m.s.edit(d=>{
    const substrate=d.parts.find(p=>p.name==='substrate');
    substrate.component='Assembly/Original';
    substrate.transforms=[{type:'rotate',axis:'z',center:[0,0,0],angle:45,copies:1}];
    const literal=JSON.parse(JSON.stringify(substrate));
    literal.name='substrate [2]';literal.component='Assembly/Literal';literal.transforms=[];
    d.parts.push(literal);d.components=['Assembly/Original','Assembly/Literal','Empty/Folder'];d.far_field.enabled=false;
   }));
   await s.click('ribbon.tab.post',{sel:'.rb-tab'});await s.clickSel('button[data-action="open-python"]');
   await s.wait('.python-panel .python-panel-code');await s.clickSel('button[data-action="python-edit"]');
   await s.wait('.python-panel .cm-content');
   before=await draftOf(s);geometry=await geometryOf(s);ports=await portsOf(s);history=await s.store((_,m)=>m.s.historyIndex());
   await s.page.evaluate(()=>{
    const view=document.querySelector('.python-panel .python-panel-editor').cmView;
    if(!view.state.doc.toString().includes('FAIRBEAM_ORGANIZATION')) throw new Error('actual generated source must contain organization metadata');
    view.dispatch({changes:{from:view.state.doc.length,insert:'\n# UI provenance acceptance\n'}});
   });
  });
  await s.step('Apply retains provenance folders and physical geometry; one Undo restores original Design',async()=>{
   await s.clickSel('button[data-action="python-apply"]');await s.wait('.python-panel-feedback',await s.T('python.edit.applied'));
   const after=await draftOf(s),folders=Object.fromEntries(after.parts.map(p=>[p.name,p.component]));
   assert.equal(folders.substrate,'Assembly/Original');assert.equal(folders['substrate [2]'],'Assembly/Original');
   assert.equal(folders['substrate [2] [2]'],'Assembly/Literal');assert.deepEqual(after.components,before.components);
   assert.equal(after.model.id,before.model.id);assert.equal(after.parts.length,before.parts.length+1,'native transformed groups are represented explicitly');
   assert.deepEqual(await geometryOf(s),geometry,'all eight world vertices of every physical box are retained');
   assert.deepEqual(await portsOf(s),ports,'port endpoints stay fixed');
   assert.equal(await s.store((_,m)=>m.s.historyIndex()),history+1,'Apply is one edit');
   await s.click('ribbon.tab.home',{sel:'.rb-tab'});
   if(!await s.find('.rb-btn',await s.T('ribbon.home.undo'))) await s.click('ribbon.home.clipboard',{sel:'.rb-group-toggle'});
   await s.click('ribbon.home.undo',{sel:'.rb-btn'});
   assert.deepEqual(await draftOf(s),before,'one toolbar Undo restores complete original Design');
  });
 }
};
