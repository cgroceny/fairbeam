// Synthetic history rendered through the actual Designer sweep tree. No solver is started.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { chromePath, startStack } from './scenarios/stack.mjs';
import { withStartupDiagnostics } from './scenarios/startup-diagnostics.mjs';
if (process.env.CI !== 'true' && process.env.FAIRBEAM_ALLOW_LOCAL_BROWSER !== '1') throw new Error('Local browser requires root scheduling.');
const out = join(process.env.FAIRBEAM_TEST_ARTIFACTS || 'fairbeam-scenario-failures', 'sweep-trend');
mkdirSync(out, { recursive: true });
let stack, browser, page;
const errors = [], forbidden = [];
try {
  stack = await startStack({ log: console.log, niceSolver: false });
  browser = await puppeteer.launch({ headless: true, executablePath: await chromePath(), args: ['--no-sandbox', '--mute-audio', '--enable-unsafe-swiftshader'] });
  for (const lang of ['en', 'tr']) {
    const context = await browser.createBrowserContext(); page = await context.newPage();
    let history = [];
    page.on('pageerror', e => errors.push(String(e.stack || e)));
    await page.setRequestInterception(true);
    page.on('request', r => {
      const path = new URL(r.url()).pathname;
      if (r.method() === 'POST' && /^\/api\/(runs|sweeps|convergence|optimizations|research\/runs|render-jobs|native-document)(\/|$)/.test(path)) {
        forbidden.push(path); void r.abort();
      } else if (r.method() === 'GET' && path === '/api/runs') void r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: history }) });
      else void r.continue();
    });
    await page.setViewport({ width: lang === 'en' ? 1440 : 760, height: 1000 });
    await page.evaluateOnNewDocument(lang => localStorage.setItem('fairbeam.generalSettings', JSON.stringify({ language: lang })), lang);
    await withStartupDiagnostics(page, { directory: join(out, `startup-${lang}`), stack }, async () => {
      await page.goto(stack.url, { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.home');
    });
    history = await page.evaluate(async lang => {
      const design = await import('/src/designer/store.ts');
      await design.createDesign({ id: `trend_${lang}`, name: 'Synthetic trend', template: 'dipole' });
      const f = design.file();
      const rows = [10, 20].flatMap(y => [1, 2, 3, 4].map(x => ({
        id: `trend-${y}-${x}`, kind: 'run', label: null, model: f.id, model_id: f.design.model.id,
        params: {}, overrides: {}, threads: 1, name: null, status: x === 3 ? 'failed' : 'done', phase: x === 3 ? 'failed' : 'done',
        created: x, started: x, finished: x + 1, created_iso: null, duration_s: 1, exit_code: x === 3 ? 1 : 0,
        bundle: null, error: x === 3 ? 'Synthetic failure' : null, end_criteria_db: -30, engine: 'cpu', last_progress: null, info: {},
        sweep: { id: 'synthetic-trend', name: 'Synthetic trend', index: x + y, total: 8, sequence_index: 0, sequence_name: 'A',
          axes: [{ key: 'length', values: [1, 2, 3, 4] }, { key: 'width', values: [10, 20] }], values: { length: x, width: y } },
        stats: { converged: true, bands: x === 2 ? [{ f_center_ghz: 5, s11_min_db: -30 }, { f_center_ghz: 2.2, s11_min_db: -20 }]
          : [{ f_center_ghz: 2 + .1 * x, s11_min_db: -20 }], farfield: [{ f_ghz: 2 + .1 * x + .01, dmax_dbi: 3 + x, rad_efficiency: .8 }] }
      })));
      (await import('/src/runner/store.ts')).setJobs(rows);
      // Capture generated download bytes while exercising the real export button and saveDownload.
      window.__trendDownloads = [];
      document.addEventListener('click', e => { const a = e.target.closest?.('a[download]'); if (a) {
        e.preventDefault(); void fetch(a.href).then(r => r.blob()).then(async blob => window.__trendDownloads.push({ name: a.download, type: blob.type, size: blob.size, text: blob.type.includes('png') ? null : await blob.text() }));
      } }, true);
      return rows;
    }, lang);
    if (await page.$('[data-layout-focus="tree-strip"]')) await page.click('[data-layout-focus="tree-strip"]');
    await page.waitForSelector('[data-id="sec:results"]', { visible: true });
    if (!await page.$('[data-id="sweep:synthetic-trend"]')) await page.click('[data-id="sec:results"]');
    await page.waitForSelector('[data-id="sweep:synthetic-trend"]');
    await page.click('[data-id="sweep:synthetic-trend"]');
    await page.click('[data-id="sweep:synthetic-trend"]');
    await page.waitForSelector('[data-trend-table]');
    assert.equal(await page.$$eval('[data-trend-table] tbody tr', rows => rows.length), 8);
    assert.equal(await page.$eval('[data-trend-reference]', el => el.value), '2.1');
    await page.$eval('[data-trend-window]', el => { el.value = '500'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForSelector('.sweep-trend-chart svg');
    assert.equal(await page.$$eval('.sweep-trend-chart .legend-item', els => els.length), 2, 'sample dots do not duplicate legends');
    assert.ok(await page.$$eval('.sweep-trend-chart .c-line', els => els.every(el => (el.getAttribute('d').match(/M/g) || []).length === 2)), 'SVG path breaks at failed x=3');
    const rows = await page.$$eval('[data-trend-table] tbody tr', rows => rows.map(r => [...r.cells].map(c => c.textContent)));
    assert.equal(rows[1][3], lang === 'tr' ? '2,200000' : '2.200000');
    assert.equal(rows[2][3], '—'); assert.equal(rows[3][4], '—');
    const rect = await page.$eval('.sweep-trend-chart', el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }));
    assert.ok(rect.width > 250 && rect.height > 200);
    await page.click('[data-trend-csv]');
    await page.waitForFunction(() => window.__trendDownloads.length === 1);
    const csv = await page.evaluate(() => window.__trendDownloads[0]);
    assert.equal(csv.name, 'Synthetic-trend-trend.csv');
    assert.ok(csv.text.includes('trend-10-2,done,frequency,GHz,2.2,0.10000000000000009,2.2,,ok,true,false,2.1,500'));
    writeFileSync(join(out, `${lang}.csv`), csv.text);
    for (const format of ['SVG', 'PNG']) {
      await page.click(`[data-trend-figure="${format.toLowerCase()}"]`);
      await page.waitForFunction(n => window.__trendDownloads.length === n, {}, format === 'SVG' ? 2 : 3);
    }
    const downloads = await page.evaluate(() => window.__trendDownloads);
    assert.ok(downloads[1].text.includes('<svg')); assert.ok(downloads[2].size > 1000);
    writeFileSync(join(out, `${lang}.svg`), downloads[1].text);
    await page.select('[data-trend-metric]', 'directivity');
    assert.equal(await page.$eval('[data-trend-table] tbody tr td:nth-child(7)', e => e.textContent), lang === 'tr' ? '2,110000' : '2.110000');
    await page.screenshot({ path: join(out, `${lang}.png`) });
    await page.focus('[data-trend-reference]'); await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace');
    await page.waitForSelector('.sweep-trend [role="alert"]');
    assert.equal(await page.$('[data-trend-csv]'), null, 'invalid inputs cannot export stale data');
    await page.keyboard.type('2.1'); await page.keyboard.press('Tab');
    await page.waitForSelector('[data-trend-table]');
    assert.equal(await page.$eval('[data-trend-reference]', el => el.value), '2.1');
    // A second sequence shares the same frequency: changing sequences must still clear an
    // invalid editor. More than eight traces are explicitly selected, while CSV retains all.
    const many = Array.from({ length: 9 }, (_, i) => {
      const j = structuredClone(history[0]); j.id = `many-${i}`;
      j.sweep.sequence_index = 1; j.sweep.sequence_name = 'B'; j.sweep.values.width = i;
      j.sweep.axes = [{ key: 'length', values: [1] }, { key: 'width', values: Array.from({ length: 9 }, (_, n) => n) }];
      return j;
    });
    history = [...history, ...many];
    await page.evaluate(async history => (await import('/src/runner/store.ts')).setJobs(history), history);
    await page.$eval('[data-trend-reference]', el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.select('[data-trend-sequence]', '1');
    await page.waitForSelector('[data-trend-series]');
    assert.equal(await page.$eval('[data-trend-reference]', el => el.value), '2.1');
    assert.equal(await page.$$eval('[data-trend-table] tbody tr', rows => rows.length), 9);
    assert.equal(await page.$$eval('.sweep-trend-chart .c-line', els => els.length), 1);
    await page.select('[data-trend-series]', '1:8');
    assert.ok((await page.$eval('.sweep-trend-chart', el => el.textContent)).includes('width=8'));
    await page.click('[data-trend-csv]');
    await page.waitForFunction(() => window.__trendDownloads.length === 4);
    assert.equal(await page.evaluate(() => window.__trendDownloads[3].text.split('\r\n').length), 11);
    console.log(`${lang}: Designer tree, two-axis trace/gaps/slopes, locale, invalid-input recovery, field provenance, real CSV/SVG/PNG bytes and layout passed`);
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
} catch (error) {
  writeFileSync(join(out, 'failure.json'), JSON.stringify({ error: String(error.stack || error), errors, forbidden }, null, 2));
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => {}); throw error;
} finally { await browser?.close(); await stack?.stop(); }
