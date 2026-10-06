// Exercise the actual session factory and incumbent default store separately: no solver or disk build.
import assert from 'node:assert/strict';
import {build} from 'vite';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)).replaceAll('\\','/');
const built=await build({root,configFile:false,logLevel:'silent',resolve:{conditions:['browser']},plugins:[{
 name:'designer-sessions-entry',resolveId(id){if(id.endsWith('designer-sessions-entry'))return '\0designer-sessions-entry';},
 load(id){if(id==='\0designer-sessions-entry')return `export {createDesignerSession} from ${JSON.stringify(root+'src/designer/sessionCore.ts')};export {createRoot,createMemo} from 'solid-js';`;},
}],build:{write:false,minify:false,lib:{entry:'designer-sessions-entry',formats:['es']}}});
let writes=0;globalThis.localStorage={getItem:()=>null,setItem:()=>writes++,removeItem:()=>writes++};
const code=(Array.isArray(built)?built[0]:built).output[0].code;
const {createDesignerSession,createRoot,createMemo}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const design=()=>({schema:'fairbeam.design/1',model:{id:'same-id',name:'Original',description:''},params:[],materials:[{name:'copper',kind:'metal'}],parts:[{name:'part',material:'copper',primitives:[{kind:'box',start:[0,0,0],stop:[1,1,1]}]}],ports:[],resistors:[],simulation:{f_min:1,f_max:2,boundaries:'MUR'},mesh:{},far_field:{enabled:false}});
const saved=()=>({id:'same-id',file:'same-id.design.json',hash:'base',readonly:false,design:design()});
const effects={a:0,b:0,restoreA:0,dispose:0};
const beforeWrites=writes;
const a=createDesignerSession({edited:()=>effects.a++,restored:()=>effects.restoreA++,disposed:()=>effects.dispose++}),b=createDesignerSession({edited:()=>effects.b++});
assert.equal(writes,beforeWrites,'constructing independent cores installs no backup/persistence adapters');
a.takeFile(saved());b.takeFile(saved());assert.notEqual(a.sessionId,b.sessionId);
assert.equal(a.dirty(),false);assert.equal(b.dirty(),false);
a.edit(d=>d.model.description='A1','model.description');b.edit(d=>d.model.description='B1','model.description');a.edit(d=>d.model.description='A2','model.description');
assert.equal(a.historySteps().length,2,'A coalescing survives edits in B');assert.equal(b.historySteps().length,2);
a.undo();assert.equal(a.draft.model.description,'');assert.equal(b.draft.model.description,'B1');a.redo();assert.equal(a.draft.model.description,'A2');
a.setSelection({type:'primitive',i:0,j:0});b.setSelection({type:'design'});a.setConflict('A conflict');a.setSaving(true);a.setServerErrors({model:'A error'});
assert.equal(b.conflict(),null);assert.equal(b.saving(),false);assert.deepEqual(b.serverErrors(),{});assert.equal(b.selection().type,'design');
const mark=a.historyMark();assert.equal(b.rollbackTo(mark),false,'same file/revision cannot accept another session mark');
a.edit(d=>d.model.name='changed','');assert.equal(a.rollbackTo(JSON.parse(JSON.stringify(mark))),true);assert.equal(a.draft.model.name,'Original');
const beforeReload=a.historyMark();a.takeFile(saved());assert.equal(a.rollbackTo(beforeReload),false,'same-file replacement retires old document marks');
let observed;a.registerPostEditObserver((before,after)=>observed={before,after});a.edit(d=>d.parts[0].label='Observed','');b.edit(d=>d.parts[0].label='B label','');
assert.equal(a.revertObservedEdit(observed.before,observed.after),true);assert.equal(a.draft.parts[0].label,undefined);assert.equal(b.draft.parts[0].label,'B label');
a.registerDeriveHook(d=>d.model.description='derived A');a.edit(d=>d.parts[0].label='derive','');assert.equal(a.draft.model.description,'derived A');assert.equal(b.draft.model.description,'B1');a.registerDeriveHook(null);
a.takeFile(saved());a.edit(d=>d.parts[0].label='Geometry','');const baseline=JSON.parse(a.snapshot());a.setFile({...a.file(),design:baseline,hash:'geometry'});
const original=a.historyMark();assert.equal(a.syncSavedDesignName('same-id','Original','geometry','geometry'),true);assert.deepEqual(a.historyMark(),original);
assert.equal(a.syncSavedDesignName('same-id','Renamed','renamed','geometry'),true);assert.equal(a.rollbackTo(original),false);a.undo();assert.equal(a.draft.model.name,'Renamed');a.redo();assert.equal(a.draft.parts[0].label,'Geometry');assert.equal(b.draft.model.name,'Original');
a.takeFile({...saved(),design:{...design(),python_source_model:'python-project',python_source_hash:'linked'}});
a.edit(d=>d.model.description='metadata','');assert.equal(a.draft.python_source_model,'python-project');a.edit(d=>d.parts[0].label='geometry','');assert.equal(a.draft.python_source_model,undefined);a.undo();assert.equal(a.draft.python_source_model,'python-project');
const ta=a.asyncState.ticket(),tb=b.asyncState.ticket();assert.equal(b.asyncState.isDocumentCurrent(ta),false);assert.equal(a.asyncState.isDocumentCurrent(tb),false);
const nav=a.asyncState.navigationTicket();assert.equal(b.asyncState.isOwnedNavigationCurrent(nav),false);assert.equal(a.asyncState.isOwnedNavigationCurrent(nav),true);
a.asyncState.editDraft();assert.equal(a.asyncState.isDraftCurrent(ta),false);assert.equal(b.asyncState.isDraftCurrent(tb),true);
// Delayed successes/failures/finally are routed only to their captured live owner.
let release;const held=new Promise(resolve=>release=resolve),owned=a.asyncState.ticket();a.setSaving(true);
const pending=(async()=>{await held;if(a.asyncState.isDocumentCurrent(owned))a.setMessage({tone:'good',text:'late A'});if(a.asyncState.isDocumentCurrent(owned))a.setSaving(false);})();
const bBefore=b.historyMark(),callbacks={...effects};a.showSaveNote({tone:'good',text:'temporary'});a.dispose();release();await pending;
assert.equal(a.asyncState.isDocumentCurrent(owned),false);assert.equal(a.asyncState.isDocumentCurrent(a.asyncState.ticket()),false);assert.equal(a.asyncState.isOwnedNavigationCurrent(a.asyncState.navigationTicket()),false);
a.edit(()=>{throw Error('disposed edit ran');});a.undo();a.redo();a.takeFile(saved());a.setFile(saved());a.setDraft('model','name','revived');a.notifyDocumentChange();a.showSaveNote({tone:'good',text:'revived'});
assert.equal(a.file(),null);assert.deepEqual(JSON.parse(a.snapshot()),{});assert.equal(a.message(),null);assert.equal(a.rollbackTo(mark),false);assert.equal(effects.a,callbacks.a);assert.equal(effects.restoreA,callbacks.restoreA);assert.equal(effects.dispose,1);a.dispose();assert.equal(effects.dispose,1);
assert.deepEqual(b.historyMark(),bBefore);assert.equal(b.asyncState.isDraftCurrent(tb),true);assert.equal(writes,beforeWrites);b.dispose();
const c=createDesignerSession({edited:()=>{throw Error('disposed observer triggered preview callback');}});c.takeFile(saved());
let disposeConsumer;const steps=createRoot(dispose=>{disposeConsumer=dispose;return createMemo(()=>c.historySteps());});
assert.equal(steps().length,1);c.registerPostEditObserver(()=>c.dispose());c.edit(d=>d.model.description='observer closes session','');
assert.equal(c.isDisposed(),true);assert.equal(c.file(),null);assert.equal(steps().length,0,'external reactive history consumers see disposal');disposeConsumer();
const closing=createDesignerSession();closing.takeFile(saved());closing.registerDocumentChangeObserver(()=>closing.dispose());closing.takeFile(saved());
assert.equal(closing.isDisposed(),true);assert.equal(closing.file(),null);assert.deepEqual(JSON.parse(closing.snapshot()),{},'document observer disposal cannot reload a closed session');
console.log('Designer sessions: independent draft/status/history/coalescing/observers/marks/rename/Python/async ownership/disposal pass');
