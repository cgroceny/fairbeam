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
  },
};
