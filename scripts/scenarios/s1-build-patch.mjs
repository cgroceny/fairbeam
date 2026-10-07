// S1: build a patch antenna from the empty design, using only the UI.
import assert from 'node:assert/strict';

const draftOf = async (s) => {
  const end = Date.now() + 10000;
  for (;;) { // the store fills a moment after the designer appears
    const d = await s.store((_, m) => (m.s.draft.parts ? JSON.parse(JSON.stringify(m.s.draft)) : null));
    if (d) return d;
    if (Date.now() > end) throw new Error('the design draft did not load');
    await s.sleep(100);
  }
};

/** Home tab, Modeling tab, … : open a ribbon tab by its i18n key */
export async function ribbonTab(s, key) { await s.click(key, { sel: '.rb-tab' }); }

/** Shapes › Brick, fill the dialog (values in mm) and press OK. */
export async function addBrick(s, { name, material, min, max, into }) {
  await ribbonTab(s, 'ribbon.tab.model');
  await s.click('ribbon.shapes.group', { sel: '.rb-group-toggle' });
  await s.click('ribbon.shapes.box');
  await s.wait('.sd');
  const dlg = '.sd';
  if (into !== undefined) await s.pick(await s.field(await s.T('shape.solid'), { within: dlg }), into);
  else await s.fill(await s.field(await s.T('shape.name'), { within: dlg }), name);
  if (material) await s.pick(await s.field(await s.T('shape.material'), { within: dlg }), material);
  for (const [k, axis] of ['X', 'Y', 'Z'].entries()) {
    await s.fill(await s.field(`${axis}min`, { within: dlg }), min[k]);
    await s.fill(await s.field(`${axis}max`, { within: dlg }), max[k]);
  }
  await s.click('common.ok', { within: dlg });
  await s.gone(dlg);
}

/** The material the shape dialog offers before anything is changed */
export async function brickDefaultMaterial(s) {
  await ribbonTab(s, 'ribbon.tab.model');
  await s.click('ribbon.shapes.group', { sel: '.rb-group-toggle' });
  await s.click('ribbon.shapes.box');
  await s.wait('.sd');
  const el = await s.field(await s.T('shape.material'), { within: '.sd' });
  const value = await el.evaluate((sel) => sel.value);
  await s.click('common.cancel', { within: '.sd' });
  await s.gone('.sd');
  return value;
}

export default {
  id: 'S1',
  title: 'Build a patch from the empty design',
  async run(s, ctx) {
    const design = `Scenario patch ${s.lang} ${ctx.stamp}`;
    await s.step('start screen shows the new-design form', async () => {
      await s.page.goto(s.url, { waitUntil: 'domcontentloaded' });
      await s.wait('.home');
      await s.wait('button', await s.T('home.newProject.create'));
    });
    await s.step('create an empty design', async () => {
      await s.fill(await s.field(await s.T('home.newProject.name')), design, { blur: false });
      await s.click('home.newProject.create');
      await s.wait('.rb');
      const d = await draftOf(s);
      assert.equal(d.parts.length, 0, 'the empty design has no solids');
      assert.ok(d.materials.length > 0 && d.materials.every((m) => m.kind === 'metal'), 'the empty design has only a metal (a new shape is a solid in the design\'s metal)');
    });
    await s.step('add the FR4 substrate brick', async () => {
      // the empty design has only a metal: a substrate's dielectric is copied from the library first (Materials > Add dielectric)
      await s.ev(({ id }, m) => m.s.edit((d) => { d.materials.push(m.mat.designMaterial(m.mat.MATERIAL_LIBRARY.find((x) => x.id === id))); }),
        { id: 'fr4' }, { s: '/src/designer/store.ts', mat: '/src/designer/materials.ts' });
      await addBrick(s, { name: 'substrate', material: 'FR4', min: [-30, -30, 0], max: [30, 30, 1.6] });
      const d = await draftOf(s);
      assert.equal(d.parts.length, 1);
      assert.equal(d.parts[0].material, 'FR4');
    });
    await s.step('F6 cycles the panes with a named focus ring; Undo is named after the last step', async () => {
      await s.page.evaluate(() => document.activeElement?.blur());
      const seen = [];
      for (let i = 0; i < 5; i++) {
        await s.page.keyboard.press('F6');
        seen.push(await s.page.evaluate(() => { const e = document.activeElement; return e?.getAttribute('data-pane') && e.classList.contains('pane-ring') && e.getAttribute('aria-label') ? e.getAttribute('data-pane') : null; }));
      }
      assert.deepEqual(seen, ['tree', 'ribbon', 'main', 'dock', 'properties'], 'F6 visits the panes in order');
      await s.page.keyboard.down('Shift'); await s.page.keyboard.press('F6'); await s.page.keyboard.up('Shift');
      assert.equal(await s.page.evaluate(() => document.activeElement?.getAttribute('data-pane')), 'dock', 'Shift+F6 goes back');
      const label = await s.ev((_, m) => m.s.undoLabel(), null, { s: '/src/designer/store.ts' });
      assert.ok(label && !/^Edit /.test(label), `the last step has a name (${label})`);
    });
    await s.step('a new shape starts in the design\'s metal, never the dielectric', async () => {
      assert.equal(await brickDefaultMaterial(s), 'copper', 'the dielectric is not offered: the first metal is');
    });
    await s.step('add the ground sheet and the patch (copper)', async () => {
      await addBrick(s, { name: 'ground', material: 'copper', min: [-30, -30, 0], max: [30, 30, 0] });
      assert.equal(await brickDefaultMaterial(s), 'copper', 'the material used last is offered');
      await addBrick(s, { name: 'patch', material: 'copper', min: [-18.5, -14.5, 1.6], max: [18.5, 14.5, 1.6] });
      const d = await draftOf(s);
      assert.deepEqual(d.parts.map((p) => p.name), ['substrate', 'ground', 'patch']);
    });
    await s.step('add the slot tool', async () => {
      await addBrick(s, { name: 'slot', material: 'copper', min: [8, -1, 1.6], max: [19, 1, 1.6] });
    });
    await s.step('an overlapping solid offers the Boolean choices: keep both', async () => {
      await s.click('boolean.overlap.keep');
      await s.gone('.rb-hint');
      assert.equal((await draftOf(s)).parts.length, 4);
    });
    await s.step('mirror the slot with the Transform dialog and its live preview', async () => {
      const before = await draftOf(s);
      await treeRow(s, 'slot', 'primitive').then((r) => r.click());
      await (await s.wait('button', await s.T('props.transform.mirror'))).click();
      await s.wait('.dialog, [role=dialog]', undefined, { within: '[role=dialog]' }).catch(() => {});
      await s.wait('p.note', await s.T('transform.preview.ready'));
      const shown = await s.ev((_, m) => m.t.previewGeometry().length, null, { t: '/src/designer/transforms.ts' });
      assert.ok(shown > 0, 'the dashed preview geometry is shown while the dialog is open');
      assert.deepEqual((await draftOf(s)).parts, before.parts, 'the preview does not touch the design');
      await s.click('transform.keepOriginal', { sel: 'label' });
      await s.wait('p.note', await s.T('transform.preview.ready'));
      await s.click('common.apply', { within: '[role=dialog]' });
      await s.gone('[role=dialog]');
      const after = await draftOf(s);
      const slot = after.parts.find((p) => p.name === 'slot');
      assert.notDeepEqual(slot, before.parts.find((p) => p.name === 'slot'), 'the slot changed');
      assert.equal(after.parts.length, 4, 'moving (keep original off) adds no solid');
    });
    await s.step('cut the slot: right-click the patch, Subtract, slot', async () => {
      const row = await treeRow(s, 'patch', 'part');
      await row.click({ button: 'right' });
      await s.click('contextMenu.boolean', { sel: '[role=menuitem]', within: '.dz-context-menu' }); // Boolean ›, then the operations
      await s.click('contextMenu.boolean.subtract', { sel: '[role=menuitem]', within: '.dz-context-menu' });
      await (await s.wait('[data-boolean-target]', undefined, { within: '.dz-context-menu' })).evaluate((e) => e.getAttribute('data-boolean-target'));
      const targets = await s.page.$$eval('[data-boolean-target]', (els) => els.map((e) => e.getAttribute('data-boolean-target')));
      assert.deepEqual(targets.sort(), ['ground', 'slot', 'substrate'], 'every other solid is listed');
      await (await s.wait('[data-boolean-target="slot"]')).click();
      await s.gone('.dz-context-menu');
      const d = await draftOf(s);
      assert.deepEqual(d.parts.map((p) => p.name), ['substrate', 'ground', 'patch'], 'the tool solid is consumed');
      assert.ok(d.parts.find((p) => p.name === 'patch').booleanHistory, 'the patch keeps its Boolean history');
      await s.store((_, m) => m.s.undo());
      assert.equal((await draftOf(s)).parts.length, 4, 'one undo step brings the slot back');
      await s.store((_, m) => m.s.redo());
      assert.equal((await draftOf(s)).parts.length, 3);
    });
    await s.step('extrude a face of the substrate: live thickness preview', async () => {
      const before = await draftOf(s);
      await s.page.evaluate(() => window.dispatchEvent(new CustomEvent('fairbeam:extrude-face-pick', {
        detail: { part: 'substrate', primitiveKind: 'box', axis: 2, sign: 1, value: 1.6, centre: [0, 0, 1.6], tris: [[-30, -30, 1.6], [30, -30, 1.6], [30, 30, 1.6], [-30, -30, 1.6], [30, 30, 1.6], [-30, 30, 1.6]] },
      })));
      const dlg = '.dm-face-extrude';
      await s.wait(dlg);
      const shown = () => s.ev((_, m) => m.t.previewGeometry().length, null, { t: '/src/designer/transforms.ts' });
      const thickness = await s.field(await s.T('faceExtrude.thickness'), { within: dlg });
      await s.fill(thickness, '0.5');
      await s.wait('p.note', await s.T('faceExtrude.preview.updated'), { within: dlg });
      assert.ok(await shown() > 0, 'the dashed outline of the new solid is shown');
      assert.deepEqual((await draftOf(s)).parts, before.parts, 'the preview does not touch the design');
      await s.fill(thickness, 'bogus');
      await s.wait('p.note', await s.T('faceExtrude.preview.unavailable'), { within: dlg });
      assert.equal(await shown(), 0, 'no outline for a thickness that does not evaluate');
      await s.fill(thickness, '0.5');
      await s.wait('p.note', await s.T('faceExtrude.preview.updated'), { within: dlg });
      await s.click('common.ok', { within: dlg });
      await s.gone(dlg);
      assert.equal((await draftOf(s)).parts.length, before.parts.length + 1, 'OK adds the extrusion');
      assert.equal(await shown(), 0, 'the outline is gone with the dialog');
      await s.store((_, m) => m.s.undo());
      assert.equal((await draftOf(s)).parts.length, before.parts.length, 'one undo removes it');
    });
    await s.step('add the discrete port', async () => {
      await s.click('tree.add.port', { sel: 'button' });
      assert.equal((await draftOf(s)).ports.length, 0, 'opening the form adds no port');
      const z = (n) => s.wait(`#feed-${n}`);
      await s.fill(await z('start-0'), 7); await s.fill(await z('start-1'), 0); await s.fill(await z('start-2'), 0);
      await s.fill(await z('stop-0'), 7); await s.fill(await z('stop-1'), 0); await s.fill(await z('stop-2'), 1.6);
      await s.click('feed.create', { sel: '.dialog button[type="submit"]' });
      const port = (await draftOf(s)).ports[0];
      assert.deepEqual([port.start, port.stop].flat().map(Number), [7, 0, 0, 7, 0, 1.6]);
    });
    await s.step('set the band', async () => {
      await ribbonTab(s, 'ribbon.tab.sim');
      await s.fill(await s.field('f min', { within: '.rb' }), '1.8');
      await s.fill(await s.field('f max', { within: '.rb' }), '3.2');
      const sim = (await draftOf(s)).simulation;
      assert.deepEqual([Number(sim.f_min), Number(sim.f_max)], [1.8, 3.2]);
    });
    await s.step('color a solid from the right-click menu', async () => {
      await (await treeRow(s, 'ground', 'part')).click({ button: 'right' });
      await s.click('contextMenu.color', { sel: '[role=menuitem]' });
      await setColor(s, '#12ab34');
      assert.equal((await draftOf(s)).parts.find((p) => p.name === 'ground').color, '#12ab34');
      await s.press('Escape');
    });
    await s.step('put the patch in a component and color the component', async () => {
      await (await treeRow(s, 'patch', 'part')).click({ button: 'right' });
      await s.click('contextMenu.moveToComponent', { sel: '[role=menuitem]', within: '.dz-context-menu' });
      await s.fill(await s.wait('.dz-menu-new'), 'antenna', { blur: false });
      await s.press('Enter');
      assert.equal((await draftOf(s)).parts.find((p) => p.name === 'patch').component, 'antenna');
      await (await treeRow(s, 'antenna', 'component')).click({ button: 'right' });
      await s.click('contextMenu.color', { sel: '[role=menuitem]' });
      await setColor(s, '#cc3300');
      assert.equal((await draftOf(s)).parts.find((p) => p.name === 'patch').color, '#cc3300');
      await s.press('Escape');
    });
    let saved;
    await s.step('save, reload the page and open the design again: everything persisted', async () => {
      await ribbonTab(s, 'ribbon.tab.home');
      await s.click('common.save', { sel: '.rb-btn' });
      await s.wait('.rb-btn:disabled', await s.T('common.save'));
      saved = pick(await draftOf(s));
      await s.page.reload({ waitUntil: 'domcontentloaded' });
      // the app reopens the design it had; from the Start screen the design list opens it
      await s.waitFor(() => !!document.querySelector('.rb, .home'), null, { what: 'the app to load' });
      if (!(await s.find('.rb'))) await (await s.wait('.home-item, button', design)).click();
      await s.wait('.rb');
      const again = pick(await draftOf(s));
      assert.deepEqual(again, saved);
      assert.equal(again.parts.length, 3);
      assert.equal(again.ports.length, 1);
    });
    // One coarse solver run, at low priority and only while nobody else holds the sim lock
    const release = ctx.skipRun ? null : ctx.takeSimLock();
    if (!release) {
      console.log(`  skip S1/${s.lang} coarse run (${ctx.skipRun ? '--skip-run' : '/tmp/fairbeam-sim.lock is held'})`);
      return;
    }
    try {
      await s.step('run one coarse simulation', async () => {
        await ribbonTab(s, 'ribbon.tab.sim');
        await s.click('ribbon.sim.mesh', { sel: '.rb-group-toggle' }).catch(() => {});
        await s.fill(await s.field(await s.T('ribbon.sim.cellsPerWavelength'), { within: '.rb' }), 6);
        await s.click('ribbon.sim.run', { sel: '.rb-btn' });
        await s.wait('[role=dialog]');
        await s.click(['run.saveAndRun', 'run.run'], { within: '[role=dialog]' });
        await s.gone('[role=dialog]');
        const end = Date.now() + 5 * 60000;
        let job;
        for (;;) {
          const runs = (await (await fetch(`${ctx.stack.apiUrl}/api/runs`)).json()).runs;
          job = runs[0]; // a fresh run server: this is the only job
          if (job && ['done', 'failed', 'error', 'cancelled', 'interrupted'].includes(job.status)) break;
          if (Date.now() > end) throw new Error(`the run did not finish in 5 minutes (status ${job?.status})`);
          await s.sleep(2000);
        }
        assert.equal(job.status, 'done', `the run finished with status ${job.status}`);
      }, { settle: 1500 });
      await s.step('the S-parameters tab shows a curve and the Summary a resonance', async () => {
        // Vite's dev server learns a file the run server just wrote a moment late and can answer with
        // the page instead of the result (the built app serves /projects from disk and has no such
        // race). The message then offers Retry; a user would press it, so does the check.
        const retry = await s.find('[role=alert] button', await s.T('common.retry'));
        if (retry) { console.log('         note: the result file was not served yet (Vite dev server); pressing Retry'); await retry.click(); await s.sleep(800); }
        await ribbonTab(s, 'ribbon.tab.post');
        await s.click('ribbon.post.sparams', { sel: '.rb-btn' });
        await s.waitFor(() => [...document.querySelectorAll('svg path')].some((p) => (p.getAttribute('d') || '').length > 200), null, { what: 'an S-parameter curve', timeout: 30000 });
        await s.click('ribbon.post.summary', { sel: '.rb-btn' });
        const label = await s.T('summary.f0');
        await s.waitFor((label) => [...document.querySelectorAll('.rs-tile')].some((t) => t.querySelector('dt')?.textContent === label), label, { what: 'the Resonance tile' });
        const value = await s.page.evaluate((label) => [...document.querySelectorAll('.rs-tile')].find((t) => t.querySelector('dt')?.textContent === label).querySelector('.rs-value').textContent, label);
        assert.match(value, /^\d+[.,]\d+$/, `the Summary shows a resonance frequency (got "${value}")`);
      }, { settle: 800 });
    } finally { release(); }
  },
};

/** the persisted essentials of a design */
const pick = (d) => ({
  parts: d.parts.map((p) => ({ name: p.name, material: p.material, color: p.color, component: p.component, primitives: p.primitives, transforms: p.transforms, booleanHistory: !!p.booleanHistory })),
  ports: d.ports, band: [d.simulation.f_min, d.simulation.f_max], materials: d.materials.map((m) => m.name),
});

/** Single-shape solids use their part row; multi-shape solids retain primitive children. */
async function treeRow(s, name, kind) {
  let id = null;
  if (kind !== 'component') {
    const parts = (await draftOf(s)).parts;
    const i = parts.findIndex((p) => p.name === name);
    assert.ok(i >= 0, `solid ${name} exists`);
    id = kind === 'part' || parts[i].primitives.length === 1 ? `part:${i}` : `prim:${i}:0`;
  }
  const handle = await s.page.evaluateHandle((id, name) => [...document.querySelectorAll('.nt-row')].find((r) => id
    ? r.getAttribute('data-id') === id
    : /^(folder|comp)/.test(r.getAttribute('data-id') || '') && (r.textContent || '').trim().startsWith(name)) ?? null, id, name);
  const row = handle.asElement();
  if (!row) {
    const rows = await s.page.$$eval('.nt-row', (rs) => rs.map((r) => `${r.getAttribute('data-id')}|${(r.textContent || '').trim().slice(0, 20)}`));
    throw new Error(`no ${kind} row "${name}" in the tree: ${rows.join(' ; ')}`);
  }
  return row;
}

/** the native color input cannot be driven: set it the way its `input` event does */
async function setColor(s, hex) {
  const input = await s.wait('.dz-color-popover input[type=color]');
  await input.evaluate((e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, hex);
  await s.sleep(100);
}
