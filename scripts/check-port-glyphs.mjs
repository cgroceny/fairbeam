// Port / lumped-element glyphs: pixel-sized, x-ray, rescaled without rebuilding geometry.
// Run: node --experimental-strip-types scripts/check-port-glyphs.mjs
import assert from "node:assert/strict";
import * as THREE from "three";
import { lumpedObject, portObject, updatePortGlyphs, waveguidePortObject } from "../src/scene/portGlyphs.ts";

const meshes = (g) => { const out = []; g.traverse((o) => o.isMesh && out.push(o)); return out; };
const size = (o) => new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());

// half-wave dipole feed: a 1 mm gap and a 2 mm wide strip in a ~300 mm scene
const port = portObject([-1, -1, -0.5], [1, 1, 0.5], "#d4462f", 0.3, "z");
assert.equal(port.userData.kind, "lumped");
assert.ok(port.children.length >= 8, "ball, shaft, head (solid + x-ray) and the area block");
const xray = meshes(port).filter((m) => m.material.depthTest === false && m.material.transparent);
assert.ok(xray.length >= 3, "x-ray pass ignores the depth buffer so a port inside metal stays visible");
assert.ok(meshes(port).some((m) => m.material.depthTest === true && !m.material.transparent), "solid pass present");

const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 1e6);
camera.position.set(300, -300, 200);
const root = new THREE.Group();
root.add(port);
const geoms = new Set(meshes(port).map((m) => m.geometry));
const wpp = (d) => 2 * d * Math.tan(THREE.MathUtils.degToRad(16)) / 600;

// zoomed far out: still at least a few pixels long/wide
updatePortGlyphs(root, camera, 600);
const far = size(port);
const farPx = wpp(camera.position.distanceTo(port.userData.labelAnchor));
assert.ok(Math.max(far.x, far.y, far.z) >= 12 * farPx * 0.8, `arrow spans >= ~12 px at distance (got ${Math.max(far.x, far.y, far.z) / farPx} px)`);
// zoomed in: the true 1 mm gap length wins
camera.position.set(3, -3, 2);
updatePortGlyphs(root, camera, 600);
const near = size(port);
assert.ok(near.z >= 1 - 1e-6, "never smaller than the real gap");
// no geometry rebuilds: the same shared geometry objects before and after
assert.deepEqual(new Set(meshes(port).map((m) => m.geometry)), geoms, "geometries reused, only scales change");

// a zero-width wire feed has no area block; a strip feed does (when wider than ~2 px)
const wire = portObject([0, 0, -0.5], [0, 0, 0.5], "#d4462f", 0.05, "z");
updatePortGlyphs(Object.assign(new THREE.Group(), { children: [wire] }), camera, 600);
const fills = (g) => g.children.filter((c) => c.isMesh && c.renderOrder === 58 || c.isLineSegments && c.renderOrder === 61);
assert.ok(fills(wire).every((c) => !c.visible), "line port: no area block");
assert.ok(fills(port).every((c) => c.visible), "strip port: translucent block + outline");

// negative direction flips the arrowhead (stop below start)
const down = portObject([0, 0, 0.5], [0, 0, -0.5], "#d4462f", 0.05, "z");
const head = meshes(down).find((m) => m.geometry.type === "ConeGeometry");
assert.ok(new THREE.Vector3(0, 0, 1).applyQuaternion(head.quaternion).z < 0, "cone points along -z");

// highlight changes colour and strengthens the x-ray pass
const before = port.userData.labelAnchor.clone();
port.userData.setHighlight(true, "#2467b7");
const x = meshes(port).find((m) => m.material.transparent && m.material.depthTest === false);
assert.equal(x.material.color.getHexString(), "2467b7");
assert.ok(x.material.opacity > 0.8);
port.userData.setHighlight(false);
assert.equal(x.material.color.getHexString(), "d4462f");
assert.equal(before.x, port.userData.labelAnchor.x);

// waveguide port: translucent sheet, outline, arrow; direction x here
const wg = waveguidePortObject([0, -11, -5], [4, 11, 5], "x", "#d4462f", 0.2);
assert.equal(wg.userData.kind, "waveguide");
assert.ok(wg.children.some((c) => c.isMesh && c.material.transparent && c.material.opacity < 0.5), "translucent sheet");
assert.ok(wg.children.filter((c) => c.isLineSegments).length >= 2, "excitation outline + probe outline");
assert.equal(wg.userData.labelAnchor.x, 4, "label sits at the probe plane");

// lumped element: not the port colour, amber accent drawn through metal
const r = lumpedObject([0, 0, 0], [2, 0.5, 0], "#2f2d2a", 0.3, "#e0a526", "x");
assert.equal(r.userData.kind, "element");
const accent = r.children.find((c) => c.isLine && !c.isLineSegments);
assert.equal(accent.material.color.getHexString(), "e0a526");
assert.equal(accent.material.depthTest, false);
assert.ok(size(r).z >= 0.3 - 1e-9, "flat resistor thickened");
console.log("port glyph checks passed");
