// The rendered view and Render image: material looks, options, port placement, camera framing, file names.
// Pure data and geometry: no GL context is needed (the live scene is checked in a browser by the UI tests).
//
//   node --experimental-strip-types scripts/check-render.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { quickBundle } from "../src/designer/geometry.ts";
import { MATERIAL_LOOKS, lookFor, materialClass, partInfo } from "../src/render/materials.ts";
import {
  DEFAULT_RENDER_OPTIONS, RENDER_ANGLES, normalizeRenderOptions, renderFileName, renderFolder, renderFolderId, renderStem,
  parseRenderSide, renderTimestamp, resolutionPreset, supersampling,
} from "../src/render/options.ts";
import { MARKER_MIN_PX, SMA_MM, buildPorts, markerBead, markerScale, placeSma, portMarker, smdElement, updateMarkerSizes, waveguideFlange, worldPerPixel } from "../src/render/ports.ts";
import { FRAME_MARGIN, angleDirection, cameraFromFraming, frameBox, frameFromView } from "../src/render/frame.ts";
import { buildModel, makeMaterial } from "../src/render/scene.ts";

let n = 0;
const ok = (cond, what) => { n++; assert.ok(cond, what); };
const eq = (a, b, what) => { n++; assert.deepEqual(a, b, what); };
const near = (a, b, tol, what) => { n++; assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`); };
const vnear = (a, b, tol, what) => a.forEach((x, i) => near(x, b[i], tol, `${what}[${i}]`));

// ---------------------------------------------------------------- (a) the material table
{
  const hex = (id) => MATERIAL_LOOKS[id].baseColor.toLowerCase();
  eq([hex("copper"), MATERIAL_LOOKS.copper.metallic, MATERIAL_LOOKS.copper.roughness], ["#b87333", 1, 0.25], "copper: #B87333, metallic 1, roughness 0.25");
  eq([hex("gold"), MATERIAL_LOOKS.gold.roughness], ["#d4af37", 0.2], "gold");
  for (const id of ["silver", "tin", "nickel"]) eq([hex(id), MATERIAL_LOOKS[id].roughness], ["#c8c8c8", 0.2], id);
  eq([hex("aluminium"), MATERIAL_LOOKS.aluminium.roughness], ["#d0d3d4", 0.35], "aluminium");
  eq([hex("fr4"), MATERIAL_LOOKS.fr4.roughness], ["#c9c46a", 0.5], "FR-4 laminate: yellow-green tint, roughness 0.5");
  ok(MATERIAL_LOOKS.fr4.transmission > 0 && MATERIAL_LOOKS.fr4.transmission < 0.5, "FR-4 is slightly translucent");
  eq([hex("ptfe"), MATERIAL_LOOKS.ptfe.roughness], ["#ede6d6", 0.6], "Rogers / PTFE: cream");
  eq(MATERIAL_LOOKS.ceramic.roughness, 0.4, "alumina roughness");
  for (const [id, look] of Object.entries(MATERIAL_LOOKS)) {
    ok(look.id === id, `${id}: the key and the id agree`);
    ok(/^#[0-9a-f]{6}$/i.test(look.baseColor), `${id}: a hex colour`);
    ok(look.kind === "metal" ? look.metallic === 1 : look.metallic === 0, `${id}: metals are fully metallic, dielectrics not at all`);
    ok(look.roughness >= 0 && look.roughness <= 1 && look.transmission >= 0 && look.transmission <= 1 && look.opacity > 0 && look.opacity <= 1, `${id}: values in range`);
  }
  // the three.js material is the same numbers
  const m = makeMaterial(MATERIAL_LOOKS.copper, null);
  eq([m.color.getHexString(), m.metalness, m.roughness], ["b87333", 1, 0.25], "three material mirrors the table");
  const f = makeMaterial(MATERIAL_LOOKS.fr4, null, 1.6);
  ok(f.transmission === MATERIAL_LOOKS.fr4.transmission && f.thickness === 1.6 && f.attenuationDistance > 0, "translucent material gets a thickness and a tint distance");

  const metal = (extra) => ({ kind: "metal", ...extra });
  const diel = (extra) => ({ kind: "dielectric", ...extra });
  eq(materialClass(metal({ materialName: "copper" })), "copper", "copper by name");
  eq(materialClass(metal({ materialName: "Cu" })), "copper", "Cu");
  eq(materialClass(metal({ library: "pec" })), "copper", "PEC is copper");
  eq(materialClass(metal({})), "copper", "an unknown metal is copper");
  eq(materialClass(metal({ materialName: "gold plating" })), "gold", "gold");
  eq(materialClass(metal({ materialName: "Au" })), "gold", "Au");
  eq(materialClass(metal({ materialName: "silver" })), "silver", "silver");
  eq(materialClass(metal({ materialName: "Aluminium" })), "aluminium", "aluminium");
  eq(materialClass(metal({ materialName: "aluminum" })), "aluminium", "aluminum");
  eq(materialClass(metal({ materialName: "Al" })), "aluminium", "Al");
  eq(materialClass(metal({ materialName: "brass" })), "brass", "brass");
  eq(materialClass(metal({ materialName: "tin" })), "tin", "tin");
  eq(materialClass(metal({ materialName: "nickel" })), "nickel", "nickel");
  eq(materialClass(metal({ materialName: "stainless steel" })), "steel", "steel");
  eq(materialClass(metal({ materialName: "lossy", conductivity: 3.5e7 })), "aluminium", "conductivity names the metal");
  eq(materialClass(metal({ materialName: "lossy", conductivity: 4.1e7 })), "gold", "4.1e7 S/m is gold");
  eq(materialClass(metal({ materialName: "lossy", conductivity: 5.8e7 })), "copper", "5.8e7 S/m is copper");
  eq(materialClass(metal({ materialName: "lossy", conductivity: 2.0e6 })), "copper", "a conductivity of no known metal: copper");
  eq(materialClass(diel({ materialName: "FR4" })), "fr4", "FR4");
  eq(materialClass(diel({ materialName: "FR-4" })), "fr4", "FR-4");
  eq(materialClass(diel({ materialName: "fr4", eps_r: 4.3 })), "fr4", "fr4 with its permittivity");
  eq(materialClass(diel({ library: "ro4003c" })), "ptfe", "Rogers by library id");
  eq(materialClass(diel({ materialName: "RO4350B" })), "ptfe", "RO4350B");
  eq(materialClass(diel({ materialName: "Taconic TLY-5" })), "ptfe", "Taconic");
  eq(materialClass(diel({ materialName: "Teflon" })), "ptfe", "Teflon");
  eq(materialClass(diel({ materialName: "alumina" })), "ceramic", "alumina");
  eq(materialClass(diel({ materialName: "ceramic" })), "ceramic", "ceramic");
  eq(materialClass(diel({ materialName: "substrate", eps_r: 4.4, tan_d: 0.02 })), "fr4", "an unnamed lossy eps 4.4 board is FR-4");
  eq(materialClass(diel({ materialName: "substrate", eps_r: 3.38, tan_d: 0.0027 })), "ptfe", "an unnamed low-loss eps 3.4 board is a PTFE laminate");
  eq(materialClass(diel({ materialName: "substrate", eps_r: 9.8, tan_d: 0.0001 })), "ceramic", "eps 9.8 is ceramic");
  eq(materialClass(diel({ materialName: "foam", eps_r: 1.2, tan_d: 0.001 })), "dielectric", "any other dielectric");
  eq(materialClass(diel({ materialName: "air" })), null, "air is not drawn");
  eq(materialClass(diel({ materialName: "Vacuum" })), null, "vacuum is not drawn");
  eq(materialClass(diel({ materialName: "gap", eps_r: 1, tan_d: 0 })), null, "eps 1 without loss is air");
  eq(materialClass(diel({ materialName: "FR4", void: true })), null, "a void (cut-out) is not drawn");
  eq(materialClass({ kind: "other" }), null, "an unclassified part is not drawn");
  // solder mask: laminates only
  eq(materialClass(diel({ materialName: "fr4" }), "green"), "solder-mask", "green mask on FR-4");
  eq(materialClass(diel({ library: "ro4003c" }), "green"), "solder-mask", "green mask on a Rogers board");
  eq(materialClass(diel({ materialName: "PTFE block" }), "green"), "ptfe", "no mask on a PTFE block");
  eq(materialClass(diel({ materialName: "alumina" }), "green"), "ceramic", "no mask on ceramic");
  eq(materialClass(metal({ materialName: "copper" }), "green"), "copper", "no mask on metal");
  ok(MATERIAL_LOOKS["solder-mask"].coat > 0 && MATERIAL_LOOKS["solder-mask"].transmission === 0, "solder mask is glossy and opaque");
  // a colour override wins and keeps the finish
  const red = lookFor({ ...metal({ materialName: "copper" }), color: "#ff0000" });
  eq([red.baseColor, red.metallic, red.roughness], ["#ff0000", 1, 0.25], "a part colour on copper stays metallic");
  const blue = lookFor({ ...diel({ materialName: "fr4" }), color: "#2244ff" });
  eq([blue.baseColor, blue.attenuation.color], ["#2244ff", "#2244ff"], "a colour on FR-4 replaces the tint too");
  // from a bundle part
  const p = partInfo({ name: "ground", label: "Ground plane", type: "Metal", primitives: [], bbox: [[0, 0, 0], [1, 1, 0]], color: "#AABBCC" });
  eq([p.kind, p.color], ["metal", "#aabbcc"], "partInfo: kind and lower-cased colour");
  eq(partInfo({ name: "x", type: "Material", primitives: [], bbox: [[0, 0, 0], [1, 1, 1]], color: "red" }).color, undefined, "an invalid colour is ignored");
  eq(partInfo({ name: "x", type: "Material", primitives: [], bbox: [[0, 0, 0], [1, 1, 1]], conductor: { conductivity: 5.8e7, thickness: null } }).kind, "metal", "a lossy metal volume is metal");
}

// ---------------------------------------------------------------- (b) the options
{
  eq(Object.keys(DEFAULT_RENDER_OPTIONS).sort(), ["angles", "background", "engine", "groundShadow", "height", "ports", "projection", "quality", "solderMask", "width"], "the one options object");
  eq([DEFAULT_RENDER_OPTIONS.width, DEFAULT_RENDER_OPTIONS.height, DEFAULT_RENDER_OPTIONS.ports, DEFAULT_RENDER_OPTIONS.solderMask, DEFAULT_RENDER_OPTIONS.engine], [1920, 1080, "connector", "none", "app"], "defaults: Full HD, connector where it fits, no mask, in the app");
  eq(normalizeRenderOptions(), DEFAULT_RENDER_OPTIONS, "nothing in, defaults out");
  // a size typed in the dialog: within 64…8192 px or an error the dialog shows (it never clamps silently)
  eq(parseRenderSide("1920"), { value: 1920 }, "a size in range");
  eq(parseRenderSide(" 1000,6 "), { value: 1001 }, "a decimal (comma or point) is rounded: the field then shows it");
  for (const bad of ["50", "63", "8193", "99999", "", "abc", "-100"]) eq(parseRenderSide(bad), { error: "range" }, `"${bad}" is refused`);
  eq(parseRenderSide(64), { value: 64 }); eq(parseRenderSide("8192"), { value: 8192 }, "both ends are allowed");
  eq(normalizeRenderOptions({ angles: ["bottom", "iso", "iso", "current", "nope"] }).angles, ["iso", "bottom", "current"], "angles are deduplicated and ordered; unknown ones dropped");
  eq(normalizeRenderOptions({ angles: [] }).angles, ["iso"], "at least one angle");
  eq(normalizeRenderOptions({ angles: "iso" }).angles, ["iso"], "a non-list falls back");
  eq(RENDER_ANGLES.length, 8, "the seven presets and the current view");
  eq([normalizeRenderOptions({ width: 10, height: 99999 }).width, normalizeRenderOptions({ width: 10, height: 99999 }).height], [64, 8192], "sizes are clamped");
  eq(normalizeRenderOptions({ width: 1280.6, height: "720" }).width, 1281, "sizes are rounded");
  eq(normalizeRenderOptions({ width: "abc" }).width, 1920, "a bad size falls back");
  const o = normalizeRenderOptions({ background: "dark", ports: "marker", solderMask: "green", groundShadow: false, projection: "orthographic", engine: "blender", quality: "high" });
  eq([o.background, o.ports, o.solderMask, o.groundShadow, o.projection, o.engine, o.quality], ["dark", "marker", "green", false, "orthographic", "blender", "high"], "every option round-trips");
  const bad = normalizeRenderOptions({ background: "neon", ports: "all", solderMask: "blue", groundShadow: "yes", projection: "fisheye", engine: "gpu", quality: "ultra" });
  eq(bad, DEFAULT_RENDER_OPTIONS, "bad values fall back to the defaults");
  eq(resolutionPreset(1920, 1080), "fullhd", "1920x1080 preset");
  eq(resolutionPreset(3840, 2160), "uhd", "3840x2160 preset");
  eq(resolutionPreset(1000, 700), "custom", "anything else is custom");
  // supersampling: the quality's factor, reduced to fit the GPU and the pixel budget
  eq(supersampling({ width: 1920, height: 1080, quality: "draft" }), 1, "draft: no supersampling");
  eq(supersampling({ width: 1920, height: 1080, quality: "standard" }), 2, "standard: 2x");
  eq(supersampling({ width: 1920, height: 1080, quality: "high" }), 3, "high: 3x at Full HD");
  eq(supersampling({ width: 3840, height: 2160, quality: "high" }), 2, "high at 4K: held to the pixel budget");
  eq(supersampling({ width: 3840, height: 2160, quality: "standard" }), 2, "standard at 4K: 2x");
  eq(supersampling({ width: 7000, height: 4000, quality: "standard" }), 1, "a very large picture is drawn as it is");
  eq(supersampling({ width: 3840, height: 2160, quality: "standard" }, 4096), 1, "a small GPU limit reduces it to 1");
  ok(supersampling({ width: 64, height: 64, quality: "high" }) === 3, "tiny pictures can be tripled");
  ok(supersampling({ width: 4096, height: 4096, quality: "standard" }, 8192, 36e6) * 4096 <= 8192, "never past the GPU's side limit");
}

// ---------------------------------------------------------------- (c) file names and folders
{
  const d = new Date(2026, 9, 4, 15, 30, 12);
  eq(renderTimestamp(d), "20261004-153012", "local, sortable timestamp");
  eq(renderFileName("patch_test", "iso", d), "patch_test_iso_20261004-153012.png", "<design>_<angle>_<timestamp>.png");
  eq(renderFileName("My design (v2)", "current", d), "My_design_v2_current_20261004-153012.png", "a readable name for anything");
  eq(renderFileName("half-wave dipole", "bottom", new Date(2026, 0, 2, 3, 4, 5)), "half-wave_dipole_bottom_20260102-030405.png", "zero-padded");
  eq(renderStem("Ünïcode/..\\x"), "Unicode_.._x".replace("_.._", "_.._"), "separators and accents never leave a path");
  ok(!/[\\/:*?"<>| ]/.test(renderStem("a/b\\c:d*e?f\"g<h>i|j k")), "no character a file system refuses");
  eq(renderStem(""), "design", "empty falls back");
  eq(renderStem("....."), "design", "dots only falls back");
  ok(renderStem("x".repeat(200)).length <= 60, "long names are cut");
  eq(renderFolder("patch_test"), "renders/patch_test", "renders/<design-id>");
  eq(renderFolderId("a.b"), "a_b", "the folder id has no dot (the server's rule)");
  eq(renderFolderId("../../etc"), "etc", "a path in the id never climbs");
  ok(/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(renderFolderId("..\\evil/.x")), "folder ids are server-safe");
}

// ---------------------------------------------------------------- designs for the port tests
const unit = { length: "mm", length_m: 0.001, frequency: "GHz" };
const design = (id, materials, parts, ports) => ({
  model: { id, name: id }, params: [],
  materials, parts, ports,
  simulation: { f_min: 1, f_max: 3, boundaries: "MUR" },
});
const FR4 = { name: "fr4", kind: "dielectric", eps_r: 4.3, tan_d: 0.02, tan_d_freq: 1 };
const CU = { name: "copper", kind: "metal" };
const box = (a, b) => ({ kind: "box", start: a, stop: b });
const microstrip = design("ms", [CU, FR4], [
  { name: "substrate", material: "fr4", primitives: [box([-20, -10, 0], [20, 10, 1.6])] },
  { name: "gnd", material: "copper", primitives: [box([-20, -10, 0], [20, 10, 0])] },
  { name: "line", material: "copper", primitives: [box([-20, -1.55, 1.6], [20, 1.55, 1.6])] },
], [
  { type: "lumped", number: 1, R: "50", start: [-20, -1.55, 0], stop: [-20, 1.55, 1.6], direction: "z" },
  { type: "lumped", number: 2, R: "50", start: [20, -1.55, 0], stop: [20, 1.55, 1.6], direction: "z" },
]);
const patch = design("patch", [CU, FR4], [
  { name: "substrate", material: "fr4", primitives: [box([-30, -30, 0], [30, 30, 1.52])] },
  { name: "gnd", material: "copper", primitives: [box([-30, -30, 0], [30, 30, 0])] },
  { name: "patch", material: "copper", primitives: [box([-14, -17, 1.52], [14, 17, 1.52])] },
], [{ type: "lumped", number: 1, R: "50", start: [5, 0, 0], stop: [5, 0, 1.52], direction: "z" }]);
const dipole = design("dip", [CU], [
  { name: "arms", material: "copper", primitives: [box([-0.5, 0, 0.5], [0.5, 0, 28]), box([-0.5, 0, -28], [0.5, 0, -0.5])] },
], [{ type: "lumped", number: 1, R: "50", start: [-0.5, 0, -0.5], stop: [0.5, 0, 0.5], direction: "z" }]);
const bundleOf = (d) => { const b = quickBundle(d, {}, null); ok(b, `${d.model.id}: bundle builds`); return b; };
const solidsOf = (b) => b.parts.map((p) => {
  const box3 = new THREE.Box3(new THREE.Vector3(...p.bbox[0]), new THREE.Vector3(...p.bbox[1]));
  return { name: p.name, kind: p.type === "Metal" ? "metal" : "dielectric", min: box3.min.toArray(), max: box3.max.toArray() };
});

// ---------------------------------------------------------------- (d) SMA placement
{
  const b = bundleOf(microstrip), solids = solidsOf(b);
  const left = placeSma(b.ports[0], solids, 1), right = placeSma(b.ports[1], solids, 1);
  ok(left && right, "a microstrip port at a board edge gets a connector");
  eq([left.mount, right.mount], ["edge", "edge"], "edge launch at both ends");
  eq(left.axis, [-1, 0, 0], "the left connector points out of the left edge");
  eq(right.axis, [1, 0, 0], "the right connector points out of the right edge");
  vnear(left.origin, [-20, 0, 1.6 + SMA_MM.pin / 2], 1e-9, "the pin axis sits on the trace, at the board edge");
  vnear(right.origin, [20, 0, 1.6 + SMA_MM.pin / 2], 1e-9, "right pin axis");
  eq(left.flats, [0, 0, 1], "the hex flats are parallel to the board");
  ok(left.pinLength > 0 && left.pinLength <= SMA_MM.reach + 1e-9, "the pin reaches onto the trace by its reach");
  eq(left.board, "substrate", "mounted on the substrate");
  // drawing units of 0.1 mm: the same connector in real size (the table says 6.35 mm hex)
  const fine = placeSma({ ...b.ports[0], start: b.ports[0].start.map((v) => v * 10), stop: b.ports[0].stop.map((v) => v * 10) },
    solids.map((s) => ({ ...s, min: s.min.map((v) => v * 10), max: s.max.map((v) => v * 10) })), 0.1);
  ok(fine && fine.axis[0] === -1, "the same in another drawing unit");
  near(fine.origin[2], 16 + SMA_MM.pin / 2 / 0.1, 1e-9, "pin height scales with the unit");
  // the same board turned: the edge normal follows the geometry (a port at the +y edge)
  const turned = [
    { name: "substrate", kind: "dielectric", min: [-10, -20, 0], max: [10, 20, 1.6] },
    { name: "gnd", kind: "metal", min: [-10, -20, 0], max: [10, 20, 0] },
    { name: "line", kind: "metal", min: [-1.5, -20, 1.6], max: [1.5, 20, 1.6] },
  ];
  const up = placeSma({ number: 1, type: "lumped", direction: "z", start: [-1.5, 20, 0], stop: [1.5, 20, 1.6] }, turned, 1);
  eq([up.mount, up.axis], ["edge", [0, 1, 0]], "a port at the +y edge points +y");
  // a trace on the bottom face with the ground on top: the pin lies below
  const flipped = placeSma({ number: 1, type: "lumped", direction: "z", start: [-20, -1, 0], stop: [-20, 1, 1.6] }, [
    { name: "substrate", kind: "dielectric", min: [-20, -10, 0], max: [20, 10, 1.6] },
    { name: "gnd", kind: "metal", min: [-20, -10, 1.6], max: [20, 10, 1.6] },
    { name: "line", kind: "metal", min: [-20, -1, 0], max: [20, 1, 0] },
  ], 1);
  near(flipped.origin[2], -SMA_MM.pin / 2, 1e-9, "a bottom trace: the pin axis is below it");
  // a port near, not on, the edge still counts (within a few millimetres)
  ok(placeSma({ ...b.ports[0], start: [-18.5, -1.55, 0], stop: [-18.5, 1.55, 1.6] }, solids, 1)?.mount === "edge", "1.5 mm from the edge is still the edge");
  eq(placeSma({ ...b.ports[0], start: [-12, -1.55, 0], stop: [-12, 1.55, 1.6] }, solids, 1)?.mount, "bottom", "12 mm from the edge is not an edge launch: bottom mount");
}
{
  const b = bundleOf(patch), solids = solidsOf(b);
  const s = placeSma(b.ports[0], solids, 1);
  ok(s, "a probe-fed patch gets a connector");
  eq([s.mount, s.axis], ["bottom", [0, 0, -1]], "bottom mount, pointing down");
  vnear(s.origin, [5, 0, 0], 1e-9, "on the ground plane's outer face, under the probe");
  near(s.pinLength, 1.52, 1e-9, "the pin runs up the probe to the patch");
  eq(s.board, "substrate", "on the board");
  // a block under the ground plane in the way: no connector
  const blocked = placeSma(b.ports[0], [...solids, { name: "box", kind: "metal", min: [-30, -30, -20], max: [30, 30, -2] }], 1);
  eq(blocked, null, "a solid right under the ground plane leaves no room");
  // a connector bigger than the ground plane: no connector
  const tiny = placeSma({ number: 1, type: "lumped", direction: "z", start: [0, 0, 0], stop: [0, 0, 1] }, [
    { name: "gnd", kind: "metal", min: [-2, -2, 0], max: [2, 2, 0] }, { name: "p", kind: "metal", min: [-1, -1, 1], max: [1, 1, 1] },
  ], 1);
  eq(tiny, null, "a 4 mm ground plane cannot carry a 12.7 mm flange");
}
{
  const b = bundleOf(dipole), solids = solidsOf(b);
  eq(placeSma(b.ports[0], solids, 1), null, "a dipole's feed gap in free air gets no connector");
  eq(placeSma({ ...b.ports[0], type: "waveguide" }, solids, 1), null, "a waveguide port never gets an SMA");
  eq(placeSma({ number: 1, type: "lumped", direction: "z", start: [0, 0, 0], stop: [0, 0, 0] }, solids, 1), null, "a zero-length port");
  // a monopole: ground plane at the port's lower end, free space beyond it: bottom mount
  const mono = placeSma({ number: 1, type: "lumped", direction: "z", start: [0, 0, 0], stop: [0, 0, 1] }, [
    { name: "gnd", kind: "metal", min: [-40, -40, 0], max: [40, 40, 0] }, { name: "arm", kind: "metal", min: [-0.5, -0.5, 1], max: [0.5, 0.5, 30] },
  ], 1);
  eq([mono.mount, mono.axis], ["bottom", [0, 0, -1]], "a monopole over a ground plane gets a connector under it");
}

// ---------------------------------------------------------------- (e) port geometry
{
  const mk = (id) => new THREE.MeshBasicMaterial({ name: id });
  const b = bundleOf(microstrip), solids = solidsOf(b);
  const base = { unitMm: 1, sceneRadius: 25, mk };
  eq(Object.values(buildPorts(b.ports, solids, { ...base, mode: "hidden" }).drawn), ["hidden", "hidden"], "hidden: nothing is drawn");
  eq(buildPorts(b.ports, solids, { ...base, mode: "hidden" }).group.children.length, 0, "hidden: an empty group");
  const marker = buildPorts(b.ports, solids, { ...base, mode: "marker" });
  eq(Object.values(marker.drawn), ["marker", "marker"], "marker mode never draws a connector");
  const conn = buildPorts(b.ports, solids, { ...base, mode: "connector" });
  eq(Object.values(conn.drawn), ["sma", "sma"], "connector mode draws an SMA where one fits");
  ok(!conn.group.children.some((c) => c.name.startsWith("marker-")), "an edge-launch connector shows itself: no marker");
  eq(conn.placements.length, 2, "both placements are reported");
  const dip = bundleOf(dipole);
  eq(Object.values(buildPorts(dip.ports, solidsOf(dip), { ...base, mode: "connector" }).drawn), ["marker"], "connector mode falls back to the marker where none fits");
  // the SMA at real size
  const g = conn.group.children[0];
  const size = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3());
  near(size.x, SMA_MM.length + SMA_MM.reach, 0.8, "the connector is about 10.6 mm long along its axis (plus the pin reach)");
  ok(size.y >= SMA_MM.flangeSize * 0.95 && size.y <= SMA_MM.flangeSize * 1.05, "the 12.7 mm square flange sets the width across");
  near(SMA_MM.length, SMA_MM.flange + SMA_MM.nut + SMA_MM.barrelLength, 1e-9, "length = flange + nut + barrel");
  const names = g.children.map((c) => c.name);
  for (const part of ["flange", "barrel", "nut", "dielectric", "pin", "thread"]) ok(names.includes(part), `SMA part: ${part}`);
  const looks = g.children.map((c) => c.material.name);
  ok(["sma-body", "sma-nut", "sma-dielectric", "sma-pin"].every((id) => looks.includes(id)), "gold body, nut, PTFE ring and pin each have their own look");
  // its pin points at the feed: the pin's far end is at the trace end of the port
  const pin = g.children.find((c) => c.name === "pin");
  const tip = new THREE.Box3().setFromObject(pin);
  near(tip.max.x, -20 + SMA_MM.reach, 0.01, "the pin tip lies on the trace, its reach inside the board edge");
  // the same connector scales with the drawing unit: 0.1 mm units make it 10x larger in model units
  const fine = new THREE.Box3().setFromObject(buildPorts(
    b.ports.slice(0, 1).map((p) => ({ ...p, start: p.start.map((v) => v * 10), stop: p.stop.map((v) => v * 10) })),
    solids.map((s) => ({ ...s, min: s.min.map((v) => v * 10), max: s.max.map((v) => v * 10) })), { ...base, unitMm: 0.1, mode: "connector" }).group).getSize(new THREE.Vector3());
  near(fine.y / size.y, 10, 0.2, "real size in any drawing unit");
  // the marker spans the port along its direction, through the middle of its cross-section
  const m = portMarker(b.ports[0], 0.3, mk);
  const mb = new THREE.Box3().setFromObject(m);
  near(mb.min.z, -0.3, 1e-6, "marker bead at the low end");
  near(mb.max.z, 1.6 + 0.3, 1e-6, "marker bead at the high end");
  near((mb.min.y + mb.max.y) / 2, 0, 1e-6, "centred across the port");
  near(markerBead(100, 1), 1.2, 1e-9, "a big scene: a bead of 1.2 % of its radius");
  near(markerBead(1, 1), 0.3, 1e-9, "the marker bead never goes below 0.3 mm");
  near(markerBead(1, 0.1), 3, 1e-9, "0.3 mm in 0.1 mm units");
  // the marker keeps a minimum size on screen whatever the zoom: at least MARKER_MIN_PX pixels across
  eq(markerScale(0.3, 0.01), 1, "a bead large enough on screen keeps its size");
  near(markerScale(0.3, 0.3), (MARKER_MIN_PX / 2) * 0.3 / 0.3, 1e-9, "a bead that would be 2 px across grows to the minimum");
  eq(markerScale(0, 1), 1, "no bead, no scale");
  const cam = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 10000);
  cam.position.set(0, 0, 600);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const far = portMarker(b.ports[0], 0.3, mk);
  updateMarkerSizes(far, cam, 360);
  const beads = far.children.filter((c) => c.userData.markerPart === "bead");
  const px = (2 * 0.3 * beads[0].scale.x) / worldPerPixel(cam, beads[0].position, 360);
  ok(px >= MARKER_MIN_PX - 0.1 && px <= MARKER_MIN_PX + 0.5, `a marker seen from afar is ${MARKER_MIN_PX} px across (${px.toFixed(2)})`);
  ok(far.children.find((c) => c.userData.markerPart === "rod").scale.x === beads[0].scale.x, "the rod thickens with the beads");
  cam.position.set(0, 0, 5);
  cam.updateMatrixWorld();
  updateMarkerSizes(far, cam, 360);
  eq(beads[0].scale.x, 1, "close up the marker has its own size again");
  const ortho = new THREE.OrthographicCamera(-50, 50, 28, -28, 0.1, 1000);
  near(worldPerPixel(ortho, new THREE.Vector3(), 560), 0.1, 1e-12, "orthographic: the view height over the picture height");
  // a waveguide flange and an SMD body
  const wg = waveguideFlange({ number: 1, type: "waveguide", direction: "x", start: [0, -5, -2], stop: [4, 5, 2] }, mk);
  eq(wg.children.length, 4, "four flange bars round the opening");
  const fb = new THREE.Box3().setFromObject(wg);
  ok(fb.min.y < -5 && fb.max.y > 5 && Math.abs(fb.min.x) < 0.5, "the flange frames the opening in its plane");
  const smd = smdElement({ name: "r1", direction: "x", start: [0, 0, 0], stop: [2, 0.2, 0] }, mk);
  eq(smd.children.length, 3, "an SMD body and two end caps");
  const sb = new THREE.Box3().setFromObject(smd);
  ok(sb.min.x <= 0.01 && sb.max.x >= 1.99, "along the element's current");
  ok(sb.min.z >= -0.05, "a body along x sits on the board (its caps overhang by 1 %), not through it");
}

// ---------------------------------------------------------------- (f) the model of a bundle
{
  const mk = (b, o = {}) => buildModel(b, undefined, { ports: "connector", solderMask: "none", ...o }, null);
  const withAir = design("air", [CU, FR4, { name: "air", kind: "dielectric", eps_r: 1, tan_d: 0 }], [
    { name: "substrate", material: "fr4", primitives: [box([-20, -10, 0], [20, 10, 1.6])] },
    { name: "gnd", material: "copper", primitives: [box([-20, -10, 0], [20, 10, 0])] },
    { name: "gap", material: "air", primitives: [box([-5, -5, 0], [5, 5, 1.6])] },
  ], []);
  const m = mk(quickBundle(withAir, {}, null));
  eq(m.drawn, ["substrate", "gnd"], "air is not rendered");
  eq(m.skipped, ["gap"], "air is skipped");
  near(m.unitMm, 1, 1e-12, "millimetres per unit");
  ok(m.bounds.min.x === -20 && m.bounds.max.x === 20, "bounds of the drawn parts");
  m.dispose();
  // names and classes through the whole path
  const ms = mk(bundleOf(microstrip), { ports: "connector" });
  eq(ms.group.children.find((c) => c.name === "substrate").userData.look, "fr4", "unnamed in the bundle, FR-4 by its permittivity and loss");
  eq(ms.group.children.find((c) => c.name === "line").userData.look, "copper", "copper by conductivity (PEC)");
  const green = mk(bundleOf(microstrip), { solderMask: "green" });
  eq(green.group.children.find((c) => c.name === "substrate").userData.look, "solder-mask", "the mask option reaches the board");
  ok(ms.bounds.min.x < -20 - 5 && ms.bounds.max.x > 20 + 5, "the connectors are part of the bounds");
  eq(ms.ports.drawn[1], "sma", "port 1 is an SMA");
  ms.dispose(); green.dispose();
  const lumped = { ...bundleOf(patch), lumped_elements: [{ name: "r1", label: "R1", type: "resistor", R: 100, direction: "x", start: [10, 0, 1.52], stop: [13, 0.5, 1.52] }] };
  const withR = mk(lumped, { ports: "marker" });
  ok(withR.group.children.some((c) => c.name === "smd-r1"), "lumped elements are drawn as SMD bodies");
  const noR = mk(lumped, { ports: "hidden" });
  ok(!noR.group.children.some((c) => c.name === "smd-r1"), "hidden ports hide them too");
  withR.dispose(); noR.dispose();
  // a probe feed: its connector sits under the ground plane, so a marker shows the feed from above; the ground shadow
  // falls on the board's underside (the floor), not under the connector hanging below it
  const probe = mk(bundleOf(patch), { ports: "connector" });
  eq(probe.ports.drawn[1], "sma", "the probe gets a bottom-mount connector");
  ok(probe.ports.group.children.some((c) => c.name === "marker-1"), "and a marker, seen from the top");
  const partsLow = Math.min(...bundleOf(patch).parts.flatMap((p) => p.primitives.length ? [p.bbox[0][2]] : []));
  near(probe.floor, partsLow, 1e-6, "the floor is the parts' lowest face");
  ok(probe.bounds.min.z < probe.floor - 5, "the connector reaches below the floor (it stays in the framing)");
  probe.dispose();
  // a part hidden in the tree is left out, and a connector that needs it is too
  const hiddenGround = mk(bundleOf(microstrip), { hidden: new Set(["gnd"]) });
  eq(hiddenGround.drawn, ["substrate", "line"], "a hidden part is not drawn");
  eq(hiddenGround.ports.drawn[1], "marker", "no ground plane, no connector: the marker");
  hiddenGround.dispose();
  // a part colour reaches the material
  const coloured = design("c", [{ name: "copper", kind: "metal", color: "#3366ff" }], [{ name: "b", material: "copper", primitives: [box([0, 0, 0], [5, 5, 5])] }], []);
  const cm = mk(quickBundle(coloured, {}, null));
  const mesh = cm.group.children[0].children[0];
  eq([mesh.material.color.getHexString(), mesh.material.metalness], ["3366ff", 1], "a colour override stays metallic");
  cm.dispose();
}

// ---------------------------------------------------------------- (g) camera framing
{
  const box3 = new THREE.Box3(new THREE.Vector3(-30, -20, 0), new THREE.Vector3(30, 20, 8));
  const corners = [];
  for (const x of [box3.min.x, box3.max.x]) for (const y of [box3.min.y, box3.max.y]) for (const z of [box3.min.z, box3.max.z]) corners.push(new THREE.Vector3(x, y, z));
  const ndc = (cam, c) => c.clone().project(cam);
  for (const angle of ["iso", "top", "front", "right", "back", "left", "bottom"]) for (const aspect of [16 / 9, 1, 0.5]) {
    const f = frameBox(box3, angleDirection(angle), aspect, "perspective");
    const cam = cameraFromFraming(f, aspect);
    const pts = corners.map((c) => ndc(cam, c));
    const maxAbs = Math.max(...pts.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)]));
    ok(maxAbs <= 1 / FRAME_MARGIN + 1e-3, `${angle} @${aspect.toFixed(2)}: every corner is inside the picture with the margin (${maxAbs.toFixed(3)})`);
    ok(maxAbs >= 1 / FRAME_MARGIN - 0.03, `${angle} @${aspect.toFixed(2)}: and the model fills it (${maxAbs.toFixed(3)})`);
    const cx = (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2, cy = (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2;
    ok(Math.abs(cx) < 0.02 && Math.abs(cy) < 0.02, `${angle} @${aspect.toFixed(2)}: centred (${cx.toFixed(3)}, ${cy.toFixed(3)})`);
    ok(pts.every((p) => p.z > -1 && p.z < 1), `${angle}: all corners between the near and far planes`);
    const o = cameraFromFraming(frameBox(box3, angleDirection(angle), aspect, "orthographic"), aspect);
    const op = corners.map((c) => ndc(o, c));
    const omax = Math.max(...op.flatMap((p) => [Math.abs(p.x), Math.abs(p.y)]));
    ok(omax <= 1 / FRAME_MARGIN + 1e-3 && omax >= 1 / FRAME_MARGIN - 0.03, `${angle} @${aspect.toFixed(2)}: orthographic fits too (${omax.toFixed(3)})`);
    ok(op.every((p) => p.z > -1 && p.z < 1), `${angle}: orthographic clipping planes hold the model`);
  }
  // a preset looks along its own direction, with Z up
  const top = frameBox(box3, angleDirection("top"), 1.78, "perspective");
  ok(top.position.z > top.target.z && Math.abs(top.position.x - top.target.x) < 1e-2, "the top view looks straight down");
  const front = frameBox(box3, angleDirection("front"), 1.78, "perspective");
  ok(front.position.y < front.target.y, "the front view looks along +y");
  eq(front.up.toArray(), [0, 0, 1], "Z is up");
  // current view: the live camera's own picture height, in either projection
  const view = { position: [100, -100, 80], target: [0, 0, 4], up: [0, 0, 1], fov: 32 };
  const fp = frameFromView(view, box3, "perspective");
  eq(fp.position.toArray(), [100, -100, 80], "perspective keeps the camera where it is");
  const dist = new THREE.Vector3(...view.position).distanceTo(new THREE.Vector3(...view.target));
  near(frameFromView(view, box3, "orthographic").halfHeight, dist * Math.tan(THREE.MathUtils.degToRad(16)), 1e-9, "orthographic shows the same picture height at the target");
}

// ---------------------------------------------------------------- (h) the Render image dialog
{
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const dialog = read("src/render/RenderDialog.tsx"), panel = read("src/render/BlenderRenderPanel.tsx"), css = read("src/styles/render.css");
  ok(/\.render-custom \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/.test(css) && /\.render-custom input \{[^}]*width: 100%/.test(css),
    "the custom size fields share the options column without overflowing it");
  ok(/disabled=\{locked\(\) \|\| !bundle\(\) \|\| sizeBlocked\(\)\}/.test(dialog), "an invalid size disables Render");
  ok(/blocked=\{sizeBlocked\(\) \? sizeMessage\(\) : undefined\}/.test(dialog) && /disabled=\{detecting\(\) \|\| !info\(\)\?\.ok \|\| !!props\.blocked\}/.test(panel),
    "and the Blender render");
  ok(/onBlur=\{sizeBlur\("width"\)\}/.test(dialog) && /onBlur=\{sizeBlur\("height"\)\}/.test(dialog), "on blur a field shows the size that will be used");
  ok(!/Math\.min\(MAX_SIDE/.test(dialog), "no silent clamp in the dialog");
  ok(/data-action="render-download"/.test(dialog), "every picture can be downloaded");
  ok(/render\.folder\.opened/.test(dialog) && /render\.folder\.opened/.test(panel) && /downloadMessage\(r\)/.test(panel), "Open folder and Save as… answer with a status line");
}

console.log(`check-render: ${n} checks passed`);
