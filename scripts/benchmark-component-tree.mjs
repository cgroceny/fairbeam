// Bounded tree construction benchmark; compares serialized outputs to the original algorithm.
import { performance } from 'node:perf_hooks';
import { strict as assert } from 'node:assert';
import { componentTree, normComponent } from '../src/designer/navModel.ts';
function original(parts,components=[]) {
  const root={name:'',path:'',folders:[],parts:[]};
  const addPath=component=>{
    let f=root;
    for(const seg of normComponent(component).split('/').filter(Boolean)) {
      const path=f.path?`${f.path}/${seg}`:seg;
      let next=f.folders.find(x=>x.name===seg);
      if(!next)f.folders.push(next={name:seg,path,folders:[],parts:[]});
      f=next;
    }
    return f;
  };
  components.forEach(addPath);parts.forEach((p,i)=>addPath(p.component).parts.push(i));
  return root;
}
function medianTime(fn,parts,components) {
  for(let i=0;i<3;i++)fn(parts,components);
  const samples=[];
  for(let i=0;i<9;i++){const start=performance.now();fn(parts,components);samples.push(performance.now()-start);}
  return samples.sort((a,b)=>a-b)[4];
}
for(const n of [1000,5000])for(const layout of ['unique-siblings','nested','shared']) {
  const parts=Array.from({length:n},(_,i)=>({component:layout==='unique-siblings'?`part-${i}`:layout==='nested'?`bank-${i%100}/feed-${i}`:`bank-${i%20}/ feed `}));
  parts.push({}, {component:' __proto__ / constructor '});
  const components=['empty/nested','bank-0/explicit','part-0','empty/nested'];
  assert.deepEqual(componentTree(parts,components),original(parts,components));
  console.log(JSON.stringify({parts:n,layout,identical:true,before_ms:medianTime(original,parts,components),after_ms:medianTime(componentTree,parts,components)}));
}
