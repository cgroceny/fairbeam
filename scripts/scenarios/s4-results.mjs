// S4: results of two runs: compare in the Summary, the field map, CSV and Copy, run Properties.
// The runs are the bundled example bundles copied into the projects folder as runs of a new design
// (no solver).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pythonPath, root } from './stack.mjs';

// A 3 x 2 E-field map with its phasor (a circular polarization), as python/fairbeam/field_planes.py
// writes it: none of the bundled example bundles carries field planes.
function fieldMap() {
  const ex = { re: [100, 0, -100, 50, 0, 25], im: [0, 100, 0, 0, -50, 25] };
  const ey = { re: ex.im.map((v) => -v), im: ex.re.slice() };
  const bytes = new Int8Array(6 * 3 * 2);
  for (let px = 0; px < 6; px++) [ex, ey, { re: Array(6).fill(0), im: Array(6).fill(0) }].forEach((c, k) => {
    bytes[(px * 3 + k) * 2] = Math.round((127 * c.re[px]) / 100);
    bytes[(px * 3 + k) * 2 + 1] = Math.round((127 * c.im[px]) / 100);
  });
  return {
    quantity: 'E', component: 'abs', normal: 'z', axis: 2, u_axis: 0, v_axis: 1, position_mm: 2.5, requested_mm: 2.524,
    f: 2.45e9, u_range: [-10, 10], v_range: [-5, 5], nu: 3, nv: 2, unit: 'V/m',
    normalization: '1 W incident power at the driven port (peak phasor)', max: 1000, magnitude: [[1000, 100, 10], [1, 0, 500]], port: 1,
    phasor: { components: ['x', 'y', 'z'], peak: 100, data: Buffer.from(bytes.buffer).toString('base64') },
  };
}

async function copyRun(ctx, source, id, letter, name, created, extra = {}) {
  const bundle = JSON.parse(readFileSync(join(root, 'public', 'projects', source), 'utf8'));
  bundle.model = { ...bundle.model, id, name: `${bundle.model.name ?? name}` };
  bundle.name = name;
  bundle.created = created;
  Object.assign(bundle, extra);
  writeFileSync(join(ctx.stack.projects, `${id}--run-${letter}.json`), JSON.stringify(bundle));
}

export default {
  id: 'S4',
  title: 'Compare two runs and export',
  async run(s, ctx) {
    let id;
    await s.step('create a patch design', async () => {
      await s.page.evaluateOnNewDocument(() => {
        // What a browser download or the clipboard would receive, kept for the checks
        window.__captured = { downloads: [], copies: [] };
        const create = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => { if (blob instanceof Blob) blob.text().then((text) => window.__captured.downloads.push(text)); return create(blob); };
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__captured.copies.push(String(text)); }, readText: async () => '' } });
      });
      await s.page.goto(s.url, { waitUntil: 'domcontentloaded' });
      await s.wait('.home');
      await s.fill(await s.field(await s.T('home.newProject.name')), `Scenario results ${s.lang} ${ctx.stamp}`, { blur: false });
      await (await s.wait('label, .home-tpl', await s.T('templates.patch.name'))).click();
      await s.click('home.newProject.create');
      await s.wait('.rb');
      id = await s.store((_, m) => m.s.file().design.model.id);
      assert.ok(id);
    });
    await s.step('two example bundles appear as runs of the design', async () => {
      await copyRun(ctx, 'patch-antenna.json', id, 'a', 'Run A (with field maps)', '2026-09-20T10:00:00+0000', { field_planes: [fieldMap()] });
      await copyRun(ctx, 'inset-patch.json', id, 'b', 'Run B', '2026-09-20T11:00:00+0000');
      execFileSync(pythonPath(), ['-m', 'fairbeam', 'index', ctx.stack.projects], { cwd: join(root, 'python'), env: { ...process.env, PYTHONPATH: join(root, 'python') }, stdio: 'ignore' });
      await s.page.reload({ waitUntil: 'domcontentloaded' });
      await s.wait('.rb');
      await s.waitFor(() => document.querySelectorAll('.nt-row[data-id^="run:"]').length >= 2, null, { what: 'two runs in the tree', timeout: 20000 });
    });
    const rows = () => s.page.$$('.nt-row[data-id^="run:"]');
    await s.step('⌘-click a second run in the tree: the comparison opens and the Summary shows Δ', async () => {
      await (await rows())[0].click();
      await s.page.keyboard.down('Meta'); // the tree takes ctrlKey or metaKey; Ctrl-click is a right click on a Mac
      try { await (await rows())[1].click(); } finally { await s.page.keyboard.up('Meta'); }
      await s.click('ribbon.tab.post', { sel: '.rb-tab' });
      await s.click('ribbon.post.summary', { sel: '.rb-btn' });
      await s.wait('table.rs-compare');
      assert.equal(await s.page.$$eval('table.rs-compare tbody tr', (r) => r.length), 2, 'both runs are compared');
      await (await s.wait('[role=radio]', 'Δ')).click();
      await s.waitFor(() => document.querySelector('.rs-delta'), null, { what: 'a delta cell' });
      await s.click('summary.mode.values', { sel: '[role=radio]' });
      await (await rows())[0].click(); // a plain click goes back to one run; the next step adds the second from the dock
    });
    await s.step('add the second run to the comparison (dock Runs tab) and open the Summary: one row per run', async () => {
      const [first] = await rows();
      await first.click();
      await (await s.wait('button.rdk-run-btn[aria-pressed=false]')).click();
      await s.click('ribbon.tab.post', { sel: '.rb-tab' });
      await s.click('ribbon.post.summary', { sel: '.rb-btn' });
      await s.wait('table.rs-compare');
      assert.equal(await s.page.$$eval('table.rs-compare tbody tr', (r) => r.length), 2, 'one row per run');
    });
    await s.step('Δ vs A: the second run shows differences from the first', async () => {
      const values = await s.text('table.rs-compare tbody');
      await (await s.wait('[role=radio]', 'Δ')).click(); // "Δ vs A" ("Δ vs A" in Turkish reads the same)
      await s.waitFor(() => document.querySelector('.rs-delta'), null, { what: 'a delta cell' });
      assert.notEqual(await s.text('table.rs-compare tbody'), values, 'the table changed');
      assert.ok(await s.page.$$eval('.rs-delta', (els) => els.some((e) => /[+−-]\d|[±]/.test(e.textContent))), 'a Δ value is shown');
      await s.click('summary.mode.values', { sel: '[role=radio]' });
    });
    await s.step('Copy data and CSV of the Summary reach the clipboard and a download', async () => {
      await s.click('results.toolbar.copyData', { sel: 'button' });
      await s.waitFor(() => window.__captured.copies.length > 0, null, { what: 'copied data' });
      const copy = await s.page.evaluate(() => window.__captured.copies.at(-1));
      assert.match(copy, /\d/, 'the copied data has numbers');
      await (await s.wait('button', 'CSV')).click();
      await s.waitFor(() => window.__captured.downloads.length > 0, null, { what: 'the CSV download' });
      const csv = await s.page.evaluate(() => window.__captured.downloads.at(-1));
      assert.ok(csv.split('\n').length >= 3 && csv.split('\n')[0].includes(','), 'the CSV has a header row and data rows');
    });
    await s.step('Properties of a run: the right panel shows its numbers', async () => {
      const rowA = await s.page.evaluateHandle(() => [...document.querySelectorAll('.nt-row[data-id^="run:"]')].find((r) => /field maps/.test(r.textContent)));
      await rowA.asElement().click();
      await s.wait('*', await s.T('props.run.date'));
      const text = await s.text('body');
      assert.ok(text.includes(await s.T('props.run.engine')) && text.includes(await s.T('props.run.cells')), 'engine and cells are listed');
      assert.match(text, /2[.,]453/, 'the resonance of run A is listed');
    });
    await s.step('Field map: Phase and Animate', async () => {
      await s.click('ribbon.post.fieldMap', { sel: '.rb-btn' });
      await s.wait('.fm-plot');
      await s.click('fieldPlane.mode.phase', { sel: '[role=radio]', exact: true }); // exact: another mode's tooltip may mention the word
      await s.waitFor((label) => [...document.querySelectorAll('[role=radio]')].some((r) => r.getAttribute('aria-checked') === 'true' && r.textContent.trim() === label), await s.T('fieldPlane.mode.phase'), { what: 'Phase mode' });
      await s.click('fieldPlane.mode.animate', { sel: '[role=radio]', exact: true });
      const slider = await s.wait('#field-plane-phase');
      await s.click('viewport.current.play', { sel: 'button' });
      const before = await slider.evaluate((e) => e.value);
      await s.sleep(900);
      assert.notEqual(await slider.evaluate((e) => e.value), before, 'the animation advances the phase');
      await s.click('viewport.current.pause', { sel: 'button' });
    });
    await s.step('a result file that fails to load offers Retry', async () => {
      // the run server answers 500 for run B's file twice (the load retries once by itself)
      await s.page.evaluate(() => {
        const real = window.fetch.bind(window);
        let failures = 0;
        window.fetch = (input, init) => {
          const url = String(input?.url ?? input);
          if (failures < 2 && /--run-b\.json/.test(url)) { failures++; return Promise.resolve(new Response('boom', { status: 500 })); }
          return real(input, init);
        };
      });
      const rowB = await s.page.evaluateHandle(() => [...document.querySelectorAll('.nt-row[data-id^="run:"]')].find((r) => /Run B/.test(r.textContent)));
      await rowB.asElement().click();
      await s.wait('[role=alert] button', await s.T('common.retry'));
      await s.click('common.retry', { sel: '[role=alert] button' });
      await s.gone('[role=alert] button', await s.T('common.retry'));
      assert.equal(await s.page.$$eval('[role=alert]', (els) => els.filter((e) => /HTTP 500/.test(e.textContent)).length), 0, 'the error is gone after the retry');
    });
  },
};
