// Actual Solid comparison store, bundled in memory with its current-project inputs isolated.
// No DOM, server, solver, network or emitted build files.
import assert from 'node:assert/strict';
import {build} from 'vite';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)).replaceAll('\\','/');
const state='\0compare-test-state';
const built=await build({root,configFile:false,logLevel:'silent',resolve:{conditions:['browser']},plugins:[{
 name:'compare-lifecycle-entry',enforce:'pre',resolveId(id,importer){if(id.endsWith('compare-lifecycle-entry'))return '\0compare-lifecycle-entry';if(id===state || id==='../state'&&importer?.replaceAll('\\','/').endsWith('/src/compare/store.ts'))return state;},
 load(id){if(id===state)return `import {createSignal} from 'solid-js';export const [bundle,setBundle]=createSignal(null);export const [source,setSource]=createSignal('');`;if(id==='\0compare-lifecycle-entry')return `export * as store from ${JSON.stringify(root+'src/compare/store.ts')};export * as current from ${JSON.stringify(state)};`;},
}],build:{write:false,minify:false,lib:{entry:'compare-lifecycle-entry',formats:['es']}}});
const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v))};
const requests=[];globalThis.fetch=(url)=>new Promise((resolve,reject)=>requests.push({url,resolve,reject}));
const code=(Array.isArray(built)?built[0]:built).output[0].code;
const {store:s,current}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const fixture=JSON.parse(readFileSync(root+'public/projects/patch-antenna.json','utf8'));
const success=(r,name)=>r.resolve({ok:true,json:async()=>({...fixture,name})});
const tick=async()=>{await Promise.resolve();await Promise.resolve();};
const entry=()=>s.pinned()[0];
let checks=0;const check=async(name,run)=>{s.clearPinned();await run();checks++;console.log('ok '+name);};
await check('removed and re-pinned same file ignores the old success',async()=>{
 const first=s.pin('a.json'),old=requests.at(-1);s.unpin('a.json');const next=s.pin('a.json'),fresh=requests.at(-1);
 success(fresh,'fresh');await next;success(old,'old');await first;assert.equal(entry().bundle.name,'fresh');
});
await check('removed and re-pinned same file ignores the old failure',async()=>{
 const first=s.pin('a.json'),old=requests.at(-1);s.unpin('a.json');const next=s.pin('a.json'),fresh=requests.at(-1);
 success(fresh,'fresh');await next;old.reject(new Error('obsolete failure'));await first;assert.equal(entry().bundle.name,'fresh');assert.equal(entry().error,undefined);
});
await check('clear cancels sequential pinAll before the next request',async()=>{
 const all=s.pinAll(['a.json','b.json']),old=requests.at(-1),count=requests.length;s.clearPinned();success(old,'old');await tick();
 assert.equal(requests.length,count,'cancelled batch must not fetch the next file');await all;assert.deepEqual(s.pinned(),[]);
});
await check('newer pinAll owns the set and old completion cannot append',async()=>{
 const older=s.pinAll(['a.json','b.json']),old=requests.at(-1);const newer=s.pinAll(['c.json']),fresh=requests.at(-1);
 success(fresh,'new');await newer;const count=requests.length;success(old,'old');await tick();assert.equal(requests.length,count);await older;assert.deepEqual(s.pinned().map(x=>x.file),['c.json']);
});
await check('re-pin after clear reads fresh bytes even after obsolete successes',async()=>{
 for(let i=0;i<12;i++){const file=`file-${i}.json`;let task=s.pin(file);success(requests.at(-1),'first');await task;s.clearPinned();const count=requests.length;task=s.pin(file);assert.equal(requests.length,count+1,'re-pin after clear must fetch current bytes');success(requests.at(-1),'current');await task;assert.equal(entry().bundle.name,'current');s.clearPinned();}
 const old=s.pin('late.json'),request=requests.at(-1);s.clearPinned();success(request,'old');await old;const count=requests.length;const fresh=s.pin('late.json');assert.equal(requests.length,count+1);success(requests.at(-1),'fresh');await fresh;
});
await check('obsolete batch failure cannot erase a newer same-file batch',async()=>{
 const older=s.pinAll(['a.json','b.json']),old=requests.at(-1);const newer=s.pinAll(['a.json']),fresh=requests.at(-1);
 old.reject(new Error('old batch failure'));await older;assert.equal(entry().error,undefined);assert.equal(entry().bundle,null);
 success(fresh,'fresh batch');await newer;assert.equal(entry().bundle.name,'fresh batch');assert.deepEqual(s.pinned().map(x=>x.file),['a.json']);
});
await check('duplicates and max seven preserve order and persistence',async()=>{
 const tasks=[];for(let i=0;i<7;i++){tasks.push(s.pin(`p${i}.json`));success(requests.at(-1),`p${i}`);}await Promise.all(tasks);const count=requests.length;await s.pin('p0.json');await s.pin('extra.json');assert.equal(requests.length,count);assert.equal(s.pinned().length,7);assert.deepEqual(JSON.parse(storage.get('fairbeam.compare')),s.pinned().map(x=>x.file));
});
await check('reference import merges, occupies one slot and survives ordinary unpin',async()=>{
 const ref={name:'reference.s1p',text:async()=> '# Hz S RI R 50\n1000000000 0.1 0\n2000000000 0.2 0\n'};
 await s.importReferenceFile(ref);assert.equal(s.pinned()[0].file,s.REF_KEY);assert.ok(s.reference());await s.importReferenceFile(ref);assert.equal(s.pinned().length,1);
 const task=s.pin('a.json');success(requests.at(-1),'a');await task;s.unpin('a.json');assert.ok(s.reference());s.clearReference();assert.deepEqual(s.pinned(),[]);
});
await check('full-set reference replacement cannot leave ownership of an evicted request',async()=>{
 const tasks=[];for(let i=0;i<7;i++)tasks.push(s.pin(`r${i}.json`));const old=requests.at(-1);
 await s.importReferenceFile({name:'reference.s1p',text:async()=> '# Hz S RI R 50\n1000000000 0.1 0\n2000000000 0.2 0\n'});
 assert.equal(s.pinned().length,7);assert.equal(s.isPinned('r6.json'),false);
 s.unpin('r0.json');const fresh=s.pin('r6.json'),request=requests.at(-1);success(request,'fresh');await fresh;success(old,'old');await tasks[6];
 assert.equal(s.pinned().find(x=>x.file==='r6.json').bundle.name,'fresh');assert.ok(s.reference());
 for(let i=0;i<6;i++)success(requests.find(r=>r.url.endsWith('/r'+i+'.json')),'retained');await Promise.all(tasks);
});
const referenceText='# Hz S RI R 50\n1000000000 0.1 0\n2000000000 0.2 0\n';
const deferredFile=name=>{let resolve,reject;const text=new Promise((yes,no)=>{resolve=yes;reject=no;});return {file:{name,text:()=>text},resolve:()=>resolve(referenceText),reject};};
await check('project switch during file read rejects reference attachment',async()=>{
 current.setBundle({...fixture,model:{...fixture.model,id:'project-a'}});await tick();
 const read=deferredFile('old.s1p'),task=s.importReferenceFile(read.file);
 current.setBundle({...fixture,model:{...fixture.model,id:'project-b'}});await tick();read.resolve();await task;assert.equal(s.reference(),undefined);
});
await check('clear reference or all pins cancels a read even with no visible reference',async()=>{
 for(const clear of [s.clearReference,s.clearPinned]){const read=deferredFile('cleared.s1p'),task=s.importReferenceFile(read.file);clear();read.resolve();await task;assert.equal(s.reference(),undefined);}
 const read=deferredFile('cleared-error.s1p'),task=s.importReferenceFile(read.file);s.clearReference();read.reject(new Error('obsolete read'));await task;assert.equal(s.refError(),null);
});
await check('newer overlapping import wins and obsolete failures cannot replace its error',async()=>{
 const older=deferredFile('older.s1p'),first=s.importReferenceFile(older.file);const newer=deferredFile('newer.s1p'),next=s.importReferenceFile(newer.file);
 newer.resolve();await next;older.resolve();await first;assert.deepEqual(s.reference().reference.files,['newer.s1p']);
 const obsolete=deferredFile('obsolete.s1p'),old=s.importReferenceFile(obsolete.file);const latest=deferredFile('latest.s1p'),fresh=s.importReferenceFile(latest.file);
 latest.reject(new Error('latest read failed'));await fresh;obsolete.reject(new Error('obsolete read failed'));await old;assert.equal(s.refError(),'latest.s1p: latest read failed');
});
await check('sequential imports keep intentional merges and same-model source replacement cancels reads',async()=>{
 await s.importReferenceFile({name:'first.s1p',text:async()=>referenceText});await s.importReferenceFile({name:'second.s1p',text:async()=>referenceText});assert.deepEqual(s.reference().reference.files,['first.s1p','second.s1p']);
 const prior=s.reference(),read=deferredFile('stale.s1p'),task=s.importReferenceFile(read.file);current.setBundle({...current.bundle()});await tick();read.resolve();await task;assert.equal(s.reference(),prior);
});
await check('switch away and back to the same source invalidates an in-flight import',async()=>{
 const owner=current.bundle(),read=deferredFile('away.s1p'),task=s.importReferenceFile(read.file);
 current.setBundle({...fixture,model:{...fixture.model,id:'temporary-project'}});await tick();current.setBundle(owner);await tick();read.resolve();await task;assert.equal(s.reference(),undefined);
});
console.log(`Comparison lifecycle: ${checks} checks passed`);

