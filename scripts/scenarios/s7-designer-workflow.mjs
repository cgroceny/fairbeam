// S7: exercise designer transforms, component moves, local drawing frames and view preferences
// through the real browser UI. Fixtures are edited/saved directly only to avoid solver runs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pythonPath, root } from './stack.mjs';

const COMPONENT = 'Assembly/Feed';
const REFERENCE = 'Assembly/Reference';
const TRANSFORM_PANEL = '.tf-panel';
const WCS_DIALOG = '[aria-labelledby="wcs-title"]';

async function screenshot(s, name) {
  const dir = process.env.FAIRBEAM_SCENARIO_SCREENSHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await s.page.screenshot({ path: join(dir, `S7-${s.lang}-${name}.png`) });
}

function stablePart(part) {
  return {
    name: part.name,
    material: part.material,
    label: part.label ?? null,
    component: part.component ?? '',
    primitives: part.primitives,
    cuts: part.cuts ?? [],
    transforms: part.transforms ?? [],
  };
}

async function partsOf(s) {
  return s.store((_, m) => {
    const parts = m.s.draft.parts.map((p) => ({
      name: p.name,
      material: p.material,
      label: p.label ?? null,
      component: p.component ?? '',
      primitives: p.primitives,
      cuts: p.cuts ?? [],
      transforms: p.transforms ?? [],
    }));
    return JSON.parse(JSON.stringify(parts));
  });
}

async function draftOf(s) {
  return s.store((_, m) => JSON.stringify(m.s.draft));
}

async function historyAt(s) {
  return s.store((_, m) => m.s.historyIndex());
}

async function waitForComponent(s, i, value) {
  await s.waitFor(async ({ index, expected }) => {
    const store = await import('/src/designer/store.ts');
    return (store.draft.parts[index]?.component ?? '') === expected;
  }, { index: i, expected: value }, { what: `part ${i} to move into ${value || 'the design root'}` });
}

async function waitForPreview(s) {
  const ready = await s.T('transform.preview.ready');
  await s.wait('p[aria-live="polite"]', ready, { within: TRANSFORM_PANEL });
}

function assertBounds(actual, expected, message) {
  assert.equal(actual.length, expected.length, `${message}: primitive count`);
  const order = (a, b) => a[0][0] - b[0][0];
  const got = [...actual].sort(order);
  const want = [...expected].sort(order);
  for (let i = 0; i < want.length; i++) {
    const gotValues = got[i].flat();
    const wantValues = want[i].flat();
    assert.equal(gotValues.length, wantValues.length);
    for (let k = 0; k < wantValues.length; k++) {
      assert.ok(Math.abs(gotValues[k] - wantValues[k]) < 1e-6,
        `${message}: bbox ${i}, value ${k}; expected ${wantValues[k]}, got ${gotValues[k]}`);
    }
  }
}

async function previewBounds(s) {
  return s.ev((_, m) => m.tr.previewGeometry().map((p) => p.bbox), null, { tr: '/src/designer/transforms.ts' });
}

async function dockLayout(s) {
  return s.page.evaluate(() => {
    const panel = document.querySelector('.tf-panel');
    const dialog = panel?.querySelector('.tf-dialog');
    const head = dialog?.querySelector('.dialog-head');
    const body = dialog?.querySelector('.sd-body');
    const foot = dialog?.querySelector('.dialog-foot');
    const close = head?.querySelector('button[aria-label]');
    const apply = foot?.querySelector('button[type="submit"]');
    const viewport = document.querySelector('.viewport');
    const canvas = viewport?.querySelector('canvas.vp-canvas');
    const rect = (el) => {
      const r = el?.getBoundingClientRect();
      return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
    };
    const overflow = (el) => el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } : null;
    const style = (el) => {
      if (!el) return null;
      const s = getComputedStyle(el);
      return { width: s.width, minWidth: s.minWidth, padding: s.padding, boxSizing: s.boxSizing, display: s.display, overflowX: s.overflowX };
    };
    const intersects = (a, b) => !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const panelRect = rect(panel), closeRect = rect(close), applyRect = rect(apply);
    const within = (item, container) => !!item && !!container && item.left >= container.left - 1 && item.right <= container.right + 1 && item.top >= container.top - 1 && item.bottom <= container.bottom + 1;
    return {
      panel: panelRect, viewport: rect(viewport), canvas: rect(canvas), dialog: rect(dialog), head: rect(head), body: rect(body), foot: rect(foot),
      close: closeRect, apply: applyRect, closeInsidePanel: within(closeRect, panelRect), applyInsidePanel: within(applyRect, panelRect),
      overflow: { panel: overflow(panel), dialog: overflow(dialog), head: overflow(head), body: overflow(body), foot: overflow(foot) },
      styles: { panel: style(panel), dialog: style(dialog), head: style(head), body: style(body) },
      panelOverlapsViewport: intersects(panelRect, rect(viewport)),
      panelOverlapsCanvas: intersects(panelRect, rect(canvas)),
      modal: dialog?.getAttribute('aria-modal') ?? null,
      inert: !!viewport?.inert,
    };
  });
}

function assertDockDoesNotOverlapViewport(layout, label) {
  const details = JSON.stringify(layout);
  assert.ok(layout.panel && layout.viewport && layout.canvas, 'the modeless panel, viewport, and canvas are mounted');
  assert.equal(layout.modal, 'false', 'the transform dialog is explicitly modeless');
  assert.equal(layout.inert, false, 'the viewport remains interactive while Transform is open');
  assert.equal(layout.panelOverlapsViewport, false, `the dock does not cover the viewport ${label}: ${details}`);
  assert.equal(layout.panelOverlapsCanvas, false, `the dock does not cover the 3D canvas ${label}: ${details}`);
  for (const [name, metrics] of Object.entries(layout.overflow)) {
    if (metrics) assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `${name} contents are horizontally reachable ${label}: ${details}`);
  }
  assert.ok(layout.closeInsidePanel, `the Transform close control is inside the panel ${label}: ${details}`);
  assert.ok(layout.applyInsidePanel, `the Transform Apply control is inside the panel ${label}: ${details}`);
}

async function assertTransformDockLeavesViewportUsable(s) {
  assertDockDoesNotOverlapViewport(await dockLayout(s), 'at desktop width');

  await s.page.$eval('.viewport', (el) => el.focus({ preventScroll: true }));
  assert.equal(await s.page.evaluate(() => document.activeElement?.classList.contains('viewport')), true,
    'the viewport accepts keyboard focus while the transform panel is open');
  const topSelector = '.viewport .vp-hud-tl .seg-btn:nth-of-type(2)';
  await s.page.click(topSelector);
  assert.equal(await s.page.$eval(topSelector, (el) => el.getAttribute('aria-pressed')), 'true', 'the viewport camera toolbar responds with the dock open');
  assert.equal(await s.page.$eval(TRANSFORM_PANEL, (el) => el.isConnected), true,
    'using a camera view leaves the transform panel open');

  const canvas = await s.wait('canvas.vp-canvas', undefined, { within: '.viewport' });
  const bounds = await canvas.boundingBox();
  assert.ok(bounds && bounds.width > 100 && bounds.height > 100, 'the visible canvas can receive pointer input');
  await s.sleep(300);
  const beforeOrbit = await s.page.evaluate(() => window.__fairbeam.camera.position.toArray());
  await s.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await s.page.mouse.down();
  await s.page.mouse.move(bounds.x + bounds.width / 2 + 54, bounds.y + bounds.height / 2 + 31, { steps: 5 });
  await s.page.mouse.up();
  await s.sleep(300);
  const afterOrbit = await s.page.evaluate(() => window.__fairbeam.camera.position.toArray());
  assert.ok(afterOrbit.some((value, i) => Math.abs(value - beforeOrbit[i]) > 1e-5),
    'dragging the viewport orbits the camera while Transform stays open');
  assert.equal(await s.page.$eval(TRANSFORM_PANEL, (el) => el.isConnected), true,
    'orbiting the viewport does not close or cover the transform panel');
}

async function openComponentTransform(s, path, count) {
  const row = await s.wait(`.nt-row[data-id="folder:${path}"]`);
  await row.click({ button: 'right' });
  await s.wait('.nt-context-menu');
  await s.click('tree.menu.transformComponent', {
    sel: '[role=menuitem]', within: '.nt-context-menu', params: { count }, exact: true,
  });
  await s.wait(TRANSFORM_PANEL);
}

// Reach the same real action whether the ribbon group is inline or folded into a flyout.
async function clickRibbonAction(s, groupKey, actionKey) {
  const group = `.rb-group[aria-label="${await s.T(groupKey)}"]`;
  if (!await s.find('.rb-btn', await s.T(actionKey), { within: group, exact: true })) {
    await s.click(groupKey, { sel: '.rb-group-toggle', within: group, exact: true });
  }
  await s.click(actionKey, { sel: '.rb-btn', within: group, exact: true });
}

async function openWcsTransform(s) {
  await clickRibbonAction(s, 'ribbon.wcs.group', 'ribbon.wcs.transform');
  await s.wait(WCS_DIALOG);
}

async function openBoxDialog(s) {
  await clickRibbonAction(s, 'ribbon.shapes.group', 'ribbon.shapes.box');
  await s.wait('.sd');
}

async function copyPatternRun(ctx, designId) {
  const bundle = JSON.parse(readFileSync(join(root, 'public', 'projects', 'sierpinski-monopole--iterations-0.json'), 'utf8'));
  bundle.model = { ...bundle.model, id: designId, name: 'Local UI fixture' };
  bundle.name = 'S7 local result fixture';
  bundle.created = '2026-10-02T12:00:00+0000';
  const filename = `${designId}--run-s7.json`;
  writeFileSync(join(ctx.stack.projects, filename), JSON.stringify(bundle));
  execFileSync(pythonPath(), ['-m', 'fairbeam', 'index', ctx.stack.projects], {
    cwd: join(root, 'python'),
    env: { ...process.env, PYTHONPATH: join(root, 'python') },
    stdio: 'ignore',
  });
  return filename;
}

async function saveThroughUi(s) {
  await s.click('ribbon.tab.home', { sel: '.rb-tab' });
  await s.click('common.save', { sel: '.rb-btn' });
  await s.waitFor(async () => !(await import('/src/designer/store.ts')).dirty(), null, { what: 'the design save to finish', timeout: 20000 });
}

export default {
  id: 'S7',
  title: 'Transform components and preserve view state',
  async run(s, ctx) {
    let designId;
    let indices;
    let baselineDraft;
    let baselineHistory;

    await s.step('create a patch fixture with two nested components', async () => {
      await s.page.goto(s.url, { waitUntil: 'domcontentloaded' });
      await s.wait('.home');
      await s.fill(await s.field(await s.T('home.newProject.name')), `Scenario designer ${s.lang} ${ctx.stamp}`);
      await (await s.wait('label, .home-tpl', await s.T('templates.patch.name'))).click();
      await s.click('home.newProject.create');
      await s.wait('.rb');
      await s.waitFor(async () => (await import('/src/designer/store.ts')).draft.parts?.length >= 3,
        null, { what: 'the patch starter geometry to load' });
      indices = await s.store(({ component, reference }, m) => {
        const parts = m.s.draft.parts;
        const substrate = parts.findIndex((p) => p.name === 'substrate');
        const patch = parts.findIndex((p) => p.name === 'patch');
        const ground = parts.findIndex((p) => p.name === 'gnd');
        m.s.edit((d) => {
          d.parts[substrate].component = component;
          d.parts[patch].component = component;
          d.parts[ground].component = reference;
        });
        return { substrate, patch, ground };
      }, { component: COMPONENT, reference: REFERENCE });
      assert.ok(indices.substrate >= 0 && indices.patch >= 0 && indices.ground >= 0,
        'the starter has substrate, patch and ground parts');
      await s.wait(`.nt-row[data-id="folder:${COMPONENT}"]`);
      await s.wait(`.nt-row[data-id="folder:${REFERENCE}"]`);
      designId = await s.store((_, m) => m.s.file()?.design.model.id);
      assert.ok(designId, 'the Design is open');
      baselineDraft = await draftOf(s);
      baselineHistory = await historyAt(s);
    }, { settle: 500 });

    await s.step('Preview twice shows the exact shared-origin outline without editing the draft', async () => {
      await openComponentTransform(s, COMPONENT, 2);
      await waitForPreview(s);
      await screenshot(s, 'transform-dock-ready-1440');
      const copyOption = await s.page.$(`${TRANSFORM_PANEL} input[type="checkbox"]`);
      await copyOption.click();
      assert.equal(await copyOption.evaluate((e) => e.checked), true,
        'the Move operation can enable copies before the operation changes');
      await s.clickSel(`${TRANSFORM_PANEL} input[name="tf-operation"][value="scale"]`);
      assert.equal(await s.page.$eval(`${TRANSFORM_PANEL} input[type="checkbox"]`, (e) => e.checked), false,
        'switching from Move to Scale clears the incompatible copy option');
      for (const [axis, value] of [['x', '5'], ['y', '-2'], ['z', '1']]) {
        await s.fill(await s.field(axis, { within: TRANSFORM_PANEL, nth: 1 }), value);
      }
      const scaleX = await s.field('x', { within: TRANSFORM_PANEL, nth: 0 });
      await s.fill(scaleX, '0');
      await s.wait('[aria-live="polite"]', await s.T('transform.preview.fixFields'), { within: TRANSFORM_PANEL });
      const scaleError = await scaleX.evaluate((e) => e.closest('.dz-field')?.querySelector('.dz-value.dz-bad')?.textContent.trim() ?? '');
      assert.equal(scaleError.toLocaleLowerCase(), (await s.T('checks.msg.scale.equalPositive')).toLocaleLowerCase(), 'the invalid uniform scale has one precise field error');
      const applyButton = await s.wait('button', await s.T('common.apply'), { within: TRANSFORM_PANEL, exact: true });
      assert.equal(await applyButton.evaluate((e) => e.disabled), true,
        'a nonpositive scale is rejected before Apply');
      assert.deepEqual(await previewBounds(s), [], 'invalid scale values remove any stale preview outline');
      assert.equal(await draftOf(s), baselineDraft, 'invalid values do not edit the draft');
      await s.fill(await s.field('x', { within: TRANSFORM_PANEL, nth: 0 }), '2');
      await waitForPreview(s);
      await s.click('transform.preview.button', { within: TRANSFORM_PANEL });
      await waitForPreview(s);
      const first = await previewBounds(s);
      assertBounds(first, [
        [[-65, -58, -1], [55, 62, 2.048]],
        [[-37, -38, 2.048], [27, 42, 2.048]],
      ], 'the outline scales both component members about [5, -2, 1]');
      await assertTransformDockLeavesViewportUsable(s);
      await screenshot(s, 'transform-ready-1440');
      assert.equal(await draftOf(s), baselineDraft, 'Preview leaves every draft field untouched');
      assert.equal(await historyAt(s), baselineHistory, 'Preview does not add an undo step');

      await s.click('transform.preview.button', { within: TRANSFORM_PANEL });
      await waitForPreview(s);
      assert.deepEqual(await previewBounds(s), first, 'a repeated Preview displays the same transformed geometry');
      assert.equal(await draftOf(s), baselineDraft, 'repeated Preview still leaves the draft untouched');
      assert.equal(await historyAt(s), baselineHistory, 'repeated Preview still has no undo entry');
    });

    await s.step('double-click Apply commits once, closes, and one Undo restores the component', async () => {
      const apply = await s.wait('button', await s.T('common.apply'), { within: TRANSFORM_PANEL, exact: true });
      await apply.click({ clickCount: 2, delay: 80 });
      await s.gone(TRANSFORM_PANEL);
      const applied = await s.store((_, m) => ({
        parts: JSON.parse(JSON.stringify(m.s.draft.parts.map((p) => ({
          name: p.name,
          material: p.material,
          label: p.label ?? null,
          component: p.component ?? '',
          primitives: p.primitives,
          cuts: p.cuts ?? [],
          transforms: p.transforms ?? [],
        })))),
        history: m.s.historyIndex(),
        selection: m.s.selection(),
      }));
      assert.equal(applied.history, baselineHistory + 1, 'Apply creates exactly one undo transaction');
      assert.deepEqual(applied.parts[indices.substrate].transforms.at(-1), {
        type: 'scale', factors: [2, 2, 2], origin: [5, -2, 1],
      });
      assert.deepEqual(applied.parts[indices.patch].transforms.at(-1), {
        type: 'scale', factors: [2, 2, 2], origin: [5, -2, 1],
      }, 'all component members receive the identical shared-origin transform');
      assert.deepEqual(applied.parts[indices.ground], JSON.parse(baselineDraft).parts.map(stablePart)[indices.ground],
        'the neighboring component is unchanged');
      assert.deepEqual(applied.selection, { type: 'part', i: indices.substrate }, 'selection moves to the first member after commit');

      await s.click('ribbon.tab.home', { sel: '.rb-tab' });
      await s.click('ribbon.home.undo', { sel: '.rb-btn' });
      assert.equal(await historyAt(s), baselineHistory, 'one Undo reverses the whole group transform');
      assert.equal(await draftOf(s), baselineDraft, 'one Undo restores the exact pre-transform design');
    });

    await s.step('arbitrary Z rotations preview exact off-origin component geometry', async () => {
      await s.store(({ substrate, patch }, m) => m.s.edit((d) => {
        d.parts[substrate].primitives = [{ kind: 'box', start: [10, 20, 2], stop: [14, 23, 5] }];
        d.parts[substrate].cuts = [];
        d.parts[substrate].transforms = [];
        d.parts[patch].primitives = [{ kind: 'box', start: [15, 25, 0], stop: [17, 29, 1] }];
        d.parts[patch].cuts = [];
        d.parts[patch].transforms = [];
      }), { substrate: indices.substrate, patch: indices.patch });
      const untransformed = await draftOf(s);

      await openComponentTransform(s, COMPONENT, 2);
      await s.clickSel(`${TRANSFORM_PANEL} input[name="tf-operation"][value="rotate"]`);
      const angle = await s.field(await s.T('transform.angle'), { within: TRANSFORM_PANEL });
      await s.fill(angle, '45');
      await waitForPreview(s);
      assert.equal(await angle.evaluate((e) => e.value), '45', 'an arbitrary angle stays editable');
      const apply = await s.wait('button', await s.T('common.apply'), { within: TRANSFORM_PANEL, exact: true });
      assert.equal(await apply.evaluate((e) => e.disabled), false, 'a valid 45° rotation can be applied');
      const root2 = Math.SQRT1_2;
      assertBounds(await previewBounds(s), [
        [[-13 * root2, 30 * root2, 2], [-6 * root2, 37 * root2, 5]],
        [[-14 * root2, 40 * root2, 0], [-8 * root2, 46 * root2, 1]],
      ], '45° rotation preserves the exact world bounds of both component boxes about [0, 0, 0]');

      const missing = 'S7_UNKNOWN_ANGLE';
      await s.fill(angle, missing);
      const oneAngleError = await s.T('checks.msg.expr.unknownName', { name: missing });
      await s.wait('[aria-live="polite"]', await s.T('transform.preview.fixFields'), { within: TRANSFORM_PANEL });
      const visibleErrors = await s.page.$eval(TRANSFORM_PANEL,
        (panel) => [...panel.querySelectorAll('.dz-field .dz-value.dz-bad')].map((el) => el.textContent.trim()).filter(Boolean));
      assert.deepEqual(visibleErrors.map((message) => message.toLocaleLowerCase()), [oneAngleError.toLocaleLowerCase()],
        'an unresolved angle produces the localized field error (capitalization may differ at sentence start)');
      assert.equal(await angle.evaluate((e) => e.getAttribute('aria-invalid')), 'true', 'the angle field is marked invalid');
      assert.equal(await apply.evaluate((e) => e.disabled), true, 'an unresolved angle cannot be applied');
      assert.deepEqual(await previewBounds(s), [], 'an invalid angle clears the previous preview');

      await s.clickSel('[data-angle-preset="90"]');
      await waitForPreview(s);
      assert.equal(await angle.evaluate((e) => e.value), '90', 'the 90° preset replaces the invalid expression');
      assert.equal(await apply.evaluate((e) => e.disabled), false, 'the valid preset restores Apply');
      assertBounds(await previewBounds(s), [
        [[-23, 10, 2], [-20, 14, 5]],
        [[-29, 15, 0], [-25, 17, 1]],
      ], 'the 90° preset restores the exact quarter-turn preview for both boxes');
      const frontSelector = '.viewport .vp-hud-tl .seg-btn:nth-of-type(3)';
      await s.page.click(frontSelector);
      assert.equal(await s.page.$eval(frontSelector, (el) => el.getAttribute('aria-pressed')), 'true', 'the camera starts from a distinct front view');
      const beforeRotationPlane = await s.page.evaluate(() => {
        const { camera, controls } = window.__fairbeam;
        return camera.position.clone().sub(controls.target).normalize().toArray();
      });
      assert.ok(beforeRotationPlane[1] < -0.99 && Math.abs(beforeRotationPlane[2]) < 0.001,
        `Front view has the expected camera direction before invoking the tool: ${JSON.stringify(beforeRotationPlane)}`);
      await s.click('transform.viewRotationPlane', { within: TRANSFORM_PANEL });
      assert.equal(await s.page.$eval('.viewport .vp-hud-tl .seg-btn:nth-of-type(2)', (el) => el.getAttribute('aria-pressed')), 'true',
        'View rotation plane shows a Z transform from above');
      const cameraView = await s.page.evaluate(() => {
        const { camera, controls } = window.__fairbeam;
        return {
          direction: camera.position.clone().sub(controls.target).normalize().toArray(),
          up: camera.up.toArray(),
          target: controls.target.toArray(),
          distance: camera.position.distanceTo(controls.target),
          fov: camera.fov,
          aspect: camera.aspect,
        };
      });
      const fitExpected = await s.ev((_, m) => {
        const b = m.state.bundle();
        const base = m.geo.sceneRadius(b);
        const min = base.box.min.toArray(), max = base.box.max.toArray();
        const preview = m.tr.previewGeometry();
        for (const p of preview) for (const corner of p.bbox) for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], corner[axis]);
          max[axis] = Math.max(max[axis], corner[axis]);
        }
        const size = max.map((value, axis) => value - min[axis]);
        return { center: min.map((value, axis) => (value + max[axis]) / 2), radius: Math.hypot(...size) / 2, previewCount: preview.length };
      }, null, { state: '/src/state.ts', tr: '/src/designer/transforms.ts', geo: '/src/scene/geometry.ts' });
      const topDirection = [0, -0.0001 / Math.hypot(0.0001, 1), 1 / Math.hypot(0.0001, 1)];
      const directionDot = cameraView.direction.reduce((sum, value, i) => sum + value * topDirection[i], 0);
      assert.ok(directionDot > 0.9999999 && cameraView.direction[2] > 0.9999 && beforeRotationPlane[1] < -0.99,
        `rotation plane command moves the camera from Front to Top: ${JSON.stringify(cameraView)}`);
      assert.deepEqual(cameraView.up, [0, 0, 1], 'the top camera retains the project Z-up orientation');
      assert.ok(fitExpected.previewCount > 0, 'the exact rotated candidate is available to the camera fit');
      for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(cameraView.target[axis] - fitExpected.center[axis]) < 1e-5,
        `camera fit target includes original and candidate bounds on axis ${axis}: ${JSON.stringify({ cameraView, fitExpected })}`);
      const expectedDistance = fitExpected.radius / Math.sin(cameraView.fov * Math.PI / 360) * 1.08 * Math.max(1, 1 / cameraView.aspect);
      assert.ok(Math.abs(cameraView.distance - expectedDistance) < expectedDistance * 1e-5,
        `camera fit distance uses the original plus preview bounds: ${JSON.stringify({ cameraView, fitExpected, expectedDistance })}`);
      assert.equal(await s.page.$eval(TRANSFORM_PANEL, (el) => el.isConnected), true,
        'showing the rotation plane keeps the modeless transform available');
      await screenshot(s, 'transform-z90-1440');
      await s.page.setViewport({ width: 768, height: 900 });
      await s.sleep(300);
      assertDockDoesNotOverlapViewport(await dockLayout(s), 'at compact width');
      await screenshot(s, 'transform-z90-768');
      await s.page.setViewport({ width: 1440, height: 900 });
      await s.sleep(250);
      assert.equal(await draftOf(s), untransformed, 'live 45°, invalid and preset previews never edit the draft');
      await s.click('common.cancel', { within: TRANSFORM_PANEL });
      await s.gone(TRANSFORM_PANEL);
      assert.equal(await draftOf(s), untransformed, 'cancel leaves the component geometry unchanged');
    });

    await s.step('coplanar PCB Z rotations and offset mirrors remain visible over the source', async () => {
      const original = await draftOf(s);
      await s.store(({i},m)=>m.s.edit(d=>{d.parts[i].primitives=[{kind:'box',start:[-11,-17,1],stop:[21,23,1]}];d.parts[i].cuts=[];d.parts[i].transforms=[];}),{i:indices.patch});
      const baseline=await draftOf(s);
      await s.store(({i},m)=>m.tr.openTransform('rotate',{type:'part',i}),{i:indices.patch},{tr:'/src/designer/transforms.ts'});
      await s.wait(TRANSFORM_PANEL);
      const angle=await s.field(await s.T('transform.angle'),{within:TRANSFORM_PANEL});
      for(const degrees of [45,90]) {
        await s.fill(angle,String(degrees));await waitForPreview(s);
        await s.click('transform.viewRotationPlane',{within:TRANSFORM_PANEL});
        const visible=await s.page.evaluate(()=>window.__fairbeam.scene.getObjectByName('transform-preview').children.map(o=>({mesh:o.isMesh,depth:o.material.depthTest,write:o.material.depthWrite,order:o.renderOrder,z:Array.from(o.geometry.getAttribute('position').array).filter((_,k)=>k%3===2)})));
        assert.ok(visible.some(o=>o.mesh&&o.depth===false&&o.write===false&&o.order===19),'coplanar native surfaces draw through the opaque original');
        assert.ok(visible.some(o=>o.order===20),'result silhouette draws above the ghost surface');
        assert.ok(visible.filter(o=>o.mesh).every(o=>o.z.every(z=>z===1)),'ghost geometry has no artificial Z offset');
        await screenshot(s,`pcb-z${degrees}`);
      }
      await s.clickSel(`${TRANSFORM_PANEL} input[name="tf-operation"][value="mirror"]`);
      const planeFields=await s.page.$$(`${TRANSFORM_PANEL} .dz-vec-row input`);
      await s.fill(planeFields[0],'4');await waitForPreview(s);
      const guide=await s.ev((_,m)=>m.tr.transformGuide(),null,{tr:'/src/designer/transforms.ts'});
      assert.deepEqual(guide,{kind:'plane',axis:0,point:[4,0,0]},'world mirror plane follows the entered point');
      const bounds=await previewBounds(s);
      assertBounds(bounds,[[[-11,-17,1],[21,23,1]],[[-13,-17,1],[19,23,1]]],'offset plane reflection uses x=4');
      await screenshot(s,'pcb-offset-mirror');
      assert.equal(await draftOf(s),baseline,'guides and surfaces never alter source geometry');
      await s.click('common.cancel',{within:TRANSFORM_PANEL});await s.gone(TRANSFORM_PANEL);
      await s.store(({design},m)=>m.s.edit(d=>Object.assign(d,JSON.parse(design))),{design:original});
    });

    await s.step('a draft edit behind Transform closes the stale component preview', async () => {
      await openComponentTransform(s, COMPONENT, 2);
      await waitForPreview(s);
      const before = await partsOf(s);
      const history = await historyAt(s);

      // Move one selected member by keyboard through the real NavTree menu while the modeless dock remains open.
      const row = await s.wait(`.nt-row[data-id="part:${indices.patch}"]`);
      await row.focus();
      await s.press('F10', ['Shift']);
      await s.wait('.dz-context-menu');
      // Duplicate and Delete follow Move to component in the menu, so pick it by its label, not with End.
      await s.click('contextMenu.moveToComponent', { within: '.dz-context-menu' });
      await s.wait('.dz-context-menu input.dz-menu-new');
      for (let i = 0; i < 3; i++) await s.press('ArrowDown');
      await s.press('Enter');
      await waitForComponent(s, indices.patch, REFERENCE);
      await s.gone(TRANSFORM_PANEL);

      const after = await partsOf(s);
      const expected = structuredClone(before);
      expected[indices.patch].component = REFERENCE;
      assert.deepEqual(after, expected, 'the background folder move is preserved without a stale transform');
      assert.equal(await historyAt(s), history + 1, 'the background edit creates only its own undo step');
      assert.deepEqual(await previewBounds(s), [], 'closing the stale panel clears its old preview');
      assert.equal(await s.page.$(`.tf-panel button`), null, 'a closed stale transform has no Apply action');
    });

    await s.step('dragging a part to a sibling folder preserves its material and geometry', async () => {
      const before = await partsOf(s);
      const source = await s.wait(`.nt-row[data-id="part:${indices.patch}"]`);
      const target = await s.wait(`.nt-row[data-id="folder:${COMPONENT}"]`);
      assert.equal(await source.evaluate((el) => el.draggable), true, 'part row uses native HTML drag and drop');
      const a = await source.boundingBox();
      const b = await target.boundingBox();
      assert.ok(a && b, 'both drag rows are visible');
      await s.page.evaluate(() => {
        const trace = [];
        window.__s7DragEvents = trace;
        for (const type of ['dragstart', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend']) {
          document.addEventListener(type, (event) => {
            const row = event.target instanceof Element ? event.target.closest('.nt-row') : null;
            trace.push({ type, target: row?.getAttribute('data-id') ?? null, types: [...(event.dataTransfer?.types ?? [])],
              dropEffect: event.dataTransfer?.dropEffect ?? null, effectAllowed: event.dataTransfer?.effectAllowed ?? null,
              defaultPrevented: event.defaultPrevented });
          });
        }
      });
      await s.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await s.page.mouse.down();
      await s.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
      const targetSelector = `.nt-row[data-id="folder:${COMPONENT}"]`;
      const waitForAcceptedTarget = async () => {
        try {
          await s.page.waitForFunction((selector) => document.querySelector(selector)?.classList.contains('dz-drop') ?? false,
            { timeout: 900 }, targetSelector);
          return true;
        } catch { return false; }
      };
      let accepted = await waitForAcceptedTarget();
      if (!accepted) {
        const x = b.x + b.width / 2, y = b.y + b.height / 2;
        await s.page.mouse.move(x + 3, y + 2, { steps: 2 });
        accepted = await waitForAcceptedTarget();
      }
      const dragTrace = await s.page.evaluate(() => window.__s7DragEvents ?? []);
      assert.ok(accepted, `native dragover marks the folder as an accepted drop target: ${JSON.stringify(dragTrace)}`);
      await s.page.mouse.up();
      try { await waitForComponent(s, indices.patch, COMPONENT); }
      catch (error) {
        const trace = await s.page.evaluate(() => window.__s7DragEvents ?? []);
        throw new Error(`${error.message}; drag event trace: ${JSON.stringify(trace)}`);
      }
      const after = await partsOf(s);
      const expected = structuredClone(before);
      expected[indices.patch].component = COMPONENT;
      assert.deepEqual(after, expected, 'only the component path changed; material, shapes, cuts and transforms match');
    });

    await s.step('the keyboard Move to component menu moves another part without changing geometry', async () => {
      const before = await partsOf(s);
      const row = await s.wait(`.nt-row[data-id="part:${indices.substrate}"]`);
      await row.focus();
      await s.press('F10', ['Shift']);
      await s.wait('.dz-context-menu');
      // Duplicate and Delete follow Move to component in the menu, so pick it by its label, not with End.
      await s.click('contextMenu.moveToComponent', { within: '.dz-context-menu' });
      await s.wait('.dz-context-menu input.dz-menu-new');
      // The moving menu focuses its Back action, then Top level, Assembly and Reference.
      for (let i = 0; i < 3; i++) await s.press('ArrowDown');
      await s.press('Enter');
      await waitForComponent(s, indices.substrate, REFERENCE);
      const after = await partsOf(s);
      const expected = structuredClone(before);
      expected[indices.substrate].component = REFERENCE;
      assert.deepEqual(after, expected, 'keyboard move changes only the folder path');
    });

    await s.step('WCS quarter-turn controls preview and create the expected world-space brick', async () => {
      await s.click('ribbon.tab.model', { sel: '.rb-tab' });
      await openWcsTransform(s);
      const beforeInvalidFrame = await draftOf(s);
      const invalidFrameHistory = await historyAt(s);
      await s.fill(await s.field('u', { within: WCS_DIALOG }), 'S7_UNKNOWN_ORIGIN');
      await s.wait('[role="alert"]', await s.T('wcs.error.value'), { within: WCS_DIALOG });
      const frameOk = await s.wait('button', await s.T('common.ok'), { within: WCS_DIALOG, exact: true });
      assert.equal(await frameOk.evaluate((e) => e.disabled), true, 'an unresolved origin cannot be committed');
      assert.equal(await s.page.$(`${WCS_DIALOG} [role="status"]`), null, 'an invalid frame has no stale result preview');
      await frameOk.click();
      await s.wait(WCS_DIALOG);
      assert.equal(await draftOf(s), beforeInvalidFrame, 'an invalid local frame cannot change the design');
      assert.equal(await historyAt(s), invalidFrameHistory, 'an invalid local frame cannot create an undo entry');
      await s.fill(await s.field('u', { within: WCS_DIALOG }), '10');
      const rotation = await s.field(await s.T('wcs.dialog.about', { axis: 'w' }), { within: WCS_DIALOG });
      await s.fill(rotation, '45');
      await s.wait('[role="alert"]', await s.T('wcs.error.angle'), { within: WCS_DIALOG });
      assert.equal(await frameOk.evaluate((e) => e.disabled), true, 'a non-quarter-turn cannot enter the drawing frame');
      assert.equal(await draftOf(s), beforeInvalidFrame, 'invalid rotation and uncommitted movement leave the draft untouched');
      assert.equal(await historyAt(s), invalidFrameHistory, 'invalid rotation adds no undo entry');
      await s.click('common.cancel', { within: WCS_DIALOG });
      await s.gone(WCS_DIALOG);
      assert.equal(await draftOf(s), beforeInvalidFrame, 'Cancel discards all proposed WCS changes');

      await openWcsTransform(s);
      for (const [axis, value] of [['u', '10'], ['v', '20'], ['w', '0']]) {
        await s.fill(await s.field(axis, { within: WCS_DIALOG }), value);
      }
      await s.fill(await s.field(await s.T('wcs.dialog.about', { axis: 'w' }), { within: WCS_DIALOG }), '90');
      await s.wait('[role="status"]', await s.T('wcs.dialog.preview', { origin: '10, 20, 0', u: '+y', v: '−x', w: '+z' }), { within: WCS_DIALOG });
      assert.equal(await draftOf(s), beforeInvalidFrame, 'the WCS result preview does not edit the design');
      assert.equal(await historyAt(s), invalidFrameHistory, 'the WCS result preview has no undo entry');
      await screenshot(s, 'wcs-frame-1440');
      await s.click('common.ok', { within: WCS_DIALOG });
      await s.gone(WCS_DIALOG);
      assert.equal(await historyAt(s), invalidFrameHistory + 1, 'the WCS transform commits as one undo transaction');
      assert.deepEqual(await s.ev((_, m) => JSON.parse(JSON.stringify(m.d.wcs())), null, { d: '/src/designer/draw.ts' }),
        { normal: 'z', origin: [10, 20, 0], angle: 90 }, 'the committed frame matches its preview');

      await openBoxDialog(s);
      await s.wait('p', await s.T('shape.intro.frameNewPart'), { within: '.sd' });
      for (const [field, value] of [['Umin', '0'], ['Umax', '2'], ['Vmin', '0'], ['Vmax', '4'], ['Wmin', '0'], ['Wmax', '1']]) {
        await s.fill(await s.field(field, { within: '.sd' }), value);
      }
      await s.waitFor(async () => (await import('/src/designer/draw.ts')).ghost() !== null,
        null, { what: 'the frame-aware brick outline' });
      const ghostBounds = await s.ev((_, m) => {
        const shape = m.d.ghost();
        const transforms = m.d.ghostFrameTransforms();
        const design = m.s.draft;
        const candidate = {
          ...design,
          ports: [], resistors: [],
          parts: [{ name: '__frame-preview', material: design.materials[0].name, primitives: [shape], transforms }],
        };
        const bundle = m.g.quickBundle(candidate, m.s.names().names, null);
        return { transforms, bounds: bundle?.parts[0]?.primitives[0]?.bbox ?? null };
      }, null, { s: '/src/designer/store.ts', d: '/src/designer/draw.ts', g: '/src/designer/geometry.ts' });
      assert.deepEqual(ghostBounds.transforms, [
        { type: 'rotate', axis: 'z', center: [0, 0, 0], angle: 90, copies: 0 },
        { type: 'move', offset: [10, 20, 0] },
      ], 'the temporary frame is represented by a pure quarter-turn followed by its global offset');
      assertBounds([ghostBounds.bounds], [[[6, 20, 0], [10, 22, 1]]], 'the live shape outline has the expected world-space bounds');

      await s.click('common.ok', { within: '.sd' });
      await s.gone('.sd');
      const created = await s.ev((_, m) => {
        const part = m.s.draft.parts.at(-1);
        const b = m.g.quickBundle(m.s.draft, m.s.names().names, null);
        return { part: JSON.parse(JSON.stringify(part)), bounds: b?.parts.at(-1)?.primitives[0]?.bbox ?? null };
      }, null, { s: '/src/designer/store.ts', g: '/src/designer/geometry.ts' });
      assert.deepEqual(created.part.transforms, ghostBounds.transforms, 'the committed part stores the exact frame transform');
      assertBounds([created.bounds], [[[6, 20, 0], [10, 22, 1]]], 'the committed geometry matches its preview');

      await clickRibbonAction(s, 'ribbon.wcs.group', 'ribbon.wcs.global');
      assert.equal(await s.ev((_, m) => m.d.localFrameActive(), null, { d: '/src/designer/draw.ts' }), false,
        'Return to global resets the temporary frame for later drawing');
    }, { settle: 500 });

    await s.step('round a real brick outline with its local transforms and one Undo', async () => {
      const before=await draftOf(s), history=await historyAt(s);
      const row=await s.wait(`.nt-row[data-id="part:${indices.patch}"]`);await row.click({button:'right'});
      await s.click('edgeTreatment.title',{sel:'.menu-item'});
      await s.wait('[aria-labelledby="edge-title"]');
      await s.fill(await s.field(await s.T('edgeTreatment.radius'),{within:'[aria-labelledby="edge-title"]'}),'0.25');
      await s.click('common.apply',{within:'[aria-labelledby="edge-title"]'});await s.gone('[aria-labelledby="edge-title"]');
      const rounded=await s.store(({i},m)=>JSON.parse(JSON.stringify(m.s.draft.parts[i])),{i:indices.patch});
      assert.equal(rounded.primitives[0].kind,'linpoly');assert.equal(rounded.primitives[0].points.length,68);
      assert.deepEqual(rounded.transforms,JSON.parse(before).parts[indices.patch].transforms);
      assert.equal(rounded.material,JSON.parse(before).parts[indices.patch].material);
      assert.equal(await historyAt(s),history+1);
      await s.store((_,m)=>m.s.undo());assert.equal(await draftOf(s),before);
    });

    await s.step('create an empty component from its heading and reopen it', async () => {
      const before=await partsOf(s);
      const row=await s.wait('.nt-row[data-id="sec:components"]');
      await row.click({button:'right'});
      await s.click('tree.add.component',{sel:'.menu-item'});
      const input=await s.wait('.nt-rename');await s.fill(input,'Empty RF group');await input.press('Enter');
      await s.wait('.nt-row[data-id="folder:Empty RF group"]');
      assert.deepEqual(await partsOf(s),before,'creating a component never changes geometry/material/transforms');
      assert.ok(await s.store((_,m)=>m.s.draft.components.includes('Empty RF group')));
      await s.click('ribbon.tab.home',{sel:'.rb-tab'});await s.click('common.save',{sel:'.rb-btn'});
      await s.sleep(500);await s.page.reload({waitUntil:'domcontentloaded'});await s.wait('.rb');
      await s.wait('.nt-row[data-id="folder:Empty RF group"]');
      assert.deepEqual(await partsOf(s),before,'empty component survives JSON save/reopen without changing parts');
    });

    await s.step('hide the guide grid independently of ground and snapping, then reload', async () => {
      await saveThroughUi(s);
      const runFile = await copyPatternRun(ctx, designId);
      await s.page.reload({ waitUntil: 'domcontentloaded' });
      await s.wait('.rb');
      await s.wait(`.nt-row[data-id="run:${runFile}"]`);

      await s.click('ribbon.tab.model', { sel: '.rb-tab' });
      await clickRibbonAction(s, 'ribbon.draw.group', 'ribbon.draw.options');
      await s.wait('.rb-pop');
      await s.fill(await s.field(await s.T('draw.wcs.gridSnap'), { within: '.rb-pop' }), '0.5');
      await s.click('common.close', { within: '.rb-pop', exact: true });
      await s.gone('.rb-pop');
      const beforeSnap = await s.ev((_, m) => m.d.snap(), null, { d: '/src/designer/draw.ts' });
      assert.equal(beforeSnap, 0.5, 'the WCS UI set a non-default grid snap');

      const runRow = await s.wait(`.nt-row[data-id="run:${runFile}"]`);
      await runRow.click();
      await s.waitFor(async () => (await import('/src/designer/ribbonResults.ts')).ribbonPattern3d().ok,
        null, { what: 'the run 3D pattern to become available' });
      await s.click('ribbon.tab.post', { sel: '.rb-tab' });
      await s.click('ribbon.post.pattern3d', { sel: '.rb-btn' });
      await s.waitFor(async (filename) => {
        const state = await import('/src/state.ts');
        return state.source() === filename && !!state.bundle()?.half_space;
      }, runFile, { what: 'the result bundle with its ground plane to display' });
      const focusBefore = await s.ev((_, m) => m.r.resultFocus(), null, { r: '/src/designer/resultFocus.ts' });
      assert.equal(focusBefore?.view, 'pattern3d', 'the fixture opens a 3D result focus');

      await s.click('ribbon.tab.view', { sel: '.rb-tab' });
      const layersGroup = `.rb-group[aria-label="${await s.T('model.layers')}"]`;
      await s.click('model.layers', { sel: '.rb-group-toggle', within: layersGroup, exact: true });
      const ground = await s.wait('.rb-btn', await s.T('model.layer.ground'), { within: layersGroup });
      assert.equal(await ground.evaluate((e) => e.disabled), false, 'the result fixture enables the ground layer');
      await ground.click();
      await s.click('model.layer.guideGrid', { sel: '.rb-btn', within: layersGroup, exact: true });
      const switched = await s.ev((_, m) => ({
        focus: m.r.resultFocus(),
        guideGrid: m.state.layers.guideGrid,
        ground: m.state.layers.ground,
        snap: m.d.snap(),
      }), null, { r: '/src/designer/resultFocus.ts', state: '/src/state.ts', d: '/src/designer/draw.ts' });
      assert.deepEqual(switched.focus, focusBefore, 'the View tab and grid toggle preserve the 3D result focus');
      assert.equal(switched.guideGrid, false, 'the guide grid is hidden');
      assert.equal(switched.ground, false, 'toggling the grid leaves the ground setting unchanged');
      assert.equal(switched.snap, 0.5, 'hiding the grid leaves grid snapping unchanged');
      await screenshot(s, 'view-grid-1440');
      const groundAgain = await s.wait('.rb-btn', await s.T('model.layer.ground'), { within: layersGroup });
      await groundAgain.click();
      assert.equal(await s.ev((_, m) => m.state.layers.guideGrid, null, { state: '/src/state.ts' }), false,
        'restoring ground does not restore the guide grid');

      await s.page.reload({ waitUntil: 'domcontentloaded' });
      await s.wait('.rb');
      assert.equal(await s.ev((_, m) => m.state.layers.guideGrid, null, { state: '/src/state.ts' }), false,
        'the hidden guide-grid preference survives a full page reload');
      await s.wait(`.nt-row[data-id="run:${runFile}"]`);
      await (await s.wait(`.nt-row[data-id="run:${runFile}"]`)).click();
      await s.waitFor(async () => (await import('/src/designer/ribbonResults.ts')).ribbonPattern3d().ok,
        null, { what: 'the 3D result to reload' });
      await s.click('ribbon.tab.post', { sel: '.rb-tab' });
      await s.click('ribbon.post.pattern3d', { sel: '.rb-btn' });
      assert.equal(await s.ev((_, m) => m.r.resultFocus()?.view, null, { r: '/src/designer/resultFocus.ts' }), 'pattern3d',
        'the 3D result can be focused again after reload while the grid stays hidden');
      await s.click('ribbon.tab.view', { sel: '.rb-tab' });
      assert.equal(await s.ev((_, m) => m.r.resultFocus()?.view, null, { r: '/src/designer/resultFocus.ts' }), 'pattern3d',
        'opening View at compact width keeps the 3D result focused');
      await s.page.setViewport({ width: 768, height: 900 });
      await s.sleep(250);
      const compactHeader = await s.page.evaluate(() => {
        const secondary = document.querySelector('.header-secondary');
        const more = document.querySelector('.header-more-trigger');
        const rect = more?.getBoundingClientRect();
        return {
          secondaryDisplay: secondary ? getComputedStyle(secondary).display : null,
          moreVisible: !!more && getComputedStyle(more).display !== 'none' && !!rect && rect.width > 0 && rect.height > 0,
        };
      });
      assert.equal(compactHeader.secondaryDisplay, 'none', 'the secondary app header collapses at 768px');
      assert.equal(compactHeader.moreVisible, true, 'the app header More control remains visible at 768px');
      await screenshot(s, 'view-grid-768');
    }, { settle: 700 });
  },
};
