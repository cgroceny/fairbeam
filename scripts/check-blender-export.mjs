import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import * as THREE from 'three';
import { blenderScene, blenderGlb, blenderFileStem } from '../src/export/blender.ts';
// The texture-free browser exporter needs only this FileReader operation in Node.
globalThis.FileReader = class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.(); }); }
};
const primitive = { kind: 'box', start: [0, 0, 0], stop: [10, 20, 2], bbox: [[0,0,0],[10,20,2]], exact: true, priority: 1 };
const transformed = { kind: 'transformed', primitive, matrix: [[0,-1,0,30],[1,0,0,5],[0,0,1,3],[0,0,0,1]], bbox: [[10,5,3],[30,15,5]], exact: true, priority: 1 };
const bundle = { model: { id: '../fixture', name: 'Transformed copper' }, units: { length: 'mm', length_m: 0.001 }, parts: [{ name: 'Copper component', type: 'Metal', color: '#b87333', primitives: [transformed] }] };
const colors = Object.fromEntries(['metal','dielectric','port','edge','domain','nf2ff','ground','grid','gridMajor'].map(key => [key,'#888888']));
const scene = blenderScene(bundle, colors);
const bounds = new THREE.Box3().setFromObject(scene);
assert.ok(bounds.min.distanceTo(new THREE.Vector3(0.01,0.003,-0.015)) < 1e-8);
assert.ok(bounds.max.distanceTo(new THREE.Vector3(0.03,0.005,-0.005)) < 1e-8);
const mesh = scene.children[0].children[0].children[0];
assert.equal(mesh.name, 'Copper component_1');
assert.equal(mesh.material.color.getHexString(), 'b87333');
assert.equal(mesh.material.transparent, false);
assert.equal(blenderFileStem('../../a b'), 'a_b');
assert.throws(() => blenderScene({ ...bundle, units: { length_m: 0 } }, colors), /length unit/);
assert.throws(() => blenderScene({ ...bundle, parts: [{...bundle.parts[0], primitives: [{...primitive, exact:false}]}] }, colors), /approximate/);
const glb = await blenderGlb(bundle, colors);
const header = new DataView(glb);
assert.equal(header.getUint32(0,true), 0x46546c67);
assert.equal(header.getUint32(4,true), 2);
assert.equal(header.getUint32(8,true), glb.byteLength);
const jsonLength = header.getUint32(12,true);
const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb,20,jsonLength)));
assert.equal(json.asset.version, '2.0');
assert.equal(json.meshes.length, 1);
assert.ok(json.nodes.some(node => node.extras?.component === 'Copper component'));
const output = process.argv[2];
if (output) { await mkdir(output,{recursive:true}); await writeFile(`${output}/model.glb`,new Uint8Array(glb)); await copyFile(new URL('../src/export/blender-render.py',import.meta.url),`${output}/blender-render.py`); }
console.log('Blender export: transformed metric bounds, names, colors, GLB structure and error guards pass');
