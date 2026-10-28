// Synthetic controls and cross-language fixture parity. No browser or native SDK.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateRequirements, validateRequirements, requirementsToGoals, requirementSegments } from '../src/lib/requirements.ts';
import { registerPortProjection } from '../src/lib/portProcessingMetadata.ts';

const data = JSON.parse(readFileSync(new URL('../python/tests/fixtures/requirements_parity.json', import.meta.url), 'utf8'));
const spec = goal => ({ schema: 'fairbeam.requirements/1', items: [{ id: 'spec', goal }] });
const change = (value, changes = []) => {
  const out = structuredClone(value);
  for (const item of changes) {
    let parent = out;
    for (const key of item.path.slice(0, -1)) parent = parent[key];
    const key = item.path.at(-1);
    if (item.remove) delete parent[key]; else parent[key] = structuredClone(item.value);
  }
  return out;
};
let checks = 0;
const equal = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
const near = (a, b, label) => { assert.ok(Number.isFinite(a) && Math.abs(a-b) <= 1e-10 * Math.max(1, Math.abs(b)), `${label}: ${a} != ${b}`); checks++; };
const outputs = data.cases.map(c => {
  const evaluation = evaluateRequirements(spec(c.goal), change(data.base, c.changes), change(data.context, c.contextChanges));
  for (const k of ['metric', 'status', 'energy', 'mesh']) if (k in c.expect) equal(evaluation[k], c.expect[k], `${c.name}:${k}`);
  if (c.expect.parseReason) {
    equal(evaluation.reason, c.expect.parseReason, c.name); equal(evaluation.items, [], c.name);
  } else {
    const item = evaluation.items[0];
    for (const k of ['reason', 'samples', 'lowerBound']) if (k in c.expect) equal(item[k], c.expect[k], `${c.name}:${k}`);
    if ('value' in c.expect) near(item.value, c.expect.value, c.name);
    if ('reciprocal' in c.expect) equal(item.sources[0].reciprocal, c.expect.reciprocal, c.name);
  }
  return { name: c.name, evaluation };
});

const g = { kind: 'sij_min', target: -6.0123456789, at: 2.00000011, at_hi: 2.00000012, ports: [4, 2], weight: 2.123456789 };
const original = spec(g), converted = requirementsToGoals(original);
equal(converted.goals, [g], 'numeric roundtrip');
equal(converted.f0TolerancePct, .25, 'optimizer f0 default retained');
equal(converted.qualificationRequired, true, 'conversion not certification');
converted.goals[0].ports[0] = 99;
equal(original.items[0].goal.ports, [4, 2], 'no conversion alias');
const close = spec({ kind: 'sij_min', target: -6, at: 2.00000011, ports: [4, 2] });
close.items.push({ id: 'second', goal: { ...close.items[0].goal, at: 2.00000012 } });
const values = evaluateRequirements(close, data.base, data.context).items;
equal(values[0].value === values[1].value, false, 'display rounding does not merge identities');

const valid = spec({ kind: 's11_max', target: -10, at: 2.5 });
for (const s of [null, {}, { ...valid, schema: 'future/2' }, { ...valid, extra: true }, { ...valid, items: [...valid.items, ...valid.items] }]) equal(validateRequirements(s).ok, false, 'invalid schema');
for (const bad of [NaN, Infinity, -Infinity, true, '-10', null]) equal(validateRequirements(spec({ kind: 's11_max', target: bad, at: 2.5 })).ok, false, 'invalid numeric target');
for (const bad of [NaN, Infinity, true, '2', null]) {
  const b = structuredClone(data.base); b.results.sparams.s['1,1'].re[1] = bad;
  equal(evaluateRequirements(valid, b, data.context).metric, 'unknown', 'corrupt trace');
}
equal(evaluateRequirements(valid, data.base).reason, 'source-mismatch', 'missing snapshot identity');
equal(evaluateRequirements({ schema: 'fairbeam.requirements/1', items: [] }, data.base, data.context).status, 'unknown', 'empty is not pass');
const mask = spec({ kind: 'sij_min', target: -3, at: 2.4, at_hi: 2.48, ports: [4, 2] });
equal(requirementSegments(mask), [{ id: 'spec', kind: 'sij_min', ports: [4, 2], fromHz: 2.4e9, toHz: 2.48e9, valueDb: -3, direction: 'min' }], 'bounded physical mask');
delete mask.items[0].goal.at_hi;
equal(requirementSegments(mask)[0].fromHz, requirementSegments(mask)[0].toHz, 'point is not global line');
equal(requirementSegments(spec({ kind: 'dmax_min', target: 2, at: 2.5 })), [], 'no invented radiation band');
const duplicate = structuredClone(data.base); duplicate.results.farfield.push(structuredClone(duplicate.results.farfield[0]));
equal(evaluateRequirements(spec({ kind: 'dmax_min', target: 2, at: 2.5 }), duplicate, data.context).items[0].reason, 'missing-exact-field', 'duplicate field refused');
const projection = structuredClone(data.base);
registerPortProjection(projection, { source: data.base, settings: { referenceOhm: 75, delayPs: {} }, physicalPorts: [2, 4], sourceReferences: [50, 50], missingSamples: 0, description: 'synthetic reference change', channels: [], primaryIndex: 1 });
equal(evaluateRequirements(valid, projection, data.context).reason, 'invalid-spectrum', 'session projection cannot inherit native source identity');
const large = structuredClone(data.base); large.results.frequency = Array.from({ length: 16000 }, (_, i) => 2e9+i);
const many = { schema: 'fairbeam.requirements/1', items: Array.from({ length: 64 }, (_, i) => ({ id: `r${i}`, goal: { kind: 'match_all', target: -10, at: 2 } })) };
equal(evaluateRequirements(many, large, data.context).reason, 'work-limit', 'bounded work refusal before trace sampling');

// The Python fixture result is produced serially by test_requirements.py --dump <path>.
// Compare all fields recursively; only floating-point arithmetic has a numeric tolerance.
const pythonPath = process.argv[2];
if (pythonPath) {
  const compare = (a, b, path = '') => {
    if (typeof a === 'number' && typeof b === 'number') return near(a, b, path);
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      equal(Object.keys(a).sort(), Object.keys(b).sort(), path);
      for (const k of Object.keys(a)) compare(a[k], b[k], `${path}.${k}`);
    } else equal(a, b, path);
  };
  compare(outputs, JSON.parse(readFileSync(pythonPath, 'utf8')), 'Python/TypeScript parity');
}
console.log(`PASS requirements: ${checks} assertions; ${outputs.length} synthetic fixtures${pythonPath ? '; full Python/TypeScript parity' : '; Python parity not requested'}. No solver or browser run.`);
