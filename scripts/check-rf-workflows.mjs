import assert from "node:assert/strict";
import { powerWaveReflection } from "../src/lib/powerWaves.ts";
const match=powerWaveReflection(20,150,20,-150);
assert.equal(match.magnitude,0); assert.equal(match.transfer,1);
const real=powerWaveReflection(100,0,50,0);
assert.ok(Math.abs(real.re-1/3)<1e-14); assert.ok(Math.abs(real.transfer-8/9)<1e-14);
assert.equal(powerWaveReflection(50,0,0,0),null);
assert.equal(powerWaveReflection(50,0,20,NaN),null);
assert.ok(powerWaveReflection(20,-150,20,-150).magnitude > 0.9);
console.log("RF workflow: conjugate match, real-reference equivalence and reference gating pass");

// Independently reconstruct physical load impedance from admittance, in SI units.
import { equivalentChipLoad } from "../src/lib/chipLoad.ts";
const impedance = (load, hz) => {
  const omega = 2 * Math.PI * hz, conductance = 1 / load.R;
  const susceptance = (load.C ? omega * load.C : 0) - (load.L ? 1 / (omega * load.L) : 0);
  const denominator = conductance ** 2 + susceptance ** 2;
  return { real: conductance / denominator, imag: -susceptance / denominator };
};
for (const [r,x,hz] of [[20,-150,915e6],[20,150,915e6],[50,0,1e9],[2,-0.2,13.56e6],[100,20,2.45e9]]) {
  const load = equivalentChipLoad(r,x,hz);
  assert.ok(load);assert.equal(load.topology,"parallel");
  const actual = impedance(load,hz);
  assert.ok(Math.abs(actual.real-r) < 1e-12*Math.max(r,1));
  assert.ok(Math.abs(actual.imag-x) < 1e-12*Math.max(Math.abs(x),1));
  assert.equal(load.C !== undefined,x<0);assert.equal(load.L !== undefined,x>0);
  if (x) assert.ok(Math.abs(impedance(load,hz/2).imag-x)>Math.abs(x)*0.01,"equivalent is frequency-specific");
  else assert.equal(load.R,r);
}
for (const args of [[0,-150,915e6],[-1,10,1e9],[20,NaN,1e9],[20,10,0],[20,10,-1],[20,10,Infinity],[Infinity,0,1e9],[1e308,1e308,1e9]]) assert.equal(equivalentChipLoad(...args),null);
console.log("Chip load: independently reconstructed parallel impedance, both reactance signs, SI units, frequency dependence and passive gating pass");
