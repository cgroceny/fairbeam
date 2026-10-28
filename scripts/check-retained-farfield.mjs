// Pure admission/ownership controls: no API calls, browser or native solver.
import assert from 'node:assert/strict';
import { farfieldRequest, retainedSourceJob, retainedViewerFile } from '../src/lib/retainedFarfield.ts';
const cap = { available: true, parent_sha256: 'a'.repeat(64), raw_bytes: 12,
  max_frequencies: 16, max_cells_per_frequency: 65536, max_total_cells_per_port: 262144,
  ports: [{ port: 2, domain: 'TD', band_hz: [1e9, 3e9], recorded_frequencies_hz: [] }] };
let controls = 0;
function check(fn) { fn(); controls++; }
check(() => assert.deepEqual(farfieldRequest('1.5, 2.45', 3, 5, cap).request,
  { frequencies_hz: [1.5e9, 2.45e9], theta_step: 3, phi_step: 5 }));
for (const text of ['', ' ', '0', '-1', 'NaN', 'Infinity', '0x2', '1,', '1,1', Array(17).fill('2').join(',')])
  check(() => assert.equal(farfieldRequest(text, 3, 5, cap).error, 'nf2ff.badFrequencies'));
for (const n of [NaN, 0, .24, 91, Infinity])
  check(() => assert.equal(farfieldRequest('2', n, 5, cap).error, 'nf2ff.badSteps'));
check(() => assert.equal(farfieldRequest('2', .25, .25, cap).error, 'nf2ff.budget'));
check(() => assert.equal(farfieldRequest('3.1', 3, 5, cap).error, 'nf2ff.outsideBand'));
const fd = { ...cap, ports: [{ ...cap.ports[0], domain: 'FD', recorded_frequencies_hz: [2e9] }] };
check(() => assert.equal(farfieldRequest('2.1', 3, 5, fd).error, 'nf2ff.fdOnly'));
check(() => assert.equal(farfieldRequest('2', 3, 5, fd).request.frequencies_hz[0], 2e9));
check(() => assert.equal(farfieldRequest('2', 3, 5, { available: false, reason: 'deleted' }).error, 'nf2ff.unavailable'));
const source = { id: 'one', status: 'done', kind: 'run', bundle: 'one.json', retained_nf2ff: { root: 'not-used-by-client', sha256: 'a' } };
const derivative = { id: 'two', status: 'done', kind: 'postprocess', bundle: 'two.json', postprocess: { source_job_id: 'one' } };
check(() => assert.equal(retainedSourceJob('one.json', [source], true), source));
check(() => assert.equal(retainedSourceJob('two.json', [source, derivative], true), source));
check(() => assert.equal(retainedSourceJob('one.json', [source], false), undefined));
check(() => assert.equal(retainedSourceJob('foreign.json', [source], true), undefined));
check(() => assert.equal(retainedSourceJob('one.json', [{ ...source, kind: 'optimize' }], true), undefined));
check(() => assert.equal(retainedSourceJob('one.json', [{ ...source, status: 'failed' }], true), undefined));
check(() => assert.equal(retainedSourceJob('two.json', [derivative], true), undefined));
check(() => assert.equal(retainedViewerFile('one.json', 'project'), 'one.json'));
check(() => assert.equal(retainedViewerFile('one.json', 'local-file'), undefined));
check(() => assert.equal(retainedViewerFile('one.json', 'generated'), undefined));
check(() => assert.equal(retainedViewerFile('', 'project'), undefined));
console.log(`retained NF2FF: ${controls} pure controls passed; no native or browser execution`);
