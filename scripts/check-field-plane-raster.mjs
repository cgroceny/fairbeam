// Field-plane pixel parity, in-place animation buffers, and a small interleaved CPU benchmark.
// Run with: node --experimental-strip-types scripts/check-field-plane-raster.mjs [--bench]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { build } from "vite";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const root = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
const built = await build({
  root, configFile: false, logLevel: "silent", resolve: { conditions: ["browser"] }, css: { postcss: {} },
  plugins: [{
    name: "field-plane-raster-entry",
    resolveId(id) { if (id.endsWith("field-plane-raster-entry")) return "\0field-plane-raster-entry"; },
    load(id) {
      if (id !== "\0field-plane-raster-entry") return;
      return `export * as m0 from ${JSON.stringify(`${root}src/scene/fieldPlaneModel.ts`)}; export * as m1 from ${JSON.stringify(`${root}src/scene/fieldPlanes.ts`)};`;
    },
  }],
  build: { write: false, minify: false, cssCodeSplit: false, lib: { entry: "field-plane-raster-entry", formats: ["es"] }, rollupOptions: { output: { inlineDynamicImports: true } } },
});
const chunk = (Array.isArray(built) ? built[0] : built).output.find((output) => output.type === "chunk");
const { m0: model, m1: planes } = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`);
const { fieldPlaneLayer, updateFieldPlanePhase } = planes;

const makeMap = (nu, nv) => {
  const n = nu * nv, count = n * 3 * 2, raw = new Uint8Array(count);
  for (let i = 0; i < count; i++) raw[i] = (i * 37 + 11) & 255;
  const magnitude = Array.from({ length: nv }, (_, j) => Array.from({ length: nu }, (_, i) =>
    (i + j) % 11 === 0 ? Number.NaN : ((i * 19 + j * 31) % 53) / 17));
  return {
    quantity: "E", component: "abs", normal: "z", axis: 2, u_axis: 0, v_axis: 1,
    position_mm: 2, requested_mm: 2, f: 2.45e9, u_range: [-4, 4], v_range: [-3, 3],
    nu, nv, unit: "V/m", normalization: "test", max: 4, magnitude,
    phasor: { components: ["x", "y", "z"], peak: 12.5, data: Buffer.from(raw).toString("base64") },
  };
};

const ramp = [[30, 90, 180], [235, 230, 215], [180, 45, 35]];

function alignMagnitudeToPhasor(m) {
  const raw = Buffer.from(m.phasor.data, "base64"), n = m.nu * m.nv, components = m.phasor.components.length;
  const scale = m.phasor.peak / 127;
  let maximum = 0;
  for (let px = 0; px < n; px++) {
    let sum = 0;
    for (let c = 0; c < components; c++) {
      const at = (px * components + c) * 2;
      const re = (raw[at] > 127 ? raw[at] - 256 : raw[at]) * scale;
      const im = (raw[at + 1] > 127 ? raw[at + 1] - 256 : raw[at + 1]) * scale;
      sum += re * re + im * im;
    }
    const value = Math.sqrt(sum);
    m.magnitude[Math.floor(px / m.nu)][px % m.nu] = value;
    maximum = Math.max(maximum, value);
  }
  m.max = maximum;
  return m;
}

// Original color helpers retained as a local oracle for pixel parity and interleaved timings.
function referenceRampPosition(value, max, scale, dbRange = model.FIELD_PLANE_DB_RANGE) {
  if (!(max > 0) || !(value > 0)) return 0;
  const r = Math.min(1, value / max);
  if (scale === "linear") return r;
  return Math.max(0, 1 + (20 * Math.log10(r)) / dbRange);
}
function referenceSampleRamp(stops, t) {
  const x = (Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i, a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
function referencePhaseColor(deg) {
  const h = ((((deg + 180) % 360) + 360) % 360) / 60;
  const s = 0.62, v = 0.96;
  const f = h - Math.floor(h), p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][Math.floor(h) % 6];
  return [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255];
}
function referencePhaseWeight(amplitude, ref) {
  if (!(ref > 0) || !(amplitude > 0)) return 0;
  const db = 20 * Math.log10(Math.min(1, amplitude / ref));
  const x = Math.max(0, Math.min(1, (db + 40) / 12));
  return x * x * (3 - 2 * x);
}
function referenceColor(fv, i, scale, colors) {
  const value = fv.values[i];
  if (fv.kind === "magnitude") return referenceSampleRamp(colors, referenceRampPosition(value, fv.ref, scale));
  if (fv.kind === "signed") return referenceSampleRamp(model.DIVERGING_STOPS, fv.ref > 0 ? 0.5 + 0.5 * Math.max(-1, Math.min(1, value / fv.ref)) : 0.5);
  const weight = referencePhaseWeight(fv.amplitude?.[i] ?? 0, fv.ref), color = referencePhaseColor(value);
  return [128 + (color[0] - 128) * weight, 128 + (color[1] - 128) * weight, 128 + (color[2] - 128) * weight];
}

// Reference raster from the pre-optimization implementation: a fresh RGB tuple per sample.
function referenceRgba(m, fv, scale, colors, flipV = false) {
  const data = new Uint8ClampedArray(m.nu * m.nv * 4);
  for (let j = 0; j < m.nv; j++) {
    const row = flipV ? m.nv - 1 - j : j;
    for (let i = 0; i < m.nu; i++) {
      const color = referenceColor(fv, j * m.nu + i, scale, colors), at = (row * m.nu + i) * 4;
      data[at] = color[0]; data[at + 1] = color[1]; data[at + 2] = color[2]; data[at + 3] = 255;
    }
  }
  return data;
}

function comboDigest(m) {
  const hash = createHash("sha256");
  for (const mode of ["magnitude", "phase", "animate"]) {
    for (const part of ["all", "x", "y", "z"]) {
      for (const scale of ["db", "linear"]) {
        for (const phaseDeg of [0, 15, 180, 359, Number.NaN]) {
          const view = { mode, part, scale, phaseDeg };
          const fv = model.fieldPlaneValues(m, view);
          const expected = referenceRgba(m, fv, scale, ramp);
          const actual = model.fieldPlaneRgba(m, fv, scale, ramp);
          assert.deepEqual(actual, expected, `optimized bytes match old helper (${mode}/${part}/${scale}/${phaseDeg})`);
          hash.update(actual);
          if (mode === "animate") {
            const values = new Float32Array(m.nu * m.nv);
            const reused = model.fieldPlaneValues(m, view, values);
            assert.strictEqual(reused.values, values, "animation values reuse the supplied Float32Array");
            assert.deepEqual(model.fieldPlaneRgba(m, reused, scale, ramp), model.fieldPlaneRgba(m, fv, scale, ramp),
              `animation scratch matches allocation path (${part}/${scale}/${phaseDeg})`);
          }
        }
      }
    }
  }
  return hash.digest("hex");
}

const m = makeMap(9, 7);
assert.equal(comboDigest(m), "a70c771f3f80cd77f2a62979e4753fc18d9951ee2e6a4694c75c076ef989bc29",
  "all mode, part, scale, and phase pixel bytes match the pre-optimization output");

const edge = {
  ...m, phasor: undefined,
  magnitude: [[Number.NaN, -1, 0, Infinity, 1e-300, 2, 4, 8, 16],
    [1, 2, 3, 4, 5, 6, 7, 8, 9], ...Array.from({ length: 5 }, () => Array(9).fill(0))],
};
const edgePixels = model.fieldPlaneRgba(edge, model.fieldPlaneValues(edge, {
  mode: "magnitude", part: "all", scale: "db", phaseDeg: Number.NaN,
}), "db", [[0, 0, 0], [100, 100, 100], [255, 255, 255]]);
assert.equal(createHash("sha256").update(edgePixels).digest("hex"),
  "5e64d9f2605d03ec9b1f39e5f0ecfba547bcb80521957a15276f54e7e728feb0",
  "NaN, infinity, negative, and zero magnitude bytes preserve the old output");
const pixels = new Uint8ClampedArray(edge.nu * edge.nv * 4);
assert.strictEqual(model.fieldPlaneRgba(edge, model.fieldPlaneValues(edge, {
  mode: "magnitude", part: "all", scale: "db", phaseDeg: Number.NaN,
}), "db", [[0, 0, 0], [100, 100, 100], [255, 255, 255]], false, pixels), pixels,
  "RGBA output reuses the caller buffer");

// The animated DataTexture remains a normal Uint8Array for WebGL, but its bytes share the clamped
// raster's backing store; each phase updates the same data object and backing buffer.
const textureMap = { ...m, phasor: { ...m.phasor, peak: 1 } };
const colors = ["#1e5ab4", "#ebe6d7", "#b42d23"].map((color) => new THREE.Color(color));
const group = fieldPlaneLayer(textureMap, { mode: "animate", part: "all", scale: "db", phaseDeg: 0 },
  colors);
const mesh = group.children.find((child) => child.isMesh);
const texture = mesh?.material?.map;
assert.ok(texture?.isDataTexture, "field plane is backed by a DataTexture");
const imageBytes = texture.image.data;
assert.ok(imageBytes instanceof Uint8Array && !(imageBytes instanceof Uint8ClampedArray), "DataTexture keeps the WebGL Uint8Array upload type");
const backing = imageBytes.buffer;
const initial = Uint8Array.from(imageBytes);
assert.equal(updateFieldPlanePhase(group, 15), true, "Animate layer handles phase updates");
assert.strictEqual(texture.image.data, imageBytes, "phase update keeps the same texture data object");
assert.strictEqual(imageBytes.buffer, backing, "phase update keeps the same pixel backing buffer");
assert.notDeepEqual(imageBytes, initial, "phase update changes pixels in place");
const secondGroup = fieldPlaneLayer(textureMap, { mode: "animate", part: "x", scale: "linear", phaseDeg: 0 }, colors);
const secondMesh = secondGroup.children.find((child) => child.isMesh);
const secondTexture = secondMesh?.material?.map;
const secondBytes = secondTexture?.image.data;
const secondInitial = Uint8Array.from(secondBytes);
assert.ok(secondBytes instanceof Uint8Array && !(secondBytes instanceof Uint8ClampedArray));
assert.notStrictEqual(secondBytes.buffer, imageBytes.buffer, "separate field-plane layers own separate pixel buffers");
assert.equal(updateFieldPlanePhase(group, 30), true);
assert.strictEqual(texture.image.data, imageBytes);
assert.strictEqual(imageBytes.buffer, backing);
assert.deepEqual(secondBytes, secondInitial, "updating one layer does not repaint the other layer");
assert.equal(updateFieldPlanePhase(secondGroup, 15), true);
assert.strictEqual(secondTexture.image.data, secondBytes);
assert.notDeepEqual(secondBytes, secondInitial, "the other layer updates only when its own phase changes");

console.log("Field-plane raster parity and reusable texture buffers passed.");

if (process.argv.includes("--bench")) {
  const large = alignMagnitudeToPhasor(makeMap(200, 200));
  const values = new Float32Array(large.nu * large.nv);
  const currentPixels = new Uint8ClampedArray(large.nu * large.nv * 4);
  const baselineTimes = [], currentTimes = [];
  const viewAt = (i) => ({ mode: "animate", part: "all", scale: "db", phaseDeg: (i * 15) % 360 });
  const baseline = (view) => {
    const fv = model.fieldPlaneValues(large, view);
    return referenceRgba(large, fv, view.scale, ramp);
  };
  const current = (view) => {
    const fv = model.fieldPlaneValues(large, view, values);
    return model.fieldPlaneRgba(large, fv, view.scale, ramp, false, currentPixels);
  };
  for (let i = 0; i < 8; i++) { baseline(viewAt(i)); current(viewAt(i)); }
  for (let i = 0; i < 120; i++) {
    let baselineFrame, currentFrame, start;
    if (i % 2 === 0) {
      start = performance.now(); baselineFrame = baseline(viewAt(i)); baselineTimes.push(performance.now() - start);
      start = performance.now(); current(viewAt(i)); currentTimes.push(performance.now() - start);
      currentFrame = Uint8ClampedArray.from(currentPixels);
    } else {
      start = performance.now(); current(viewAt(i)); currentTimes.push(performance.now() - start);
      currentFrame = Uint8ClampedArray.from(currentPixels);
      start = performance.now(); baselineFrame = baseline(viewAt(i)); baselineTimes.push(performance.now() - start);
    }
    assert.deepEqual(currentFrame, baselineFrame, `interleaved benchmark frame ${i} stays byte-identical`);
  }
  const stats = (times) => {
    times.sort((a, b) => a - b);
    return { medianMs: Number(times[Math.floor(times.length / 2)].toFixed(3)), p95Ms: Number(times[Math.floor(times.length * 0.95)].toFixed(3)) };
  };
  console.log(JSON.stringify({ fixture: "200x200 3-component phasor, Animate/all/dB", frames: 120,
    baseline: stats(baselineTimes), current: stats(currentTimes) }));
}
