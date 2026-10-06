import assert from 'node:assert/strict';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';

async function openExport(s) {
  await s.clickSel('.header-cst');
  const menu = await s.find('[data-action="export-geometry"]');
  if (menu) await menu.click();
  await s.wait('#export-title');
  await s.waitFor(() => {
    const button = document.querySelector('[aria-labelledby="export-title"] .btn-primary');
    return button && !button.disabled;
  }, null, { what: 'current design export to finish preparing' });
}

async function downloaded(folder, suffix) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const files = await readdir(folder);
    const file = files.find(name => name.endsWith(suffix));
    if (file) return readFile(join(folder, file));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`No completed ${suffix} download`);
}

export default {
  id: 'S8', title: 'Appearance persistence and current-design export',
  async run(s, ctx) {
    await s.step('default fonts and keyboard appearance tabs', async () => {
      await s.page.goto(s.url, { waitUntil: 'domcontentloaded' });
      await s.wait('.home');
      const defaults = await s.page.evaluate(() => ({ sans: document.documentElement.style.getPropertyValue('--al-font-sans'), mono: document.documentElement.style.getPropertyValue('--al-font-mono') }));
      assert.deepEqual(defaults, { sans: '', mono: '' });
      await s.click('header.settings');
      await s.wait('#gs-title');
      await s.clickSel('#gs-tab-general');
      await s.press('ArrowRight');
      assert.equal(await s.page.evaluate(() => document.activeElement?.id), 'gs-tab-appearance');
      await s.wait('#gs-panel-appearance');
      await (await s.field(await s.T('settings.appearance.uiFont'))).select('system');
      await (await s.field(await s.T('settings.appearance.monoFont'))).select('consolas');
      await (await s.field(await s.T('settings.theme'))).select('dark');
      assert.match(await s.page.evaluate(() => getComputedStyle(document.body).fontFamily), /system-ui/);
      assert.match(await s.page.evaluate(() => getComputedStyle(document.querySelector('.gs-font-preview .mono')).fontFamily), /Consolas/);
      if (process.env.FAIRBEAM_SCENARIO_SCREENSHOTS) {
        await mkdir(process.env.FAIRBEAM_SCENARIO_SCREENSHOTS, { recursive: true });
        await s.page.screenshot({ path: join(process.env.FAIRBEAM_SCENARIO_SCREENSHOTS, `S8-${s.lang}-appearance.png`) });
      }
      await s.click('common.close', { within: '[aria-labelledby="gs-title"]' });
    });
    await s.step('font persistence and appearance-only reset', async () => {
      await s.page.reload({ waitUntil: 'domcontentloaded' });
      await s.wait('.home');
      assert.match(await s.page.evaluate(() => getComputedStyle(document.body).fontFamily), /system-ui/);
      await s.click('header.settings');
      await s.clickSel('#gs-tab-appearance');
      await s.click('settings.appearance.reset');
      const reset = await s.page.evaluate(() => ({ sans: document.documentElement.style.getPropertyValue('--al-font-sans'), mono: document.documentElement.style.getPropertyValue('--al-font-mono'), settings: JSON.parse(localStorage.getItem('fairbeam.generalSettings')) }));
      assert.equal(reset.sans, ''); assert.equal(reset.mono, '');
      assert.equal(reset.settings.language, s.lang);
      assert.equal(reset.settings.theme, 'system');
      await s.click('common.close', { within: '[aria-labelledby="gs-title"]' });
    });
    await s.step('export captures unsaved geometry and component hierarchy', async () => {
      await s.fill(await s.field(await s.T('home.newProject.name')), `Export fixture ${s.lang} ${ctx.stamp}`);
      await (await s.wait('label, .home-tpl', await s.T('templates.patch.name'))).click();
      await s.click('home.newProject.create');
      await s.wait('.rb');
      await s.waitFor(async () => (await import('/src/designer/store.ts')).draft.parts?.length >= 3);
      await s.store((_, m) => m.s.edit(d => { d.parts[1].name = 'unsaved_export_solid'; d.parts[1].component = 'Assembly/Radiator'; }));
      const folder = join(ctx.stack.dir, `export-${s.lang}`);
      await mkdir(folder, { recursive: true });
      const cdp = await s.page.createCDPSession();
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: folder, browserContextId: s.page.browserContext().id });
      await openExport(s);
      assert.equal(await s.ev((_, m) => m.w.appMode(), null, { w: '/src/workspace.ts' }), 'design');
      await s.click('export.blender.download');
      const files = unzipSync(await downloaded(folder, '.zip'));
      assert.ok(files['Render.cmd'] && files['blender-render.py']);
      assert.match(strFromU8(files['blender-render.py']), /save_as_mainfile/);
      const glb = files['model.glb'];
      const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
      assert.equal(view.getUint32(0, true), 0x46546c67);
      const model = JSON.parse(strFromU8(glb.subarray(20, 20 + view.getUint32(12, true))));
      assert.ok(model.nodes.some(node => node.name === 'unsaved_export_solid'));
      assert.ok(model.nodes.some(node => node.extras?.component === 'Assembly/Radiator'));
      await (await s.field(await s.T('export.format'), { within: '[aria-labelledby="export-title"]' })).select('glb');
      await s.click('export.glb.download');
      const directGlb = await downloaded(folder, '.glb');
      assert.equal(directGlb.readUInt32LE(0), 0x46546c67);
      assert.equal(directGlb.readUInt32LE(8), directGlb.length);
      await (await s.field(await s.T('export.format'), { within: '[aria-labelledby="export-title"]' })).select('stl');
      await s.click('export.stl.download');
      const stl = await downloaded(folder, '.stl');
      assert.ok(stl.readUInt32LE(80) > 0);
      assert.equal(stl.length, 84 + stl.readUInt32LE(80) * 50);
      assert.match(stl.toString('utf8', 0, 80), /millimetres/);
      assert.equal(await s.store((_, m) => m.s.dirty()), true, 'export must not silently save the draft');
      await s.click('common.close', { within: '[aria-labelledby="export-title"]' });
      await cdp.detach();
    });
  },
};
