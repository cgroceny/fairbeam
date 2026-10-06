// S8: gaps in S4/S7: component transforms leave ports and
// resistors at their world coordinates, and the field map switches between its 2D and 3D views.
// No solver: the run is a bundled example bundle with a synthetic field plane.
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


const TRANSFORM_PANEL = '.tf-panel';

export default {
  id: 'S8',
  title: 'Ports stay put under component transforms; field map 2D/3D',
  async run(s, ctx) {
    let id;
    await s.step('create a patch design and put two parts into a component', async () => {
      await s.page.goto(s.url, { waitUntil: 'domcontentloaded' });
      await s.wait('.home');
      await s.fill(await s.field(await s.T('home.newProject.name')), `Scenario ports ${s.lang} ${ctx.stamp}`, { blur: false });
      await (await s.wait('label, .home-tpl', await s.T('templates.patch.name'))).click();
      await s.click('home.newProject.create');
      await s.wait('.rb');
      await s.waitFor(async () => (await import('/src/designer/store.ts')).draft.parts?.length >= 3, null, { what: 'the starter geometry' });
      id = await s.store((_, m) => m.s.file().design.model.id);
      await s.store((_, m) => m.s.edit((d) => {
        for (const p of d.parts) if (p.name === 'substrate' || p.name === 'patch') p.component = 'Assembly/Feed';
      }));
      await s.wait('.nt-row[data-id="folder:Assembly/Feed"]');
    }, { settle: 500 });

    await s.step('grouped feeds keep signs through editing, duplication, undo and save/reopen', async () => {
      await s.store((_, m) => m.s.setSelection({ type: 'port', i: 0 }));
      await s.click('props.port.group.add', { sel: 'button' });
      await (await s.field(await s.T('props.port.group.connection'))).select('series');
      await (await s.field(await s.T('props.port.group.polarity'))).select('-1');
      await s.store((_, m) => m.s.edit((d) => {
        const member = d.ports[0].group.members[0];
        member.start[0] = 'feed + 2'; member.stop[0] = 'feed + 2';
      }));
      const expected = await s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft.ports[0].group)));
      assert.equal(expected.connection, 'series'); assert.equal(expected.members[0].polarity, -1);
      const waveguide = await s.wait('button', await s.T('props.port.waveguide'), { exact: true });
      assert.equal(await waveguide.evaluate((el) => el.disabled), true, 'changing type cannot drop additional feeds');
      await s.store((_, m) => m.s.duplicateSelected());
      assert.deepEqual(await s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft.ports[1].group))), expected);
      await s.store((_, m) => { m.s.undo(); m.s.setSelection({ type: 'port', i: 0 }); });
      await s.click('props.port.group.remove', { sel: 'button' });
      assert.equal(await s.store((_, m) => !!m.s.draft.ports[0].group), false);
      await s.store((_, m) => m.s.undo());
      await s.click('ribbon.tab.home', { sel: '.rb-tab' });
      await s.click('common.save', { sel: '.rb-btn' });
      await s.waitFor(async () => !(await import('/src/designer/store.ts')).dirty(), null, { what: 'the grouped-port save', timeout: 20000 });
      await s.page.reload({ waitUntil: 'domcontentloaded' });
      await s.wait('.rb');
      assert.deepEqual(await s.store((_, m) => JSON.parse(JSON.stringify(m.s.draft.ports[0].group))), expected);
    });

    await s.step('rotating a component 90 degrees moves its parts but not the ports or resistors', async () => {
      const before = await s.store((_, m) => JSON.parse(JSON.stringify({ ports: m.s.draft.ports, resistors: m.s.draft.resistors, parts: m.s.draft.parts })));
      assert.ok(before.ports.length >= 1, 'the patch starter has a port');
      const row = await s.wait('.nt-row[data-id="folder:Assembly/Feed"]');
      await row.click({ button: 'right' });
      await s.wait('.nt-context-menu');
      await s.click('tree.menu.transformComponent', { sel: '[role=menuitem]', within: '.nt-context-menu', params: { count: 2 }, exact: true });
      await s.wait(TRANSFORM_PANEL);
      await s.clickSel(`${TRANSFORM_PANEL} input[name="tf-operation"][value="rotate"]`);
      await s.clickSel('[data-angle-preset="90"]');
      await s.wait('p[aria-live="polite"]', await s.T('transform.preview.ready'), { within: TRANSFORM_PANEL });
      const apply = await s.wait('button', await s.T('common.apply'), { within: TRANSFORM_PANEL, exact: true });
      await apply.click();
      await s.gone(TRANSFORM_PANEL);
      const after = await s.store((_, m) => JSON.parse(JSON.stringify({ ports: m.s.draft.ports, resistors: m.s.draft.resistors, parts: m.s.draft.parts })));
      assert.deepEqual(after.ports, before.ports, 'ports keep their world coordinates');
      assert.deepEqual(after.resistors, before.resistors, 'resistors keep their world coordinates');
      for (const [i, p] of after.parts.entries()) {
        const moved = (p.transforms?.length ?? 0) > (before.parts[i].transforms?.length ?? 0);
        assert.equal(moved, p.component === 'Assembly/Feed', `${p.name}: only the component's parts receive the transform`);
      }
    });

    await s.step('a run with a field plane is added to the design', async () => {
      const bundle = JSON.parse(readFileSync(join(root, 'public', 'projects', 'patch-antenna.json'), 'utf8'));
      bundle.model = { ...bundle.model, id };
      bundle.name = 'Run with field map';
      bundle.created = '2026-10-03T10:00:00+0000';
      bundle.field_planes = [fieldMap()];
      writeFileSync(join(ctx.stack.projects, `${id}--run-a.json`), JSON.stringify(bundle));
      execFileSync(pythonPath(), ['-m', 'fairbeam', 'index', ctx.stack.projects], { cwd: join(root, 'python'), env: { ...process.env, PYTHONPATH: join(root, 'python') }, stdio: 'ignore' });
      await s.store((_, m) => m.s.dirty() && null);
      await s.click('ribbon.tab.home', { sel: '.rb-tab' });
      await s.click('common.save', { sel: '.rb-btn' });
      await s.waitFor(async () => !(await import('/src/designer/store.ts')).dirty(), null, { what: 'the save', timeout: 20000 });
      await s.page.reload({ waitUntil: 'domcontentloaded' });
      await s.wait('.rb');
      await s.waitFor(() => document.querySelectorAll('.nt-row[data-id^="run:"]').length >= 1, null, { what: 'the run in the tree', timeout: 20000 });
      await (await s.wait('.nt-row[data-id^="run:"]')).click();
    }, { settle: 500 });

    await s.step('field map switches 2D, 3D, 2D with the mode kept and no stale view', async () => {
      const view = () => s.ev((_, m) => m.r.resultFocus()?.view, null, { r: '/src/designer/resultFocus.ts' });
      await s.click('ribbon.tab.post', { sel: '.rb-tab' });
      await s.click('ribbon.post.fieldMap', { sel: '.rb-btn' });
      await s.wait('.fm-plot');
      assert.equal(await view(), 'fieldmap');
      await s.click('fieldPlane.mode.phase', { sel: '[role=radio]', exact: true });
      await s.click('ribbon.fieldPlane', { sel: '.rb-btn' });
      await s.waitFor(async () => (await import('/src/designer/resultFocus.ts')).resultFocus()?.view === 'fieldplane', null, { what: 'the 3D field plane' });
      await s.gone('.fm-plot');
      assert.ok(await s.page.$('canvas.vp-canvas'), 'the 3D viewport is shown');
      await s.click('ribbon.post.fieldMap', { sel: '.rb-btn' });
      await s.wait('.fm-plot');
      assert.equal(await view(), 'fieldmap');
      const phase = await s.page.$$eval('[role=radio]', (rs) => rs.filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent.trim()));
      assert.ok(phase.includes(await s.T('fieldPlane.mode.phase')), 'the Phase mode survives the 2D/3D round trip');
      await s.click('ribbon.fieldPlane', { sel: '.rb-btn' });
      await s.gone('.fm-plot');
    });
  },
};
