import assert from 'node:assert/strict';

export default {
  id: 'S12', title: 'Single solids have one editable tree row',
  async run(s, ctx) {
    let single, multi;
    const row = () => `.nt-row[data-id="part:${single}"]`;
    await s.step('open a component containing single and multi-shape parts', async () => {
      await s.page.goto(s.url, { waitUntil: 'domcontentloaded' }); await s.wait('.home');
      await s.fill(await s.field(await s.T('home.newProject.name')), `Solid tree ${s.lang} ${ctx.stamp}`, { blur: false });
      await (await s.wait('label, .home-tpl', await s.T('templates.patch.name'))).click();
      await s.click('home.newProject.create'); await s.wait('.rb');
      ({ single, multi } = await s.store((_, m) => {
        const single = m.s.draft.parts.findIndex(p => p.name === 'substrate');
        const multi = m.s.draft.parts.findIndex(p => p.name === 'patch');
        if (single < 0 || multi < 0) throw new Error('patch fixture missing expected parts');
        m.s.edit(d => {
          d.components = ['Assembly'];
          d.parts[single].component = 'Assembly'; d.parts[multi].component = 'Assembly';
          d.parts[single].primitives[0].label = 'Searchable solid';
          d.parts[multi].primitives.push(JSON.parse(JSON.stringify(d.parts[multi].primitives[0])));
        });
        return { single, multi };
      }));
      await s.showDesignPanel(); await s.wait(row());
      assert.equal(await s.page.$eval(row(), el => el.getAttribute('aria-expanded')), null);
      assert.equal(await s.page.$(`.nt-row[data-id="prim:${single}:0"]`), null);
      assert.equal(await s.page.$eval(`.nt-row[data-id="part:${multi}"]`, el => el.getAttribute('aria-expanded')), 'true');
      assert.equal(await s.page.$$eval(`.nt-row[data-id^="prim:${multi}:"]`, els => els.length), 2);
    });
    await s.step('one row retains geometry, material and visibility controls', async () => {
      await s.clickSel(row()); await s.showDesignPanel('side');
      const path = `parts[${single}].primitives[0].stop[0]`;
      const id = await s.store((path, m) => m.s.fieldId(path), path);
      await s.fill(`#${id}`, '36');
      assert.equal(await s.store((i, m) => m.s.draft.parts[i].primitives[0].stop[0], single), 36);
      const materialId = await s.store((i, m) => m.s.fieldId(`parts[${i}].material`), single);
      assert.ok(await s.page.$(`#${materialId}`), 'material selector remains available');
      await s.showDesignPanel(); await s.clickSel(`${row()} .nt-eye`);
      assert.equal(await s.page.$eval(row(), el => el.classList.contains('nt-hidden')), true);
      await s.clickSel(`${row()} .nt-eye`);
      assert.equal(await s.page.$eval(row(), el => el.classList.contains('nt-hidden')), false);
    });
    await s.step('primitive picks highlight the merged row and F2 renames it with Undo', async () => {
      await s.store((i, m) => m.s.setSelection({ type: 'primitive', i, j: 0 }), single);
      await s.waitFor(sel => document.querySelector(sel)?.getAttribute('aria-selected') === 'true', row());
      const history = await s.store((_, m) => m.s.historyIndex());
      await (await s.wait(row())).focus(); await s.press('F2');
      await s.fill('.nt-rename', 'Renamed solid', { blur: false }); await s.press('Enter');
      assert.equal(await s.store((i, m) => m.s.draft.parts[i].label, single), 'Renamed solid');
      assert.equal(await s.store((_, m) => m.s.historyIndex()), history + 1, 'rename makes exactly one undo entry');
      assert.ok((await s.text(row())).includes('Renamed solid'));
      await s.click('ribbon.tab.home', { sel: '.rb-tab' }); await s.click('ribbon.home.undo', { sel: '.rb-btn' });
      assert.notEqual(await s.store((i, m) => m.s.draft.parts[i].label, single), 'Renamed solid');
    });
    await s.step('shape-label filtering and multi-shape selection still work', async () => {
      await s.fill('.nt-filter-input', 'Searchable solid'); await s.wait(row());
      assert.equal(await s.page.$(`.nt-row[data-id="part:${multi}"]`), null);
      await s.fill('.nt-filter-input', '');
      await s.clickSel(`.nt-row[data-id="prim:${multi}:1"]`);
      assert.deepEqual(await s.store((_, m) => m.s.selection()), { type: 'primitive', i: multi, j: 1 });
    });
    await s.step('merged row commands duplicate, delete and move the whole solid', async () => {
      await s.showDesignPanel(); await s.clickSel(row());
      const before = await s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft.parts)));
      await (await s.wait(row())).focus(); await s.press('F10', ['Shift']); await s.wait('.dz-context-menu');
      const duplicateKey = await s.ev((_, m) => m.sc.SHORTCUTS.duplicate.key, null, { sc: '/src/designer/shortcuts.ts' }); // ⌘D on macOS, Ctrl+D elsewhere
      await s.click('contextMenu.duplicate', { within: '.dz-context-menu', params: { key: duplicateKey } });
      let after = await s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft.parts)));
      assert.equal(after.length, before.length + 1);
      assert.deepEqual(after[single + 1].primitives, before[single].primitives);
      assert.equal(after[single + 1].material, before[single].material);
      await s.click('ribbon.tab.home', { sel: '.rb-tab' }); await s.click('ribbon.home.undo', { sel: '.rb-btn' });
      await s.showDesignPanel(); await s.clickSel(row()); await s.press('Delete');
      after = await s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft.parts)));
      assert.deepEqual(after, before.filter((_, i) => i !== single));
      await s.click('ribbon.home.undo', { sel: '.rb-btn' });
      await s.showDesignPanel(); await (await s.wait(row())).focus(); await s.press('F10', ['Shift']);
      await s.wait('.dz-context-menu'); await s.click('contextMenu.moveToComponent', { within: '.dz-context-menu' }); // Duplicate and Delete follow it, so not End
      await s.wait('.dz-context-menu input.dz-menu-new'); await s.press('ArrowDown'); await s.press('Enter');
      after = await s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft.parts)));
      const expected = structuredClone(before); delete expected[single].component;
      assert.deepEqual(after, expected);
    });
    await s.step('tree and Properties shape renames retain live Boolean history with Undo', async () => {
      await s.store((_, m) => m.s.edit(d => {
        const material = d.materials.find(mt => mt.kind === 'metal').name;
        d.materials = d.materials.filter(mt => mt.name === material);
        d.params = [{ key: 'r', default: 1 }]; d.ports = []; d.resistors = []; d.components = [];
        d.simulation = { f_min: 1, f_max: 2, boundaries: 'MUR' }; d.far_field = { enabled: false };
        d.parts = [
          { name: 'sleeve', material, primitives: [{ kind: 'cylinder', axis: 'z', center: [0, 0], radius: 'r', inner_radius: 0.5, range: [0, 3], label: 'slv_body' }] },
          { name: 'disc', material, primitives: [{ kind: 'cylinder', axis: 'z', center: [0, 0], radius: 2, inner_radius: 0.5, range: [3, 4], label: 'disc_body' }] },
        ];
      }));
      assert.equal(await s.ev((_, m) => m.b.runBoolean('add', 0, 1), null, { b: '/src/designer/booleanUi.ts' }), true);
      await s.showDesignPanel();
      const first = '.nt-row[data-id="prim:0:0"]';
      await s.clickSel(first); await (await s.wait(first)).focus(); await s.press('F2');
      await s.fill('.nt-rename', 'Tree sleeve', { blur: false }); await s.press('Enter');
      const result = () => s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft.parts[0])));
      let renamed = await result();
      assert.equal(renamed.primitives[0].label, 'Tree sleeve');
      assert.equal(renamed.booleanHistory.A.primitives[0].label, 'Tree sleeve');
      assert.equal(renamed.booleanHistory.A.primitives[0].radius, 'r');
      assert.equal(renamed.booleanHistory.live, true);
      await s.click('ribbon.tab.home', { sel: '.rb-tab' }); await s.click('ribbon.home.undo', { sel: '.rb-btn' });
      assert.equal((await result()).primitives[0].label, 'slv_body');
      await s.click('ribbon.home.redo', { sel: '.rb-btn' });
      assert.deepEqual(await result(), renamed);

      await s.showDesignPanel(); await s.clickSel('.nt-row[data-id="prim:0:1"]'); await s.showDesignPanel('side');
      const labelId = await s.store((_, m) => m.s.fieldId('parts[0].primitives[1].label'));
      await s.fill(`#${labelId}`, 'Properties disc');
      renamed = await result();
      assert.deepEqual(renamed.primitives.map(p => p.label), ['Tree sleeve', 'Properties disc']);
      assert.equal(renamed.booleanHistory.B.primitives[0].label, 'Properties disc');
      assert.equal(renamed.booleanHistory.live, true);
      await s.fill(`#${labelId}`, '');
      assert.deepEqual(await result(), renamed, 'an unsupported clear keeps the complete live result unchanged');
      await s.wait('.dz-msg', await s.T('boolean.labelCannotClear', { part: 'sleeve' }));
      assert.equal(await s.page.$eval(`#${labelId}`, e => e.value), 'Properties disc', 'Properties shows the retained label after refusal');
    });
    await s.step('renamed Boolean shapes survive changed parameters and a saved page reload', async () => {
      await s.store((_, m) => m.s.edit(d => { d.params[0].default = 1.5; }));
      const atNewValues = await s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft.parts[0])));
      assert.equal(atNewValues.primitives[0].radius, 1.5);
      assert.deepEqual(atNewValues.primitives.map(p => p.label), ['Tree sleeve', 'Properties disc']);
      assert.equal(atNewValues.booleanHistory.live, true);
      await s.click('ribbon.tab.home', { sel: '.rb-tab' }); await s.click('common.save', { sel: '.rb-btn' });
      await s.waitFor(async () => !(await import('/src/designer/store.ts')).dirty(), null, { what: 'the renamed live design to save' });
      await s.page.reload({ waitUntil: 'domcontentloaded' }); await s.wait('.rb');
      await s.waitFor(async () => (await import('/src/designer/store.ts')).draft.parts?.[0]?.primitives?.[0]?.label === 'Tree sleeve', null, { what: 'the saved renamed design to reopen' });
      assert.deepEqual(await s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft.parts[0]))), atNewValues);
      await s.showDesignPanel(); await s.clickSel('.nt-row[data-id="part:0"]'); await s.showDesignPanel('side');
      await s.click('boolean.restore', { sel: 'button' });
      const restored = await s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft.parts)));
      assert.deepEqual(restored.map(p => p.primitives[0].label), ['Tree sleeve', 'Properties disc']);
      assert.equal(restored[0].primitives[0].radius, 'r');
      assert.ok(restored.every(p => !p.booleanHistory), 'Restore operands exposes the original parametric sources');
    });
    await s.step('a copied Boolean shape refuses ambiguous tree renaming with a visible explanation', async () => {
      await s.store((_, m) => m.s.edit(d => { d.parts[0].transforms = [{ type: 'translate', copies: 1, step: [4, 0, 0] }]; }));
      assert.equal(await s.ev((_, m) => m.b.runBoolean('add', 0, 1), null, { b: '/src/designer/booleanUi.ts' }), true);
      const before = await s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft.parts[0])));
      await s.showDesignPanel();
      const first = '.nt-row[data-id="prim:0:0"]';
      await s.clickSel(first); await (await s.wait(first)).focus(); await s.press('F2');
      await s.fill('.nt-rename', 'Only one copy', { blur: false }); await s.press('Enter');
      assert.deepEqual(await s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft.parts[0]))), before);
      await s.showDesignPanel('side');
      await s.wait('.dz-msg', await s.T('boolean.labelNeedsSource', { part: 'sleeve' }));
      await s.showDesignPanel(); assert.ok((await s.text(first)).includes('Tree sleeve'));
    });
  },
};
