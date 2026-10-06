// No solver runs: real RF creation, cancellation and modal layout in EN/TR.
import assert from 'node:assert/strict';
export default {
  id: 'S10', title: 'Deliberate RF creation and compact dialogs',
  async run(s, ctx) {
    await s.step('create an empty RF design', async () => {
      await s.page.goto(s.url, {waitUntil:'domcontentloaded'});
      await s.wait('.home');
      await s.fill(await s.field(await s.T('home.newProject.name')), `RF ${s.lang} ${ctx.stamp}`, {blur:false});
      await s.click('home.newProject.create'); await s.wait('.rb');
    });
    for (const [sizeIndex, size] of (ctx.compact ? [[1024,700],[1024,688]] : [[1440,900],[1280,720]]).entries()) {
      await s.page.setViewport({width:size[0],height:size[1]});
      await s.step(`cancel without creating a port at ${size.join('x')}`, async () => {
        const before = await s.store((_,m)=>m.s.draft.ports.length);
        await s.showDesignPanel();await s.click('tree.add.port'); await s.wait('.dz-feed-dialog');
        assert.equal(await s.store((_,m)=>m.s.draft.ports.length),before);
        assert.ok(await s.page.evaluate(()=>document.querySelector('.dz-feed-dialog').contains(document.activeElement)));
        assert.equal(await s.page.$$eval('.dz-feed-dialog input', inputs=>inputs.every(i=>i.autocomplete==='off')),true);
        const geometry=await s.page.$eval('.dz-feed-dialog', e=>{const r=e.getBoundingClientRect();return {width:r.width,bottom:r.bottom,height:innerHeight,overflow:e.scrollWidth>e.clientWidth};});
        assert.ok(geometry.width<=560 && geometry.bottom<=geometry.height && !geometry.overflow);
        if(ctx.compact)await s.tabTo('.dz-feed-dialog .dialog-foot button[type=button]');
        await s.click('common.cancel',{within:'.dz-feed-dialog'});await s.gone('.dz-feed-dialog');
        assert.equal(await s.store((_,m)=>m.s.draft.ports.length),before);
      });
      for (const key of ['L','C']) await s.step(`create pure ${key} at ${size.join('x')}`,async()=>{
        await s.showDesignPanel();await s.click('tree.add.resistor');await s.wait('.dz-feed-dialog');
        const inputs=await s.page.$$('.dz-feed-dialog input:not([type=checkbox])');
        await s.fill(inputs[6],'');await s.fill(inputs[key==='L'?7:8],key==='L'?'1e-9':'1e-12');
        if(ctx.compact)await s.tabTo('.dz-feed-dialog button[type=submit]');await s.click('feed.create',{sel:'.dz-feed-dialog button[type=submit]'});await s.gone('.dz-feed-dialog');
        const element=await s.store((_,m)=>JSON.parse(JSON.stringify(m.s.draft.resistors.at(-1))));
        assert.equal(element.R,undefined);assert.equal(element[key],key==='L'?'1e-9':'1e-12');
      });
      await s.step(`configure complex reference and waveguide at ${size.join('x')}`,async()=>{
        await s.showDesignPanel();await s.click('tree.add.port');await s.wait('.dz-feed-dialog');
        await s.fill('#feed-start-0',sizeIndex===0?'2':'4');await s.fill('#feed-stop-0',sizeIndex===0?'2':'4');
        await s.page.click('.dz-feed-dialog input[type=checkbox]');
        assert.ok((await s.text('.dz-feed-dialog')).includes(await s.T('feed.referenceNote')));
        if(ctx.compact)await s.tabTo('.dz-feed-dialog button[type=submit]');await s.click('feed.create',{sel:'.dz-feed-dialog button[type=submit]'});await s.gone('.dz-feed-dialog');
        const port=await s.store((_,m)=>JSON.parse(JSON.stringify(m.s.draft.ports.at(-1))));
        assert.deepEqual(port.reference_impedance,{real:'20',imag:'-150'});assert.equal(port.R,'50');
        await s.showDesignPanel();await s.click('tree.add.port');await s.wait('.dz-feed-dialog');
        await s.store((_,m)=>m.s.edit(d=>{d.simulation.f_min=8;d.simulation.f_max=12;}));
        await s.page.select('.dz-feed-dialog select','waveguide');
        assert.ok((await s.text('.dz-feed-dialog')).includes(await s.T('feed.floquetNote')));
        await s.fill('#feed-start-0','-11.43');await s.fill('#feed-start-1','-5.08');
        await s.fill('#feed-stop-0','11.43');await s.fill('#feed-stop-1','5.08');
        await s.fill('#feed-start-2',sizeIndex===0?'10':'20');await s.fill('#feed-stop-2',sizeIndex===0?'11':'21');
        if(ctx.compact)await s.tabTo('.dz-feed-dialog button[type=submit]');await s.click('feed.create',{sel:'.dz-feed-dialog button[type=submit]'});await s.gone('.dz-feed-dialog');
        assert.equal(await s.store((_,m)=>m.s.draft.ports.at(-1).type),'waveguide');
        await s.showDesignPanel();await s.click('tree.add.resistor');await s.wait('.dz-feed-dialog');
        const fields=await s.page.$$('.dz-feed-dialog input:not([type=checkbox])');
        await s.fill(fields[7],'1e-9');await s.page.$$eval('.dz-feed-dialog select', selects=>{const sel=selects.find(s=>[...s.options].some(o=>o.value==='series'));sel.value='series';sel.dispatchEvent(new Event('change',{bubbles:true}));});
        assert.ok((await s.text('.dz-feed-dialog')).includes(await s.T('feed.seriesLimitation')));
        await s.click('common.close',{sel:'.dz-feed-dialog button[aria-label]'});await s.gone('.dz-feed-dialog');
        assert.ok(await s.page.evaluate(()=>document.activeElement?.isConnected && !document.activeElement.closest('[inert]')));
        await s.showDesignPanel();await s.click('tree.add.resistor');await s.wait('.dz-feed-dialog');
        const seriesFields=await s.page.$$('.dz-feed-dialog input:not([type=checkbox])');await s.fill(seriesFields[7],'1e-9');
        await s.page.$$eval('.dz-feed-dialog select', selects=>{const sel=selects.find(s=>[...s.options].some(o=>o.value==='series'));sel.value='series';sel.dispatchEvent(new Event('change',{bubbles:true}));});
        if(ctx.compact)await s.tabTo('.dz-feed-dialog button[type=submit]');await s.click('feed.create',{sel:'.dz-feed-dialog button[type=submit]'});await s.gone('.dz-feed-dialog');
        await s.showDesignPanel('side');
        assert.ok((await s.text()).includes(await s.T('feed.seriesLimitation')));
      });
      await s.step(`create single-frequency chip equivalents and undo at ${size.join('x')}`,async()=>{
        for (const reactance of [-150,150,0]) {
          const before = await s.store((_,m)=>JSON.stringify(m.s.draft));
          await s.showDesignPanel();await s.click('tree.add.resistor');await s.wait('.dz-feed-dialog');
          assert.equal(await s.page.$eval('.dz-chip-helper',e=>e.open),false);
          await s.page.click('.dz-chip-helper summary');
          assert.equal(await s.page.$eval('#feed-chip-frequency',e=>Number(e.value)),10,'default is design band center in GHz');
          assert.ok((await s.text('.dz-chip-helper')).includes(await s.T('feed.chipNote')));
          await s.fill('#feed-chip-real','0');
          assert.equal(await s.page.$eval('.dz-chip-helper button',e=>e.disabled),true);
          await s.fill('#feed-chip-real','20');await s.fill('#feed-chip-imag',String(reactance));await s.fill('#feed-chip-frequency','0');
          assert.equal(await s.page.$eval('.dz-chip-helper button',e=>e.disabled),true);
          await s.page.focus('#feed-chip-frequency');await s.page.keyboard.press('Enter');
          assert.equal(await s.store((_,m)=>JSON.stringify(m.s.draft)),before,'invalid helper Enter cannot submit default R');
          assert.ok(await s.page.$('.dz-feed-dialog'));
          await s.fill('#feed-chip-frequency','0.915');
          await s.page.focus('#feed-chip-frequency');await s.page.keyboard.press('Enter');
          assert.equal(await s.store((_,m)=>JSON.stringify(m.s.draft)),before,'Enter in helper fills for review without creating');
          assert.ok(await s.page.$('.dz-feed-dialog'),'Enter leaves the creation form open');
          const manual = await s.page.$$eval('.dz-feed-dialog input:not([type=checkbox])',inputs=>inputs.slice(6,9).map(i=>i.value));
          assert.ok(Math.abs(Number(manual[0])-(400+reactance*reactance)/20)<1e-10,'Enter fills the equivalent resistance');
          await s.page.focus('.dz-chip-helper button');await s.page.keyboard.press('Enter');
          assert.equal(await s.store((_,m)=>JSON.stringify(m.s.draft)),before,'calculator only fills the form');
          if(ctx.compact)await s.tabTo('.dz-feed-dialog button[type=submit]');await s.click('feed.create',{sel:'.dz-feed-dialog button[type=submit]'});await s.gone('.dz-feed-dialog');
          const load=await s.store((_,m)=>JSON.parse(JSON.stringify(m.s.draft.resistors.at(-1))));
          const square=400+reactance*reactance,omega=2*Math.PI*915e6;
          assert.equal(load.topology,'parallel');assert.ok(Math.abs(Number(load.R)-square/20)<1e-10);
          if (reactance<0) {assert.ok(Math.abs(Number(load.C)-(-reactance/(omega*square)))<1e-25);assert.equal(load.L,undefined);}
          else if (reactance>0) {assert.ok(Math.abs(Number(load.L)-square/(omega*reactance))<1e-21);assert.equal(load.C,undefined);}
          else {assert.equal(load.L,undefined);assert.equal(load.C,undefined);}
          await s.click('ribbon.tab.home',{sel:'.rb-tab'});await s.click('ribbon.home.undo',{sel:'.rb-btn'});
          assert.equal(await s.store((_,m)=>JSON.stringify(m.s.draft)),before,'one undo removes the created physical load');
        }
      });
    }
  }
};
