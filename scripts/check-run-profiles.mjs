import assert from 'node:assert/strict';
import { applyRunProfile, runProfileSupported, RUN_PROFILES } from '../src/designer/runProfiles.ts';

const base = {mesh:{mode:'design',overrides:{pad:0.4,edge_rule:'thirds'},thin_metal:'sheet'},
  simulation:{f_min:1,f_max:3,end_criteria_db:-50,max_timesteps:50000,boundaries:'PML_8'},
  parts:[{name:'patch'}],ports:[{name:'feed'}],far_field:{enabled:true,frequencies:[2.4]}};
for(const profile of Object.keys(RUN_PROFILES)){
 const d=structuredClone(base), p=RUN_PROFILES[profile];
 assert.equal(applyRunProfile(d,profile),true);
 assert.equal(d.mesh.overrides.cells_per_wavelength,p.cpw);
 assert.equal(d.simulation.end_criteria_db,p.endDb);
 assert.deepEqual({...d.simulation,end_criteria_db:-50},base.simulation,'band/boundaries/timestep cap unchanged');
 assert.deepEqual(d.parts,base.parts);assert.deepEqual(d.ports,base.ports);assert.deepEqual(d.far_field,base.far_field);
 assert.equal(d.mesh.overrides.pad,0.4);assert.equal(d.mesh.thin_metal,'sheet');
}
const manual={...structuredClone(base),mesh:{mode:'manual',lines:{x:[0,1],y:[0,1],z:[0,1]}}};
const before=JSON.stringify(manual);
assert.equal(runProfileSupported(manual),false);assert.equal(applyRunProfile(manual,'quick'),false);
assert.equal(JSON.stringify(manual),before,'manual mesh is never replaced');
const legacy={...structuredClone(base),mesh:{cells_per_wavelength:20,pad:0.25}};
applyRunProfile(legacy,'quick');assert.equal(legacy.mesh.cells_per_wavelength,10);assert.equal(legacy.mesh.pad,0.25);
assert.equal(legacy.mesh.mode,undefined,'legacy mesher stays legacy');
// the presets stop where the solver field's hint and the end-criterion check say they should
// ("−40 quick, −60 accurate"; docs/RESULTS.md, End criterion)
import { readFileSync } from 'node:fs';
const en=JSON.parse(readFileSync(new URL('../src/i18n/en.json',import.meta.url),'utf8'));
const hinted=(text)=>{const m=/[−-](\d+) quick, [−-](\d+) accurate/.exec(text);assert.ok(m,`no quick/accurate pair in ${text}`);return {quick:-Number(m[1]),accurate:-Number(m[2])};};
for(const key of ['sim.solver.endHint','checks.msg.end-criterion.above']){
 const h=hinted(en[key]);
 assert.equal(RUN_PROFILES.quick.endDb,h.quick,`Quick exploration stops at the ${key} quick value`);
 assert.equal(RUN_PROFILES.verification.endDb,h.accurate,`Verification stops at the ${key} accurate value`);
}
assert.equal(RUN_PROFILES.quick.cpw,10,'Quick exploration keeps 10 cells per wavelength');
assert.ok(RUN_PROFILES.quick.endDb<=RUN_PROFILES.balanced.endDb&&RUN_PROFILES.balanced.endDb>=RUN_PROFILES.verification.endDb,'criteria get stricter towards verification');
console.log('run profiles: explicit mesh/criterion changes preserve model, band, boundaries and manual mesh');
