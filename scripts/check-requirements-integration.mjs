// Saved-input identity, Design schema parity, isolated source masks and export controls. No UI/SDK.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { designChecks } from '../src/designer/checks.ts';
import { requirementPlotSegments, savedRequirements } from '../src/lib/requirementsSnapshot.ts';
import { bundleRequirementsReport, requirementsCsv } from '../src/export/requirementsReport.ts';
import { registerPortProjection } from '../src/lib/portProcessingMetadata.ts';
import { requirementGoalDrafts } from '../src/lib/requirementGoals.ts';
import { parseCsv } from '../src/export/csv.ts';
import { packageFiles } from '../src/export/package.ts';
import { readmeReport } from '../src/export/report.ts';
import { reportPages } from '../src/export/reportPdf.ts';
import { setLanguage, setDecimalChoice } from '../src/i18n/index.ts';

const input = process.argv[2];
if (!input) throw new Error('Generate Python integration fixture first: test_requirements.py --integration-dump <path>');
const fixture = JSON.parse(readFileSync(input, 'utf8'));
let count = 0;
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); count++; };
const csvValue = (text, header) => { const rows = parseCsv(text); return rows[1][rows[0].indexOf(header)]; };
const key = c => `${c.severity}|${c.code}|${c.path}`;
for (const c of fixture.designCases) {
  const checks = designChecks(c.design);
  equal(checks.map(key).sort(), [...c.expect].sort(), c.name);
  equal(checks.map(c => [key(c), c.message, c.explain]), c.checks.map(c => [key(c), c.message, c.explain]), `${c.name}: exact Python/TS checks`);
}
const b = fixture.bundle, saved = savedRequirements(b);
equal(saved, fixture.evaluation, 'saved wrapper parity');
equal(saved.metric, 'pass', 'stored limits pass');
equal(saved.status, 'unknown', 'no inferred mesh certificate');
equal(saved.mesh, 'unknown', 'mesh membership is absent');
const original = JSON.stringify(b);
const editor = structuredClone(b.requirements_snapshot.requirements);
editor.items[0].goal.target = -100;
equal(savedRequirements(b).metric, 'pass', 'later editor edit cannot relabel a run');
equal(requirementPlotSegments(b, [[2,2]]), [{x0:2.5,x1:2.5,y:-10,label:'spec: S(2,2) ≤ -10 dB'}], 'point mask bound to driven physical port');
equal(requirementPlotSegments(b, [[4,4]]), [], 'S11 does not apply to another physical port');
const multi = structuredClone(b);
multi.requirements_snapshot.requirements.items[0].goal = { kind:'sij_min', target:-3, at:2.4, at_hi:2.48, ports:[4,2] };
equal(requirementPlotSegments(multi, [[4,2]])[0], {x0:2.4,x1:2.48,y:-3,label:'spec: S(4,2) ≥ -3 dB'}, 'bounded explicit physical pair');
equal(requirementPlotSegments(multi, [[2,4]]), [], 'reciprocal data does not change mask identity');
for (const field of ['source_id','input_sha256']) {
  const corrupt = structuredClone(b); corrupt.requirements_snapshot[field] = '0'.repeat(64);
  equal(savedRequirements(corrupt).metric, 'unknown', `mismatched ${field}`);
  equal(requirementPlotSegments(corrupt, [[2,2]]), [], `no masks for mismatched ${field}`);
}
const old = structuredClone(b); delete old.requirements_snapshot;
equal(savedRequirements(old).reason, 'no-snapshot', 'legacy result remains unqualified');
const projected = structuredClone(b);
registerPortProjection(projected, {source:b,settings:{referenceOhm:75,delayPs:{}},physicalPorts:[2,4],sourceReferences:[50,50],missingSamples:0,description:'synthetic',channels:[],primaryIndex:1});
equal(savedRequirements(projected).metric, 'unknown', 'session projection cannot reuse driven-wave mask');
equal(requirementPlotSegments(projected, [[2,2]]), [], 'projection has no source masks');
const report = bundleRequirementsReport(b), csv = requirementsCsv(b);
equal(report.evaluation, saved, 'report uses same qualified evaluation');
equal(report.rows.length, 1, 'all saved requirements exported');
equal(csv.includes(b.requirements_source.source_id), true, 'CSV source ID');
equal(csvValue(csv, 'qualified_verdict'), 'unknown', 'CSV preserves unqualified verdict');
equal(requirementsCsv(old).includes('no-snapshot'), true, 'legacy export retains reason');
equal(bundleRequirementsReport(projected).evaluation.metric, 'unknown', 'report keeps object projection identity');
equal(JSON.stringify(b), original, 'readers/export do not mutate source');

const precise = {kind:'sij_min',target:-6.01234567890123,at:2.000000000001,at_hi:2.000000000002,ports:[4,2],weight:1.12345678901234};
const draft = requirementGoalDrafts([precise])[0];
equal([Number(draft.target),Number(draft.at),Number(draft.atHi),Number(draft.weight),Number(draft.i),Number(draft.j)],
  [precise.target,precise.at,precise.at_hi,precise.weight,4,2], 'optimizer form preserves numeric precision and physical IDs');
equal(requirementGoalDrafts(Array.from({length:5},()=>precise)), null, 'existing four-goal cap refuses without truncation');
equal(requirementGoalDrafts([]), null, 'empty conversion refuses');
equal(requirementGoalDrafts([{...precise,target:NaN}]), null, 'invalid conversion refuses');
const preciseBundle=structuredClone(b); preciseBundle.requirements_snapshot.requirements.items[0].goal=precise;
const preciseRows=parseCsv(requirementsCsv(preciseBundle));
equal(preciseRows[1].slice(3,9), ['sij_min',String(precise.target),String(precise.at),String(precise.at_hi),'4 2',String(precise.weight)], 'CSV raw mask precision');
equal(requirementsCsv(preciseBundle).includes('\r'), false, 'existing LF CSV contract');
const malformed=structuredClone(b); malformed.requirements_snapshot.requirements.items[0].goal.target='-10';
equal(bundleRequirementsReport(malformed).evaluation.metric, 'unknown', 'malformed exported mask unknown');
equal(requirementsCsv(malformed).includes('requirement-goal'), true, 'malformed CSV retains refusal');

// Full exporters filter vacuum geometry; keep the original object identity for stored-wave masks.
const full=JSON.parse(readFileSync(new URL('../public/projects/dipole.json', import.meta.url),'utf8'));
full.name='Synthetic requirements export control';
full.requirements_source=structuredClone(b.requirements_source); full.requirements_snapshot=structuredClone(b.requirements_snapshot);
full.ports=b.ports.map(p=>({...structuredClone(full.ports[0]),...p}));
full.results={...full.results,...structuredClone(b.results),farfield:[]}; full.run={...full.run,...structuredClone(b.run)};
full.solver={...full.solver,...b.solver};
full.parts.push({...structuredClone(full.parts[0]),name:'Vacuum carver',void:true});
equal(savedRequirements(full).metric,'pass','full fixture raw numeric pass');
const include={project:false,readme:true,report:false,data:true,drawings:false,figures:false,cst:false,fab:false,image:false};
const files=packageFiles(full,include,{},new Date('2026-10-28T00:00:00Z'));
equal(csvValue(files.find(f=>f.path==='data/requirements.csv').data, 'qualified_verdict'),'unknown','package keeps mesh qualification separate');
const packageJson = (files,path) => JSON.parse(files.find(f=>f.path===path).data);
equal(files.some(f=>f.path==='project.json'),false,'data provenance does not depend on project export');
equal(packageJson(files,'data/requirements-source.json'),full.requirements_source,'data-only original source identity');
equal(packageJson(files,'data/requirements-snapshot.json'),full.requirements_snapshot,'data-only original saved mask snapshot');
equal(packageFiles(full,{...include,data:false},{}).some(f=>f.path.startsWith('data/requirements')),false,'data opt-out excludes provenance files');
const noResults=structuredClone(full); delete noResults.results;
const noResultFiles=packageFiles(noResults,{...include,readme:false},{});
equal(packageJson(noResultFiles,'data/requirements-source.json'),full.requirements_source,'source audit record survives absent numerical results');
equal(packageJson(noResultFiles,'data/requirements-snapshot.json'),full.requirements_snapshot,'original snapshot survives absent numerical results');
const sourceOnly=structuredClone(full); delete sourceOnly.requirements_snapshot;
const sourceOnlyFiles=packageFiles(sourceOnly,include,{});
equal(packageJson(sourceOnlyFiles,'data/requirements-source.json'),full.requirements_source,'source-only producer record retained');
equal(sourceOnlyFiles.some(f=>f.path==='data/requirements-snapshot.json'),false,'no invented snapshot for mask-free saved input');
const projectedFull=structuredClone(full);
registerPortProjection(projectedFull,{source:full,settings:{referenceOhm:75,delayPs:{}},physicalPorts:[2,4],sourceReferences:[50,50],missingSamples:0,description:'synthetic',channels:[],primaryIndex:1});
const readme=readmeReport(projectedFull,{exported:'2026-10-28',files:[]});
const pages=reportPages(projectedFull,{generated:'2026-10-28',date:'2026-10-28'}).join('\n');
equal(readme.includes('Saved requirements'),true,'README includes requirements');
equal(readme.includes('Numeric limits: Unknown'),true,'README processed+void keeps refusal');
equal(pages.includes('Numeric limits: Unknown'),true,'PDF processed+void keeps refusal');
const projectedFiles=packageFiles(projectedFull,include,{},new Date('2026-10-28T00:00:00Z'));
equal(csvValue(projectedFiles.find(f=>f.path==='data/requirements.csv').data, 'numeric_verdict'),'unknown','package processed+void numeric refusal');
equal(packageJson(projectedFiles,'data/requirements-source.json'),full.requirements_source,'projection does not forge original producer source');
equal(packageJson(projectedFiles,'data/requirements-snapshot.json'),full.requirements_snapshot,'projection preserves original snapshot as provenance only');
for (const mutation of [x=>{x.requirements_snapshot.source_id='0'.repeat(64);},x=>{x.requirements_snapshot.requirements.items[0].goal.target='-10';}]) {
  const invalid=structuredClone(full); mutation(invalid);
  const invalidFiles=packageFiles(invalid,include,{});
  equal(csvValue(invalidFiles.find(f=>f.path==='data/requirements.csv').data,'numeric_verdict'),'unknown','invalid provenance refuses numeric qualification');
  equal(packageJson(invalidFiles,'data/requirements-snapshot.json'),invalid.requirements_snapshot,'invalid original snapshot remains available for audit, never repaired');
  equal(packageJson(invalidFiles,'data/requirements-source.json'),invalid.requirements_source,'invalid snapshot does not overwrite original source identity');
}
const englishReport = bundleRequirementsReport(preciseBundle), englishCsv = requirementsCsv(preciseBundle);
setLanguage('tr'); setDecimalChoice('comma');
equal(bundleRequirementsReport(preciseBundle), englishReport, 'fixed English report is independent of UI language and decimal choice');
equal(requirementsCsv(preciseBundle), englishCsv, 'precise CSV values remain byte-identical under Turkish/comma UI');
setLanguage('en'); setDecimalChoice('language');
console.log(`PASS requirements integration: ${count} assertions; ${fixture.designCases.length} shared Design cases. No UI or native solver run.`);
