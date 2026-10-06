// S3: the Sweep and Optimizer dialogs (no runs).
import assert from 'node:assert/strict';

export default {
  id: 'S3',
  title: 'Sweep and optimizer dialogs',
  async run(s, ctx) {
    await s.step('create a patch design from the Start screen', async () => {
      await s.page.goto(s.url, { waitUntil: 'domcontentloaded' });
      await s.wait('.home');
      await s.fill(await s.field(await s.T('home.newProject.name')), `Scenario sweep ${s.lang} ${ctx.stamp}`, { blur: false });
      await (await s.wait('label, .home-tpl', await s.T('templates.patch.name'))).click();
      await s.click('home.newProject.create');
      await s.wait('.rb');
      await s.waitFor(() => !!document.querySelector('.nt-row[data-id^="part:"]'), null, { what: 'the starter geometry' });
    });
    await s.step('Simulation settings: Discard after live edits goes back to the state at open', async () => {
      const text = () => s.store((_, m) => JSON.stringify(m.s.draft));
      const before = await text();
      await s.click('ribbon.tab.sim', { sel: '.rb-tab' });
      await s.click('ribbon.sim.mesh', { sel: '.rb-group-toggle' }).catch(() => {});
      await s.click('ribbon.sim.meshSettings', { sel: '.rb-btn, button' });
      await s.wait('[role=dialog]');
      assert.ok(await s.find('button', await s.T('common.cancel'), { within: '[role=dialog]' }), 'unchanged: the button says Cancel');
      await s.fill(await s.field('f max', { within: '[role=dialog]' }), '3.3');
      assert.notEqual(await text(), before, 'the edit applies to the design at once');
      const discard = await s.wait('button', await s.T('sim.discard'), { within: '[role=dialog]' });
      await discard.click();
      await s.gone('[role=dialog]');
      assert.equal(await text(), before, 'the design is as it was when the dialog opened');
      await s.store((_, m) => m.s.undo());
      assert.equal(await text(), before, 'and no undo step is left behind');
    });
    await s.step('open the Sweep dialog', async () => {
      await s.click('ribbon.tab.optimize', { sel: '.rb-tab' });
      await s.click('ribbon.optimize.sweep', { sel: '.rb-btn' });
      await s.wait('[role=dialog]');
    });
    let key;
    const jobCount = async () => (await (await fetch(`${ctx.stack.apiUrl}/api/runs`)).json()).runs.length;
    const jobsBefore = await jobCount(); // other scenarios may have run jobs on this server
    await s.step('a new sweep parameter starts at the value ±10 % in 5 steps', async () => {
      await s.click('sweep.addParameter', { within: '[role=dialog]' });
      const select = await s.wait('select[aria-label]', undefined, { within: '[role=dialog]' });
      key = await select.evaluate((e) => e.value);
      const read = async (k) => Number(await (await s.field(await s.T(k), { within: '[role=dialog]' })).evaluate((e) => e.value));
      const [start, stop, steps] = [await read('sweep.range.start'), await read('sweep.range.stop'), await read('sweep.range.steps')];
      const p = await s.store((a, m) => ({ ...m.s.draft.params.find((x) => x.key === a), value: m.s.names().names[a] }), key);
      const clamp = (x) => Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, x));
      assert.ok(Math.abs(start - clamp(p.value * 0.9)) < 1e-9 * Math.max(1, Math.abs(p.value)), `start is 90 % of ${key} = ${p.value} (got ${start})`);
      assert.ok(Math.abs(stop - clamp(p.value * 1.1)) < 1e-9 * Math.max(1, Math.abs(p.value)), `stop is 110 % of ${key} = ${p.value} (got ${stop})`);
      assert.equal(steps, 5);
    });
    await s.step('validate, then queue the sweep and cancel before it runs', async () => {
      await s.click('sweep.check', { within: '[role=dialog]' });
      await s.wait('*', await s.T('sweep.checkPassed', { count: 5 }), { within: '[role=dialog]' });
      // No solver: the submission is captured instead of sent, so nothing can start
      await s.ev(async (_, m) => {
        window.__sweepCalls = [];
        m.api.api.submitSweep = async (body) => { window.__sweepCalls.push(body); return { sweep: { id: 'scenario-sweep', total: 5 }, runs: [] }; };
        m.api.api.cancelSweep = async (id) => { window.__sweepCalls.push({ cancelled: id }); return {}; };
      }, null, { api: '/src/runner/api.ts' });
      await s.click('sweep.start', { within: '[role=dialog]' });
      await s.waitFor(() => window.__sweepCalls.length > 0, null, { what: 'the sweep submission' });
      const call = await s.page.evaluate(() => window.__sweepCalls[0]);
      assert.equal(call.sequences.length, 1);
      assert.equal(call.sequences[0].sweep.axes?.[0]?.key ?? call.sequences[0].sweep[0]?.key ?? key, key);
      assert.equal(await jobCount(), jobsBefore, 'no job was added on the run server');
      await s.click('common.close', { within: '[role=dialog]' });
      await s.gone('[role=dialog]');
    });
    const startDisabled = () => s.page.evaluate(() => document.querySelector('[role=dialog] .rp-start-btn')?.disabled);
    const alerts = () => s.page.$$eval('[role=dialog] .rp-error', (els) => els.map((e) => e.textContent.trim()).filter(Boolean));
    await s.step('open the Optimizer: a goal is set, Start is ready', async () => {
      await s.click('ribbon.optimize.optimizer', { sel: '.rb-btn' });
      await s.wait('[role=dialog] .rp-start-btn');
      assert.equal(await startDisabled(), false, 'the default goal and parameter can start');
      assert.deepEqual(await alerts(), []);
    });
    await s.step('an empty goal target is refused with a message', async () => {
      await s.fill(await s.wait('#op-goal-0-target'), '');
      await s.waitFor(() => document.querySelectorAll('[role=dialog] .rp-error').length > 0, null, { what: 'the goal message' });
      assert.equal(await startDisabled(), true, 'Start is disabled');
      await s.fill(await s.wait('#op-goal-0-target'), '2.45');
      await s.waitFor(() => document.querySelectorAll('[role=dialog] .rp-error').length === 0, null, { what: 'the message to go' });
      assert.equal(await startDisabled(), false);
    });
    await s.step('a minimum above the maximum and zero evaluations are refused', async () => {
      const max = Number(await (await s.wait('#op-vary-0-max')).evaluate((e) => e.value));
      const min = await (await s.wait('#op-vary-0-min')).evaluate((e) => e.value);
      await s.fill(await s.wait('#op-vary-0-min'), String(max + 5));
      await s.waitFor(() => document.querySelectorAll('[role=dialog] .rp-error').length > 0, null, { what: 'the range message' });
      assert.equal(await startDisabled(), true);
      await s.fill(await s.wait('#op-vary-0-min'), min);
      await s.fill(await s.wait('.op-evals'), '0');
      await s.waitFor(() => document.querySelectorAll('[role=dialog] .rp-error').length > 0, null, { what: 'the evaluations message' });
      assert.equal(await startDisabled(), true);
      await s.fill(await s.wait('.op-evals'), '6');
      await s.waitFor(() => document.querySelectorAll('[role=dialog] .rp-error').length === 0, null, { what: 'the messages to go' });
      assert.equal(await startDisabled(), false);
      assert.equal(await jobCount(), jobsBefore, 'the check never started a run');
      await s.click('common.close', { within: '[role=dialog]' });
    });
  },
};
