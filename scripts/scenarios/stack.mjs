// The scenario stack: Vite + a run server on free ports, both over a temp folder.
//
// The viewer loads result files from /projects/*.json, which Vite serves from its public folder,
// while the run server writes runs and designs into --projects. So the temp public folder is a copy
// of public/ and the server's --projects is that copy's projects/: what the server writes the viewer
// can load. Nothing here touches the checkout's public/projects or python/models.
import { spawn } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
  });
}

async function waitFor(url, what, ms = 60000, alive = () => true) {
  const end = Date.now() + ms;
  for (;;) {
    if (!alive()) throw new Error(`${what} exited before it was ready`);
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`${what} did not come up at ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export const pythonPath = () => process.env.FAIRBEAM_PYTHON || join(process.env.HOME ?? '', 'opt/openEMS/venv/bin/python');

export async function chromePath() {
  const cands = [process.env.FAIRBEAM_CHROME,
    ...(process.platform === 'win32' ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
      : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'])].filter(Boolean);
  for (const c of cands) { try { await access(c); return c; } catch { /* next */ } }
  throw new Error('No Chrome or Edge found; set FAIRBEAM_CHROME.');
}

/** Start Vite and the run server. `stop()` ends both by PID (and removes the temp folder). */
export async function startStack({ log = () => {}, niceSolver = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fairbeam-scenarios-'));
  const pub = join(dir, 'public'), projects = join(pub, 'projects'), models = join(dir, 'models');
  await cp(join(root, 'public'), pub, { recursive: true });
  // The run server's default template folder is beside --models; scenario stacks need the same
  // Python model templates as a normal checkout to exercise the real create-model flow.
  await cp(join(root, 'python', 'templates'), join(dir, 'templates'), { recursive: true });
  await mkdir(models, { recursive: true });
  const [apiPort, vitePort] = [await freePort(), await freePort()];
  const kids = [];
  const run = (cmd, args, opts, name) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts });
    const rec = { name, child, out: '', exited: false };
    for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { rec.out = (rec.out + d).slice(-4000); });
    child.on('exit', () => { rec.exited = true; });
    kids.push(rec);
    return rec;
  };
  const stop = async () => {
    for (const { child, exited } of [...kids].reverse()) if (!exited && child.pid) { try { process.kill(child.pid, 'SIGTERM'); } catch { /* gone */ } }
    await new Promise((r) => setTimeout(r, 800));
    for (const { child, exited } of kids) if (!exited && child.pid) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } }
    await rm(dir, { recursive: true, force: true });
  };
  try {
    // the server runs under `nice`, so the one coarse solver run stays polite
    const serveArgs = ['-m', 'fairbeam', 'serve', '--port', String(apiPort), '--projects', projects, '--models', models,
      '--jobs', join(dir, 'sim', 'jobs'), '--sim-root', join(dir, 'sim'), '--python', pythonPath()];
    const useNice = niceSolver && process.platform !== 'win32';
    const api = run(useNice ? 'nice' : pythonPath(), useNice ? ['-n', '10', pythonPath(), ...serveArgs] : serveArgs,
      { cwd: join(root, 'python'), env: { ...process.env, PYTHONPATH: join(root, 'python') } }, 'run server');
    await waitFor(`http://127.0.0.1:${apiPort}/api/health`, 'run server', 30000, () => !api.exited);
    // A config of its own: the checkout's, with the temp public folder and free ports
    const config = join(dir, 'vite.config.mjs');
    // Managed checkouts may share their dependency directory through a symlink/junction.
    // Serve that exact dependency path too, so locally bundled font files remain accessible.
    const dependencies = await realpath(join(root, 'node_modules'));
    await writeFile(config, `import solid from ${JSON.stringify(join(root, 'node_modules/vite-plugin-solid/dist/esm/index.mjs'))};
export default { root: ${JSON.stringify(root)}, publicDir: ${JSON.stringify(pub)}, plugins: [solid()], clearScreen: false, cacheDir: ${JSON.stringify(join(dir, 'vite-cache'))},
  // Pre-optimize lazy workspace/editor/export imports so first use does not trigger Vite's
  // "optimized dependencies changed" reload or split CodeMirror across optimizer generations.
  optimizeDeps: { include: ['three', 'three/addons/controls/OrbitControls.js', 'three/addons/environments/RoomEnvironment.js', 'three/addons/renderers/CSS2DRenderer.js', 'three/addons/exporters/GLTFExporter.js', 'three/addons/exporters/STLExporter.js', 'fflate', 'jspdf',
    '@codemirror/state', '@codemirror/view', '@codemirror/commands', '@codemirror/lang-python', '@codemirror/language', '@codemirror/search', '@codemirror/lint', '@lezer/highlight'] },
  server: { host: '127.0.0.1', port: ${vitePort}, strictPort: true, fs: { allow: ${JSON.stringify([root, dependencies])} }, watch: { ignored: ['**/.sim/**', '**/python/**'] },
    proxy: { '/api': { target: 'http://127.0.0.1:${apiPort}', changeOrigin: false } } } };\n`);
    const vite = run(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--config', config], { cwd: root }, 'vite');
    await waitFor(`http://127.0.0.1:${vitePort}/`, 'vite', 60000, () => !vite.exited);
    log(`stack up: viewer :${vitePort}, run server :${apiPort}, folder ${dir}`);
  } catch (e) { const out = kids.map((k) => `--- ${k.name}\n${k.out}`).join('\n'); await stop(); throw new Error(`${e.message}\n${out}`); }
  return { url: `http://127.0.0.1:${vitePort}/`, apiUrl: `http://127.0.0.1:${apiPort}`, dir, projects, pids: kids.map((k) => k.child.pid), stop };
}
