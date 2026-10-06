// Real EN/TR browser regression for the camera presets and their focus guards.
// No solver runs; the app and API use the isolated scenario stack.
//
//   node scripts/check-camera-views.mjs
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startStack, chromePath, root } from './scenarios/stack.mjs';

const VIEWS = [
  { id: 'iso', label: 'viewport.btn.iso', shortcut: '0', key: '0', numpadKey: 'Insert' },
  { id: 'top', label: 'viewport.view.top', shortcut: '8', key: '8', numpadKey: 'ArrowUp' },
  { id: 'front', label: 'viewport.view.front', shortcut: '5', key: '5', numpadKey: 'Clear' },
  { id: 'right', label: 'viewport.view.right', shortcut: '6', key: '6', numpadKey: 'ArrowRight' },
  { id: 'bottom', label: 'viewport.view.bottom', shortcut: '2', key: '2', numpadKey: 'ArrowDown' },
  { id: 'back', label: 'viewport.view.back', shortcut: '3', key: '3', numpadKey: 'PageDown' },
  { id: 'left', label: 'viewport.view.left', shortcut: '4', key: '4', numpadKey: 'ArrowLeft' },
];
const DIRECTIONS = {
  iso: [1, -1.25, 0.85], top: [0, -0.0001, 1], bottom: [0, 0.0001, -1],
  front: [0, -1, 0.0001], back: [0, 1, 0.0001], right: [1, 0, 0.0001], left: [-1, 0, 0.0001],
};

let stack;
let browser;

async function buttonHandle(page, label, scope = '') {
  const selector = `${scope} button`;
  await page.waitForFunction(({ selector, label }) => [...document.querySelectorAll(selector)].some((e) =>
    e.getAttribute('aria-label') === label || e.textContent.trim() === label), { timeout: 10000 }, { selector, label });
  const handle = await page.evaluateHandle(({ selector, label }) => [...document.querySelectorAll(selector)].find((e) =>
    e.getAttribute('aria-label') === label || e.textContent.trim() === label) ?? null, { selector, label });
  const element = handle.asElement();
  assert.ok(element, `button "${label}" exists in ${scope || 'the page'}`);
  return { handle, element };
}

async function clickButton(page, label, scope = '') {
  const { handle, element } = await buttonHandle(page, label, scope);
  await element.click();
  await handle.dispose();
}

async function selectRibbonTab(page, tab) {
  await page.click(`#rb-tab-${tab}`);
  await page.waitForFunction((id) => document.querySelector(`#rb-tab-${id}`)?.getAttribute('aria-selected') === 'true', {}, tab);
}

async function groupButton(page, groupLabel, itemLabel) {
  const group = await page.evaluateHandle(({ groupLabel }) => [...document.querySelectorAll('.rb-group[role="group"]')]
    .find((e) => e.getAttribute('aria-label') === groupLabel) ?? null, { groupLabel });
  const groupElement = group.asElement();
  assert.ok(groupElement, `ribbon group "${groupLabel}" exists`);
  const collapsed = await groupElement.evaluate((e) => e.dataset.collapsed !== undefined && e.dataset.open === undefined);
  if (collapsed) await groupElement.$eval('.rb-group-toggle', (e) => e.click());
  await page.waitForFunction(({ groupLabel, itemLabel }) => {
    const g = [...document.querySelectorAll('.rb-group[role="group"]')].find((e) => e.getAttribute('aria-label') === groupLabel);
    const button = [...(g?.querySelectorAll('.rb-items button') ?? [])].find((e) => e.getAttribute('aria-label') === itemLabel);
    return !!button?.getClientRects().length;
  }, {}, { groupLabel, itemLabel });
  const item = await groupElement.evaluateHandle((g, label) => [...g.querySelectorAll('.rb-items button')]
    .find((e) => e.getAttribute('aria-label') === label) ?? null, itemLabel);
  const element = item.asElement();
  assert.ok(element, `ribbon item "${itemLabel}" exists`);
  await group.dispose();
  return { handle: item, element };
}

async function clickRibbonItem(page, translations, groupKey, itemKey) {
  const { handle, element } = await groupButton(page, translations[groupKey], translations[itemKey]);
  await element.click();
  await handle.dispose();
}

async function activeView(page) {
  return page.$eval('.vp-hud-tl', (root) => root.querySelector('.seg-btn[aria-pressed="true"]')?.textContent.trim() ?? null);
}

async function cameraSnapshot(page) {
  return page.evaluate(() => {
    const debug = window.__fairbeam;
    const { camera, controls } = debug;
    const target = controls.target.toArray();
    const position = camera.position.toArray();
    return { target, position, distance: camera.position.distanceTo(controls.target) };
  });
}

async function seedCamera(page, target = [2.3, -4.7, 1.2], direction = [0.37, -0.81, 0.45], distance = 18.75) {
  await page.evaluate(({ target, direction, distance }) => {
    const { camera, controls } = window.__fairbeam;
    const length = Math.hypot(...direction);
    controls.target.set(...target);
    camera.up.set(0, 0, 1);
    camera.position.set(
      target[0] + direction[0] / length * distance,
      target[1] + direction[1] / length * distance,
      target[2] + direction[2] / length * distance,
    );
    camera.lookAt(controls.target);
    controls.update();
  }, { target, direction, distance });
}

function assertPosePreserved(before, after, message) {
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(before.target[i] - after.target[i]) < 1e-6, `${message}: target[${i}] preserved`);
  assert.ok(Math.abs(before.distance - after.distance) < 1e-5, `${message}: camera distance preserved`);
}

function assertViewDirection(snapshot, viewId, message) {
  const direction = snapshot.position.map((value, i) => value - snapshot.target[i]);
  const length = Math.hypot(...direction);
  const expected = DIRECTIONS[viewId];
  const expectedLength = Math.hypot(...expected);
  const dot = direction.reduce((sum, value, i) => sum + value / length * expected[i] / expectedLength, 0);
  assert.ok(dot > 0.99999, `${message}: camera points along ${viewId} (dot ${dot})`);
}

async function sendNumpadOff(page, view, translations) {
  const event = await page.$eval('.viewport', (host, { key, code }) => {
    const e = new KeyboardEvent('keydown', { key, code, location: 3, bubbles: true, cancelable: true });
    host.dispatchEvent(e);
    return { prevented: e.defaultPrevented, code: e.code, key: e.key };
  }, { key: view.numpadKey, code: `Numpad${view.shortcut}` });
  assert.equal(event.prevented, true, `Numpad${view.shortcut} (${view.numpadKey}, Num Lock off) is handled`);
  await page.waitForFunction((label) => [...document.querySelectorAll('.vp-hud-tl .seg-btn')].some((e) =>
    e.getAttribute('aria-pressed') === 'true' && e.textContent.trim() === label), {}, translations[view.label]);
}

async function sendTopRow(page, view, translations) {
  await page.focus('.viewport');
  await page.keyboard.press(view.key);
  await page.waitForFunction((label) => [...document.querySelectorAll('.vp-hud-tl .seg-btn')].some((e) =>
    e.getAttribute('aria-pressed') === 'true' && e.textContent.trim() === label), {}, translations[view.label]);
}

async function checkUniqueIcons(page, translations, language) {
  for (const [scope, labels] of [
    ['ribbon', VIEWS.map((view) => translations[view.label])],
    ['hud', VIEWS.map((view) => translations[view.label])],
  ]) {
    const items = await page.evaluate(({ scope, labels, viewGroup }) => {
      if (scope === 'hud') return [...document.querySelectorAll('.vp-hud-tl .seg-btn')].map((button) => ({
        label: button.textContent.trim(), title: button.title, svg: button.querySelector('svg')?.outerHTML,
      }));
      const group = [...document.querySelectorAll('.rb-group[role="group"]')].find((e) => e.getAttribute('aria-label') === viewGroup);
      return [...(group?.querySelectorAll('.rb-items button') ?? [])]
        .filter((button) => labels.includes(button.getAttribute('aria-label')))
        .map((button) => ({ label: button.getAttribute('aria-label'), title: button.title, svg: button.querySelector('svg')?.outerHTML }));
    }, { scope, labels, viewGroup: translations['ribbon.home.view'] });
    assert.equal(items.length, 7, `${language}: seven ${scope} camera view buttons render`);
    assert.equal(new Set(items.map((item) => item.svg)).size, 7, `${language}: all seven ${scope} camera view icons are distinct SVGs`);
    for (const view of VIEWS) {
      const item = items.find((candidate) => candidate.label === translations[view.label]);
      assert.ok(item?.svg?.includes('viewBox="0 0 24 24"'), `${language}: ${view.id} has a 24 × 24 SVG glyph`);
      assert.ok(item.title.includes(`(${view.shortcut})`), `${language}: ${view.id} tooltip shows shortcut ${view.shortcut}`);
      assert.ok(!item.title.includes('viewport.'), `${language}: ${view.id} tooltip is translated`);
    }
  }
}

async function createBox(page, translations) {
  await selectRibbonTab(page, 'model');
  await clickRibbonItem(page, translations, 'ribbon.shapes.group', 'ribbon.shapes.box');
  await page.waitForSelector('.sd');
  await clickButton(page, translations['common.ok'], '.sd');
  await page.waitForSelector('.sd', { hidden: true });
  await page.waitForFunction(() => !!window.__fairbeam?.camera && document.querySelector('.viewport canvas.vp-canvas'));
}

try {
  for (const language of ['en', 'tr']) {
    let context;
    try {
    const translations = JSON.parse(await readFile(new URL(`../src/i18n/${language}.json`, import.meta.url), 'utf8'));
    if (!browser) {
      stack = await startStack({ log: console.log, niceSolver: false });
      browser = await puppeteer.launch({ executablePath: await chromePath(), headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
    }
    context = await browser.createBrowserContext();
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await page.setViewport({ width: 1024, height: 768 });
    await page.evaluateOnNewDocument((lang) => localStorage.setItem('fairbeam.generalSettings', JSON.stringify({ language: lang })), language);
    await page.goto(stack.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.home form input[type=text]');
    const name = await page.$('.home form input[type=text]');
    await name.click({ clickCount: 3 });
    await page.keyboard.type(`Camera views ${language}`);
    await clickButton(page, translations['home.newProject.create'], '.home');
    await page.waitForSelector('.viewport canvas.vp-canvas');
    await createBox(page, translations);

    await selectRibbonTab(page, 'home');
    await checkUniqueIcons(page, translations, language);
    const previewItem = await groupButton(page, translations['ribbon.home.view'], translations['viewport.btn.iso']);
    await previewItem.handle.dispose();
    const previewDir = resolve(root, '..', '..', 'outputs', 'fairbeam-camera-preview');
    await mkdir(previewDir, { recursive: true });
    await page.screenshot({ path: resolve(previewDir, `${language}.png`) });

    // Top-row digit aliases use the corresponding Digit code and preserve a non-origin target
    // plus the camera's current zoom on every view change.
    for (const view of VIEWS) {
      await seedCamera(page);
      const before = await cameraSnapshot(page);
      await sendTopRow(page, view, translations);
      const after = await cameraSnapshot(page);
      assertPosePreserved(before, after, `${language}: Digit${view.shortcut} selects ${view.id}`);
      assertViewDirection(after, view.id, `${language}: Digit${view.shortcut}`);
    }

    // 1 means nearest axis. Try all three dominant axes so the shortcut is proven to derive its
    // result from the current free orbit, then cover every physical numpad code with Num Lock off.
    for (const [direction, nearest] of [
      [[5, 1, 2], 'right'],
      [[0.4, -0.8, 1.3], 'top'],
      [[0.2, -3, 0.4], 'front'],
    ]) {
      await seedCamera(page, [2.3, -4.7, 1.2], direction);
      const before = await cameraSnapshot(page);
      const nearestView = VIEWS.find((view) => view.id === nearest);
      await sendTopRow(page, { ...nearestView, key: '1', shortcut: '1' }, translations);
      const after = await cameraSnapshot(page);
      assertPosePreserved(before, after, `${language}: Digit1 chooses nearest ${nearest}`);
      assertViewDirection(after, nearest, `${language}: Digit1 nearest`);
    }
    for (const view of VIEWS) {
      await seedCamera(page);
      const before = await cameraSnapshot(page);
      await sendNumpadOff(page, view, translations);
      const after = await cameraSnapshot(page);
      assertPosePreserved(before, after, `${language}: Numpad${view.shortcut} selects ${view.id}`);
      assertViewDirection(after, view.id, `${language}: Numpad${view.shortcut}`);
    }
    for (const [direction, nearest] of [
      [[5, 1, 2], 'right'],
      [[0.4, -0.8, 1.3], 'top'],
      [[0.2, -3, 0.4], 'front'],
    ]) {
      await seedCamera(page, [2.3, -4.7, 1.2], direction);
      const before = await cameraSnapshot(page);
      const event = await page.$eval('.viewport', (host, { key, code }) => {
        const e = new KeyboardEvent('keydown', { key, code, location: 3, bubbles: true, cancelable: true });
        host.dispatchEvent(e);
        return { prevented: e.defaultPrevented, code, key };
      }, { key: 'End', code: 'Numpad1' });
      assert.equal(event.prevented, true, `${language}: Numpad1 with Num Lock off is handled`);
      await page.waitForFunction((label) => [...document.querySelectorAll('.vp-hud-tl .seg-btn')].some((e) =>
        e.getAttribute('aria-pressed') === 'true' && e.textContent.trim() === label), {}, translations[VIEWS.find((view) => view.id === nearest).label]);
      const after = await cameraSnapshot(page);
      assertPosePreserved(before, after, `${language}: Numpad1 chooses nearest ${nearest}`);
      assertViewDirection(after, nearest, `${language}: Numpad1 nearest`);
    }

    // Camera controls remain usable from keyboard focus inside the viewport HUD and from the ribbon.
    const topLabel = translations['viewport.view.top'];
    const hudTop = await buttonHandle(page, topLabel, '.vp-hud-tl');
    await hudTop.element.focus();
    assert.equal(await page.evaluate(() => document.activeElement?.closest('.vp-hud-tl') !== null), true, `${language}: HUD view button takes focus`);
    await page.keyboard.press('4');
    assert.equal(await activeView(page), translations['viewport.view.left'], `${language}: Digit4 works while HUD button has focus`);
    await hudTop.handle.dispose();

    await selectRibbonTab(page, 'home');
    const ribbonFront = await groupButton(page, translations['ribbon.home.view'], translations['viewport.view.front']);
    await ribbonFront.element.click();
    assert.equal(await activeView(page), translations['viewport.view.front'], `${language}: ribbon Front button selects its view`);
    await ribbonFront.handle.dispose();
    const ribbonFocus = await groupButton(page, translations['ribbon.home.view'], translations['viewport.view.front']);
    await ribbonFocus.element.focus();
    assert.equal(await page.evaluate(() => document.activeElement?.closest('.rb-group')?.getAttribute('aria-label')), translations['ribbon.home.view'], `${language}: ribbon camera button takes focus`);
    await page.keyboard.press('6');
    assert.equal(await activeView(page), translations['viewport.view.right'], `${language}: Digit6 works while ribbon camera button has focus`);
    await ribbonFocus.handle.dispose();

    // A modeless shape dialog permits typed digits in its text and expression fields; neither field
    // should be converted into a camera command.
    await selectRibbonTab(page, 'model');
    await clickRibbonItem(page, translations, 'ribbon.shapes.group', 'ribbon.shapes.box');
    await page.waitForSelector('.sd');
    await page.waitForFunction(() => !!document.querySelector('.sd input[type=text]') && !!document.querySelector('.sd-geom input'));
    const cameraBeforeFields = await activeView(page);
    const text = await page.$('.sd input[type=text]');
    await text.focus();
    await page.keyboard.press('End');
    await page.keyboard.press('8');
    assert.equal(await text.evaluate((e) => e.value.endsWith('8')), true, `${language}: Digit8 types into the shape name field`);
    const numeric = await page.$('.sd-geom input');
    const numberBefore = await numeric.evaluate((e) => e.value);
    await numeric.focus();
    await page.keyboard.press('End');
    await page.keyboard.press('8');
    assert.notEqual(await numeric.evaluate((e) => e.value), numberBefore, `${language}: Digit8 types into a shape expression field`);
    assert.equal(await activeView(page), cameraBeforeFields, `${language}: text and number fields keep camera shortcuts`);
    await clickButton(page, translations['common.cancel'], '.sd');
    await page.waitForSelector('.sd', { hidden: true });

    // Modal dialogs suppress camera shortcuts even when focus is on the dialog itself.
    await selectRibbonTab(page, 'home');
    await clickRibbonItem(page, translations, 'ribbon.home.project', 'ribbon.home.shortcuts');
    await page.waitForSelector('.shortcut-help-dialog');
    const cameraBeforeDialog = await activeView(page);
    await page.keyboard.press('2');
    assert.equal(await activeView(page), cameraBeforeDialog, `${language}: modal dialog keeps Digit2`);
    await clickButton(page, translations['shortcuts.dialog.done'], '.shortcut-help-dialog');
    await page.waitForSelector('.shortcut-help-dialog', { hidden: true });

    // Drawing tools own the digit stream while active.
    await selectRibbonTab(page, 'model');
    await clickRibbonItem(page, translations, 'ribbon.draw.group', 'ribbon.shapes.box');
    await page.waitForFunction((label) => [...document.querySelectorAll('.rb-group[role="group"] button[aria-pressed="true"]')]
      .some((e) => e.getAttribute('aria-label') === label), {}, translations['ribbon.shapes.box']);
    const cameraBeforeDraw = await activeView(page);
    await page.focus('.viewport');
    await page.keyboard.press('2');
    assert.equal(await activeView(page), cameraBeforeDraw, `${language}: active drawing tool keeps Digit2`);
    await clickRibbonItem(page, translations, 'ribbon.draw.group', 'ribbon.shapes.box');
    await page.waitForFunction((label) => [...document.querySelectorAll('.rb-group[role="group"] button')]
      .some((e) => e.getAttribute('aria-label') === label && e.getAttribute('aria-pressed') === 'false'), {}, translations['ribbon.shapes.box']);

    // Dragging creates a free orbit, which clears the selected preset. Fit recentres the design
    // while preserving that orbit direction.
    await page.focus('.viewport');
    await page.keyboard.press('0');
    assert.equal(await activeView(page), translations['viewport.btn.iso'], `${language}: setup isometric view`);
    const canvas = await page.$('.viewport canvas.vp-canvas');
    const rect = await canvas.boundingBox();
    assert.ok(rect, `${language}: viewport canvas is visible`);
    await page.mouse.move(rect.x + rect.width * 0.54, rect.y + rect.height * 0.56);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width * 0.61, rect.y + rect.height * 0.61, { steps: 6 });
    await page.mouse.up();
    assert.equal(await activeView(page), null, `${language}: orbit clears the selected camera preset`);
    const beforeFit = await cameraSnapshot(page);
    const directionBeforeFit = beforeFit.position.map((value, i) => value - beforeFit.target[i]);
    const directionLength = Math.hypot(...directionBeforeFit);
    const fit = await page.$('.vp-hud-tl [data-action="fit"]');
    await fit.click();
    await fit.dispose();
    const afterFit = await cameraSnapshot(page);
    const directionAfterFit = afterFit.position.map((value, i) => value - afterFit.target[i]);
    const directionLengthAfter = Math.hypot(...directionAfterFit);
    const dot = directionBeforeFit.reduce((sum, value, i) => sum + value / directionLength * directionAfterFit[i] / directionLengthAfter, 0);
    assert.ok(dot > 0.999, `${language}: Fit preserves the free orbit direction`);
    assert.equal(await activeView(page), null, `${language}: Fit does not select a camera preset`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${language}: camera controls fit the workspace`);

      await context.close();
      context = undefined;
      console.log(`PASS ${language}: unique ribbon/HUD glyphs, Digit and Num Lock off views, focus, input/drawing guards, free orbit and Fit`);
    } finally {
      await context?.close();
    }
  }
} finally {
  await browser?.close();
  await stack?.stop();
}
console.log('check-camera-views: English and Turkish passed');
