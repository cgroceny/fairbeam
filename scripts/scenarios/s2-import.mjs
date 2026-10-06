// S2: import a CST macro and PCB artwork as new designs.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { root } from './stack.mjs';

const CST_MACRO = join(root, 'examples', 'cst', 'patch-antenna.bas');
const PCB_FILES = ['patch_top.gtl', 'patch_edge.gko'].map((f) => join(root, 'python', 'tests', 'fixtures', 'pcb', f));

const draftOf = async (s) => {
  const end = Date.now() + 10000;
  for (;;) {
    const d = await s.store((_, m) => (m.s.draft.parts ? JSON.parse(JSON.stringify(m.s.draft)) : null));
    if (d) return d;
    if (Date.now() > end) throw new Error('the design draft did not load');
    await s.sleep(100);
  }
};

/** The Start screen, from wherever the app is */
async function toStart(s) {
  if (!(await s.find('.home'))) await s.click('ribbon.home.start', { sel: '.rb-btn' }).catch(async () => {
    await s.click('ribbon.tab.home', { sel: '.rb-tab' });
    await s.click('ribbon.home.start', { sel: '.rb-btn' });
  });
  await s.wait('.home');
}

export default {
  id: 'S2',
  title: 'Import a CST macro and PCB artwork',
  async run(s, ctx) {
    await s.step('open the Start screen', async () => {
      await s.page.goto(s.url, { waitUntil: 'domcontentloaded' });
      await s.wait('.home');
    });

    await s.step('CST macro: choose the file, read the report', async () => {
      await s.click('home.importCst.button');
      await s.wait('#ci-file', undefined, { timeout: 5000 }).catch(() => {});
      const input = await s.page.waitForSelector('#ci-file', { timeout: 10000 });
      await input.uploadFile(CST_MACRO);
      await s.wait('.ci-report');
      const summary = await s.text('.ci-summary');
      assert.match(summary, /\d/, 'the report counts what was imported');
      assert.ok(await s.find('.ci-created'), 'the list of created items is offered');
    });
    await s.step('CST macro: create the design, solids and ports appear', async () => {
      await s.fill(await s.field(await s.T('cstImport.designName')), `Imported CST ${ctx.stamp} ${s.lang}`, { blur: false });
      await s.click('cstImport.create', { within: '.dialog, [role=dialog]' });
      await s.wait('.rb', undefined, { timeout: 30000 });
      const d = await draftOf(s);
      assert.ok(d.parts.length >= 2, `the import made solids (${d.parts.length})`);
      assert.ok(d.ports.length >= 1, 'the import made a port');
      assert.ok(await s.find('.nt-row', d.parts[0].name), 'the solids are in the tree');
      assert.match(await s.text('.nt-tree, #nt-tree'), /\d/);
    });

    await s.step('PCB artwork: choose the Gerber files, read the layers', async () => {
      await toStart(s);
      await s.click('home.importPcb.button');
      const input = await s.page.waitForSelector('#pi-file', { timeout: 10000 });
      await input.uploadFile(...PCB_FILES);
      await s.wait('.ci-report');
      assert.match(await s.text('.ci-summary'), /\d/, 'the report counts the copper');
      assert.ok(await s.find('.pi-files li, ul.pi-files'), 'the chosen files are listed');
    });
    await s.step('PCB artwork: create the design, the copper and substrate appear', async () => {
      await s.fill(await s.field(await s.T('cstImport.designName')), `Imported PCB ${ctx.stamp} ${s.lang}`, { blur: false });
      await s.click('cstImport.create', { within: '.dialog, [role=dialog]' });
      await s.wait('.pi-port-hint');
      await s.click('common.close', { within: '[role=dialog]' }).catch(() => {});
    });
    await s.step('PCB artwork: the design opens with solids', async () => {
      await s.wait('.rb', undefined, { timeout: 30000 });
      const d = await draftOf(s);
      assert.ok(d.parts.length >= 2, `the import made copper and a substrate (${d.parts.length})`);
      assert.ok(d.materials.some((m) => m.kind === 'dielectric'), 'a substrate material');
    });
  },
};
