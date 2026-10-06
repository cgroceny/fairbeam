// Focused browser regression for FigureMenu's async export snapshot, duplicate guard and retry.
// Uses the normal Vite/run-server scenario stack over its temporary public-project copy. Downloads
// are intercepted at the anchor boundary inside this browser page, so no file reaches disk.
//
//   node scripts/check-figure-export.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromePath, startStack } from './scenarios/stack.mjs';

const require = createRequire(import.meta.url);
const withTimeout = async (promise, ms, what) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
};

let stack, browser, page, releaseLazy;
try {
  const modulePath = process.env.FAIRBEAM_PUPPETEER
    ? process.env.FAIRBEAM_PUPPETEER
    : require.resolve('puppeteer-core');
  const puppeteerModule = await import(pathToFileURL(modulePath).href);
  const puppeteer = puppeteerModule.default ?? puppeteerModule;
  stack = await startStack({ log: (line) => console.log(line) });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(), args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  console.log('Browser started; loading the temporary result fixture.');
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  let resolveChartImport;
  const chartImportHeldPromise = new Promise((resolve) => { resolveChartImport = resolve; });
  let chartImportSeen = false;
  let releaseGate;
  const lazyGate = new Promise((resolve) => { releaseGate = resolve; });
  releaseLazy = releaseGate;
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/src/drawing/charts.ts') && !chartImportSeen) {
      chartImportSeen = true;
      resolveChartImport();
      void lazyGate.then(() => request.continue()).catch(() => {
        if (!request.isInterceptResolutionHandled()) void request.abort().catch(() => {});
      });
    } else void request.continue();
  });

  await page.goto(stack.url, { waitUntil: 'networkidle0', timeout: 90000 });
  const loaded = await page.evaluate(async (file) => {
    const state = await import('/src/state.ts');
    const workspace = await import('/src/workspace.ts');
    const ok = await state.loadProject(file);
    workspace.setAppMode('results');
    if (ok) window.__figureFixtureA = JSON.parse(JSON.stringify(state.bundle()));
    return ok;
  }, 'patch-antenna.json');
  assert.equal(loaded, true, 'patch result fixture loads');
  await page.waitForSelector('.figure-menu > button:not([disabled])');
  console.log('Result fixture mounted; preparing the intercepted download.');

  await page.evaluate(() => {
    window.__figureDownloads = [];
    window.__figureAttempts = [];
    window.__failNextFigureDownload = false;
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download) return;
      const record = { name: this.download, href: this.href, text: null, failed: false };
      window.__figureAttempts.push(record);
      if (window.__failNextFigureDownload) {
        window.__failNextFigureDownload = false;
        record.failed = true;
        throw new Error('fixture download failure');
      }
      window.__figureDownloads.push(record);
      void fetch(this.href).then((response) => response.text()).then((text) => { record.text = text; });
    };
  });

  await page.click('.figure-menu > button');
  await page.waitForSelector('.figure-menu [role="menu"]');
  console.log('Figure menu opened.');
  await page.$$eval('.figure-menu [role="menuitemradio"]', (items) => items[1].click()); // wide SVG
  await page.click('.figure-menu [role="menuitem"]'); // |S11|, triggering the first lazy imports
  console.log('Figure export clicked; waiting for the chart-import gate.');
  await withTimeout(chartImportHeldPromise, 15000, 'first chart import');
  assert.equal(chartImportSeen, true, 'first export actually requested the lazy charts module');
  assert.equal(await page.$eval('.figure-menu > button', (button) => button.getAttribute('aria-disabled')), 'true', 'export trigger marks the active save');

  const switched = await page.evaluate(async (file) => {
    const state = await import('/src/state.ts');
    const ok = await state.loadProject(file);
    if (ok) window.__figureFixtureB = JSON.parse(JSON.stringify(state.bundle()));
    return ok;
  }, 'dipole.json');
  assert.equal(switched, true, 'second result fixture opens during the deferred import');
  assert.equal(await page.evaluate(() => window.__figureDownloads.length), 0, 'no download occurs before imports resolve');
  await page.click('.figure-menu > button'); // repeated action while saving must be ignored
  assert.equal(await page.$('.figure-menu [role="menu"]'), null, 'busy trigger cannot reopen a second export menu');
  assert.equal(await page.evaluate(() => window.__figureAttempts.length), 0, 'busy click does not start another download');
  const settingsButton = 'button[aria-label="General settings"]';
  await page.$eval(settingsButton, (button) => button.focus());
  assert.equal(await page.$eval(settingsButton, (button) => document.activeElement === button), true, 'unrelated control can receive focus before completion');

  releaseLazy();
  releaseLazy = undefined;
  await page.waitForFunction(() => window.__figureDownloads.length === 1 && window.__figureDownloads[0].text !== null);
  const first = await page.evaluate(() => window.__figureDownloads[0]);
  const expected = await page.evaluate(async () => {
    const charts = await import('/src/drawing/charts.ts');
    return {
      a: charts.s11Figure(window.__figureFixtureA, { widthMm: 180 }),
      b: charts.s11Figure(window.__figureFixtureB, { widthMm: 180 }),
    };
  });
  assert.ok(expected.a && expected.b && expected.a !== expected.b, 'fixture figures distinguish source bundles');
  assert.equal(first.name, 'patch-antenna_s11_wide.svg', 'filename snapshots the source and selected width');
  assert.equal(first.text, expected.a, 'exported SVG content stays on the clicked source bundle');
  assert.notEqual(first.text, expected.b, 'export content did not switch to the new active result');
  assert.equal(await page.$eval(settingsButton, (button) => document.activeElement === button), true, 'completion leaves unrelated focus where the user moved it');
  console.log('PASS deferred export uses the clicked bundle and one wide filename despite a busy repeat click');

  await page.evaluate(() => { window.__failNextFigureDownload = true; });
  await page.click('.figure-menu > button');
  await page.waitForSelector('.figure-menu [role="menu"]');
  await page.click('.figure-menu [role="menuitem"]');
  await page.waitForFunction(() => {
    const status = document.querySelector('.figure-menu [role="status"]');
    return status && !status.hidden && status.textContent.includes('fixture download failure');
  });
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.figure-menu > button')), true, 'failed export leaves focus on the trigger');
  assert.equal(await page.$eval('.figure-menu > button', (button) => button.getAttribute('aria-disabled')), 'false', 'failure clears the busy state');

  await page.click('.figure-menu > button');
  await page.waitForSelector('.figure-menu [role="menu"]');
  await page.click('.figure-menu [role="menuitem"]');
  await page.waitForFunction(() => window.__figureDownloads.length === 2 && window.__figureDownloads[1].text !== null);
  const retry = await page.evaluate(() => window.__figureDownloads[1]);
  assert.equal(retry.name, 'dipole_s11_wide.svg', 'retry uses the currently active result');
  assert.equal(retry.text, expected.b, 'retry exports the current result after failure');
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.figure-menu > button')), true, 'retry completion does not steal focus');
  assert.equal(await page.evaluate(() => window.__figureAttempts.length), 3, 'one initial save, one failed attempt and one retry were issued');
  console.log('PASS export failure is announced, clears busy state and can be retried without moving focus');

  await page.evaluate(async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('fixture clipboard failure'); } } });
    const state = await import('/src/state.ts');
    state.setExportOpen(true);
  });
  await page.waitForSelector('.dialog[role="dialog"]');
  await page.click('.dialog-actions .btn-ghost');
  await page.waitForFunction(() => document.querySelector('.dialog [role="status"]')?.textContent.includes('Could not copy to the clipboard'));
  assert.equal(await page.$eval('.dialog-actions .btn-primary', (button) => button.disabled), false, 'Download remains enabled after clipboard rejection');
  await page.click('.dialog-actions .btn-primary');
  await page.waitForFunction(() => window.__figureDownloads.length === 3 && window.__figureDownloads[2].text !== null);
  const fallback = await page.evaluate(() => window.__figureDownloads[2]);
  assert.equal(fallback.name, 'dipole.bas', 'clipboard recovery can use the macro download');
  assert.ok(fallback.text.length > 500, 'macro content reached the intercepted download');
  console.log('PASS clipboard failure is announced and the .bas download recovery remains usable');

  if (pageErrors.length) throw new Error(`Browser page errors:\n${pageErrors.join('\n')}`);
  console.log('Figure export browser check passed.');
} finally {
  releaseLazy?.();
  await browser?.close();
  await stack?.stop();
}
