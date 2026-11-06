import assert from 'node:assert/strict';
import { antennaDimensions, calculatorRecord } from '../src/home/antennaDimensions.ts';
import { antennaDraft } from '../src/home/antennaDraft.ts';
import { paramValues, evaluate } from '../src/designer/expr.ts';
import { designChecks } from '../src/designer/checks.ts';
const input = { kind: 'dipole', frequencyGHz: .3, shortening: 1, epsilonR: 4.3, heightMm: 1.6 };
const dimensions = i => { const r = antennaDimensions(i); assert.equal(r.ok, true); return r.dimensions; };
const close = (a,b,tol=1e-8) => assert.ok(Math.abs(a-b)<tol, `${a} != ${b}`);
const dipole = dimensions(input);
close(dipole.wavelengthMm, 999.3081933333333);
close(dipole.lengthMm, 499.65409666666665);
close(dipole.armMm, dipole.lengthMm/2);
close(dimensions({...input,kind:'monopole'}).lengthMm,dipole.lengthMm/2);
close(dimensions({...input,frequencyGHz:.6}).lengthMm,dipole.lengthMm/2);
close(dimensions({...input,shortening:.95}).lengthMm,.95*dipole.lengthMm);
const patch = dimensions({...input,kind:'patch',frequencyGHz:2.45});
assert.ok(patch.widthMm > 37.5 && patch.widthMm < 37.7);
assert.ok(patch.lengthMm > 29.0 && patch.lengthMm < 29.3);
assert.ok(patch.effectivePermittivity > 1 && patch.effectivePermittivity < 4.3);
const scaled = dimensions({...input,kind:'patch',frequencyGHz:4.9,heightMm:.8});
close(scaled.lengthMm, patch.lengthMm/2);
close(scaled.widthMm, patch.widthMm/2);
close(scaled.effectivePermittivity,patch.effectivePermittivity);
for(const frequencyGHz of [0,-1,NaN,Infinity,1e9]) assert.equal(antennaDimensions({...input,frequencyGHz}).ok,false);
for(const shortening of [0,.49,1.01,NaN]) assert.equal(antennaDimensions({...input,shortening}).ok,false);
for(const heightMm of [0,-1,NaN,1e6]) assert.equal(antennaDimensions({...input,kind:'patch',heightMm}).ok,false);
for(const epsilonR of [.99,21,NaN]) assert.equal(antennaDimensions({...input,kind:'patch',epsilonR}).ok,false);
const record=calculatorRecord(input);
assert.equal(record.simulated,false);
assert.deepEqual(record.dimensions,dipole);
assert.equal(record.units.length,'mm');
assert.throws(()=>calculatorRecord({...input,frequencyGHz:NaN}));
console.log('antenna calculator: analytical controls, scaling, input refusal, export PASS');
for(const kind of ['dipole','monopole','patch']) for(const frequencyGHz of [0.0071,0.3,2.45]) {
 const source={...input,kind,frequencyGHz},before=JSON.stringify(source);
 const draft=antennaDraft(source,'calculated_antenna','Calculated antenna');
 const values=paramValues(draft.params);assert.deepEqual(Object.keys(values.errors),[]);
 assert.deepEqual(designChecks(draft).filter(c=>c.severity==='error'),[]);
 close(values.names.L,dimensions(source).lengthMm);
 if(kind==='patch') {
   close(values.names.W,dimensions(source).widthMm);
   assert.equal(draft.materials.find(m=>m.name==='substrate').eps_r,'eps_r');
 } else {
   assert.ok(values.names.g<values.names.L/2);
   const originalLength=values.names.L;
   draft.params.find(p=>p.key==='f0').default*=2;
   close(paramValues(draft.params).names.L,originalLength/2);
   if(kind==='monopole')assert.match(draft.model.description,/finite.*ground/i);
 }
 assert.equal(draft.ports.length,1);assert.equal(draft.ports[0].direction,'z');
 const env=paramValues(draft.params).names;
 assert.ok(evaluate(draft.ports[0].stop[2],env)>evaluate(draft.ports[0].start[2],env));
 assert.equal(JSON.stringify(source),before,'draft creation does not alter calculator inputs');
 assert.match(draft.model.description,/no simulated performance/i);
}
for(const bad of [{frequencyGHz:NaN},{shortening:0},{kind:'unknown'},{kind:'patch',epsilonR:0}])
 assert.throws(()=>antennaDraft({...input,...bad},'calculated_antenna','Calculated antenna'));
console.log('antenna drafts: three editable geometries, nine frequency/type cases, parameter scaling, units, feeds and invalid input refusal PASS; no solver run');
