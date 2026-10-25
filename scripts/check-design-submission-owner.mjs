// Real session/IO plus the production preparation and submit closures. Native pickers and job
// transport are controlled boundaries; this does not claim an Explorer/Finder or solver test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/');
const built = await build({ root, configFile: false, logLevel: 'silent', resolve: { conditions: ['browser'] },
  plugins: [{name: 'submission-owner', resolveId(id) { if (id.endsWith('submission-owner')) return '\0submission-owner'; },
    load(id) { if (id === '\0submission-owner') return `export {createDesignerSession} from '${root}src/designer/sessionCore.ts';export {createDesignerIO} from '${root}src/designer/sessionIO.ts';`; }}],
  build: {write: false, minify: false, lib: {entry: 'submission-owner', formats: ['es']}} });
const chunk = (Array.isArray(built) ? built[0] : built).output.find(x => x.type === 'chunk');
const {createDesignerSession, createDesignerIO} = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
const read = path => readFileSync(root + path, 'utf8');
const baseline = process.argv.includes('--baseline');
const runSource = baseline ? execFileSync('git', ['show', '03bd2ab:src/runner/designRun.ts'], {cwd: root, encoding: 'utf8'}) : read('src/runner/designRun.ts');
const begin = runSource.indexOf(`export async function ${baseline ? 'prepareDesignOptimize' : 'prepareDesignSubmission'}(`);
const end = runSource.indexOf('\nexport function attachDesignOptimize', begin);
const preparation = stripTypeScriptTypes(runSource.slice(begin, end).replaceAll('export ', ''));
const compile = (source, deps, expression) => new Function(...Object.keys(deps), stripTypeScriptTypes(source) + `;return ${expression};`)(...Object.values(deps));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const design = id => ({schema: 'fairbeam.design/1', model: {id, name: id}, params: [{key: 'W', default: 32}], materials: [], parts: [], ports: [], resistors: [], simulation: {}, mesh: {}, parameter_sweep: {schema: 'fairbeam.parameter-sweep/1', sequences: []}});
const file = (id, hash = 'base', scope = id) => ({id, hash, backup_scope: scope, file: `${id}.design.json`, readonly: false, design: design(id)});
function fixture({dirty = true, native = true, waitRefresh = false, waitResearch = null, networkRequest = undefined} = {}) {
  const core = createDesignerSession(), external = deferred(), refreshed = deferred();
  const researchBoundary = deferred();
  const writes = [], selected = [], submitted = [], errors = [];
  const followed = [];
  let live = true, refreshedCalled = false, busy = false, researchCalled = null;
  const researchWait = async phase => {
    researchCalled = phase;
    if (waitResearch === phase) await researchBoundary.promise;
  };
  const original = file('legacy'), originalBytes = JSON.stringify(original.design);
  const io = createDesignerIO(core, {
    transport: {design: async id => file(id), saveDesign: async (f, d) => { writes.push([f.id, structuredClone(d)]); return {hash: 'saved', validation: {valid: true, checks: []}}; }},
    persistUnsavedDesign: async (_f, d) => {
      if (!native) return;
      const outcome = await external.promise;
      if (outcome === 'cancel') return {canceled: true};
      return {file: {...file('fb_new', 'new-hash'), design: structuredClone(d)}};
    },
    rememberLastDesign() {}, readBackup: () => null, clearBackup() {}, stopPreview() {}, forgetPreviewFailure() {}, resetParamAsks() {}, schedulePreview() {}, applyModelEntry() {}, restoreModelSelection() {},
  });
  core.takeFile(original);
  if (dirty) core.edit(d => d.params[0].default = 33);
  const deps = {
    designFile: core.file, prepareSavedDesign: io.prepareSavedDesign, dirty: core.dirty, conflict: core.conflict, save: io.save,
    checks: () => [], refreshModels: async () => { refreshedCalled = true; if (waitRefresh) await refreshed.promise; },
    models: () => ['legacy', 'fb_new', 'other'].map(key => ({key})),
    selectModel: (key, fromBundle) => { if (!baseline) assert.equal(fromBundle, undefined, 'displayed results must not override the saved parameter defaults'); selected.push(key); },
    bundle: () => ({model: {...core.draft.model, params: [{key: 'W', value: 999}]}}), t: key => key,
  };
  const prepare = compile(preparation, deps, baseline ? '{prepareDesignOptimize}' : '{prepareDesignOptimize, prepareDesignSubmission}');
  const common = {
    ...deps, ...prepare, file: core.file, draft: core.draft, defaultDesignerSession: core,
    active: true, busy: () => busy, setBusy: v => { busy = v; }, setErr: e => errors.push(e), setNotice: e => errors.push(e),
    setSubmitError() {}, setSubmitting: v => { busy = v; }, submitting: () => busy, setInfo() {},
    errorCount: () => 0, serverState: () => 'online', probeServer: async () => true,
    pointsBad: () => false, threadsBad: () => false, eng: () => 'cpu', thr: () => 2, points: () => 801, name: () => '',
    startDesignRun: async opts => { submitted.push({kind: 'run', model: selected.at(-1), opts}); return null; }, close() {}, submitError: () => null,
    api: {submitSweep: async request => { submitted.push({kind: 'sweep', ...request}); return {sweep: {id: 'sw'}, runs: []}; },
      submitConvergence: async request => { submitted.push({kind: 'convergence', ...request}); return {study: {id: 'study'}, runs: []}; },
      health: async () => {await researchWait('health'); return {elmer_driven: 2, research_source: true};},
      researchProbe: async () => {await researchWait('probe'); return {available: true};},
      researchStart: async request => {submitted.push({kind: 'elmer', ...request}); await researchWait('start'); return {id: 'research-job'};}},
    invalid: () => false, setError: e => errors.push(e), setDiagnostic() {}, props: {close() {}},
    defaultDesignerIO: io, unwrap: v => JSON.parse(JSON.stringify(v)),
    path: () => '/elmer', researchPath: () => '/elmer', domain: () => ['-10', '-10', '-10', '10', '10', '10'],
    cell: () => '2', target: () => '1.8',
    values: () => ({f_min_hz: '1.5', f_max_hz: '3.2', farfield_hz: '2.45', points: '11', cell_mm: '12'}),
    hasDocumentResultScope: f => f?.id.startsWith('fb_'),
    followInDesigner: job => followed.push(job.id), openResearch: id => followed.push(id),
    network: () => ({request: networkRequest}),
    setupError: () => null, planned: () => [15, 20], largestNodes: () => undefined, tol: () => ({}), runs: () => 2,
    runSettings: () => ({threads: 2}), setStudyId() {}, setStudy() {}, refreshRuns: async () => {}, attachDesignOptimize() {}, setBottomDockCollapsed() {},
    plan: () => ({error: null, sequences: [{name: 'Test', sweep: [{key: 'W', values: [32, 33]}]}]}), names: () => ({names: {W: core.draft.params[0].default}}),
    editParameterSweep: definition => core.edit(d => d.parameter_sweep = definition), definition: () => core.draft.parameter_sweep,
    designCells: () => undefined, setRunId() {}, setDesignDockTab() {},
  };
  function handler(kind) {
    if (kind === 'elmer' || kind === 'elmer-driven') {
      const source = read(`src/designer/${kind === 'elmer' ? 'ElmerDesignRun' : 'ElmerAntennaRun'}.tsx`);
      const start = source.indexOf('  const submit');
      const finish = source.indexOf('\n  return <form', start);
      assert.ok(start > 0 && finish > start, `extract the production ${kind} handler`);
      return compile(`let alive = true;\n${source.slice(start, finish)}`, common,
        '{invoke:submit, close:()=>{alive=false}}');
    }
    const path = {run: 'RunDialog', sweep: 'SweepDialog', convergence: 'ConvergenceDialog'}[kind];
    const source = read(`src/designer/${path}.tsx`);
    const start = source.indexOf(kind === 'run' ? '  const run = async' : '  const start = async');
    const finish = source.indexOf({run: '\n  const optimize', sweep: '\n  // a new range', convergence: '\n  // ---- progress'}[kind], start);
    assert.ok(start > 0 && finish > start, `extract the production ${kind} handler`);
    const {active: _, ...bindings} = common;
    return compile(`let dialogActive = true;\n${source.slice(start, finish)}`, bindings,
      `{invoke:${kind === 'run' ? 'run' : 'start'}, close:()=>{dialogActive=false}}`);
  }
  return {core, io, prepare, external, refreshed, refreshedCalled: () => refreshedCalled, writes, selected, submitted, errors, handler,
    researchBoundary, researchCalled: () => researchCalled, followed, setNetwork: value => {networkRequest = value;},
    live: () => live, cancel: () => { live = false; }, sourceUnchanged: () => assert.equal(JSON.stringify(original.design), originalBytes),
    dispose: () => {io.dispose(); core.dispose();}};
}
const tick = async until => { for (let i = 0; i < 30 && !until(); i++) await Promise.resolve(); assert.ok(until(), 'controlled boundary reached'); };

// Baseline proof targets the original bug using the actual old preparation function and real IO.
if (baseline) {
  const x = fixture(); const p = x.prepare.prepareDesignOptimize(); x.external.resolve('save'); assert.equal(await p, null);
  assert.equal(x.core.file().id, 'fb_new');
  assert.equal(x.selected.at(-1), 'fb_new', 'native Save must prepare the new document rather than the unchanged source JSON');
  x.dispose();
} else {
  let cases = 0;
  // Both research forms use the real saved-document target, without the openEMS model list.
  for (const action of ['elmer', 'elmer-driven']) {
    const x = fixture(), h = x.handler(action);
    const p = h.invoke({preventDefault() {}}); x.external.resolve('save'); await p;
    assert.equal(x.core.file().id, 'fb_new', action);
    assert.equal(x.submitted.length, 1, `${action} submits after its own first native Save`);
    assert.equal(x.submitted[0].design.params[0].default, 33);
    if (action === 'elmer-driven') assert.deepEqual(x.submitted[0].source,
      {model_id: 'fb_new', workspace_hash: 'new-hash', backup_scope: 'fb_new'});
    else assert.equal(x.submitted[0].source, undefined, 'eigenmode backend does not accept a driven source binding');
    assert.deepEqual(x.selected, [], 'research never requires or selects an openEMS model');
    assert.deepEqual(x.followed, ['research-job']);
    assert.equal(x.writes.length, 0); x.sourceUnchanged(); x.dispose(); cases++;
  }
  for (const action of ['elmer', 'elmer-driven']) for (const outcome of ['cancel', 'failure', 'open', 'edit', 'close']) {
    const x = fixture(), h = x.handler(action), p = h.invoke({preventDefault() {}});
    // Reach the native picker in either form, including the driven health/probe awaits.
    await tick(() => x.core.saving());
    if (outcome === 'open') x.core.takeFile(file('other'));
    if (outcome === 'edit') x.core.edit(d => d.params[0].default = 34);
    if (outcome === 'close') h.close();
    if (outcome === 'failure') x.external.reject(Error('Picker/write failed'));
    else x.external.resolve(outcome === 'cancel' ? 'cancel' : 'save');
    await p; assert.deepEqual(x.submitted, [], `${action}/${outcome}`); assert.deepEqual(x.followed, []);
    x.sourceUnchanged(); x.dispose(); cases++;
  }
  for (const phase of ['health', 'probe']) for (const outcome of ['close', 'open', 'edit', 'undo-edit', 'hash', 'scope']) {
    const x = fixture({waitResearch: phase}), h = x.handler('elmer-driven'), p = h.invoke({preventDefault() {}});
    await tick(() => x.researchCalled() === phase);
    if (outcome === 'close') h.close();
    if (outcome === 'open') x.core.takeFile(file('other'));
    if (outcome === 'edit' || outcome === 'undo-edit') {x.core.edit(d => d.params[0].default = 35); if (outcome === 'undo-edit') x.core.undo();}
    if (outcome === 'hash') x.core.setFile({...x.core.file(), hash: 'external-save'});
    if (outcome === 'scope') x.core.setFile({...x.core.file(), backup_scope: 'other-workspace'});
    x.researchBoundary.resolve(); x.external.resolve('save'); await p;
    assert.deepEqual(x.submitted, [], `elmer-driven/${phase}/${outcome}`);
    x.sourceUnchanged(); x.dispose(); cases++;
  }
  for (const action of ['elmer', 'elmer-driven']) {
    const x = fixture({waitResearch: 'start'}), h = x.handler(action), p = h.invoke({preventDefault() {}});
    x.external.resolve('save'); await tick(() => x.researchCalled() === 'start');
    x.core.takeFile(file('other')); x.researchBoundary.resolve(); await p;
    assert.equal(x.submitted.length, 1); assert.deepEqual(x.followed, [], 'an already submitted job cannot navigate a competing Open');
    x.sourceUnchanged(); x.dispose(); cases++;
  }
  // All actual submit closures and Optimizer preparation must follow their own first native Save.
  for (const action of ['optimize', 'run', 'sweep', 'convergence']) {
    const x = fixture();
    const p = action === 'optimize' ? x.prepare.prepareDesignOptimize(x.live) : x.handler(action).invoke({preventDefault() {}});
    x.external.resolve('save'); await p;
    assert.equal(x.core.file().id, 'fb_new'); assert.equal(x.selected.at(-1), 'fb_new', action);
    if (action !== 'optimize') assert.equal(x.submitted[0].model, 'fb_new', action);
    if (action === 'convergence') assert.ok(!('network_criteria' in x.submitted[0]), 'opt-out remains absent');
    assert.equal(x.writes.length, 0, 'first native Save does not overwrite the legacy JSON'); x.sourceUnchanged(); x.dispose(); cases++;
  }
  // Opt-in criteria are captured at the initiating click and stay attached to its saved target.
  // Changing form criteria while native Save waits must not substitute another request.
  for (const outcome of ['saved', 'cancel', 'open', 'edit', 'close']) {
    const criteria = {frequency_ghz: 2.4, metrics: ['isolation:7,19:0.2']};
    const x = fixture({networkRequest: structuredClone(criteria)}), h = x.handler('convergence');
    const p = h.invoke();
    await tick(() => x.core.saving());
    x.setNetwork({frequency_ghz: 3, metrics: ['phase:19,7:1']});
    if (outcome === 'open') x.core.takeFile(file('other'));
    if (outcome === 'edit') x.core.edit(d => d.params[0].default = 34);
    if (outcome === 'close') h.close();
    x.external.resolve(outcome === 'cancel' ? 'cancel' : 'save');
    await p;
    if (outcome === 'saved') {
      assert.equal(x.submitted.length, 1);
      assert.equal(x.submitted[0].model, 'fb_new');
      assert.deepEqual(x.submitted[0].network_criteria, criteria);
    } else assert.deepEqual(x.submitted, [], `network criteria/${outcome}`);
    x.sourceUnchanged(); x.dispose(); cases++;
  }
  // Picker cancel, failure, concurrent Open and edits must never select or submit an old/new stranger.
  for (const action of ['optimize', 'run', 'sweep', 'convergence']) for (const outcome of ['cancel', 'failure', 'open', 'edit']) {
    const x = fixture(); const p = action === 'optimize' ? x.prepare.prepareDesignOptimize(x.live) : x.handler(action).invoke({preventDefault() {}});
    if (outcome === 'open') x.core.takeFile(file('other'));
    if (outcome === 'edit') x.core.edit(d => d.params[0].default = 34);
    if (outcome === 'failure') x.external.reject(Error('Picker/write failed')); else x.external.resolve(outcome === 'cancel' ? 'cancel' : 'save');
    const result = await p;
    if (action === 'optimize') assert.notEqual(result, null, 'cancel/failure is not success');
    assert.deepEqual(x.selected, [], `${action}/${outcome}`); assert.deepEqual(x.submitted, []);
    assert.equal(x.core.file().id, outcome === 'open' ? 'other' : 'legacy');
    if (outcome === 'edit') assert.equal(x.core.draft.params[0].default, 34);
    x.sourceUnchanged(); x.dispose(); cases++;
  }
  // The owned target remains guarded across model refresh, including same-id new hash/scope.
  for (const action of ['optimize', 'run', 'sweep', 'convergence']) for (const outcome of ['close', 'open', 'edit', 'undo-edit', 'hash', 'scope']) {
    const x = fixture({waitRefresh: true}), h = action === 'optimize' ? null : x.handler(action);
    const p = action === 'optimize' ? x.prepare.prepareDesignOptimize(x.live) : h.invoke({preventDefault() {}});
    x.external.resolve('save'); await tick(x.refreshedCalled);
    if (outcome === 'close') h ? h.close() : x.cancel();
    if (outcome === 'open') x.core.takeFile(file('other'));
    if (outcome === 'edit' || outcome === 'undo-edit') {x.core.edit(d => d.params[0].default = 35); if (outcome === 'undo-edit') x.core.undo();}
    if (outcome === 'hash') x.core.setFile({...x.core.file(), hash: 'external-save'});
    if (outcome === 'scope') x.core.setFile({...x.core.file(), backup_scope: 'other-workspace'});
    x.refreshed.resolve(); await p;
    assert.deepEqual(x.selected, [], `${action}/refresh/${outcome}`); assert.deepEqual(x.submitted, []);
    x.dispose(); cases++;
  }
  for (const dirty of [false, true]) {
    const x = fixture({dirty, native: false}); const p = await x.prepare.prepareDesignSubmission();
    assert.equal(p.error, null); assert.equal(p.target.file.id, 'legacy'); assert.equal(p.target.isCurrent(), true);
    assert.equal(x.writes.length, dirty ? 1 : 0, 'legacy clean designs run without forcing a native Save');
    x.core.edit(d => d.params[0].default++); assert.equal(p.target.isCurrent(), false); x.dispose(); cases++;
  }
  console.log(`Saved document submission ownership: ${cases} real session/IO and production preparation/Run/Sweep/Convergence/Elmer boundary cases passed.`);
}
