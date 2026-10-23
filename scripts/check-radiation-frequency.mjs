// Focused pure Python -> strict JSON -> TS -> CSV/report contracts. No browser, renderer or solver.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {radiationBands, radiationPatternPoints, radiationTable, validRadiationSweep, sampledArIntervals, RADIATION_QUANTITIES, radiationUnit} from '../src/lib/radiationFrequency.ts';
import {nearestStoredIndex} from '../src/charts/storedSamples.ts';
import {validateBundle} from '../src/lib/validate.ts';
import {resultDataTable, comparedResultDataTable} from '../src/designer/resultData.ts';
import {radiationFrequencyCsv, parseCsv} from '../src/export/csv.ts';
import {packageFiles, PACKAGE_GROUPS} from '../src/export/package.ts';
import {reportPages} from '../src/export/reportPdf.ts';

const root=fileURLToPath(new URL('..',import.meta.url));
const python=process.env.FAIRBEAM_PYTHON||(process.platform==='win32'?'python':'python3');
const records=JSON.parse(execFileSync(python,['python/tests/test_radiation_frequency.py','--json'],{cwd:root,encoding:'utf8'}));
const original=JSON.parse(readFileSync(new URL('../public/projects/helix-axial.json',import.meta.url),'utf8'));
const named=name=>structuredClone(records.find(r=>r.name===name));
// Synthetic metadata only, independently specified accepted-power controls.
const trusted=name=>({...named(name),reliable:[true,true,true],pacc_error:[.02,.03,.04]});
const bundle=(...sweeps)=>{const b=structuredClone(original);b.results.efficiency=sweeps;b.results.farfield=[];return b;};
const baseline=trusted('baseline'), b=bundle(baseline);
assert.ok(records.every(validRadiationSweep));
assert.deepEqual(radiationBands(bundle(named('baseline')))[0].samples.map(s=>s.reliability),['unassessed','unassessed','unassessed']);
assert.ok(radiationBands(bundle(named('baseline')))[0].samples.every(s=>s.values.d_peak_dbi===null));
const band=radiationBands(b)[0];
assert.equal(band.port,7,'physical port is not a dense matrix index');
for(let i=0;i<3;i++){
  const s=band.samples[i], eta=[.5,.8,1.1][i], mismatch=1-[.1,.2,.3][i]**2;
  const close=(a,e)=>assert.ok(Math.abs(a-e)<=.00051,`${a} != ${e}`);
  close(s.values.d_peak_dbi,10*Math.log10(4));
  close(s.values.d_boresight_dbi,10*Math.log10(4)-20);
  close(s.values.gain_peak_dbi,10*Math.log10(4*eta));
  close(s.values.realized_peak_dbi,10*Math.log10(4*eta*mismatch));
  assert.equal(s.theta,90);assert.equal(s.phi,0);
  assert.equal(s.values.ar_peak_db,6.021);assert.equal(s.values.ar_boresight_db,0);
}
const bad=radiationBands(bundle(named('unreliable')))[0].samples;
assert.deepEqual(bad.map(s=>s.reliability),['accepted-power-pass','unreliable','unreliable']);
assert.ok(bad[1].raw.realized_peak_dbi!==null);assert.equal(bad[1].values.realized_peak_dbi,null);
const contradictory=trusted('baseline');contradictory.pacc_error=[.100001,null,-.1];
assert.deepEqual(radiationBands(bundle(contradictory))[0].samples.map(s=>s.reliability),['unreliable','unassessed','unreliable']);
const nonpositive=trusted('baseline');nonpositive.pacc_w=[0,-1,NaN];
assert.ok(radiationBands(bundle(nonpositive))[0].samples.every(s=>s.values.d_peak_dbi===null));
for(const name of ['cp-off','cp-missing'])assert.ok(radiationBands(bundle(trusted(name)))[0].samples.every(s=>s.values.ar_peak_db===null));
assert.equal(radiationBands(bundle(trusted('gapped-mismatch')))[0].samples[1].values.realized_peak_dbi,null);
assert.ok(radiationBands(bundle(trusted('missing-port')))[0].samples.every(s=>s.values.realized_peak_dbi===null));
const lossless=radiationBands(bundle(trusted('lossless')))[0].samples;
assert.equal(lossless[0].values.gain_peak_dbi,lossless[0].values.d_peak_dbi,'reported lossless eta, not raw eta');
assert.equal(lossless[1].values.gain_peak_dbi,lossless[1].values.d_peak_dbi);
const masked=trusted('baseline');masked.radiation.d_boresight_dbi[1]-=.001;
assert.equal(radiationBands(bundle(masked))[0].samples[1].values.ar_boresight_db,null,'read side enforces Dmax−20 mask');
assert.equal(radiationBands(bundle(masked))[0].samples[1].raw.ar_boresight_db,0,'raw audit value retained separately');
const offPole=trusted('baseline');offPole.radiation.theta[0]=5;
for(const q of RADIATION_QUANTITIES.filter(q=>q.includes('boresight')))assert.equal(radiationBands(bundle(offPole))[0].samples[0].values[q],null,'no implicit boresight on an explicit off-pole grid');
assert.equal(band.samples[0].mismatchEfficiency,.99);
const other=trusted('baseline');other.port=19;other.radiation.realized_peak_dbi=[-31,-32,-33];
assert.deepEqual(radiationBands(bundle(baseline,other)).map(p=>p.port),[7,19]);
assert.equal(radiationBands(bundle(baseline,other))[1].samples[0].values.realized_peak_dbi,-31,'port numbers never cross-map');
for(const corrupt of [s=>s.f.reverse(),s=>s.f[1]=s.f[0],s=>s.f[1]=null,s=>s.radiation.d_peak_dbi.pop(),s=>s.radiation.source='unknown',s=>s.radiation.ar_peak_db[1]=61,s=>s.radiation.ar_mask_db=30]){
  const s=trusted('baseline');corrupt(s);assert.equal(validRadiationSweep(s),false);
  const checked=validateBundle(bundle(s));assert.deepEqual(checked.errors,[]);assert.equal(checked.bundle.results.efficiency[0].radiation,undefined);
  assert.deepEqual(checked.bundle.results.efficiency[0].rad_efficiency,s.rad_efficiency,'legacy efficiency remains');
  assert.equal(checked.warnings.filter(w=>w.includes('radiation scalars')).length,1);
}
const cp={rhcp_dbi:[[3,3],[3,3]],lhcp_dbi:[[-50,-50],[-50,-50]],axial_ratio_db:[[0,0],[6,6]],peak:{theta:90,phi:0,rhcp_dbi:3,lhcp_dbi:-50,axial_ratio_db:6},boresight:{theta:0,rhcp_dbi:3,lhcp_dbi:-50,axial_ratio_db:0}};
b.results.farfield=[{f:2e9,port:19,theta:[0,90],phi:[0,180],directivity_dbi:[[-20,-20],[6,6]],dmax_dbi:6,gain_dbi:2,realized_gain_dbi:null,rad_efficiency:.5,cp}];
const detailed=radiationPatternPoints(b)[0];
assert.equal(detailed.source,'stored-pattern');assert.equal(detailed.reliability,'unassessed');assert.equal(detailed.port,19);
assert.equal(detailed.values.ar_boresight_db,null,'detailed pattern mask independent of coarse pass');
assert.equal(detailed.values.realized_peak_dbi,null,'missing stored gain never reconstructed from S parameters');
assert.equal(detailed.values.gain_boresight_dbi,-24,'stored same-pattern offset only');
assert.equal(radiationBands(b)[0].samples[1].values.ar_boresight_db,0,'detailed point never replaces coarse sample at same f');
const interval=trusted('baseline');interval.radiation.ar_peak_db=[2,4,2];
assert.deepEqual(sampledArIntervals(radiationBands(bundle(interval))[0].samples,'ar_peak_db'),[{lo:1e9,hi:1e9,count:1,left:'edge',right:'above'},{lo:3e9,hi:3e9,count:1,left:'above',right:'edge'}]);
interval.radiation.ar_peak_db=[3,null,2];
assert.equal(sampledArIntervals(radiationBands(bundle(interval))[0].samples,'ar_peak_db')[0].right,'gap');
interval.radiation.ar_peak_db=[3,1,2];
assert.deepEqual(sampledArIntervals(radiationBands(bundle(interval))[0].samples,'ar_peak_db'),[{lo:1e9,hi:3e9,count:3,left:'edge',right:'edge'}]);
assert.equal(nearestStoredIndex([1,2,3],2),1,'choose missing-sample frequency before value');
assert.equal(nearestStoredIndex([1,2,3],1.6),1);assert.equal(nearestStoredIndex([1,2,3],.9),-1);assert.equal(nearestStoredIndex([1,2,3],3.1),-1);
for(const q of RADIATION_QUANTITIES){
  const table=radiationTable(b,[q]);assert.deepEqual(resultDataTable(b,'efficiency',undefined,{radiationQuantity:q}),table);
  assert.deepEqual(resultDataTable(b,'efficiency',undefined,{radiationQuantity:q,patternQuantity:'axial_ratio',patternCut:{kind:'conical',angle:90},patternQuantityFixed:true}),table,'pattern controls do not change frequency data');
  const column=table.header.indexOf(`${q} (${radiationUnit(q)})`);
  assert.deepEqual(table.rows.slice(0,3).map(r=>r[column]),radiationBands(b)[0].samples.map(s=>s.values[q]));
  assert.equal(table.rows.at(-1)[2],'stored-pattern');assert.equal(radiationUnit(q),q.startsWith('ar_')?'dB':'dBi');
}
const csv=radiationFrequencyCsv(b);assert.ok(csv.includes('theta axis (deg)'));assert.ok(csv.includes('band-efficiency-nf2ff'));assert.ok(csv.includes('stored-pattern'));
const parsed=parseCsv(csv);assert.equal(parsed.length,5);
const cmp=comparedResultDataTable([{file:'base',bundle:b},{file:'second',bundle:bundle(other)}],'efficiency',undefined,{radiationQuantity:'realized_peak_dbi'});
assert.equal(cmp.rows.length,7);assert.ok(cmp.header.includes('run'));assert.ok(cmp.rows.some(r=>r[cmp.header.indexOf('Port')]===19));
// Integrated #228/#231/#242/#236: a detailed selected cut keeps its own quantity,
// mask and reference gaps even when the frequency selector is set independently.
const cutOptions={patternQuantity:'axial_ratio',patternCut:{kind:'conical',angle:90},patternPort:19};
const selectedCut=resultDataTable(b,'pattern',2e9,cutOptions);
assert.deepEqual(resultDataTable(b,'pattern',2e9,{...cutOptions,radiationQuantity:'realized_peak_dbi'}),selectedCut,'frequency controls do not change selected-cut exports');
assert.ok(selectedCut.header.includes('Axial ratio (dB)'));
assert.ok(selectedCut.rows.length>0 && selectedCut.rows.every(r=>r[selectedCut.header.indexOf('HPBW status')]==='quantity'),'AR never acquires lobe metrics');
const noCp=structuredClone(b);delete noCp.results.farfield[0].cp;
const cutCompare=comparedResultDataTable([{file:'cp',bundle:b},{file:'no-cp',bundle:noCp}],'pattern',2e9,{...cutOptions,radiationQuantity:'ar_peak_db'});
const arColumn=cutCompare.header.indexOf('Axial ratio (dB)'), missing=cutCompare.rows.filter(r=>r[cutCompare.header.indexOf('run')]==='no-cp');
assert.ok(arColumn>=0 && missing.length>0 && missing.every(r=>r[arColumn]===null),'missing reference CP stays a gap instead of frequency scalars or directivity');
assert.deepEqual(comparedResultDataTable([{file:'base',bundle:b},{file:'second',bundle:bundle(other)}],'efficiency',undefined,{...cutOptions,radiationQuantity:'realized_peak_dbi'}),cmp,'pattern comparison controls never align or replace coarse frequency records');
const files=packageFiles(b,Object.fromEntries(PACKAGE_GROUPS.map(g=>[g.id,g.id==='data'])));
assert.equal(files.find(f=>f.path==='data/radiation_frequency.csv')?.data,csv);
const svg=reportPages(b,{generated:'synthetic control',date:'2026-10-23'}).join('\n');
for(const text of ['Radiation versus frequency','band-efficiency-nf2ff','Physical port 7','Separate stored-pattern AR points','unassessed'])assert.ok(svg.includes(text),text);
assert.ok(!svg.includes('NaN'));assert.ok(!svg.includes('undefined'));
console.log(`PASS: ${records.length} Python fixtures; eight quantities; same-grid/missing/reliability/port/mask/interval/CSV/compare/package/report contracts. Synthetic, no EM accuracy claim.`);
