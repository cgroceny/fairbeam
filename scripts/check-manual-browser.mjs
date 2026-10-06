// Explicit local browser fixture. This owns its Vite process, temporary public projects and API;
// it never reads or writes the user's real designs. `--smoke` validates setup without launching.
import { createRequire } from 'node:module';
import { access, cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const moduleFile = process.env.FAIRBEAM_PUPPETEER;
// puppeteer-core drives an installed Chrome/Edge (no browser download on `npm install`); set
// FAIRBEAM_CHROME to use another Chromium-based executable.
const winRoots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
const chromeCandidates = [process.env.FAIRBEAM_CHROME,
  ...(process.platform === 'win32' ? [
    ...winRoots.map((dir) => join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...winRoots.map((dir) => join(dir, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge']),
].filter(Boolean);
let puppeteerPath;
try { puppeteerPath = moduleFile ? resolve(moduleFile) : require.resolve('puppeteer-core'); } catch {}
let chromePath;
for (const candidate of chromeCandidates) {
  try { await access(candidate); chromePath = candidate; break; } catch {}
}

if (process.argv.includes('--smoke')) {
  console.log(`Manual browser setup: ${puppeteerPath ? 'Puppeteer module found' : 'Puppeteer module missing'}; ${chromePath ? 'browser executable found' : 'browser executable missing'}.`);
  console.log('Smoke mode did not start a server or browser.');
  process.exit(0);
}
if (!puppeteerPath) {
  console.error('Manual browser checks need the puppeteer-core dev dependency (or FAIRBEAM_PUPPETEER). Run `npm ci` and retry.');
  process.exit(1);
}
if (!chromePath) {
  console.error('Manual browser checks need an installed Chrome or Edge. Install one or set FAIRBEAM_CHROME to its executable.');
  process.exit(1);
}

const fixtureRoot = await mkdtemp(join(tmpdir(), 'fairbeam-browser-'));
const fixtureProjects = join(fixtureRoot, 'public', 'projects');
await mkdir(fixtureProjects, { recursive: true });
const exampleFile = 'branchline-coupler.json';
await Promise.all([
  cp(join(root, 'public', 'projects', exampleFile), join(fixtureProjects, exampleFile)),
  writeFile(join(fixtureProjects, 'index.json'), JSON.stringify({ projects: [{ file: exampleFile, name: 'Manual fixture result', model: 'branchline-coupler', simulated: true }] })),
]);

let server;
let browser;
try {
  const { createServer } = await import(pathToFileURL(join(root, 'node_modules/vite/dist/node/index.js')).href);
  server = await createServer({ root, configFile: join(root, 'vite.config.ts'), publicDir: join(fixtureRoot, 'public'), server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer.address();
  const url = `http://127.0.0.1:${address.port}/`;
  const imported = await import(pathToFileURL(puppeteerPath).href);
  const puppeteer = imported.default ?? imported;
  browser = await puppeteer.launch({ headless: true, executablePath: chromePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/health') return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, api: 1, cpu_count: 4, default_threads: 2, queue: { running: null, queued: 0 } }) });
    if (pathname === '/api/models') return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [] }) });
    if (pathname === '/api/runs') return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [] }) });
    return request.continue();
  });
  // a cold Vite cache (a fresh checkout, CI) optimizes dependencies on the first load: allow for it
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
  await page.waitForSelector('.home');
  const project = await page.evaluate(async (file) => {
    const state = await import('/src/state.ts');
    const workspace = await import('/src/workspace.ts');
    const loaded = await state.loadProject(file);
    workspace.setAppMode('results');
    return loaded;
  }, exampleFile);
  if (!project) throw new Error(`Could not load fixture project ${exampleFile}`);
  for (const [width, height] of [[1600, 1000], [1280, 720]]) {
    await page.setViewport({ width, height });
    await page.waitForSelector('.workspace .vp-canvas');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    console.log(`PASS example result mounted at ${width}x${height}`);
    for (const tab of ['reflection', 'pattern']) {
      const selector = `.tabs[aria-label="Result views"] [data-tab="${tab}"]`;
      await page.click(selector);
      const selected = await page.$eval(selector, (element) => element.getAttribute('aria-selected'));
      if (selected !== 'true') throw new Error(`result tab ${tab} did not activate at ${width}x${height}`);
    }
    console.log(`PASS result tab transitions at ${width}x${height}`);
    const mounted = await page.evaluate(async () => {
      const workspace = await import('/src/workspace.ts');
      workspace.setAppMode('home');
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const unmounted = !document.querySelector('.workspace');
      workspace.setAppMode('results');
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { unmounted, remounted: !!document.querySelector('.workspace .vp-canvas') };
    });
    if (!mounted.unmounted || !mounted.remounted) throw new Error(`workspace/result transition failed at ${width}x${height}`);
    console.log(`PASS mounted workspace/result transition at ${width}x${height}`);
  }
  // Count native wrappers after GC in the same mounted result state. The shared Three DFG_LUT
  // must release each retired renderer's listener or contexts/textures grow with every remount.
  const heap = await page.createCDPSession();
  await heap.send('HeapProfiler.enable');
  const heapCounts = async () => {
    await heap.send('Runtime.discardConsoleEntries');
    await heap.send('HeapProfiler.collectGarbage');
    const chunks = [];
    const onChunk = ({ chunk }) => chunks.push(chunk);
    heap.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    try { await heap.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }); }
    finally { heap.off('HeapProfiler.addHeapSnapshotChunk', onChunk); }
    const snapshot = JSON.parse(chunks.join(''));
    const fields = snapshot.snapshot.meta.node_fields, types = snapshot.snapshot.meta.node_types[0];
    const nodes = snapshot.nodes, strings = snapshot.strings, width = fields.length;
    const counts = { contexts: 0, textures: 0 };
    for (let i = 0; i < nodes.length; i += width) {
      if (types[nodes[i]] !== 'native') continue;
      const name = strings[nodes[i + fields.indexOf('name')]];
      if (name === 'WebGL2RenderingContext') counts.contexts++;
      if (name === 'WebGLTexture') counts.textures++;
    }
    return counts;
  };
  const baseline = await heapCounts();
  if (baseline.contexts < 1 || baseline.textures < 1) throw new Error(`WebGL heap baseline missing: ${JSON.stringify(baseline)}`);
  for (let i = 1; i <= 10; i++) {
    await page.evaluate(async () => {
      const workspace = await import('/src/workspace.ts');
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      workspace.setAppMode('home'); await frame();
      workspace.setAppMode('results'); await frame();
    });
    if ([2, 4, 10].includes(i)) {
      const counts = await heapCounts();
      if (counts.contexts !== baseline.contexts || counts.textures !== baseline.textures)
        throw new Error(`viewport heap grew after ${i} cycles: ${JSON.stringify({ baseline, counts })}`);
      console.log(`PASS viewport heap plateau after ${i} cycles: ${counts.contexts} context, ${counts.textures} textures`);
    }
  }
  if (pageErrors.length) throw new Error(`Browser page errors:\n${pageErrors.join('\n')}`);
  console.log('Manual browser fixture passed.');
} finally {
  await browser?.close();
  await server?.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}
