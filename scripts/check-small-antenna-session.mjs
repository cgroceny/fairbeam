// node --conditions=browser --experimental-strip-types scripts/check-small-antenna-session.mjs
// Reactive ownership and export controls, independent analytical inputs, no browser or solver.
import assert from 'node:assert/strict';
import { createRoot, createSignal } from 'solid-js';
import { createSmallAntennaSession } from '../src/lib/smallAntennaSession.ts';
import { smallAntennaColumns } from '../src/lib/smallAntenna.ts';
import { smallAntennaResultColumns, SmallAntennaSnapshotError } from '../src/lib/smallAntennaResult.ts';
import { postprocessPorts } from '../src/lib/portPostprocess.ts';
import { activeResultDataTable, copyResultData, resultDataCsv } from '../src/designer/resultData.ts';
import { smallAntennaFixture, parseDelimited } from './scenarios/small-antenna-fixture.mjs';

const a = smallAntennaFixture(), b = smallAntennaFixture({ f0: 1.2e9, q: 30, scale: 2, name: 'Synthetic second run' });
const original = JSON.stringify(a);
createRoot(dispose => { try {
  const [source, setSource] = createSignal(a), [identity, setIdentity] = createSignal('doc-a\nrun-a.json'), [compare, setCompare] = createSignal(false);
  const x = createSmallAntennaSession(source, { identity, comparing: compare });
  const y = createSmallAntennaSession(() => b);
  assert.ok(x.analysis().q.qz > 19.99 && x.analysis().q.qz < 20.01, 'analytical RLC Q=20');
  assert.equal(x.analysis().provenance.port, 7, 'sparse physical port is retained');
  assert.deepEqual(x.options().selectedPartIndices, [0, 1]);
  x.selectPart(1, false); x.setVswr('1.5');
  assert.deepEqual(x.options().selectedPartIndices, [0]);
  assert.equal(x.analysis().geometry.radiusM, 0.0025, '3-by-4 planar enclosing radius');
  assert.equal(y.options().vswr, 2); assert.deepEqual(y.options().selectedPartIndices, [0, 1]);
  const captured = x.snapshot(a, 'run-a.json');
  assert.equal(captured.selection, 'current'); assert.ok(Object.isFrozen(captured.analysis));
  assert.throws(() => captured.analysis.geometry.selectedPartIndices.push(1), TypeError);
  assert.throws(() => x.options().selectedPartIndices.push(1), TypeError);
  setCompare(true); x.setVswr('4'); x.selectAllParts();
  assert.equal(x.options().vswr, 1.5); assert.deepEqual(x.options().selectedPartIndices, [0]);
  const other = x.snapshot(b, 'run-b.json');
  assert.equal(other.selection, 'default'); assert.equal(other.analysis.bandwidth.vswr, 2);
  assert.ok(other.analysis.q.qz > 29.99 && other.analysis.q.qz < 30.01);
  setCompare(false); assert.equal(x.options().vswr, 1.5);
  x.setVswr(''); assert.ok(x.invalidVswr()); assert.equal(x.analysis().bandwidth.predicted.hz, null);
  x.setVswr('', true); assert.ok(x.invalidVswr());
  x.setVswr('2'); assert.ok(!x.invalidVswr());
  x.selectPart(0, false); assert.equal(x.analysis().geometry.radiusM, null);
  x.selectAllParts(); assert.equal(x.options().selectedPartIndices.length, 2);
  const projected = postprocessPorts(a, { referenceOhm: 75, delayPs: { 7: 10 } }).bundle;
  assert.ok(projected); setSource(projected);
  assert.equal(x.analysis().reason, 'projected-plane'); assert.equal(x.analysis().q.qz, null);
  setSource(a); assert.equal(x.options().vswr, 2); assert.deepEqual(x.options().selectedPartIndices, [0, 1]);
  x.setVswr('1.8'); setIdentity('doc-a\nrun-b.json'); assert.equal(x.options().vswr, 2);
  x.setVswr('1.8'); setSource(structuredClone(a)); assert.equal(x.options().vswr, 2, 'same-name source replacement resets');
  setSource(null); assert.equal(x.analysis(), null); assert.equal(x.editable(), false); x.setVswr('7');
  setSource(a); assert.equal(x.options().vswr, 2);
  const multiple = smallAntennaFixture({ multiple: true }); setSource(multiple);
  assert.equal(x.analysis().reason, 'choose-resonance'); assert.equal(x.analysis().selectedCandidateId, null);
  assert.equal(x.analysis().q.qz, null); assert.equal(x.analysis().candidates.filter(candidate => candidate.available).length, 2);
  const chosen = x.analysis().candidates[1]; x.selectResonance(chosen.id);
  assert.equal(x.analysis().selectedCandidateId, chosen.id); assert.ok(Math.abs(x.analysis().q.f0Hz - 1.04e9) < 1);
  x.selectResonance('other-source-id'); assert.equal(x.analysis().selectedCandidateId, chosen.id);
  x.selectResonance(null); assert.equal(x.analysis().reason, 'choose-resonance');
  setSource(a);
  const [focus, setFocus] = createSignal({ view: 'impedance', file: 'run-a', f: 1 });
  const derived = createSmallAntennaSession(() => { focus(); return a; }, { identity: () => focus().file });
  derived.setVswr('1.7'); derived.selectPart(1, false);
  const revision = derived.revision(), saved = derived.analysis();
  setFocus({ view: 'summary', file: 'run-a', f: 2 });
  assert.equal(derived.revision(), revision); assert.equal(derived.analysis(), saved);
  assert.equal(derived.options().vswr, 1.7); assert.deepEqual(derived.options().selectedPartIndices, [0]);

  const snapshots = [captured, other], columns = smallAntennaResultColumns(a, snapshots, 'run-a.json');
  assert.throws(() => smallAntennaResultColumns(structuredClone(a), snapshots), SmallAntennaSnapshotError);
  assert.throws(() => smallAntennaResultColumns(a, snapshots, 'wrong-file.json'), SmallAntennaSnapshotError);
  const runs = [{ file: 'run-a.json', bundle: a }, { file: 'run-b.json', bundle: b }];
  const summary = activeResultDataTable(a, 'summary', undefined, runs, { smallAntenna: snapshots });
  for (const [index, snapshot] of snapshots.entries()) {
    const expected = smallAntennaColumns(snapshot.analysis);
    expected.header.forEach((name, col) => assert.equal(summary.rows[index][summary.header.indexOf(name)], expected.row[col], name));
  }
  const reordered = activeResultDataTable(b, 'summary', undefined, runs.toReversed(), { smallAntenna: snapshots });
  assert.deepEqual(reordered.rows[1].slice(-columns.row.length), summary.rows[0].slice(-columns.row.length));
  const impedance = activeResultDataTable(a, 'impedance', undefined, undefined, { smallAntenna: snapshots });
  assert.equal(impedance.rows.length, a.results.frequency.length);
  columns.header.forEach((name, col) => assert.equal(impedance.rows[0][impedance.header.indexOf(name)], columns.row[col], name));
  const previousQ = captured.analysis.q.qz; x.setVswr('3');
  assert.equal(captured.analysis.bandwidth.vswr, 1.5); assert.equal(captured.analysis.q.qz, previousQ);
  assert.equal(JSON.stringify(a), original, 'analysis/state/export do not mutate result bytes');
  derived.dispose(); assert.equal(derived.analysis(), null); derived.setVswr('9'); assert.equal(derived.editable(), false);
} finally { dispose(); } });

// Copy TSV and CSV retain quotes/tabs/newlines without creating new records.
const odd = smallAntennaFixture(); odd.parts[0].name = 'Same, "quoted"\tpart\nline'; odd.parts[1].name = odd.parts[0].name;
const table = activeResultDataTable(odd, 'summary');
const csv = parseDelimited(resultDataCsv(table));
assert.equal(csv.length, 2); assert.ok(csv.every(row => row.length === table.header.length));
let copied = '';
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { copied = text; } } } });
try {
  assert.equal((await copyResultData(odd, 'summary')).ok, true);
  assert.deepEqual(parseDelimited(copied, '\t'), csv);
} finally { if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator; }
console.log('Small-antenna session/export: reactive ownership, source/plane reset, isolated compare, immutable full-precision snapshots and quoted CSV/TSV passed. Analytical software controls only.');
