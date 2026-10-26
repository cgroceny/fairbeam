// Real frontend goal/draft/request/history closures, with reactive and I/O boundaries replaced.
// No app bootstrap, browser, server, native engine or solver is started.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {parse} from '@babel/parser';
import {fmtG,goalText} from '../src/runner/optimizeGoals.ts';
import en from '../src/i18n/en.json' with {type:'json'};
import tr from '../src/i18n/tr.json' with {type:'json'};

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const source=read('src/runner/optimize.ts'),ast=parse(source,{sourceType:'module',plugins:['typescript']});
const declarations=ast.program.body.map(node=>node.type==='ExportNamedDeclaration'?node.declaration:node).filter(Boolean);
const names=['MAX_OPT_EVALS','GOAL_PRESETS','presetOf','goalDraft','setGoalKind','optPlan','startOptimize','goalValue','evaluationGoalValue'];
const picked=names.map(name=>{
 const node=declarations.find(node=>node.type==='FunctionDeclaration'?node.id?.name===name:node.type==='VariableDeclaration'&&node.declarations.some(d=>d.id.name===name));
 assert.ok(node,`production ${name} exists`);return source.slice(node.start,node.end);
}).join('\n');
const goals=[],vary=[{key:'width',min:'1',max:'5',start:'2.123456789012345'}];
let ports=[1,2,3],submitting=false,lastRequest=null,lastErrors=null,evalBudget=12;
const translate=(key,values)=>Object.entries(values??{}).reduce((s,[k,v])=>s.replaceAll(`{${k}}`,String(v)),en[key]??key);
const deps={
 createRoot:fn=>fn(),createMemo:fn=>fn,goals,vary,modelPorts:()=>ports,
 setGoals:(i,...args)=>{if(args.length===2)goals[i][args[0]]=args[1];else Object.assign(goals[i],args[0]);},bandCentre:()=>2.4,
 specs:()=>[{key:'width',minimum:1,maximum:5,unit:'mm'}],maxEvals:()=>evalBudget,method:()=>'auto',
 currentModel:()=>({key:'synthetic-goal-control'}),submitting:()=>submitting,setSubmitting:value=>{submitting=value;},
 setSubmitError:value=>{lastErrors=value;},setOptErrors:()=>{},setFieldErrors:()=>{},setNotice:()=>{},
 paramPayload:()=>({width:999,fixed:1.23456789012345}),threadsForEngine:()=>2,threads:()=>2,health:()=>({default_threads:2}),
 optEngine:()=>'cpu',meshStats:()=>null,meshSource:()=>null,runName:()=>'',excite:()=>'auto',
 api:{submitOptimization:async body=>{lastRequest=body;return{id:'captured-only'};}},attach:()=>{},refreshRuns:()=>{},
 t:translate,fmtG,
};
const unit=new Function(...Object.keys(deps),stripTypeScriptTypes(picked)+`;return {${names.join(',')}};`)(...Object.values(deps));
const draft=(kind,changes={})=>({...unit.goalDraft(kind,'2.40000123456789'),...changes});
const install=(...list)=>{goals.splice(0,goals.length,...list);};
const valid=(goal)=>{install(goal);assert.equal(unit.optPlan().ok,true,JSON.stringify(unit.optPlan().errors));};
const invalid=(goal)=>{install(goal);assert.ok(unit.optPlan().errors['goals.0']);};

for(const kind of ['s11_max','sij_max','sij_min','match_all']) {
 assert.equal(unit.presetOf(kind).band,true);assert.equal(unit.presetOf(kind).unit,'dB');
 valid(draft(kind,{atHi:'2.50000123456789'}));
 for(const atHi of ['2.40000123456789','2','0','-1','Infinity','NaN'])invalid(draft(kind,{atHi}));
 valid(draft(kind,{atHi:''}));valid(draft(kind,{atHi:'  '}));
}
for(const [kind,unitName] of [['realized_gain_min','dBi'],['efficiency_min','%']]) {
 const preset=unit.presetOf(kind);assert.equal(preset.unit,unitName);assert.equal(preset.needsAt,true);assert.ok(!preset.band);
 assert.equal(draft(kind).atHi,'');assert.equal(draft(kind).at,'2.40000123456789');valid(draft(kind));
 for(const at of ['','0','-1','Infinity','NaN'])invalid(draft(kind,{at}));
 for(const target of ['',' ','Infinity','NaN'])invalid(draft(kind,{target}));
 for(const weight of ['','0','-1','Infinity','NaN'])invalid(draft(kind,{weight}));
}
for(const target of ['0','-1','100.0001'])invalid(draft('efficiency_min',{target}));
valid(draft('efficiency_min',{target:'0.0001'}));valid(draft('efficiency_min',{target:'100'}));
valid(draft('realized_gain_min',{target:'-3.25'}));
install(draft('s11_max',{atHi:'2.5',weight:'1.23456789012345'}));unit.setGoalKind(0,'efficiency_min');
assert.equal(goals[0].at,'2.40000123456789');assert.equal(goals[0].weight,'1.23456789012345');assert.equal(goals[0].atHi,'');
ports=[7,19];invalid(draft('sij_max'));valid(draft('sij_max',{i:'7',j:'19'}));ports=[1,2,3];

// Real request mapping preserves IEEE numeric precision and suppresses stale inapplicable bands.
install(draft('s11_max',{atHi:'2.50000123456789',target:'-19.12345678901234',weight:'1.23456789012345'}),
 draft('efficiency_min',{target:'92.12345678901234',atHi:'stale hidden field'}));
await unit.startOptimize();assert.equal(lastErrors,null);assert.equal(submitting,false);
assert.equal(lastRequest.goals[0].at,2.40000123456789);assert.equal(lastRequest.goals[0].at_hi,2.50000123456789);
assert.equal(lastRequest.goals[0].target,-19.12345678901234);assert.equal(lastRequest.goals[0].weight,1.23456789012345);
assert.equal(lastRequest.goals[1].target,92.12345678901234);assert.ok(!('at_hi' in lastRequest.goals[1]));
assert.equal(lastRequest.vary[0].start,2.123456789012345);assert.ok(!('width' in lastRequest.params));
lastRequest=null;install(draft('efficiency_min',{target:'101'}));await unit.startOptimize();assert.equal(lastRequest,null,'invalid draft never submits');

const point={kind:'sij_max',at:2.40000123456789,target:-20,ports:[2,3]},band={...point,at_hi:2.50000123456789};
const legacy={sij_at:{[`2,3@${fmtG(point.at)}`]:-22.12345678901234},match_all_at:{[fmtG(point.at)]:{max:-21.98765432101234}}};
const evaluation={index:1,params:{width:2.123456789012345},metrics:legacy,cost:0.123456789012345,met:false,file:null,wall_time_s:1.123456789012345};
assert.equal(unit.evaluationGoalValue(point,evaluation,0),-22.12345678901234,'legacy point fallback');
assert.equal(unit.evaluationGoalValue(band,evaluation,0),null,'band cannot borrow an old point');
assert.equal(unit.evaluationGoalValue({...point,kind:'match_all'},evaluation,0),-21.98765432101234);
for(const values of [[null],[],[0],[92.12345678901234]]) {
 const e={...evaluation,goals:values.map(value=>({kind:point.kind,value,cost:0,met:false,goal:'synthetic'}))};
 assert.equal(unit.evaluationGoalValue(point,e,0),values[0]??null,'explicit goal record is authoritative, including null/zero/missing');
 assert.equal(unit.evaluationGoalValue(point,e,1),null,'missing goal index cannot borrow another goal metric');
}

// Execute the actual progress export closure, not a test reimplementation of CSV formatting.
const progress=read('src/runner/OptimizeProgress.tsx'),progressAst=parse(progress,{sourceType:'module',plugins:['typescript','jsx']});
const found=[],objects=[],elements=[];function walk(node){if(!node||typeof node!=='object')return;if(node.type==='VariableDeclarator')found.push(node);if(node.type==='ObjectExpression')objects.push(node);if(node.type==='JSXOpeningElement')elements.push(node);for(const [key,value] of Object.entries(node)){if(key==='loc')continue;if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);}}
walk(progressAst);
const exportNode=found.find(node=>node.id.name==='exportHistory');assert.ok(exportNode);
const historyGoals=[band,{kind:'efficiency_min',at:2.4,target:90}],history=[
 {...evaluation,goals:[{kind:band.kind,value:null},{kind:'efficiency_min',value:92.12345678901234}]},
 {...evaluation,index:2,params:{width:2.23456789012345},cost:0,goals:[{kind:band.kind,value:-21.12345678901234},{kind:'efficiency_min',value:0}],file:'path,"quoted".json'},
];
const saved=[];const exporterDeps={optEvals:()=>history,job:()=>({id:'synthetic-export'}),spec:()=>({goals:historyGoals}),
 saveDownload:async(name,text,mime)=>{saved.push({name,text,mime});},goalTextEn:g=>goalText(g,k=>en[k]??k),
 evaluationGoalValue:unit.evaluationGoalValue,tEn:key=>en[key]??key,statusOf:e=>e.met?'opt.status.met':'opt.status.evaluated'};
const exportHistory=new Function(...Object.keys(exporterDeps),`return (${stripTypeScriptTypes(progress.slice(exportNode.init.start,exportNode.init.end))});`)(...Object.values(exporterDeps));
await exportHistory('json');assert.deepEqual(JSON.parse(saved.at(-1).text),history,'JSON keeps full precision and explicit null');
await exportHistory('csv');const csv=saved.at(-1).text;
assert.match(csv,/"1","2\.123456789012345","","92\.12345678901234","0\.123456789012345"/);
assert.match(csv,/"2","2\.23456789012345","-21\.12345678901234","0","0"/);
assert.ok(csv.includes('"path,""quoted"".json"'),'CSV escapes filename quotes');
assert.ok(csv.includes('2.4..2.5 GHz'),'CSV header identifies a band');
assert.ok(csv.includes('90 %'),'CSV header uses percent for efficiency');

for(const locale of [en,tr]) {
 const tx=key=>{assert.equal(typeof locale[key],'string',`translated ${key}`);return locale[key];};
 assert.match(goalText(band,tx),/2\.4\.\.2\.5 GHz/);
 assert.match(goalText({kind:'efficiency_min',target:91.25,at:2.45},tx),/91\.25 % @ 2\.45 GHz/);
 assert.match(goalText({kind:'realized_gain_min',target:-1.25,at:2.45},tx),/-1\.25 dBi @ 2\.45 GHz/);
}
// Evaluate the actual best-value unit expression for every goal kind.
const unitNode=found.find(node=>node.id.name==='unit');assert.ok(unitNode);
const shownUnit=new Function('g',`return (${stripTypeScriptTypes(progress.slice(unitNode.init.start,unitNode.init.end))});`);
for(const [kind,expected] of [['f0','GHz'],['bw_min','MHz'],['s11_max','dB'],['sij_min','dB'],['dmax_min','dBi'],['realized_gain_min','dBi'],['efficiency_min','%']])assert.equal(shownUnit({kind}),expected);

// The visible S11 column must honor explicit unavailable goal values, just like export/best.
const s11Col=objects.find(node=>node.properties.some(p=>p.key?.name==='label'&&p.value?.value==='|S11|'));
const s11Get=s11Col?.properties.find(p=>p.key?.name==='get')?.value;assert.ok(s11Get);
const s11={kind:'s11_max',at:2.40000123456789,target:-20};
const readS11=new Function('s11Goal','spec','evaluationGoalValue','fmtG',`return (${stripTypeScriptTypes(progress.slice(s11Get.start,s11Get.end))});`)(()=>s11,()=>({goals:[s11]}),unit.evaluationGoalValue,fmtG);
const s11Eval={...evaluation,metrics:{...legacy,s11_at:{[String(s11.at)]:-18,[fmtG(s11.at)]:-19}},goals:[{kind:'s11_max',value:null}]};
assert.equal(readS11(s11Eval),null,'point S11 visible column cannot replace explicit null with a metric');
s11Eval.goals[0].value=-19.12345678901234;assert.equal(readS11(s11Eval),-19.12345678901234,'point S11 uses the actual goal record');

// The optional upper field distinguishes truly blank input from NumberField's invalid-text
// sentinel. Its DOM accessor yields '' for both; data-bad-input is the necessary distinction.
const panel=read('src/runner/OptimizePanel.tsx');walk(parse(panel,{sourceType:'module',plugins:['typescript','jsx']}));
const upper=elements.find(node=>node.name.name==='NumberField'&&node.attributes.some(a=>a.name?.name==='id'&&a.value?.expression?.arguments?.[0]?.value==='at-hi'));
const input=upper?.attributes.find(a=>a.name?.name==='onInput')?.value?.expression;assert.ok(input);
const onUpper=new Function('setGoals','i',`return (${stripTypeScriptTypes(panel.slice(input.start,input.end))});`)(deps.setGoals,()=>0);
install(draft('s11_max'));
const field=(value,bad)=>({value,dataset:bad?{badInput:'true'}:{},hasAttribute:name=>name==='data-bad-input'&&bad,getAttribute:name=>name==='data-bad-input'&&bad?'true':null,validity:{valid:!bad},checkValidity:()=>!bad});
onUpper({currentTarget:field('',true)});assert.ok(unit.optPlan().errors['goals.0'],'malformed nonempty upper frequency blocks submission');
onUpper({currentTarget:field('',false)});assert.equal(unit.optPlan().ok,true,'actual empty upper frequency remains a point goal');
onUpper({currentTarget:field('2.5',false)});assert.equal(unit.optPlan().ok,true);assert.equal(goals[0].atHi,'2.5');
console.log('Optimizer goal controls: draft/validation, precision-preserving request/history, null/zero/band handling, EN/TR labels and best-value units passed. No browser/server/solver.');
