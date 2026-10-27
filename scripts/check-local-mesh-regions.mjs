// Offline structural, expression, identity and independently measured report controls. No solver.
import assert from 'node:assert/strict';
import { localMeshRegionChecks, newLocalMeshRegion, retainLocalMeshRegions } from '../src/designer/localMeshRegions.ts';
import { localMeshReport, localMeshRegionSegments } from '../src/designer/localMeshReport.ts';
import { renameParameter, parameterUses } from '../src/designer/paramRefs.ts';
import { markCarriedMesh } from '../src/designer/meshBottlenecks.ts';
import { mergeChecks } from '../src/designer/checks.ts';
const region = { id: 'feed_1', name: 'Feed gap', start: [0, 0, 0], stop: [1, 1, 1], cell_size: 0.5 };
const check = (r, manual = false, names = {}) => localMeshRegionChecks(r, manual, names);
assert.deepEqual(check(undefined), []); assert.deepEqual(check([]), []);
assert.deepEqual(check([region]), []);
assert.deepEqual(check([{ ...region, start: ['-gap', 0, 0], cell_size: 'gap / 2' }], false, { gap: 0.5 }), []);
for (const value of [null, false, {}, 'box']) assert.equal(check(value)[0].path, 'mesh.local_regions');
for (const value of [true, null, '', ' ', NaN, Infinity]) {
  for (const manual of [false, true]) assert.equal(check([{ ...region, cell_size: value }], manual)[0].path, 'mesh.local_regions[0].cell_size');
}
assert.deepEqual(check([{ ...region, start: [9, 'missing', 'sqrt(-1)'], stop: [1, 1, 1], cell_size: '-gap' }], true), [],
  'manual regions have a storage contract, not active expression/order/domain/positivity checks');
assert.ok(check([{ ...region, cell_size: 'missing' }]).some(x => x.path.endsWith('.cell_size') && x.message.includes('unknown name')));
assert.ok(check([{ ...region, stop: [0, 1, 1] }]).some(x => x.path === 'mesh.local_regions[0].stop[0]' && x.message === 'region stop must be greater than start on every axis'));
assert.ok(check([{ ...region, cell_size: 0 }]).some(x => x.message === 'region cell size must be greater than zero'));
for (const id of ['', '1box', 'bad id', 'a'.repeat(65)]) assert.equal(check([{ ...region, id }])[0].path, 'mesh.local_regions[0].id');
assert.ok(check([region, region]).some(x => x.path === 'mesh.local_regions[1].id'));
assert.equal(check([{ ...region, name: '😀'.repeat(80) }]).length, 0, 'name limit counts Unicode code points');
for (const name of ['', ' ', 'x'.repeat(81), 'x\n', 'x\x7f']) assert.equal(check([{ ...region, name }])[0].path, 'mesh.local_regions[0].name');
for (const start of [[0, 0], [0, 0, 0, 0], null]) assert.equal(check([{ ...region, start }])[0].path, 'mesh.local_regions[0].start');
assert.deepEqual(check(Array.from({ length: 32 }, (_, i) => ({ ...region, id: `r${i}` }))), []);
assert.ok(check(Array.from({ length: 33 }, (_, i) => ({ ...region, id: `r${i}` }))).some(x => x.path === 'mesh.local_regions'));
const structural = { ...check([{ ...region, cell_size: 0 }])[0], severity: 'error' };
const resolved = { code: 'mesh-local-region', path: 'mesh.local_regions[0].stop[0]', severity: 'error', message: 'region must lie inside the mesh domain' };
assert.deepEqual(mergeChecks([structural], [structural, resolved]), [structural, resolved], 'deduplicate cheap checks while retaining the generated-domain refusal');
assert.deepEqual(mergeChecks([], [structural, resolved]), [resolved], 'stale structural errors are replaced by live checks; server-only generated verdicts remain visible');
for (const message of ['captured expressions differ from the resolved mesh regions', 'captured parameter definitions differ from their resolved values']) {
  const capture = { ...resolved, message }; assert.deepEqual(mergeChecks([], [capture]), [capture]);
}
const design = { params: [{ key: 'gap', default: 1 }], mesh: { mode: 'manual', local_regions: [{ ...region, id: 'gap', name: 'gap', start: ['-gap', 0, 0], stop: ['gap', 1, 1], cell_size: 'gap / 2' }],
  automatic: { local_regions: [{ ...region, cell_size: 'gap / 99' }] } } };
assert.deepEqual(parameterUses(design, 'gap'), ['mesh.local_regions[0].start[0]', 'mesh.local_regions[0].stop[0]', 'mesh.local_regions[0].cell_size']);
renameParameter(design, 'gap', 'space');
assert.equal(design.mesh.local_regions[0].cell_size, 'space / 2');
assert.equal(design.mesh.local_regions[0].id, 'gap'); assert.equal(design.mesh.local_regions[0].name, 'gap');
assert.equal(design.mesh.automatic.local_regions[0].cell_size, 'gap / 99', 'obsolete stashed region lists are not authoritative expressions');
const next = retainLocalMeshRegions(design.mesh, { mode: 'design', local_regions: [region] });
assert.equal(next.local_regions, design.mesh.local_regions, 'automatic reconstruction preserves the current list, including inactive edits');
assert.equal(retainLocalMeshRegions({}, { local_regions: [region] }).local_regions, undefined, 'deleting the last region cannot restore a stale list');
const created = newLocalMeshRegion([{ ...region, id: 'region_1' }], 'New', { min: [-10, -20, -30], max: [10, 20, 30] });
assert.equal(created.id, 'region_2'); assert.deepEqual(created.start, [-1, -2, -3]); assert.deepEqual(created.stop, [1, 2, 3]); assert.equal(created.cell_size, 0.5);

// Deliberately nonuniform final grid: finalizers may exceed the insertion ceiling. Bounds touch
// the coarse outside interval; only positive overlap counts, and actual widths are independently read.
const grid = [0, 0.5, 1, 3];
const cfl = 0.0005 / (299792458 * Math.sqrt(3));
const b = { model: { id: 'synthetic-regions' }, units: { length_m: 0.001 }, parts: [],
  mesh: { x: [...grid], y: [...grid], z: [...grid], total_cells: 27,
    auto: { local_refinement: { version: 1, precision: 'float64-round-trip', regions: [{ ...region, max_width: [0.5, 0.5, 0.5] }],
      insertion: { stage: 'after-automatic-probe-alignment', before: { cells: [1, 1, 1], total_cells: 1, timestep_s: cfl * 2 },
        after: { cells: [2, 2, 2], total_cells: 8, timestep_s: cfl }, added_cells: 7, ratio: 8 },
      final: { stage: 'validated-current-grid', cells: [3, 3, 3], total_cells: 27, timestep_s: cfl }, cell_limit: 100,
      grading: { configured_max_ratio: 1.4, baseline_max_ratio: 2, admission_ceiling: 2, insertion_max_ratio: 2, final_max_ratio: 4 } } } } };
const original = structuredClone(b);
assert.equal(localMeshReport(b), b.mesh.auto.local_refinement);
const oneUlp = structuredClone(b); oneUlp.mesh.auto.local_refinement.regions[0].cell_size = 0.49999999999999994;
assert.ok(localMeshReport(oneUlp), 'the declared one-ULP roundoff allowance accepts exactly the adjacent cap');
const twoUlps = structuredClone(b); twoUlps.mesh.auto.local_refinement.regions[0].cell_size = 0.4999999999999999;
assert.equal(localMeshReport(twoUlps), null, 'a second ULP cannot become a loose relative tolerance');
const points = localMeshRegionSegments(localMeshReport(b)); assert.equal(points.length, 72);
for (let i = 0; i < points.length; i += 6) {
  const from = points.slice(i, i + 3), to = points.slice(i + 3, i + 6);
  assert.equal(from.filter((v, k) => v !== to[k]).length, 1, 'each segment is one box edge');
  assert.ok([...from, ...to].every(v => v === 0 || v === 1));
}
assert.deepEqual(b, original, 'inspection never mutates source axes or report');
for (const change of [
  x => { x.mesh.total_cells = 26; }, x => { x.mesh.x[1] = 0; }, x => { x.mesh.x[1] = NaN; },
  x => { x.mesh.auto.local_refinement.version = 2; },
  x => { x.mesh.auto.local_refinement.insertion.added_cells++; },
  x => { x.mesh.auto.local_refinement.insertion.before.total_cells = 2; },
  x => { x.mesh.auto.local_refinement.final.cells[0]++; },
  x => { x.mesh.auto.local_refinement.final.timestep_s *= 2; },
  x => { x.mesh.auto.local_refinement.cell_limit = 26; },
  x => { x.mesh.auto.local_refinement.grading.insertion_max_ratio = 3; },
  x => { x.mesh.auto.local_refinement.grading.final_max_ratio = 3; },
  x => { x.mesh.auto.local_refinement.regions[0].stop[0] = 1.001; },
  x => { x.mesh.auto.local_refinement.regions[0].start[0] = -1; },
  x => { x.mesh.auto.local_refinement.regions[0].max_width[0] = 0.49; },
  x => { x.mesh.auto.local_refinement.regions[0].cell_size = 0.499999999; },
  x => { x.mesh.auto.local_refinement.regions.push({ ...x.mesh.auto.local_refinement.regions[0] }); },
]) { const invalid = structuredClone(b); change(invalid); assert.equal(localMeshReport(invalid), null, change.toString()); }
assert.equal(localMeshReport(markCarriedMesh(structuredClone(b))), null, 'a carried draft mesh cannot draw current-region boxes');
assert.equal(localMeshReport({ ...b, mesh: { ...b.mesh, auto: undefined } }), null, 'legacy meshes do not invent evidence');
const meters = structuredClone(b); meters.units.length_m = 1; meters.mesh.auto.local_refinement.final.timestep_s *= 1000;
assert.ok(localMeshReport(meters), 'CFL uses declared model units; overlay coordinates stay in drawing units');
assert.deepEqual(localMeshRegionSegments(localMeshReport(meters)), points);
console.log('Local mesh regions: structural/active/manual, expression rename, current-list ownership, exact axes/overlap/cap/CFL/stage provenance, invalid and stale controls passed.');
