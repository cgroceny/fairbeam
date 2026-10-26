// Selected-frequency export provenance on a copied analytical fixture. No solver/browser.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {packageFiles,PACKAGE_GROUPS} from '../src/export/package.ts';
import {reportPages} from '../src/export/reportPdf.ts';
import {parseCsv} from '../src/export/csv.ts';
import {uniformWeights} from '../src/lib/array.ts';
const b=JSON.parse(readFileSync(new URL('../examples/synthetic/array2x1.json',import.meta.url),'utf8'));
const first=b.results.element_patterns[0].f,selected=2.6e9;
b.results.element_patterns.push({...structuredClone(b.results.element_patterns[0]),f:selected});
// Known diagonal reflection varies linearly with frequency; no coupling. This makes a
// wrong first-frequency CSV numerically distinguishable, independently of steering math.
for(const [key,column] of Object.entries(b.results.sparams.s)) {
 const diagonal=key.split(',')[0]===key.split(',')[1];
 column.re=b.results.frequency.map(f=>diagonal ? 0.1+0.1*(f-first)/(selected-first) : 0);
 column.im=b.results.frequency.map(()=>0);
}
const weights=uniformWeights([1,2]);weights.set(2,{ampDb:-3.123456789,phaseDeg:37.123456789});
const include=Object.fromEntries(PACKAGE_GROUPS.map(g=>[g.id,['readme','data','figures'].includes(g.id)]));
const files=packageFiles(b,include,{arrayWeights:weights,arrayFrequencyHz:selected},new Date('2026-10-26T00:00:00Z'));
const csv=files.find(file=>file.path==='data/array_weights.csv');assert.ok(csv);
const rows=parseCsv(csv.data);assert.equal(rows.length,3);
for(const row of rows.slice(1)) {
 assert.equal(Number(row[3]),selected/1e9,'weights CSV uses the selected frequency');
 assert.ok(Math.abs(Number(row[5])-.2)<1e-12,'active reflection is evaluated at the selected frequency');
 assert.ok(Math.abs(Number(row[4])-20*Math.log10(.2))<1e-10);
}
assert.equal(Number(rows[2][1]),-3.123456789);assert.equal(Number(rows[2][2]),37.123456789);
const arrayFigures=files.filter(file=>file.path.startsWith('figures/array_pattern_'));
assert.deepEqual(arrayFigures.map(file=>file.path),['figures/array_pattern_2.600GHz.svg','figures/array_pattern_2.600GHz_wide.svg']);
assert.ok(arrayFigures.every(file=>file.description.includes('2600000000 Hz')&&file.description.includes('selected stored frequency only')));
assert.ok(files.find(file=>file.path==='README.md').data.includes('2600000000 Hz'));
const report=reportPages(b,{generated:'2026-10-26 00:00',arrayWeights:weights,arrayFrequencyHz:selected}).join('\n').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
assert.ok(report.includes('Array pattern at 2.600 GHz'));assert.ok(!report.includes(`Array pattern at ${(first/1e9).toFixed(3)} GHz`));
assert.ok(report.includes('2600000000 Hz'),'report keeps the snapshot frequency');
const absent=packageFiles(b,include,{arrayWeights:weights,arrayFrequencyHz:9e9});
assert.ok(!absent.some(file=>file.path==='data/array_weights.csv'||file.path.startsWith('figures/array_pattern_')),'unknown explicit frequency never falls back to the first set');
const legacy=packageFiles(b,include,{arrayWeights:weights});
assert.equal(legacy.filter(file=>file.path.startsWith('figures/array_pattern_')).length,4);
assert.ok(legacy.filter(file=>file.path.startsWith('figures/array_pattern_')).every(file=>file.description.includes('same fixed amplitude and phase weights')));
const legacyReport=reportPages(b,{generated:'2026-10-26 00:00',arrayWeights:weights}).join('\n').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
assert.ok(legacyReport.includes('no frequency-specific re-steering'),'legacy all-frequency reports qualify fixed weights');
console.log('Array package: selected frequency, independent active reflection, weights precision, selected-only figures/report, no absent-frequency fallback and qualified legacy fixed-weight exports passed.');
