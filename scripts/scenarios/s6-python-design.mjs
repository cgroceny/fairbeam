// S6: create a Python model from Start, convert it without solving, then reopen the same linked
// Design from the existing Python models row.
import assert from 'node:assert/strict';

export default {
  id: 'S6',
  title: 'Open Python models as editable Designs',
  async run(s, ctx) {
    const sourceId = `route_python_${ctx.stamp}_${s.lang}`;
    await s.step('create a Python model and open its Design code', async () => {
      await s.page.goto(s.url, { waitUntil: 'domcontentloaded' });
      await s.wait('.home');
      await s.click('home.python.new');
      await s.wait('[role="dialog"]');
      await s.fill(await s.field(await s.T('editor.newModel.displayName'), { within: '[role="dialog"]' }), `Python route ${s.lang} ${ctx.stamp}`);
      await s.fill(await s.field(await s.T('editor.newModel.id'), { within: '[role="dialog"]' }), sourceId);
      await s.clickSel('input[name="nm-template"][value="patch_probe_fed"]');
      await s.click('editor.newModel.createModel', { within: '[role="dialog"]' });
      await s.wait('.rb');
      await s.wait('.python-panel .python-panel-code', undefined, { timeout: 30000 });
      const opened = await s.store((_, m) => ({ id: m.s.file()?.id, source: m.s.draft.python_source_model }));
      assert.ok(opened.id, 'conversion opens a saved Design');
      assert.equal(opened.source, sourceId, 'the Design links to its editable Python model');
      const code = await s.text('.python-panel .python-panel-code');
      assert.match(code, /def build\(/, 'the Design code panel shows the Python model source');
    }, { settle: 500 });

    await s.step('the existing Python row reopens its linked Design without creating another', async () => {
      await s.click('header.screen.start', { sel: '[role="radio"]' });
      await s.wait('.home');
      // Model-list refreshes can overlap a Design save. Recreate the stale client snapshot that
      // omits the link metadata while retaining the Design row, then verify routing consults the
      // server's current model list instead of creating a second linked Design.
      await s.store((id, m) => {
        m.r.setModels(m.r.models().map((entry) => entry.python_source_model === id ? { ...entry, python_source_model: undefined } : entry));
      }, sourceId, { r: '/src/runner/store.ts' });
      assert.equal(await s.store((id, m) => m.r.models().filter((entry) => entry.python_source_model === id).length, sourceId, { r: '/src/runner/store.ts' }), 0,
        'the client snapshot no longer advertises the linked Design');
      await s.ev((_, m) => m.layout.setSidePanelCollapsed(true), undefined, { layout: '/src/designer/layoutState.ts' });
      await s.clickSel(`[data-python-model="${sourceId}"]`);
      await s.wait('.rb');
      await s.wait('.python-panel .python-panel-code', undefined, { timeout: 30000 });
      const opened = await s.store((_, m) => ({ id: m.s.file()?.id, source: m.s.draft.python_source_model }));
      assert.equal(opened.id, `${sourceId}_design`);
      assert.equal(opened.source, sourceId);
      assert.equal(await s.ev((_, m) => m.layout.sidePanelCollapsed(), undefined, { layout: '/src/designer/layoutState.ts' }), false,
        'opening the Python source expands a previously collapsed properties panel');
      const links = await s.page.evaluate(async (id) => (await (await fetch('/api/models')).json()).models.filter((m) => m.python_source_model === id).length, sourceId);
      assert.equal(links, 1, 'reopening reuses the existing Design');
    }, { settle: 500 });

    const runPanelSourceId = `rp_${ctx.stamp}_${s.lang}`;
    await s.step('creating a Python model from RunPanel Code opens its editable Design', async () => {
      await s.click('header.screen.start', { sel: '[role="radio"]' });
      await s.wait('.home');
      await s.clickSel(`[data-run-python-model="${sourceId}"]`);
      await s.wait('#run-panel');
      await s.click('runPanel.tab.code', { sel: '#rp-tab-code' });
      await s.click('editor.code.new', { within: '.code-pane' });
      await s.wait('[role="dialog"]');
      await s.click('editor.newModel.kind.python', { within: '[role="dialog"]' });
      await s.fill(await s.field(await s.T('editor.newModel.displayName'), { within: '[role="dialog"]' }), `RunPanel ${ctx.stamp}`);
      await s.fill(await s.field(await s.T('editor.newModel.id'), { within: '[role="dialog"]' }), runPanelSourceId);
      await s.clickSel('input[name="nm-template"][value="patch_probe_fed"]');
      await s.click('editor.newModel.createModel', { within: '[role="dialog"]' });
      await s.wait('.rb');
      await s.wait('.python-panel .python-panel-code', undefined, { timeout: 30000 });
      const opened = await s.store((_, m) => ({ id: m.s.file()?.id, source: m.s.draft.python_source_model }));
      assert.equal(opened.id, `${runPanelSourceId}_design`, 'RunPanel creation converts to a new Design');
      assert.equal(opened.source, runPanelSourceId, 'the Design retains the new model as its Python source');
      assert.match(await s.text('.python-panel .python-panel-code'), /def build\(/, 'the Design code panel shows editable Python source');
    }, { settle: 500 });
  },
};
