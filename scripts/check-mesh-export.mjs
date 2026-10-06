import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';
import { binaryStl, binaryStlParts, DEFAULT_SHEET_THICKNESS_UM } from '../src/export/mesh.ts';
import { blenderScene, blenderGlb } from '../src/export/blender.ts';

globalThis.FileReader = class { readAsArrayBuffer(blob) { blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.(); }); } };
const colors = Object.fromEntries(['metal','dielectric','port','edge','domain','nf2ff','ground','grid','gridMajor'].map(key => [key,'#888888']));
const box = { kind:'box', start:[1,2,3], stop:[5,8,4], bbox:[[1,2,3],[5,8,4]], priority:1, exact:true };
const transform = { kind:'transformed', primitive:box, matrix:[[-2,0,0,30],[0,3,0,-5],[0,0,4,1],[0,0,0,1]], bbox:[[20,1,13],[28,19,17]], priority:1, exact:true };
const bundle = { model:{id:'mesh-fixture',name:'Asymmetric assembly'}, units:{length:'mm',length_m:0.001}, parts:[{ name:'reflected metal', type:'Metal', color:'#b87333', primitives:[transform] }], ports:[{ start:[100,100,100],stop:[200,200,200] }] };
const near = (actual,expected,epsilon=1e-5) => expected.forEach((value,index) => assert.ok(Math.abs(actual[index]-value)<epsilon,`${actual} ~= ${expected}`));
function parse(bytes) {
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const count = view.getUint32(80,true);
  assert.equal(bytes.length,84+count*50,'exact binary facet count');
  assert.match(new TextDecoder().decode(bytes.subarray(0,80)),/millimetres.*Z-up/);
  const lo = [Infinity,Infinity,Infinity], hi = [-Infinity,-Infinity,-Infinity];
  const triangles = [];
  for (let index=0;index<count;index++) {
    const values = Array.from({length:12},(_,offset)=>view.getFloat32(84+index*50+offset*4,true));
    assert.ok(values.every(Number.isFinite));
    assert.equal(view.getUint16(84+index*50+48,true),0);
    const [normal,a,b,c] = Array.from({length:4},(_,offset)=>new THREE.Vector3(...values.slice(offset*3,offset*3+3)));
    const cross = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    assert.ok(cross.dot(normal)>0.99999,'stored normal follows emitted winding');
    assert.ok(Math.abs(normal.length()-1)<1e-6);
    for (const vertex of [a,b,c]) vertex.toArray().forEach((value,axis)=>{lo[axis]=Math.min(lo[axis],value);hi[axis]=Math.max(hi[axis],value);});
    triangles.push({normal,center:a.add(b).add(c).multiplyScalar(1/3)});
  }
  return { count,lo,hi,triangles };
}
const reflected = parse(binaryStl(bundle));
assert.equal(reflected.count,12);
near(reflected.lo,[20,1,13]); near(reflected.hi,[28,19,17]);
const center = new THREE.Vector3(24,10,15);
for (const facet of reflected.triangles) assert.ok(facet.normal.dot(facet.center.clone().sub(center))>0,'reflection retains outward winding');
const centimetres = parse(binaryStl({...bundle,units:{length:'cm',length_m:0.01}}));
near(centimetres.lo,[200,10,130]); near(centimetres.hi,[280,190,170]);
const sheet = {...box,start:[1,2,7],stop:[5,8,7]};
const sheets = parse(binaryStl({...bundle,parts:[{...bundle.parts[0],primitives:[sheet]}]}));
assert.equal(sheets.count,4,'a sheet is written two-sided: 2 triangles per face'); near(sheets.lo,[1,2,7]); near(sheets.hi,[5,8,7]);
assert.ok(sheets.triangles.some(f=>f.normal.z>0.99)&&sheets.triangles.some(f=>f.normal.z<-0.99),'both faces of the sheet');
for (const primitive of [{...box,exact:false},{...box,start:[NaN,0,0]}, {...box,start:[1,2,3],stop:[1,2,3]}, {kind:'polygon',normal:2,elevation:0,points:[[0,0],[1,0],[2,0]],priority:1,exact:true}, {...transform,matrix:[[0,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]}]) {
  const bad = {...bundle,parts:[{...bundle.parts[0],primitives:[primitive]}]};
  assert.throws(()=>binaryStl(bad)); assert.throws(()=>blenderScene(bad,colors));
}
assert.throws(()=>binaryStl({...bundle,parts:[]}));
assert.throws(()=>blenderScene({...bundle,parts:[]},colors));
assert.throws(()=>binaryStl({...bundle,units:{length_m:0}}));
// Exercise the binary writer across its storage boundary without a large physical scene.
const oneBox = binaryStl({...bundle,parts:[{...bundle.parts[0],primitives:[box]}]});
const repeated = binaryStl({...bundle,parts:[{...bundle.parts[0],primitives:Array(5500).fill(box)}]});
const repeatedView = new DataView(repeated.buffer);
assert.equal(repeatedView.getUint32(80,true),66000);
assert.equal(repeated.length,84+66000*50);
for (const start of [0,65532,65988]) {
  assert.deepEqual(repeated.subarray(84+start*50,84+(start+12)*50),oneBox.subarray(84),'facet records are preserved across chunk boundaries');
}

// A board, offset thin copper patch, and a rotated/asymmetrically scaled feed.
const patch = {...bundle,model:{id:'patch-fixture',name:'Patch assembly'},parts:[
  {name:'board',type:'Material',color:'#526947',primitives:[{...box,start:[-24,-18,0],stop:[24,18,1.6]}]},
  {name:'patch',type:'Metal',color:'#b87333',primitives:[{...box,start:[-12,-9,1.6],stop:[14,11,1.6]}]},
  {name:'ground',type:'Metal',color:'#b87333',primitives:[{...box,start:[-24,-18,0],stop:[24,18,0]}]},
  bundle.parts[0],
]};
const components = {board:'PCB/Substrate',patch:'PCB/Copper',ground:'PCB/Copper','reflected metal':'Feed'};
const scene = blenderScene(patch,colors,components);
const pcb = scene.children[0].children.find(node=>node.name==='PCB');
assert.deepEqual(pcb.children.map(node=>node.name),['Substrate','Copper']);
let meshCount=0; scene.traverse(node=>{ if(node.isMesh)meshCount++; assert.ok(!node.isLine,'no grid or edges'); });
assert.equal(meshCount,4);
const patchStl = parse(binaryStl(patch));
near(patchStl.lo,[-24,-18,0]); near(patchStl.hi,[28,19,17]);
const glb = await blenderGlb(patch,colors,components);
const data = new DataView(glb);
const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb,20,data.getUint32(12,true))));
assert.equal(json.meshes.length,4);
assert.ok(json.nodes.some(node=>node.extras?.component==='PCB/Copper'));
assert.ok(json.nodes.some(node=>node.name==='reflected metal_1'));
assert.equal(json.materials.length,4);

// Sheets are never lost: the starters (a trace on a substrate, a patch, a dipole) export every conductor.
const starters = JSON.parse(await readFile(new URL('./fixtures/starter-bundles.json',import.meta.url),'utf8'));
const zRange = parsed => [parsed.lo[2],parsed.hi[2]];
for (const [key,starter] of Object.entries(starters)) {
  const per = binaryStlParts(starter);
  assert.equal(per.length,starter.parts.length,`${key}: one STL per part`);
  for (const file of per) assert.ok(parse(file.bytes).count>0,`${key}/${file.name}: triangles`);
  assert.equal(new Set(per.map(f=>f.name)).size,per.length,`${key}: unique file names`);
  assert.ok(starter.ports.length>0,'starter has ports, which must not appear as solids');
  const merged = parse(binaryStl(starter));
  assert.equal(merged.count,per.reduce((n,f)=>n+parse(f.bytes).count,0),`${key}: merged STL holds every part`);
  const sc = starter.units.length_m*1000;
  const [lo,hi] = starter.parts.reduce(([l,h],part)=>part.bbox?[l.map((v,i)=>Math.min(v,part.bbox[0][i]*sc)),h.map((v,i)=>Math.max(v,part.bbox[1][i]*sc))]:[l,h],[[Infinity,Infinity,Infinity],[-Infinity,-Infinity,-Infinity]]);
  near(merged.lo,lo,1e-3); near(merged.hi,hi,1e-3); // the ports (and the simulation box) add nothing
  // with thickness every metal part is a closed slab with volume
  const thick = binaryStlParts(starter,{sheetThicknessUm:DEFAULT_SHEET_THICKNESS_UM});
  assert.equal(thick.length,per.length);
  for (const file of thick) { const q = parse(file.bytes); assert.ok(q.count>0); }
  const glbStarter = new DataView(await blenderGlb(starter,colors,{}));
  const jsonStarter = JSON.parse(new TextDecoder().decode(new Uint8Array(await blenderGlb(starter,colors,{}),20,glbStarter.getUint32(12,true))));
  assert.equal(jsonStarter.meshes.length,starter.parts.reduce((n,p)=>n+p.primitives.length,0),`${key}: every primitive of every part is a glTF mesh`);
  for (const part of starter.parts) assert.ok(jsonStarter.nodes.some(node=>node.extras?.component===part.name),`${key}: glTF has ${part.name}`);
  assert.ok(jsonStarter.materials.every(m=>m.doubleSided),`${key}: glTF sheets are double sided`);
}
const strip = starters.microstrip, stripStl = Object.fromEntries(binaryStlParts(strip).map(f=>[f.name,parse(f.bytes)]));
assert.deepEqual(Object.keys(stripStl).sort(),['gnd.stl','line.stl','substrate.stl']);
assert.equal(stripStl['line.stl'].count,4,'the line is a two-sided sheet'); assert.equal(stripStl['substrate.stl'].count,12);
// "Give sheets a thickness": 35 um slab, the trace above the substrate, the ground plane below it.
const slabs = Object.fromEntries(binaryStlParts(strip,{sheetThicknessUm:35}).map(f=>[f.name,parse(f.bytes)]));
assert.equal(slabs['line.stl'].count,12,'closed slab: 12 triangles');
near(zRange(slabs['line.stl']),[1.6,1.635]); near(zRange(slabs['gnd.stl']),[-0.035,0]);
near(zRange(slabs['substrate.stl']),[0,1.6]);
const centre = new THREE.Vector3(0,0,1.6175);
for (const facet of slabs['line.stl'].triangles) assert.ok(facet.normal.dot(facet.center.clone().sub(centre))>0,'slab faces point outward');
const slabScene = blenderScene(strip,colors,{},{sheetThicknessUm:35});
let lineMesh; slabScene.traverse(n=>{ if(n.isMesh&&n.name.startsWith('line_')) lineMesh=n; });
assert.equal(new THREE.Box3().setFromObject(lineMesh).getSize(new THREE.Vector3()).y.toFixed(6),'0.000035','glTF slab thickness in metres (Y is up)');
// an embedded or free sheet is centred; a polygon sheet becomes a slab too
const free = binaryStlParts({...bundle,parts:[{...bundle.parts[0],name:'free',primitives:[sheet]}]},{sheetThicknessUm:100})[0];
near(zRange(parse(free.bytes)),[6.95,7.05]);
assert.throws(()=>binaryStl(strip,{sheetThicknessUm:-1}));
const output=process.argv[2];
if(output) { await mkdir(output,{recursive:true});await writeFile(`${output}/model.glb`,new Uint8Array(glb));await writeFile(`${output}/model-mm.stl`,binaryStl(patch));await copyFile(new URL('../src/export/blender-render.py',import.meta.url),`${output}/blender-render.py`); }
console.log('Mesh export: binary STL facets/normals, reflected transforms, mm scaling, two-sided and thickened sheets, per-solid STL, starters (microstrip, patch, dipole), hierarchy, GLB and invalid geometry pass');
