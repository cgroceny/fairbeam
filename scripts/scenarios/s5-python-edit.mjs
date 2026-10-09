// S5: model with Python while drawing: edit a dimension in the Python panel and Apply it (no solver).
import assert from 'node:assert/strict';

export default {
  id: 'S5',
  title: 'Edit the Python script and apply it',
  async run(s, ctx) {
    const draft = () => s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft)));
    const assertPanelBoundary = async (python = false) => {
      const layout = await s.page.evaluate((python) => {
        const panel = document.querySelector('.workspace.design-mode > .panel-right');
        const handle = document.querySelector('.workspace.design-mode > .panel-resize-right');
        const panelBox = panel.getBoundingClientRect(), handleBox = handle.getBoundingClientRect();
        const button = python ? panel.querySelector('[data-action="python-apply"]') : null;
        const buttonBox = button?.getBoundingClientRect();
        const hit = buttonBox ? document.elementFromPoint(buttonBox.left + buttonBox.width / 2, buttonBox.top + buttonBox.height / 2) : null;
        return { panelWidth: panelBox.width, panelLeft: panelBox.left,
          separatorCenter: handleBox.left + handleBox.width / 2,
          separatorShown: handleBox.width > 0 && getComputedStyle(handle).display !== 'none',
          applyDisabled: button?.disabled, applyCenterHitsButton: !!button && button.contains(hit) };
      }, python);
      if (!ctx.compact) {
        assert.ok(layout.separatorShown, 'the desktop properties resize handle is visible');
        assert.ok(Math.abs(layout.separatorCenter - layout.panelLeft) <= 1,
          `the resize handle follows the actual properties boundary: ${JSON.stringify(layout)}`);
        assert.ok(Math.abs(layout.panelWidth - (python ? 360 : 320)) <= 1,
          'the default properties width expands from 320 to 360 CSS pixels for Python');
      }
      if (python) {
        assert.equal(layout.applyDisabled, false, 'Apply is ready for a real pointer click');
        assert.equal(layout.applyCenterHitsButton, true, 'the Apply center is not covered by the resize handle');
      }
    };
    /** the editor's text, or replace it (the CodeMirror view hangs off its content element) */
    const script = (text) => s.page.evaluate((text) => {
      const view = document.querySelector('.python-panel .python-panel-editor').cmView;
      if (text !== undefined) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      return view.state.doc.toString();
    }, text);
    let key = 'W', before;
    await s.step('create a patch design and open the Python panel', async () => {
      await s.page.goto(s.url, { waitUntil: 'domcontentloaded' });
      await s.wait('.home');
      await s.fill(await s.field(await s.T('home.newProject.name')), `Scenario python ${s.lang} ${ctx.stamp}`, { blur: false });
      await (await s.wait('label, .home-tpl', await s.T('templates.patch.name'))).click();
      await s.click('home.newProject.create');
      await s.wait('.rb');
      await s.waitFor(() => !!document.querySelector('.nt-row[data-id^="part:"]'), null, { what: 'the starter geometry' });
      await assertPanelBoundary();
      await s.click('ribbon.tab.post', { sel: '.rb-tab' });
      await s.clickSel('button[data-action="open-python"]');
      await s.wait('.python-panel .python-panel-code');
    });
    await s.step('Edit opens the script in an editor with line numbers', async () => {
      await s.clickSel('button[data-action="python-edit"]');
      await s.wait('.python-panel .cm-content');
      await s.wait('.python-panel .cm-lineNumbers');
      before = await draft();
      assert.ok(before.params.some((p) => p.key === key), 'the starter has a W parameter');
      assert.match(await script(), new RegExp(`Param\\('${key}', `), 'the script defines the parameter');
    });
    await s.step('Apply after a dimension edit replaces the design in one undo step', async () => {
      const old = before.params.find((p) => p.key === key).default;
      const next = Math.round(old * 1.1 * 10) / 10;
      const text = await script();
      await script(text.replace(new RegExp(`(Param\\('${key}', )[-0-9.e]+`), `$1${next}`));
      await s.wait('strong', await s.T('python.edit.unsaved'));
      await assertPanelBoundary(true);
      await s.clickSel('button[data-action="python-apply"]');
      await s.wait('.python-panel-feedback', [await s.T('python.edit.applied'), await s.T('python.edit.normalized')]);
      const d = await draft();
      assert.equal(d.params.find((p) => p.key === key).default, next, 'the parameter follows the script');
      assert.equal(d.model.id, before.model.id, 'the design keeps its identity');
      await s.store((_, m) => m.s.undo());
      assert.deepEqual((await draft()).params, before.params, 'one Undo brings the previous design back');
      await s.store((_, m) => m.s.redo());
    });
    await s.step('an error names its line and leaves the design as it is', async () => {
      s.consoleAllow.push(/status of 422/); // the refused script is a 422, which the browser logs
      const kept = JSON.stringify(await draft());
      const lines = (await script()).split('\n');
      const at = lines.findIndex((l) => l.startsWith('def build'));
      lines.splice(at + 1, 0, "    raise ValueError('bad dimension')");
      await script(lines.join('\n'));
      await s.clickSel('button[data-action="python-apply"]');
      const alert = await s.wait('.python-panel-error');
      const shown = await alert.evaluate((e) => e.textContent);
      assert.match(shown, /bad dimension/);
      assert.ok(shown.includes(await s.T('python.edit.errorLine', { line: at + 2, message: 'ValueError: bad dimension' })), `line ${at + 2} is named: ${shown}`);
      await s.wait('.python-panel .cm-lint-marker-error, .python-panel .cm-lintRange-error');
      assert.equal(JSON.stringify(await draft()), kept, 'the design is untouched');
    });
    await s.step('Done with unapplied changes asks before discarding', async () => {
      await s.clickSel('button[data-action="python-done"]');
      await s.wait('[role=dialog]');
      await s.click('common.cancel', { within: '[role=dialog]' });
      await s.gone('[role=dialog]');
      await s.wait('.python-panel .cm-content');
      await s.clickSel('button[data-action="python-done"]');
      await s.click('confirm.discard.button', { within: '[role=dialog]' });
      await s.gone('[role=dialog]');
      await s.wait('button[data-action="python-edit"]');
    });
  },
};
