import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportSimulationSettings, importSimulationSettings } from '../src/designer/settingsTransfer.ts';
import { exportOptimizationSettings, importOptimizationSettings } from '../src/runner/optimizationSettings.ts';
import { settingsData, SETTINGS_FILE_LIMIT } from '../src/lib/settingsFile.ts';

const base = JSON.parse(readFileSync(new URL('../examples/designs/hf_dipole_7mhz.design.json', import.meta.url)));
const original = JSON.stringify(base);
const saved = exportSimulationSettings(base);
assert.deepEqual(importSimulationSettings(saved, base), { mesh: base.mesh, simulation: base.simulation });
const other = structuredClone(base);
other.model.name = 'A different design';
other.mesh = {mode: 'design', overrides: {pad: .8}};
other.simulation.max_timesteps = 1234;
const geometry = JSON.stringify([other.model, other.params, other.parts, other.ports, other.far_field]);
Object.assign(other, importSimulationSettings(saved, other));
assert.deepEqual(other.mesh, base.mesh);
assert.equal(JSON.stringify([other.model, other.params, other.parts, other.ports, other.far_field]), geometry);
assert.equal(JSON.stringify(base), original, 'export/import must never mutate their source/destination');
const reject = change => {
  const data = JSON.parse(saved); change(data);
  assert.throws(() => importSimulationSettings(JSON.stringify(data), base));
  assert.equal(JSON.stringify(base), original, 'refusal is atomic');
};
for (const change of [
  x => x.schema = 'fairbeam.simulation-settings/2', x => x.units = 'm/Hz',
  x => x.mesh = null, x => x.mesh.overrides = [], x => x.mesh.unknown = 3,
  x => x.mesh = {mode:'manual', lines:{x:[1,0],y:[0,1],z:[0,1]}},
  x => x.mesh = {mode:'manual'}, x => x.mesh = {mode:'design',overrides:{pad:'not_a_parameter'}},
  x => x.mesh = {mode:'auto',cells_per_wavelength:-1}, x => x.mesh.local_regions = [null],
  x => x.mesh = {mode:'design',overrides:{dielectric_cells:'missing_parameter'}},
  x => x.mesh = {mode:'design',overrides:{dielectric_cells:21}},
  x => x.mesh = {mode:'design',overrides:{dielectric_cells:2.5}},
  x => x.mesh = {mode:'design',overrides:{dielectric_cells:null}},
  x => x.mesh = {mode:'manual',lines:{x:[0,1],y:[0,1],z:[0,1]},automatic:{mode:'design',overrides:{pad:'missing_parameter'}}},
  x => x.simulation = null, x => x.simulation.f_min = 999, x => x.simulation.boundaries = ['MUR'],
  x => x.simulation.max_timesteps = 1.2, x => x.simulation.end_criteria_db = 0,
  x => x.parameters = [{key:'missing',unit:'mm'}], x => x.parts = [],
]) reject(change);
const parametrized = structuredClone(base);
parametrized.params.push({key:'portablePad',default:0.4,unit:''});
parametrized.mesh = {mode:'design',overrides:{pad:'portablePad'}, local_regions:[{id:'near',name:'Near feed',start:[-1,-1,-1],stop:[1,1,1],cell_size:1}]};
const parameterFile = exportSimulationSettings(parametrized);
assert.deepEqual(importSimulationSettings(parameterFile,parametrized).mesh,parametrized.mesh);
assert.throws(()=>importSimulationSettings(parameterFile,base),/incompatible/);
const wrongUnit=structuredClone(parametrized);wrongUnit.params.at(-1).unit='mm';
assert.throws(()=>importSimulationSettings(parameterFile,wrongUnit),/incompatible/);
for (const mode of ['auto','manual']) {
  const design=structuredClone(base);design.ports=[];
  design.mesh=mode==='auto'?{mode,cells_per_wavelength:20,pad:0.3}: {mode,lines:{x:[-20000,0,20000],y:[-20000,0,20000],z:[-20000,0,20000]},automatic:{mode:'design',overrides:{pad:.4}}};
  assert.deepEqual(importSimulationSettings(exportSimulationSettings(design),design).mesh,design.mesh);
  if (mode === 'manual') {
    design.mesh.automatic = {mode:'auto',cells_per_wavelength:24,pad:7494.81145,edge_rule:'thirds',max_ratio:1.4,air_cells_per_wavelength:21,refine_features:false};
    assert.deepEqual(importSimulationSettings(exportSimulationSettings(design),design).mesh,design.mesh,
      'manual meshes imported from macros retain legacy automatic settings');
  }
}
assert.throws(()=>settingsData(' '.repeat(SETTINGS_FILE_LIMIT+1)));
for(const text of ['null','[]','{','1'])assert.throws(()=>settingsData(text));
reject(x=>Object.defineProperty(x.mesh,'__proto__',{value:{polluted:true},enumerable:true}));
assert.equal({}.polluted,undefined);

const specs=[{key:'length',unit:'mm',type:'float'}];
const form={vary:[{key:'length',min:'10',max:'20',start:'15'}],goals:[{kind:'f0',target:'2.45',at:'',weight:'1',i:'',j:''}],method:'auto',maxEvals:12,excite:'auto'};
const optFile=exportOptimizationSettings(form,specs);
assert.deepEqual(importOptimizationSettings(optFile,specs),form);
for(const change of [x=>x.schema='new',x=>x.settings.method='unknown',x=>x.settings.vary.push(x.settings.vary[0]),
  x=>x.settings.goals[0].kind='unknown',x=>x.settings.goals[0].target=null,x=>x.settings.maxEvals=1.5,
  x=>x.settings.goals[0].atHiInvalid=true,x=>x.parameters[0].unit='m',x=>x.parameters[0].type='int',
  x=>x.parameters=[],x=>x.settings.vary=[],x=>x.settings.vary[0].min='',x=>x.settings.goals=Array(5).fill(x.settings.goals[0])]) {
  const data=JSON.parse(optFile);change(data);
  assert.throws(()=>importOptimizationSettings(JSON.stringify(data),specs));
}
assert.throws(()=>importOptimizationSettings(optFile,[]),/incompatible/);
assert.deepEqual(form,JSON.parse(optFile).settings);
console.log('settings transfer: round trips, geometry preservation, parameter compatibility, malformed inputs, schema/size limits and atomic refusals passed');
