// Exercise the real browser stores without a DOM or a running solver. Vite is already a dev
// dependency; bundle in memory so Solid uses its browser signals rather than its SSR stubs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
const built = await build({
  root, configFile: false, logLevel: 'silent', resolve: { conditions: ['browser'] },
  plugins: [{
    name: 'start-check-entry',
    resolveId(id) { if (id.endsWith('start-check-entry')) return '\0start-check-entry'; },
    load(id) {
      if (id !== '\0start-check-entry') return;
      return ['runner/store', 'state', 'workspace', 'runner/api', 'runner/openProject'].map((path, i) =>
        `export * as m${i} from ${JSON.stringify(`${root}src/${path}.ts`)};`).join('\n');
    },
  }],
  build: { write: false, minify: false, lib: { entry: 'start-check-entry', formats: ['es'] } },
});
const code = (Array.isArray(built) ? built[0] : built).output[0].code;
const { m0: runner, m1: state, m2: workspace, m3: { api }, m4: { openUserProject } } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const fixture = (file) => JSON.parse(readFileSync(`${root}public/projects/${file}.json`, 'utf8'));
const patch = fixture('patch-antenna');
const dipole = fixture('dipole');
const preview = { ...dipole, preview: true, name: 'Dipole (preview)' };
const model = (key, bundle) => ({ key, model: bundle.model, params: [{
  key: 'length', type: 'float', default: 60, minimum: null, maximum: null,
}] });
runner.setModels([model('patch_antenna', patch), model('dipole', dipole)]);
runner.setServerState('online');
let requests = 0;
api.preview = async (key, params) => {
  assert.equal(key, 'dipole');
  assert.deepEqual(params, { length: 60 });
  requests++;
  return { bundle: structuredClone(preview) };
};

for (const previous of ['nothing', 'result', 'design', 'preview']) {
  runner.invalidatePreview();
  runner.setPreviewActive(false);
  state.setBundle(null);
  if (previous === 'result') state.openBundle(patch, 'patch-antenna.json');
  if (previous === 'design') {
    workspace.setAppMode('design');
    runner.showEmptyDesign('Previous design');
  }
  if (previous === 'preview') {
    workspace.setAppMode('design');
    runner.showQuickPreview({ ...patch, preview: true });
  }
  workspace.setAppMode('home');
  // Closing a design also clears modelKey; retained bundles must not affect explicit picks.
  runner.selectModel('');
  workspace.setAppMode('results');
  const before = requests;
  await runner.openRunPanel('dipole');
  assert.equal(runner.modelKey(), 'dipole', `${previous}: keep the explicit Start pick`);
  assert.equal(state.bundle().model.id, dipole.model.id, `${previous}: replace displayed geometry`);
  assert.equal(requests, before + 1, `${previous}: request a fresh preview`);
  assert.equal(runner.previewState(), 'ready');
}
await runner.openRunPanel('dipole');
assert.equal(requests, 5, 'reselecting the same example previews its defaults again');
runner.setPreviewActive(false);
state.openBundle(patch, 'patch-antenna.json');
await runner.openRunPanel();
assert.equal(runner.modelKey(), 'patch_antenna', 'toolbar still follows the displayed result');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const oldFetch = globalThis.fetch;
try {
  // Simulated examples and Open report success only when their bundle actually wins.
  globalThis.fetch = async () => ({ ok: true, json: async () => structuredClone(dipole) });
  runner.invalidatePreview();
  assert.equal(await state.loadProject('dipole.json'), true);
  assert.equal(state.bundle().model.id, dipole.model.id);
  assert.equal(state.failedProject(), null, 'a successful server-backed open leaves no failed retry target');
  assert.equal(await state.loadFile(new File([JSON.stringify(patch)], 'local-patch.json')), true);
  assert.equal(state.source(), 'local-patch.json');
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  assert.equal(await state.loadProject('missing.json'), false);
  assert.match(state.loadError(), /missing.json/);
  assert.equal(state.failedProject(), 'missing.json');
  assert.equal(await state.loadFile(new File(['{}'], 'invalid.json')), false);
  assert.match(state.loadError(), /Could not open invalid.json/);
  assert.equal(state.failedProject(), null, 'a local-file failure clears a stale server retry target');
  assert.equal(state.source(), 'local-patch.json', 'failed opens preserve the prior project');
  assert.equal(await state.loadProject('missing-again.json'), false);
  assert.equal(state.failedProject(), 'missing-again.json');
  assert.equal(await state.loadFile(new File([JSON.stringify(patch)], 'local-recovered.json')), true);
  assert.equal(state.source(), 'local-recovered.json');
  assert.equal(state.failedProject(), null, 'a successful local open clears a stale server retry target');

  const slow = deferred();
  globalThis.fetch = () => slow.promise;
  const pending = state.loadProject('slow.json');
  assert.equal(await state.loadFile(new File([JSON.stringify(dipole)], 'newer.json')), true);
  slow.resolve({ ok: true, json: async () => patch });
  assert.equal(await pending, false, 'superseded example does not report success');
  assert.equal(state.source(), 'newer.json');

  const slowFile = deferred();
  const pendingFile = state.loadFile({ name: 'slow-file.json', text: () => slowFile.promise });
  await state.loadFile(new File([JSON.stringify(patch)], 'latest.json'));
  slowFile.reject(new Error('late failure'));
  assert.equal(await pendingFile, false);
  assert.equal(state.loadError(), null, 'stale file failures do not taint the newer open');

  // Keep the actual UI entry points wired to the guarded loader.
  const header = readFileSync(`${root}src/components/Header.tsx`, 'utf8');
  const picker = readFileSync(`${root}src/components/ExamplePicker.tsx`, 'utf8');
  const app = readFileSync(`${root}src/App.tsx`, 'utf8');
  const home = readFileSync(`${root}src/home/Home.tsx`, 'utf8');
  assert.match(picker, /void openUserProject\(file\)/, 'header picker uses the guard');
  assert.match(header, /if \(f\) void openUserProject\(f\)/, 'header Open uses the guard');
  assert.match(app, /\? openUserProject\(f\) : importReferenceFile\(f\)/, 'JSON drop uses the guard');
  assert.match(home, /openUserProject\(p.file\)/, 'Start examples use the guard');

  for (const path of ['Start example', 'header picker', 'header Open', 'JSON drop']) {
    for (const outcome of ['success', 'failure']) {
      state.openBundle(dipole, 'previous.json');
      workspace.setAppMode('home');
      const slowPreview = deferred();
      api.preview = () => slowPreview.promise;
      const pendingPreview = runner.openRunPanel('dipole');
      const slowLoad = deferred();
      globalThis.fetch = () => slowLoad.promise;
      const isFile = path === 'header Open' || path === 'JSON drop';
      const pendingOpen = openUserProject(isFile
        ? { name: 'picked.json', text: () => slowLoad.promise }
        : 'picked.json');
      // Reproduce the review: the preview resolves DURING the project fetch/file read.
      slowPreview.resolve({ bundle: preview });
      await pendingPreview;
      assert.equal(state.source(), 'previous.json', `${path}: pending preview is ignored`);
      const raw = outcome === 'success' ? patch : {};
      slowLoad.resolve(isFile ? JSON.stringify(raw) : { ok: true, json: async () => raw });
      assert.equal(await pendingOpen, outcome === 'success', `${path}: ${outcome} result`);
      assert.equal(state.source(), outcome === 'success' ? 'picked.json' : 'previous.json');
      assert.equal(workspace.appMode(), outcome === 'success' ? 'results' : 'home');
      if (outcome === 'failure') assert.match(state.loadError(), /Could not open picked.json/);
      else assert.equal(state.loadError(), null);
      runner.restoreProject();
      assert.equal(state.source(), outcome === 'success' ? 'picked.json' : 'previous.json');
    }
  }

  runner.setServerState('offline');
  const oldHealth = api.health;
  let offlinePreviews = 0;
  api.preview = async () => { offlinePreviews++; return { bundle: preview }; };
  api.health = async () => { throw new Error('offline'); };
  try {
    await runner.openRunPanel('dipole');
    assert.equal(runner.modelKey(), 'dipole', 'offline Start pick is retained');
    assert.equal(offlinePreviews, 0, 'offline pick does not request a preview');
  } finally {
    api.health = oldHealth;
    runner.setServerState('online');
  }
} finally {
  globalThis.fetch = oldFetch;
  runner.invalidatePreview();
}
console.log('Start checks passed: explicit picks from 4 prior states, same-model reopen, toolbar inference, bundle/file success, failures, stale loads, all four guarded opens during previews, failure banners and offline picks.');
