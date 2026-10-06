import assert from 'node:assert/strict';
import {build} from 'vite';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)).replaceAll('\\','/');
// Use the real browser Solid runtime, so independent reactive observers are tested too.
const built=await build({root,configFile:false,logLevel:'silent',resolve:{conditions:['browser']},
 plugins:[{name:'result-session-entry',resolveId:id=>id.endsWith('result-session-entry')?'\0result-session-entry':undefined,
 load:id=>id==='\0result-session-entry'?`export * from ${JSON.stringify(root+'src/designer/resultSessionState.ts')}; export {createRoot,createComputed} from "solid-js";`:undefined}],
 build:{write:false,minify:false,lib:{entry:'result-session-entry',formats:['es']}}});
const code=(Array.isArray(built)?built[0]:built).output.find(item=>item.type==='chunk').code;
const {createMainTabsState,createResultFocusState,createRoot,createComputed}=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

// These are the actual factories the public UI wrappers consume, without DOM/storage adapters.
for(const key of ['window','document','localStorage','sessionStorage']) {
 Object.defineProperty(globalThis,key,{configurable:true,get(){throw new Error(`unexpected global access: ${key}`);}});
}
createRoot(dispose=>{try {
 const initial={open:['sparams'],active:'sparams'};
 const a=createMainTabsState(initial),b=createMainTabsState(initial);
 const seenA=[],seenB=[];
 createComputed(()=>seenA.push(a.mainTabs().active));createComputed(()=>seenB.push(b.mainTabs().active));
 initial.open.push('smith');assert.deepEqual(a.mainTabs(),{open:['sparams'],active:'sparams'});
 a.openMainResult('smith');a.activateMainTab('3d');a.cycleMainTabs(-1);
 assert.deepEqual(seenA,['sparams','smith','3d','smith']);assert.deepEqual(seenB,['sparams'],'A updates do not notify B observers');
 assert.equal(a.activeMainResult(),'smith');assert.equal(b.activeMainResult(),'sparams');
 a.closeMainTab('smith');assert.equal(a.activeMainResult(),'sparams');
 a.closeMainTab('3d');assert.deepEqual(a.mainTabs(),b.mainTabs());
 a.cycleMainTabs(1);assert.equal(a.activeMainResult(),null);assert.equal(b.activeMainResult(),'sparams');
 assert.throws(()=>a.mainTabs().open.push('table'),TypeError,'callers cannot mutate stored tabs');

 let dock='run',live=true;const routed=[],announced=[];
 const focusA=createResultFocusState({
  openMainResult:view=>a.openMainResult(view),activateMainTab:id=>a.activateMainTab(id),
  dockTab:()=>dock,liveRun:()=>live,setLogTab:()=>routed.push('log'),showRunsTab:()=>routed.push('runs'),
  announce:value=>{announced.push(value);if(value?.compare)value.compare.push('event consumer');},
 });
 const focusB=createResultFocusState({openMainResult:view=>b.openMainResult(view),showRunsTab:()=>routed.push('B runs')});
 const focusedA=[],focusedB=[];
 createComputed(()=>focusedA.push(focusA.resultFocus()?.view??null));createComputed(()=>focusedB.push(focusB.resultFocus()?.view??null));
 const provided={file:'a.json',view:'smith',compare:['overlay.json']};
 focusA.focusResult(provided,'main');provided.compare.push('caller edit');provided.file='changed.json';
 assert.deepEqual(focusA.resultFocus(),{file:'a.json',view:'smith',compare:['overlay.json']});
 assert.equal(focusA.resultTarget(),'main');assert.equal(a.activeMainResult(),'smith');
 assert.equal(focusB.resultFocus(),null);assert.equal(b.activeMainResult(),'sparams');
 assert.deepEqual(focusedA,[null,'smith']);assert.deepEqual(focusedB,[null],'focus observers remain private');
 assert.deepEqual(routed,[],'live run keeps its dock progress tab');
 live=false;focusA.followResultInDock('smith');assert.deepEqual(routed,['runs']);
 focusA.focusResult({file:'a.json',view:'log'},'main');assert.equal(focusA.resultTarget(),'keep');assert.equal(routed.at(-1),'log');
 for(const view of ['pattern3d','currents','fieldplane']) {
  focusA.focusResult({file:'a.json',view},'main');assert.equal(a.mainTabs().active,'3d');
  assert.equal(focusA.leaveResultsFor('view'),false);assert.equal(focusA.leaveResultsFor('post'),false);
  assert.equal(focusA.leaveResultsFor('modeling'),true);assert.equal(focusA.resultFocus(),null);
 }
 focusA.focusResult({file:'a.json',view:'sparams'},'main');assert.equal(focusA.leaveResultsFor('modeling'),false,'main result tabs remain independent of geometry ribbon');
 focusB.focusResult(focusA.resultFocus(),'main');assert.equal(b.activeMainResult(),'sparams');
 focusA.focusResult(null);assert.equal(focusB.resultFocus().file,'a.json');assert.equal(announced.at(-1),null);
 const count=routed.length,events=announced.length;
 focusA.dispose();a.dispose();
 assert.equal(focusA.focusResult({file:'late.json',view:'log'},'main'),false);
 focusA.followResultInDock('log');assert.equal(focusA.leaveResultsFor('modeling'),false);
 assert.equal(a.openMainResult('table'),false);assert.equal(a.activateMainTab('sparams'),false);
 assert.equal(a.closeMainTab('sparams'),false);assert.equal(a.cycleMainTabs(1),false);
 assert.deepEqual(a.mainTabs(),{open:[],active:'3d'});assert.equal(focusA.resultFocus(),null);assert.equal(focusA.resultTarget(),'keep');
 assert.equal(routed.length,count);assert.equal(announced.length,events);assert.equal(focusB.resultFocus().file,'a.json');
 let focused=0;const c=createMainTabsState(undefined,{focusActive:()=>focused++});c.focusActiveMainTab();c.dispose();c.focusActiveMainTab();assert.equal(focused,1);
 const inert=createResultFocusState();inert.focusResult({file:'inert.json',view:'fieldplane'});inert.dispose();
} finally {
 for(const key of ['window','document','localStorage','sessionStorage'])delete globalThis[key];
 dispose();
}});
console.log('Result session factories: isolated focus/tabs, injected dock routing, input ownership and disposal passed');
