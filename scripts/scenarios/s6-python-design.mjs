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
      await s.click('header.screen.start', { sel: '.mode-switch button' });
      await s.wait('.home');
      await s.ev((_, m) => m.layout.setSidePanelCollapsed(true), undefined, { layout: '/src/designer/layoutState.ts' });
      // Home refreshes the model list on mount. Stage the stale snapshot in the trusted click's
      // capture phase, so a response between browser calls cannot undo the regression setup.
      await s.store((id, m) => {
        const state = { observed: null };
        state.listener = (event) => {
          const row = event.target instanceof Element ? event.target.closest('[data-python-model]') : null;
          if (row?.getAttribute('data-python-model') !== id) return;
          m.r.setModels(m.r.models().map((entry) => entry.python_source_model === id ? { ...entry, python_source_model: undefined } : entry));
          state.observed = { links: m.r.models().filter((entry) => entry.python_source_model === id).length, trusted: event.isTrusted };
          document.removeEventListener('click', state.listener, true);
        };
        window.__fairbeamS6StaleClick = state;
        document.addEventListener('click', state.listener, true);
      }, sourceId, { r: '/src/runner/store.ts' });
      try {
        // Force a real refresh after installing the fixture. The native click must still see
        // stale link metadata, then reuse the single linked Design from the server.
        const refreshed = await s.store(async (id, m) => {
          await m.r.refreshModels();
          return m.r.models().filter((entry) => entry.python_source_model === id).length;
        }, sourceId, { r: '/src/runner/store.ts' });
        assert.equal(refreshed, 1, 'the forced refresh restores the existing Design link');
        await s.clickSel(`[data-python-model="${sourceId}"]`);
        const observed = await s.page.evaluate(() => window.__fairbeamS6StaleClick?.observed);
        assert.deepEqual(observed, { links: 0, trusted: true }, 'the native click sees the stale client snapshot');
        await s.wait('.rb');
        await s.wait('.python-panel .python-panel-code', undefined, { timeout: 30000 });
        const opened = await s.store((_, m) => ({ id: m.s.file()?.id, source: m.s.draft.python_source_model }));
        assert.equal(opened.id, `${sourceId}_design`);
        assert.equal(opened.source, sourceId);
        assert.equal(await s.ev((_, m) => m.layout.sidePanelCollapsed(), undefined, { layout: '/src/designer/layoutState.ts' }), false,
          'opening the Python source expands a previously collapsed properties panel');
        const links = await s.page.evaluate(async (id) => (await (await fetch('/api/models')).json()).models.filter((m) => m.python_source_model === id).length, sourceId);
        assert.equal(links, 1, 'reopening reuses the existing Design');
      } finally {
        await s.page.evaluate(() => {
          const state = window.__fairbeamS6StaleClick;
          if (state) document.removeEventListener('click', state.listener, true);
          delete window.__fairbeamS6StaleClick;
        }).catch(() => {}); // A closed page must not replace the original failure.
      }
    }, { settle: 500 });

    const runPanelSourceId = `rp_${ctx.stamp}_${s.lang}`;
    await s.step('creating a Python model from RunPanel Code opens its editable Design', async () => {
      await s.click('header.screen.start', { sel: '.mode-switch button' });
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

    const editorState = () => s.page.evaluate(async () => {
      const editor = await import('/src/editor/store.ts');
      const runner = await import('/src/runner/store.ts');
      return {id:editor.file()?.id,text:editor.draft(),dirty:editor.dirty(),selected:runner.modelKey()};
    });
    const openCodeFromStart = async id => {
      await s.click('header.screen.start',{sel:'.mode-switch button'});await s.wait('.home');
      await s.clickSel(`[data-run-python-model="${id}"]`);await s.wait('#run-panel');
      await s.click('runPanel.tab.code',{sel:'#rp-tab-code'});
    };
    const appendCode = async text => {
      await (await s.wait('.code-pane .cm-content')).click();
      await s.page.keyboard.down('Control');await s.page.keyboard.press('End');await s.page.keyboard.up('Control');
      await s.page.keyboard.type(`\n# ${text}\n`);
    };
    let originalSource, editedSource;
    await s.step('Start to another Python model asks before replacing edited source; Cancel retains its context',async()=>{
      await s.page.setViewport({width:1920,height:1080});
      await openCodeFromStart(sourceId);await s.wait('.code-pane .cm-content');
      await s.waitFor(async id=>(await import('/src/editor/store.ts')).file()?.id===id,sourceId,{what:`source editor follows ${sourceId}`});
      originalSource=(await editorState()).text;
      await appendCode('Unsaved model-switch regression');editedSource=(await editorState()).text;
      assert.notEqual(editedSource,originalSource);
      await openCodeFromStart(runPanelSourceId);await s.wait('[role="dialog"]');
      await s.click('common.cancel',{within:'[role="dialog"]'});await s.gone('[role="dialog"]');
      await s.wait('.code-pane .cm-content');
      const kept=await editorState();
      assert.deepEqual(kept,{id:sourceId,text:editedSource,dirty:true,selected:sourceId});
    });
    await s.step('explicit Discard opens the selected model without writing the previous source',async()=>{
      await openCodeFromStart(runPanelSourceId);await s.wait('[role="dialog"]');
      await s.click('confirm.discard.button',{within:'[role="dialog"]'});await s.gone('[role="dialog"]');
      await s.waitFor(async id=>(await import('/src/editor/store.ts')).file()?.id===id,runPanelSourceId);
      assert.equal((await editorState()).dirty,false);
      const onDisk=await s.page.evaluate(async id=>(await (await fetch(`/api/models/${id}/source`)).json()).source,sourceId);
      assert.equal(onDisk,originalSource);
    });
    await s.step('saving source before switching preserves the edited file and needs no discard prompt',async()=>{
      await openCodeFromStart(sourceId);await s.waitFor(async id=>(await import('/src/editor/store.ts')).file()?.id===id,sourceId);
      await s.wait('.code-pane .cm-content');await appendCode('Saved model-switch regression');
      const savedText=(await editorState()).text;
      await s.click('editor.code.savePreview',{within:'.code-pane'});
      await s.waitFor(async()=>{const e=await import('/src/editor/store.ts');return !e.saving()&&!e.dirty();},null,{timeout:30000,what:'source saved'});
      await openCodeFromStart(runPanelSourceId);await s.waitFor(async id=>(await import('/src/editor/store.ts')).file()?.id===id,runPanelSourceId);
      assert.equal(await s.page.$('[role="dialog"]'),null);
      const onDisk=await s.page.evaluate(async id=>(await (await fetch(`/api/models/${id}/source`)).json()).source,sourceId);
      assert.equal(onDisk,savedText);
    });
  },
};
