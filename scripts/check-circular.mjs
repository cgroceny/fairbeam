// Pure CP/schema/display integration. Synthetic complex fields, no solver, DOM or renderer.
// node --experimental-strip-types scripts/check-circular.mjs
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {delimiter, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as THREE from 'three';
import {axialRatioGrid, axialRatioReadouts, AXIAL_RATIO_MASK_DB} from '../src/lib/circular.ts';
import {effectiveQuantity, quantityAvailability, quantityGrid, quantityMax, quantityOffsetDb, quantityRange, quantityUnit} from '../src/lib/farfieldQuantity.ts';
import {validateBundle} from '../src/lib/validate.ts';
import {resultDataTable, comparedResultDataTable} from '../src/designer/resultData.ts';
import {compareCuts, interp} from '../src/compare/series.ts';
import {patternMesh} from '../src/scene/pattern.ts';
import {nearestPolarSample, peakPolarSample} from '../src/charts/polarSamples.ts';
import {patternCsv, farfieldCsv} from '../src/export/csv.ts';
import {cstMacro, DEFAULT_CST_OPTIONS} from '../src/export/cst.ts';
import {designChecks} from '../src/designer/checks.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const python = process.env.FAIRBEAM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const py = code => JSON.parse(execFileSync(python, ['-c', code], {cwd:root, env:{...process.env, PYTHONPATH:[resolve(root,'python'),resolve(root,'python/tests')].join(delimiter)}, encoding:'utf8'}));
const raw = py('import json; from test_designer_circular import synthetic_records; from fairbeam.jsonutil import finite_json; print(json.dumps(finite_json(synthetic_records())))');
const baseline = JSON.parse(readFileSync(new URL('../public/projects/helix-axial.json', import.meta.url),'utf8'));
// validateBundle normalizes its input in place: preserve the strict JSON source
// independently so null-vs-NaN serialization assertions cannot observe a repair.
const bundle = ff => {const b=structuredClone(baseline); b.results.farfield=[structuredClone(ff)]; return b;};
const records = raw.map(ff => {
  const checked=validateBundle(bundle(ff));
  assert.deepEqual(checked.errors,[]);
  const f=checked.bundle.results.farfield[0];
  assert.ok(f.cp,`${ff.name}: valid CP grids survive unavailable point scalars`);
  return {...f,name:ff.name};
});
const named = name => records.find(ff=>ff.name===name);
for(const [name, ar] of [['rhcp',0],['lhcp',0],['linear',60],['elliptical',6.02]]){
  const ff=named(name), b=bundle(ff);
  assert.ok(axialRatioGrid(ff).flat().every(v=>Math.abs(v-ar)<1e-9),name);
  assert.deepEqual(axialRatioReadouts(ff),{peak:ar,boresight:ar});
  assert.equal(quantityAvailability(b,ff,'axial_ratio').ok,true);
  assert.equal(quantityMax(b,ff,'axial_ratio'),60);
  assert.equal(quantityOffsetDb(b,ff,'axial_ratio'),null);
}
assert.ok(named('rhcp').cp.rhcp_dbi[0][0]>named('rhcp').cp.lhcp_dbi[0][0],'Ephi=-j Etheta is RHCP');
assert.ok(named('lhcp').cp.lhcp_dbi[0][0]>named('lhcp').cp.rhcp_dbi[0][0],'Ephi=+j Etheta is LHCP');
assert.equal(quantityUnit('axial_ratio'),'dB');
assert.equal(quantityRange('axial_ratio'),60);
assert.equal(quantityRange('directivity'),30);
assert.equal(quantityUnit('rhcp'),'dBi');
assert.equal(AXIAL_RATIO_MASK_DB,20);
for(const ff of records){
  const grid=axialRatioGrid(ff), original=raw.find(r=>r.name===ff.name);
  for(let i=0;i<ff.theta.length;i++)for(let j=0;j<ff.phi.length;j++){
    const a=original.cp.axial_ratio_db[i][j],d=original.directivity_dbi[i][j];
    const valid=typeof a==='number'&&Number.isFinite(a)&&a>=0&&a<=60&&typeof d==='number'&&Number.isFinite(d)&&d>=original.dmax_dbi-20;
    assert.equal(Number.isFinite(grid[i][j]),valid,`${ff.name} mask ${i},${j}`);
    if(valid)assert.equal(grid[i][j],a);
  }
}
const low=named('low-directivity'), lb=bundle(low), grid=axialRatioGrid(low);
assert.equal(grid[0][1],0,'exact threshold is included');
assert.ok(Number.isNaN(grid[0][2]),'below threshold is a gap');
assert.equal(grid[0][3],0,'above threshold is included');
assert.deepEqual(axialRatioReadouts(named('null-boresight')),{peak:0,boresight:null});
assert.deepEqual(axialRatioReadouts(named('zero')),{peak:null,boresight:null});
assert.deepEqual(axialRatioReadouts(named('off-boresight')),{peak:6.02,boresight:null});
assert.equal(raw.find(f=>f.name==='off-boresight').cp.boresight.axial_ratio_db,null);
const boreCsv=farfieldCsv(bundle(named('off-boresight'))).trimEnd().split(/\r?\n/).map(line=>line.split(','));
assert.equal(boreCsv[1][boreCsv[0].indexOf('axial_ratio_boresight_dB')],'nan','raw CSV keeps its existing unavailable-number marker, never zero');
const noPole=structuredClone(low);noPole.theta=[5,45,90];
assert.equal(axialRatioReadouts(noPole).boresight,null,'first row without theta=0 is not boresight');
const missing=structuredClone(low);delete missing.cp;
for(const ff of [missing,named('zero')]){
  assert.equal(quantityAvailability(bundle(ff),ff,'axial_ratio').ok,false);
  assert.equal(effectiveQuantity(bundle(ff),ff,'axial_ratio'),'directivity');
  assert.ok(quantityGrid(bundle(ff),ff,'axial_ratio').flat().every(Number.isNaN),'comparison never substitutes dBi for missing AR');
}
const corrupt=structuredClone(low);corrupt.cp.axial_ratio_db[0][0]=-1;corrupt.cp.axial_ratio_db[0][1]=61;
assert.ok(axialRatioGrid(corrupt)[0].slice(0,2).every(Number.isNaN));
const malformed=structuredClone(low);malformed.cp.axial_ratio_db.pop();
assert.equal(validateBundle(bundle(malformed)).bundle.results.farfield[0].cp,undefined,'wrong grid shape is still rejected');
const table=resultDataTable(lb,'pattern',low.f,{patternQuantity:'axial_ratio'});
assert.equal(table.header.at(-1),'Axial ratio (dB)');
assert.deepEqual(table.rows.map(r=>r.at(-1)),grid.flat().map(v=>Number.isFinite(v)?v:null));
assert.ok(patternCsv(low).includes('axial_ratio_dB'));
assert.equal(low.cp.axial_ratio_db[0][2],0,'raw CP data are not destroyed by the display mask');
const compared=comparedResultDataTable([{file:'a',bundle:lb},{file:'b',bundle:bundle(missing)}],'pattern',low.f,{patternQuantity:'axial_ratio'});
const arColumn=compared.header.indexOf('Axial ratio (dB)');
assert.ok(arColumn>=0);
assert.ok(compared.rows.slice(table.rows.length).every(r=>r[arColumn]===null));
assert.ok(!comparedResultDataTable([{file:'base-missing',bundle:bundle(missing)},{file:'ref-cp',bundle:lb}],'pattern',low.f,{patternQuantity:'axial_ratio'}).header.includes('Axial ratio (dB)'),'CSV matches base directivity fallback');
const cuts=compareCuts([{bundle:lb,label:'CP'},{bundle:bundle(missing),label:'No CP'}],low.f,0,low,(b,f)=>quantityGrid(b,f,'axial_ratio'));
assert.ok(cuts[1].value.every(Number.isNaN));
for(const q of ['rhcp','lhcp'])assert.ok(compareCuts([{bundle:lb,label:'CP'},{bundle:bundle(missing),label:'No CP'}],low.f,0,low,(b,f)=>quantityGrid(b,f,q))[1].value.every(Number.isNaN),'no total directivity substituted for a missing circular component');
assert.deepEqual(nearestPolarSample({angle:[-30,0,30],value:[6,NaN,3]},0,false),{angle:0,value:NaN});
assert.deepEqual(nearestPolarSample({angle:[-30,0,30],value:[6,NaN,3]},4,false),{angle:0,value:NaN});
assert.deepEqual(nearestPolarSample({angle:[-100,0,100],value:[6,NaN,3]},89,true),{angle:0,value:NaN});
assert.equal(peakPolarSample({angle:[-30,0,30],value:[NaN,NaN,NaN]},false),-1);
assert.equal(peakPolarSample({angle:[-100,0,30],value:[60,NaN,3]},true),2);
for(const q of ['rhcp','lhcp'])assert.equal(quantityAvailability(bundle(named('zero')),named('zero'),q).ok,false);
assert.deepEqual(interp([0,1,2],[0,NaN,6],[0,.5,1,1.5,2]).map(v=>Number.isNaN(v)?null:v),[0,null,null,null,6]);
const colors=[new THREE.Color(0),new THREE.Color(0xffffff)];
const ordinary=patternMesh(low,new THREE.Vector3(),1,colors,false);
assert.equal(ordinary.children[0].geometry.index.count,(low.theta.length-1)*low.phi.length*6);
const masked=patternMesh(low,new THREE.Vector3(),1,colors,false,{values:grid,max:60,range:60,maskMissing:true});
for(const k of masked.children[0].geometry.index.array){
  assert.ok(Number.isFinite(grid[Math.floor(k/(low.phi.length+1))][k%(low.phi.length+1)%low.phi.length]),'every triangle vertex has valid AR');
}
assert.ok(masked.children[0].geometry.index.count<ordinary.children[0].geometry.index.count);
for(const group of [ordinary,masked])group.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});
const parity=py("import json; from designer_fixture import load,case_design; from fairbeam.design_checks import lint; cases=[c for c in load()['cases'] if 'far_field.circular' in c.get('set',{})]; print(json.dumps([{'case':c,'design':case_design(c),'checks':lint(case_design(c))} for c in cases]))");
assert.equal(parity.length,5);
for(const p of parity){
  const serialize=cs=>cs.map(c=>`${c.severity}|${c.code}|${c.path}`).sort();
  assert.deepEqual(serialize(designChecks(p.design)),serialize(p.checks),p.case.name);
  assert.deepEqual(serialize(p.checks),p.case.expect,p.case.name);
}
const cst=flag=>cstMacro(bundle(missing),DEFAULT_CST_OPTIONS,{parametric:{params:[],parts:[],ports:[],far_field:{circular:flag}}});
assert.ok(cst(true).warnings.some(s=>s.includes('far_field.circular is not exported')));
assert.ok(!cst(false).warnings.some(s=>s.includes('far_field.circular is not exported')));
assert.ok(cstMacro(lb).warnings.some(s=>s.includes('far_field.circular is not exported')));
console.log(`Circular polarization: ${records.length} Python synthetic fields, ${parity.length} shared schema cases, IEEE signs, AR mask/cap/gaps, readouts, CSV/compare, CPU geometry and CST-compatible omission passed. No solver or browser.`);
