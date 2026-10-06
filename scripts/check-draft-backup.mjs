import assert from 'node:assert/strict';
import {writeBackup, readBackup, clearBackup, readLegacyBackup, readOlderBackups, rememberLastDesign, readLastDesign, forgetLastDesign} from '../src/designer/draftBackup.ts';

const data=new Map(), last=new Map();
const storage=m=>({get length(){return m.size;},key:i=>[...m.keys()][i]??null,getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)});
globalThis.localStorage=storage(data);globalThis.sessionStorage=storage(last);
const a='models-v1:'+'a'.repeat(64),b='models-v1:'+'b'.repeat(64);
const design=name=>({schema:'fairbeam.design/1',model:{id:'same',name},params:[],materials:[],parts:[]});
writeBackup('same','same-hash',design('A'),a);writeBackup('same','same-hash',design('B'),b);
assert.equal(readBackup('same','same-hash',a).design.model.name,'A');
assert.equal(readBackup('same','same-hash',b).design.model.name,'B');
assert.equal(readBackup('same','different',a),null);assert.equal(data.size,2,'a stale read deletes no record');
clearBackup('same',a);assert.equal(readBackup('same','same-hash',a),null);
assert.equal(readBackup('same','same-hash',b).design.model.name,'B');
const legacy={at:Date.now(),base:'same-hash',design:design('Legacy')};
data.set('fairbeam:draft:same',JSON.stringify(legacy));last.set('fairbeam:lastDesign','legacy-id');
assert.deepEqual(readLegacyBackup('same'),legacy);
assert.equal(readBackup('same','same-hash',a),null,'matching legacy content does not prove workspace');
const before=[...data];
writeBackup('same','same-hash',design('unknown'));clearBackup('same');clearBackup('same','invalid');
assert.equal(readBackup('same','same-hash'),null);assert.deepEqual([...data],before);
rememberLastDesign('project-a',a);rememberLastDesign('project-b',b);forgetLastDesign(a);
assert.equal(readLastDesign(a),null);assert.equal(readLastDesign(b),'project-b');
assert.equal(readLastDesign(),null);forgetLastDesign();assert.equal(last.get('fairbeam:lastDesign'),'legacy-id');
writeBackup('same','new-base',design('B newer'),b);
assert.equal(readOlderBackups('same','new-base',b)[0].design.model.name,'B');
clearBackup('same',b,'new-base');
assert.equal(readBackup('same','same-hash',b).design.model.name,'B','clearing new base preserves stale recovery');
const kb=`fairbeam:draft:v2:${b}:same:same-hash`,valid=data.get(kb);
for(const mutation of [{scope:a},{id:'other'},{version:1},{at:NaN},{design:{}},{base:null}]) {
 data.set(kb,JSON.stringify({...JSON.parse(valid),...mutation}));assert.equal(readBackup('same','same-hash',b),null);
}
data.set(kb,'malformed');assert.equal(readBackup('same','same-hash',b),null);assert.equal(data.get(kb),'malformed');
data.set('fairbeam:draft:same','malformed');assert.equal(readLegacyBackup('same'),null);assert.equal(data.get('fairbeam:draft:same'),'malformed');
Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('blocked');}});
assert.doesNotThrow(()=>writeBackup('same','base',design('A'),a));assert.doesNotThrow(()=>clearBackup('same',a));
assert.equal(readBackup('same','base',a),null);assert.equal(readLegacyBackup('same'),null);
console.log('Workspace-scoped backup isolation, legacy preservation, corruption and unavailable storage passed');
