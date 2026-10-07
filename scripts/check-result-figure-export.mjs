// Focused export regression: filenames, live toolbar, theme preservation and standalone figures.
// Uses stored results only. The optional browser check starts one viewer on the supplied port.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { resultExportStem, resultFrequencyTag } from '../src/lib/resultExportNames.ts';
import { titledSvg, svgSizeMm } from '../src/components/figureTitle.ts';

const fixture = JSON.parse(readFileSync(new URL('../public/projects/patch-antenna.json', import.meta.url)));
const b = { ...fixture, name: 'Örnek / Patch <A>', created: '2026-10-07T10:22:01+0300' };
assert.equal(resultExportStem(b, 'pattern', 2.45e9), 'Ornek_Patch_A_pattern_2.45GHz_2026-10-07T10-22-01+0300');
assert.equal(resultFrequencyTag({ ...b, results: { frequency: [2e9, 1.25e9, 2.45e9] } }), '1.25-2.45GHz');
assert.equal(resultFrequencyTag({ ...b, results: null }), '');
assert.equal(resultFrequencyTag(b, NaN), resultFrequencyTag(b));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="88mm" height="62mm" viewBox="0 0 880 620"><path d="M0 0L880 620"/></svg>';
const titled = titledSvg(svg, 'Patch <A> & frequency');
assert.ok(titled.includes('Patch &lt;A&gt; &amp; frequency'));
assert.deepEqual(svgSizeMm(titled), [88, 68.6]);
assert.ok(titled.includes('viewBox="0 0 880 620"'));
assert.ok(svgSizeMm(titledSvg(svg, 'Long design name '.repeat(20)))[1] > 75);
assert.equal(titledSvg(svg, ' '), svg);
console.log('Result figure filename and title checks passed');
if (!process.argv.includes('--browser')) process.exit(0);

const port = Number(process.env.FAIRBEAM_FIGURE_PORT || 5347);
const root = resolve('.'), scratch = mkdtempSync('/tmp/fairbeam-result-figures-');
const artifacts = process.env.FAIRBEAM_FIGURE_ARTIFACTS || scratch;
const config = join(scratch, 'vite.config.mjs');
writeFileSync(config, `import config from ${JSON.stringify(join(root, 'vite.config.ts'))};\nconst base=config({mode:'development',command:'serve'}); export default {...base,optimizeDeps:{...base.optimizeDeps,include:[...base.optimizeDeps.include,'jspdf']},cacheDir:${JSON.stringify(join(scratch, 'cache'))}};`);
const harness = join(root, 'scripts', '.result-figure-harness.ts');
writeFileSync(harness, 'export { render } from "solid-js/web";');
const server = spawn('nice', ['-n', '15', process.execPath, 'node_modules/vite/bin/vite.js', '--config', config, '--host', '127.0.0.1', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser, output = '';
server.stdout.on('data', d => { output += d; }); server.stderr.on('data', d => { output += d; });
try {
  const url = `http://127.0.0.1:${port}`;
  let loaded = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(output);
    try { if ((await fetch(url)).ok) { loaded = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(loaded, output);
  const { default: puppeteer } = await import('puppeteer-core');
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 30000, userDataDir: join(scratch, 'chrome'), executablePath: process.env.FAIRBEAM_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 850 });
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.evaluate(async fixture => {
    const { render } = await import('/scripts/.result-figure-harness.ts');
    const { ResultBody, ResultToolbar } = await import('/src/designer/ResultViews.tsx');
    const { setDesignResult } = await import('/src/runner/designRun.ts');
    const { setLanguage } = await import('/src/i18n/index.ts');
    setLanguage('en');
    setDesignResult({ file: 'fixture.json', bundle: fixture });
    document.querySelector('#root')?.setAttribute('hidden', '');
    const host = document.createElement('div'); host.className = 'dw-result'; host.id = 'result-export-fixture';
    host.style.cssText = 'position:fixed;inset:20px;display:flex;flex-direction:column;background:var(--al-surface);';
    document.body.append(host);
    const bar = document.createElement('div'); host.append(bar);
    const plot = document.createElement('div'); plot.className = 'dw-result-plot'; plot.style.cssText = 'height:650px;flex:1'; host.append(plot);
    render(() => ResultToolbar({ view: 'impedance' }), bar);
    render(() => ResultBody({ view: 'impedance', b: fixture, format: 'plot' }), plot);
    window.__downloads = [];
    HTMLAnchorElement.prototype.click = function() {
      if (this.download) window.__downloads.push(fetch(this.href).then(async response => ({ name: this.download, blob: await response.blob() })));
    };
  }, fixture);
  await page.waitForFunction(() => document.querySelector('.dw-result-plot .chart svg')?.getBoundingClientRect().width > 100);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.setAttribute('data-theme', theme); }, theme);
    await page.screenshot({ path: join(artifacts, `${theme}-toolbar.png`) });
    for (const format of ['PNG', 'SVG']) {
      await page.click('#result-export-fixture [aria-label="Export current figure"]');
      await page.waitForSelector('.result-figure-menu');
      if (format === 'PNG') await page.screenshot({path:join(artifacts, `${theme}-menu.png`)});
      await page.evaluate(format => [...document.querySelectorAll('.result-figure-menu button')].find(b => b.textContent.includes(format)).click(), format);
      await page.waitForFunction(() => !document.querySelector('#result-export-fixture [aria-label="Export current figure"]').disabled);
      const result = await page.evaluate(async () => {
        const item = await window.__downloads.pop();
        if (!item) return null;
        const bytes = new Uint8Array(await item.blob.arrayBuffer());
        return { name: item.name, bytes: Array.from(bytes) };
      });
      assert.ok(result, `${theme} ${format} download`);
      assert.ok(result.name.includes('_impedance_') && result.name.endsWith(`.${format.toLowerCase()}`), result.name);
      writeFileSync(join(artifacts, `${theme}.${format.toLowerCase()}`), Buffer.from(result.bytes));
      assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), theme);
      // Decode the exported standalone image and verify white paper in either app theme.
      const stats = await page.evaluate(async ({ bytes, format }) => {
        const blob = new Blob([new Uint8Array(bytes)], { type: format === 'SVG' ? 'image/svg+xml' : 'image/png' });
        const url = URL.createObjectURL(blob), img = new Image(); img.src = url; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
        const pixel = [...ctx.getImageData(1, 1, 1, 1).data];
        URL.revokeObjectURL(url);
        return { pixel, width: img.width, height: img.height };
      }, { bytes: result.bytes, format });
      assert.deepEqual(stats.pixel, [255, 255, 255, 255]);
      assert.ok(stats.width > 800 && stats.height > 300);
      const previewPage = await browser.newPage();
      await previewPage.setViewport({width:1200,height:850});
      const mime = format === 'SVG' ? 'image/svg+xml' : 'image/png';
      await previewPage.setContent(`<body style="margin:0;background:white"><img style="width:100%;height:100vh;object-fit:contain" src="data:${mime};base64,${Buffer.from(result.bytes).toString('base64')}"/></body>`);
      await previewPage.evaluate(() => document.querySelector('img').decode());
      await previewPage.screenshot({ path: join(artifacts, `${theme}-${format.toLowerCase()}-preview.png`) });
      await previewPage.close();
    }
    await page.click('#result-export-fixture [aria-label="Export result data as CSV"]');
    await page.waitForFunction(() => window.__downloads.length > 0);
    const csv = await page.evaluate(async () => { const d = await window.__downloads.pop(); return {name:d.name,text:await d.blob.text()}; });
    assert.equal(csv.name.replace(/\.csv$/, ''), resultExportStem(fixture, 'impedance'));
    assert.ok(csv.text.includes('Re'), 'CSV retains the plotted data');
    await page.click('#result-export-fixture [aria-label="Export Touchstone"]');
    await page.waitForFunction(() => window.__downloads.length > 0);
    const touchstone = await page.evaluate(async () => { const d = await window.__downloads.pop(); return {name:d.name,text:await d.blob.text()}; });
    assert.equal(touchstone.name, `${resultExportStem(fixture, 'sparams')}.s1p`);
    assert.ok(touchstone.text.includes('#'), 'Touchstone retains its format header');
  }
  await page.click('#result-export-fixture [aria-label="Export current figure"]');
  await page.keyboard.press('ArrowDown');
  assert.ok(await page.evaluate(() => document.activeElement.textContent.includes('SVG')), 'menu arrow key selects SVG');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Export current figure');
  assert.equal(await page.$('.result-figure-menu'), null, 'Escape closes the menu and restores focus');
  const [light, dark] = ['light', 'dark'].map(t => readFileSync(join(artifacts, `${t}.svg`), 'utf8'));
  assert.equal(dark, light, 'SVG exports have the same palette in either theme');
  assert.ok(light.includes('Re') && light.includes('Im'), 'export preserves the plotted legend');
  assert.ok(light.includes(fixture.name) && light.includes('Impedance'), 'figure has a visible design and view title');
  assert.deepEqual(readFileSync(join(artifacts, 'dark.png')), readFileSync(join(artifacts, 'light.png')), 'PNG exports have the same palette in either theme');
  console.log(`Browser checks passed. Export previews: ${artifacts}`);
} finally {
  await browser?.close();
  rmSync(harness, {force: true});
  if (server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
  if (artifacts !== scratch) rmSync(scratch, { recursive: true, force: true });
}
