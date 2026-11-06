import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default {
  id: 'S25', title: 'Portable mesh and optimizer settings',
  async run(s, ctx) {
    const folder = mkdtempSync(join(tmpdir(), 'fairbeam-settings-'));
    const sim = '[data-settings-transfer="simulation-settings.json"]';
    const opt = '[data-settings-transfer="optimization-settings.json"]';
    const snapshot = () => s.store((_, m) => JSON.stringify(m.s.draft));
    const upload = async (selector, data) => {
      const path = join(folder, 'settings.json'); writeFileSync(path, data);
      const chooser = s.page.waitForFileChooser();
      await s.click('settingsFile.import', {within: selector});
      await (await chooser).accept([path]);
      await s.waitFor(selector => !document.querySelector(`${selector} button`).disabled, selector);
    };
    const downloaded = async selector => {
      await s.page.evaluate(() => {
        window.__settingsDownload = null;
        const create = URL.createObjectURL.bind(URL);
        URL.createObjectURL = blob => { if (blob instanceof Blob) void blob.text().then(text => { window.__settingsDownload = text; }); return create(blob); };
      });
      await s.click('settingsFile.export', {within: selector});
      await s.waitFor(() => typeof window.__settingsDownload === 'string');
      return s.page.evaluate(() => window.__settingsDownload);
    };
    let original, simulationFile, optimizationFile;
    try {
      await s.step('create a patch and export its mesh/simulation settings through the real UI', async () => {
        await s.page.goto(s.url, {waitUntil:'domcontentloaded'}); await s.wait('.home');
        await s.fill(await s.field(await s.T('home.newProject.name')), `Settings ${s.lang} ${ctx.stamp}`, {blur:false});
        await (await s.wait('label, .home-tpl', await s.T('templates.patch.name'))).click();
        await s.click('home.newProject.create'); await s.wait('.rb');
        original = await snapshot();
        await s.ev((_,m)=>m.ss.openSimSettings('profile'),null,{ss:'/src/designer/simSettingsState.ts'});
        await s.wait('.ss-dialog');
        simulationFile = await downloaded(sim);
        assert.equal(JSON.parse(simulationFile).schema,'fairbeam.simulation-settings/1');
      });
      await s.step('import is atomic, rejects malformed files and participates in Cancel and Undo', async () => {
        const changed = JSON.parse(simulationFile); changed.simulation.max_timesteps = 12345;
        await upload(sim, JSON.stringify(changed));
        assert.equal(await s.store((_,m)=>m.s.draft.simulation.max_timesteps),12345);
        assert.ok((await s.text(sim)).includes(await s.T('settingsFile.applied')));
        const before = await snapshot();
        await upload(sim, '{"schema":"unknown"}');
        assert.equal(await snapshot(),before);
        assert.ok((await s.text(sim)).includes(await s.T('settingsFile.invalid')));
        await s.press('Escape'); await s.gone('.ss-dialog');
        assert.equal(await snapshot(),original,'Cancel restores the entire design');
        await s.ev((_,m)=>m.ss.openSimSettings('profile'),null,{ss:'/src/designer/simSettingsState.ts'});
        await s.wait('.ss-dialog'); await upload(sim,JSON.stringify(changed));
        await s.click('common.ok',{within:'.ss-dialog'}); await s.gone('.ss-dialog');
        await s.store((_,m)=>m.s.undo());
        assert.equal(await snapshot(),original,'one Undo restores imported settings');
      });
      await s.step('export/import the optimizer without submitting a run; reject incompatible parameters and goals', async () => {
        await s.click('ribbon.tab.optimize',{sel:'.rb-tab'});
        await s.click('ribbon.optimize.optimizer',{sel:'.rb-btn'}); await s.wait(opt);
        optimizationFile = await downloaded(opt);
        const current = () => s.ev((_,m)=>m.o.exportOptimizerSettings(),null,{o:'/src/runner/optimize.ts'});
        assert.equal(await current(),optimizationFile);
        const changed = JSON.parse(optimizationFile); changed.settings.maxEvals=7;
        await upload(opt,JSON.stringify(changed));
        assert.equal(JSON.parse(await current()).settings.maxEvals,7);
        const before = await current();
        for (const mutate of [x=>x.parameters[0].unit='incompatible', x=>x.settings.goals[0].target='-1',
          x=>x.settings.vary[0].max=x.settings.vary[0].min, x=>x.settings.maxEvals=41,
          x=>Object.assign(x.settings.goals[0],{kind:'sij_max',target:'-10',at:'2.4',i:'99',j:'1'})]) {
          const invalid=JSON.parse(optimizationFile); mutate(invalid); await upload(opt,JSON.stringify(invalid));
          assert.equal(await current(),before,'refused import preserves the whole form');
          assert.ok((await s.text(opt)).includes(await s.T('settingsFile.incompatible')));
        }
        await upload(opt,simulationFile); assert.equal(await current(),before,'wrong settings kind cannot change the form');
        await upload(opt,optimizationFile); assert.equal(await current(),optimizationFile);
        if (process.env.FAIRBEAM_SCENARIO_SCREENSHOTS) {
          mkdirSync(process.env.FAIRBEAM_SCENARIO_SCREENSHOTS,{recursive:true});
          await s.page.screenshot({path:join(process.env.FAIRBEAM_SCENARIO_SCREENSHOTS,`S25-${s.lang}-optimizer.png`)});
        }
        await s.press('Escape'); await s.gone('[role=dialog]');
        const response=await fetch(`${ctx.stack.apiUrl}/api/runs`); const jobs=(await response.json()).runs;
        assert.equal(jobs.filter(j=>j.model===JSON.parse(original).model.id).length,0,'transfers start no solver jobs');
      });
    } finally { rmSync(folder,{recursive:true,force:true}); }
  },
};
