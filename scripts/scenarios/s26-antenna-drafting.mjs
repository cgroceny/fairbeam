import assert from 'node:assert/strict';
import { antennaDimensions } from '../../src/home/antennaDimensions.ts';

export default {
  id:'S26', title:'Create editable antenna drafts from calculator inputs',
  async run(s,ctx) {
    const created=[];
    await s.page.goto(s.url,{waitUntil:'domcontentloaded'});await s.wait('.home');
    for(const kind of ['dipole','monopole','patch','patch']) {
      await s.step(`create ${kind} as a new editable design without a solver job`,async()=>{
        if(created.length)await s.click('header.screen.start');
        await s.wait('.home');
        await s.page.click('.antenna-calculator summary');
        await s.page.select('.antenna-calculator select',kind);
        await s.waitFor(()=>!document.querySelector('[data-testid="antenna-create"]')?.disabled);
        const response=s.page.waitForResponse(r=>new URL(r.url()).pathname==='/api/designs'&&r.request().method()==='POST');
        await s.page.click('[data-testid="antenna-create"]');
        const result=await response,saved=await result.json();assert.equal(result.status(),201,JSON.stringify(saved));
        assert.equal(saved.validation.valid,true,JSON.stringify(saved.validation));
        assert.deepEqual(saved.validation.checks.filter(c=>c.severity==='error'),[]);
        await s.wait('.rb');
        const active=await s.store((_,m)=>({id:m.s.file()?.id,design:JSON.parse(JSON.stringify(m.s.draft)),params:m.s.names().names}));
        assert.equal(active.id,saved.id);assert.deepEqual(active.design,saved.design);
        const expected=antennaDimensions({kind,frequencyGHz:2.45,shortening:.95,epsilonR:4.3,heightMm:1.6});
        assert.equal(expected.ok,true);
        assert.ok(Math.abs(active.params.L-expected.dimensions.lengthMm)<1e-8);
        if(kind==='patch')assert.ok(Math.abs(active.params.W-expected.dimensions.widthMm)<1e-8);
        const paramList=active.design.params;
        assert.equal(paramList.find(p=>p.key==='f0').default,2.45);
        assert.ok(paramList.find(p=>p.key==='L').expr,'dimension remains editable through dependent parameters');
        assert.ok(!created.includes(saved.id),'a repeated calculator draft must never overwrite an existing file');
        const persisted=await(await fetch(`${ctx.stack.apiUrl}/api/designs/${saved.id}`)).json();
        assert.deepEqual(persisted.design,saved.design);
        created.push(saved.id);
      });
    }
    await s.step('Cancel preserves unsaved work and creates no file',async()=>{
      await s.store((_,m)=>m.s.edit(d=>{d.model.description='Keep this unsaved calculator draft';}));
      const before=await s.store((_,m)=>JSON.stringify({id:m.s.file()?.id,design:m.s.draft}));
      const requests=[];
      const observe=r=>{if(new URL(r.url()).pathname==='/api/designs'&&r.method()==='POST')requests.push(r.url());};
      s.page.on('request',observe);
      try {
        await s.click('header.screen.start');await s.wait('.home');
        await s.page.click('.antenna-calculator summary');
        await s.page.click('[data-testid="antenna-create"]');await s.wait('.close-project-dialog');
        await s.press('Escape');await s.gone('.close-project-dialog');
        await s.waitFor(()=>!document.querySelector('[data-testid="antenna-create"]').disabled);
        assert.equal(await s.store((_,m)=>JSON.stringify({id:m.s.file()?.id,design:m.s.draft})),before);
        assert.equal(requests.length,0);
      } finally {s.page.off('request',observe);}
    });
    const runs=(await(await fetch(`${ctx.stack.apiUrl}/api/runs`)).json()).runs;
    assert.equal(runs.filter(r=>created.includes(r.model)).length,0,'drafting submits no solver jobs');
  },
};
