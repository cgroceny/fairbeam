// Checks for the multi-port / array code (src/lib/sparams.ts, src/lib/array.ts) and the related
// exports, with analytic synthetic data. Also (re)writes the SYNTHETIC test bundle
// examples/synthetic/array2x1.json (not a simulation; never listed in public/projects/index.json).
//
//   node --experimental-strip-types scripts/check-array.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeF32Grid, decodeI16Grid, elementPatterns, ENC_F32, ENC_I16, encodeI16Grids, I16_FULL, magDb, pairLabel, parsePair, sMatrix, zFromGamma } from "../src/lib/sparams.ts";
import { activeReflection, arrayFarField, C0, combine, directivity, gammaDb, mainBeam, solidAngleWeights, steeringPhases, uniformWeights } from "../src/lib/array.ts";
import { figureSet, sparamFigure } from "../src/drawing/charts.ts";
import { technicalDrawing } from "../src/drawing/drawing.ts";
import { packageFiles } from "../src/export/package.ts";
import { reportPages } from "../src/export/reportPdf.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
let failures = 0;
const check = (cond, where, msg) => {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL ${where}: ${msg}`);
  }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const THETA = Array.from({ length: 61 }, (_, i) => i * 3);
const PHI = Array.from({ length: 72 }, (_, j) => j * 5);
const rad = Math.PI / 180;

/** Element pattern set of point sources at positions (m) with an amplitude pattern g(θ, φ) on E_θ. */
function pointSources(fHz, positions, g = () => 1) {
  const k = (2 * Math.PI * fHz) / C0;
  return {
    f: fHz, theta: THETA, phi: PHI,
    elements: positions.map((r, n) => {
      const re = [], im = [], z = [];
      for (const t of THETA) {
        const rr = [], ii = [], zz = [];
        for (const p of PHI) {
          const u = [Math.sin(t * rad) * Math.cos(p * rad), Math.sin(t * rad) * Math.sin(p * rad), Math.cos(t * rad)];
          const ph = k * (r[0] * u[0] + r[1] * u[1] + r[2] * u[2]);
          const a = g(t, p);
          rr.push(a * Math.cos(ph));
          ii.push(a * Math.sin(ph));
          zz.push(0);
        }
        re.push(rr); im.push(ii); z.push(zz);
      }
      return { port: n + 1, eThetaRe: re, eThetaIm: im, ePhiRe: z, ePhiIm: z };
    }),
  };
}

// ------------------------------------------------------------------ 1. integration / normalisation
{
  const where = "normalisation";
  const { wt, wp } = solidAngleWeights(THETA, PHI);
  const total = wt.reduce((a, c) => a + c, 0) * wp.reduce((a, c) => a + c, 0);
  check(near(total, 4 * Math.PI, 1e-9), where, `solid angle of the grid ${total} ≠ 4π`);
  const iso = THETA.map(() => PHI.map(() => 1));
  const d0 = directivity(THETA, PHI, iso, false);
  check(near(d0.dmaxDbi, 0, 1e-9), where, `isotropic Dmax ${d0.dmaxDbi} dBi ≠ 0`);
  const dh = directivity(THETA, PHI, iso, true);
  check(near(dh.dmaxDbi, 10 * Math.log10(2), 1e-9), where, `isotropic over a ground plane ${dh.dmaxDbi} dBi ≠ 3.01`);
  const dip = THETA.map((t) => PHI.map(() => Math.sin(t * rad) ** 2));
  const dd = directivity(THETA, PHI, dip, false);
  check(near(dd.dmaxDbi, 10 * Math.log10(1.5), 0.02), where, `short dipole Dmax ${dd.dmaxDbi.toFixed(3)} dBi ≠ 1.76`);
  const bd = mainBeam(THETA, PHI, dd.d, false);
  check(near(bd.hpbwTheta ?? 0, 90, 1), where, `short dipole HPBW ${bd.hpbwTheta} ≠ 90°`);
  // energy: the mean of the linear directivity over the sphere is 1
  let mean = 0;
  dd.d.forEach((row, i) => row.forEach((v, j) => (mean += Math.pow(10, v / 10) * wt[i] * wp[j])));
  check(near(mean / (4 * Math.PI), 1, 1e-6), where, `∮D dΩ / 4π = ${mean / (4 * Math.PI)}`);
  console.log(`normalisation: grid 4π, isotropic 0 / 3.01 dBi, dipole ${dd.dmaxDbi.toFixed(3)} dBi, HPBW ${bd.hpbwTheta?.toFixed(1)}°`);
}

// ------------------------------------------------------------------ 2. two-element array factor
{
  const where = "array factor";
  const f = 2.4e9;
  const lam = C0 / f;
  const d = 0.6 * lam;
  const set = pointSources(f, [[0, 0, 0], [d, 0, 0]]);
  const beta = 40; // progressive phase of element 2 (deg)
  const U = combine(set, [{ ampDb: 0, phaseDeg: 0 }, { ampDb: 0, phaseDeg: beta }]);
  const k = (2 * Math.PI) / lam;
  let err = 0;
  THETA.forEach((t, i) => PHI.forEach((p, j) => {
    const psi = k * d * Math.sin(t * rad) * Math.cos(p * rad) + beta * rad;
    err = Math.max(err, Math.abs(U[i][j] - 4 * Math.cos(psi / 2) ** 2));
  }));
  check(err < 1e-9, where, `|U − 4 cos²(ψ/2)| up to ${err}`);
  // amplitude taper: |1 + a e^{jψ}|²
  const U2 = combine(set, [{ ampDb: 0, phaseDeg: 0 }, { ampDb: -6, phaseDeg: 0 }]);
  const a = Math.pow(10, -6 / 20);
  const psi = k * d * Math.sin(30 * rad);
  check(near(U2[10][0], 1 + a * a + 2 * a * Math.cos(psi), 1e-9), where, "amplitude weighting");
  console.log(`array factor: max error ${err.toExponential(1)}`);
}

// ------------------------------------------------------------------ 3. steering
{
  const where = "steering";
  const f = 3e9;
  const lam = C0 / f;
  const n = 8;
  const pos = Array.from({ length: n }, (_, i) => [(i * lam) / 2, 0, 0]);
  const set = pointSources(f, pos);
  // a minimal bundle with ports at the element positions (mm)
  const b = { units: { length: "mm", length_m: 1e-3 }, half_space: null, ports: pos.map((r, i) => ({ number: i + 1, start: r.map((x) => x * 1e3), stop: r.map((x) => x * 1e3) })) };
  for (const [t0, p0] of [[30, 0], [45, 180], [0, 0], [60, 0]]) {
    const ph = steeringPhases(b, set.elements.map((e) => e.port), f, t0, p0);
    const w = new Map([...ph].map(([p, deg]) => [p, { ampDb: 0, phaseDeg: deg }]));
    const ff = arrayFarField(b, set, w);
    const beam = mainBeam(ff.theta, ff.phi, ff.directivity_dbi, false);
    // compare directions on the sphere (θ = 0 has no φ)
    const u = (t, p) => [Math.sin(t * rad) * Math.cos(p * rad), Math.sin(t * rad) * Math.sin(p * rad), Math.cos(t * rad)];
    const a = u(beam.theta, beam.phi), c = u(t0, p0);
    const ang = Math.acos(Math.min(1, a[0] * c[0] + a[1] * c[1] + a[2] * c[2])) / rad;
    // a linear array only fixes the cone angle to the array axis: compare the x components
    const cone = Math.abs(a[0] - c[0]);
    check(cone <= Math.sin(3 * rad) + 1e-9, where, `steer to θ0=${t0}°, φ0=${p0}°: beam at θ=${beam.theta}°, φ=${beam.phi}° (Δ ${ang.toFixed(1)}°)`);
    check(near(ff.dmax_dbi, 10 * Math.log10(n), 3.5), where, `Dmax ${ff.dmax_dbi.toFixed(2)} dBi far from 10·log10(N) (linear array)`);
  }
  // explicit case of the specification: Δφ = −k d sin θ0 for two elements along x
  const two = pointSources(f, [[0, 0, 0], [lam / 2, 0, 0]]);
  const t0 = 30;
  const dphi = (-2 * Math.PI / lam) * (lam / 2) * Math.sin(t0 * rad) / rad;
  const U = combine(two, [{ ampDb: 0, phaseDeg: 0 }, { ampDb: 0, phaseDeg: dphi }]);
  const dir = directivity(THETA, PHI, U, false);
  const bm = mainBeam(THETA, PHI, dir.d, false);
  check(Math.abs(Math.sin(bm.theta * rad) * Math.cos(bm.phi * rad) - Math.sin(t0 * rad)) <= Math.sin(3 * rad), where, `two elements, Δφ = −k d sin θ0: peak at θ=${bm.theta}°, φ=${bm.phi}°`);
  console.log(`steering: 8-element λ/2 array to 30°, 45°/180°, 0°, 60°; two-element case peak θ=${bm.theta}°`);
}

// ------------------------------------------------------------------ 4. active reflection
{
  const where = "active reflection";
  const f = [1e9, 2e9];
  const s21 = { re: [0.1, 0.2], im: [0, 0.1] };
  const zero = { re: [0, 0], im: [0, 0] };
  const S = {
    f, ports: [1, 2], zRef: [50, 50], excited: [1, 2],
    get: (i, j) => (i === j ? zero : s21), pairs: [[1, 1], [1, 2], [2, 1], [2, 2]], reciprocity: 0, passivity: null, legacy: false,
  };
  const w = new Map([[1, { ampDb: 0, phaseDeg: 0 }], [2, { ampDb: 0, phaseDeg: 90 }]]);
  const g = activeReflection(S, w, 2e9);
  // Γ1 = S12 w2 / w1 = (0.2 + 0.1j)(j) = −0.1 + 0.2j ; Γ2 = S21 w1 / w2 = (0.2 + 0.1j)(−j) = 0.1 − 0.2j
  check(near(g.get(1)[0], -0.1, 1e-12) && near(g.get(1)[1], 0.2, 1e-12), where, `Γ1 = ${g.get(1)}`);
  check(near(g.get(2)[0], 0.1, 1e-12) && near(g.get(2)[1], -0.2, 1e-12), where, `Γ2 = ${g.get(2)}`);
  const g15 = activeReflection(S, uniformWeights([1, 2]), 1.5e9);
  check(near(g15.get(1)[0], 0.15, 1e-12) && near(g15.get(1)[1], 0.05, 1e-12), where, "linear interpolation in frequency");
  check(near(gammaDb([0.1, 0]), -20, 1e-9), where, "gammaDb");
}

// ------------------------------------------------------------------ 5. adapter
{
  const where = "adapter";
  check(JSON.stringify(parsePair("2,1")) === "[2,1]" && JSON.stringify(parsePair("S21")) === "[2,1]" && JSON.stringify(parsePair("s_12_3")) === "[12,3]" && JSON.stringify(parsePair("3-4")) === "[3,4]", where, "parsePair variants");
  const index = JSON.parse(readFileSync(join(root, "public/projects/index.json"), "utf8"));
  for (const e of index.projects) {
    const b = JSON.parse(readFileSync(join(root, "public/projects", e.file), "utf8"));
    const S = sMatrix(b);
    if (!b.results) continue;
    const pr = b.results.ports["1"] ?? Object.values(b.results.ports)[0];
    check(S && S.ports.length >= 1, `${where} ${e.file}`, "no S-matrix");
    if (!S) continue;
    if (!b.results.sparams) {
      check(S.legacy && S.pairs.length === S.ports.length, `${where} ${e.file}`, "legacy bundle should be diagonal-only");
      const s11 = S.get(S.ports[0], S.ports[0]);
      check(s11.re === pr.s11_re && s11.im === pr.s11_im, `${where} ${e.file}`, "S11 is not results.ports[..].s11_*");
    }
    check(elementPatterns(b).length === 0 || !!b.results.element_patterns, `${where} ${e.file}`, "element patterns out of nowhere");
    check(figureSet(b).every((f) => !f.name.startsWith("sparams")) || S.ports.length > 1, `${where} ${e.file}`, "S-matrix figure for a 1-port bundle");
  }
  // Z from Γ
  const z = zFromGamma({ re: [0, 1 / 3, -1 / 3], im: [0, 0, 0] }, 50);
  check(near(z.re[0], 50, 1e-9) && near(z.re[1], 100, 1e-9) && near(z.re[2], 25, 1e-9), where, `zFromGamma ${z.re}`);
  console.log(`adapter: ${index.projects.length} committed bundles read as S-matrices`);
}

// ------------------------------------------------------------------ 5b. simulated multi-port bundles
// Real openEMS bundles written by python/fairbeam/multiport.py: the compact (base64 int16 or
// float32) element-pattern encoding must decode, and a single driven element must reproduce the bundle's own
// pattern-integrated directivity for that port (same field data, independent code path).
{
  const where = "simulated array";
  const index = JSON.parse(readFileSync(join(root, "public/projects/index.json"), "utf8"));
  let n = 0;
  for (const e of index.projects) {
    const b = JSON.parse(readFileSync(join(root, "public/projects", e.file), "utf8"));
    if (!b.results?.element_patterns) continue;
    n++;
    const sets = elementPatterns(b);
    check(sets.length === b.results.element_patterns.frequencies.length, `${where} ${e.file}`, `decoded ${sets.length} element-pattern sets`);
    const set = sets[0];
    const ports = set.elements.map((x) => x.port);
    check(ports.length === b.results.element_patterns.ports.length, `${where} ${e.file}`, "element count");
    for (const p of ports) {
      const only = new Map(ports.map((q) => [q, q === p ? { ampDb: 0, phaseDeg: 0 } : { ampDb: -400, phaseDeg: 0 }]));
      const ff = arrayFarField(b, set, only);
      const ref = b.results.farfield.find((x) => x.port === p && Math.abs(x.f - set.f) < 1);
      check(!!ref && near(ff.dmax_dbi, ref.dmax_pattern_dbi, 0.05), `${where} ${e.file}`,
        `port ${p} alone: Dmax ${ff.dmax_dbi.toFixed(3)} dBi vs the bundle's pattern Dmax ${ref?.dmax_pattern_dbi}`);
    }
    const uni = arrayFarField(b, set, uniformWeights(ports));
    const elem = b.results.farfield.find((x) => x.port === ports[0]).dmax_pattern_dbi;
    check(uni.dmax_dbi - elem > 1.5 && uni.dmax_dbi - elem < 10 * Math.log10(ports.length) + 0.5, `${where} ${e.file}`,
      `uniform array gain over one element ${(uni.dmax_dbi - elem).toFixed(2)} dB`);
    const S = sMatrix(b);
    check(!!S && !S.legacy && S.ports.length === ports.length, `${where} ${e.file}`, "S-matrix");
    check(S.reciprocity !== null && S.reciprocity < 0.02, `${where} ${e.file}`, `reciprocity ${S.reciprocity}`);
    check(S.passivity !== null && S.passivity <= 1.01, `${where} ${e.file}`, `passivity ${S.passivity}`);
    if (ports.length === 2) {
      // steer along the element axis by 20°
      const [pa, pb] = ports.map((p) => b.ports.find((q) => q.number === p));
      const axis = [0, 1, 2].reduce((m, i) => (Math.abs(pa.start[i] - pb.start[i]) > Math.abs(pa.start[m] - pb.start[m]) ? i : m), 0);
      const phi0 = axis === 1 ? 90 : 0;
      const ph = steeringPhases(b, ports, set.f, 20, phi0);
      const w = new Map(ports.map((p) => [p, { ampDb: 0, phaseDeg: ph.get(p) }]));
      const st = arrayFarField(b, set, w);
      const beam = mainBeam(st.theta, st.phi, st.directivity_dbi, !!b.half_space);
      check(beam.theta >= 9 && beam.theta <= 24 && Math.abs(((beam.phi - phi0 + 540) % 360) - 180) <= 10, `${where} ${e.file}`,
        `20° steering: beam at θ=${beam.theta}°, φ=${beam.phi}°`);
      const g = activeReflection(S, uniformWeights(ports), set.f);
      check([...g.values()].every((x) => x && gammaDb(x) < 0), `${where} ${e.file}`, "active reflection");
      console.log(`simulated array ${e.file}: element ${elem} dBi, uniform ${uni.dmax_dbi.toFixed(2)} dBi, 20° taper -> beam θ=${beam.theta}°, ` +
        `Γ_active ${[...g.values()].map((x) => gammaDb(x).toFixed(1)).join(" / ")} dB`);
    }
  }
  if (!n) console.log("simulated array: no committed bundle with element patterns");
}

// ------------------------------------------------------------------ 5c. element-pattern encodings
// "i16le-base64-scaled" (current writer) and "f32le-base64" (older bundles), docs/BUNDLE.md.
// examples/fixtures/element-patterns-f32.json keeps the float32 form of the committed 2×1 array
// (every 2nd θ/φ sample) as the backward-compatibility fixture.
{
  const where = "encodings";
  const KEYS = ["e_theta_re", "e_theta_im", "e_phi_re", "e_phi_im"];
  // round trip with a shared scale
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  const arrays = [1, 0.5, 2, 0.01].map((k) => Float64Array.from({ length: 12 * 7 }, () => rnd() * 1e-3 * k));
  const { scale, texts } = encodeI16Grids(arrays);
  check(scale === Math.max(...arrays.map((a) => Math.max(...a.map(Math.abs)))), where, "one shared scale = max |value|");
  let err = 0;
  arrays.forEach((a, n) => {
    const g = decodeI16Grid(texts[n], 12, 7, scale);
    g.flat().forEach((v, i) => (err = Math.max(err, Math.abs(v - a[i]))));
  });
  check(err <= (0.5 * scale) / I16_FULL * (1 + 1e-9), where, `int16 round trip error ${err} > half a step`);
  check(decodeI16Grid(texts[0], 12, 8, scale) === null && decodeI16Grid(texts[0], 12, 7, NaN) === null && decodeF32Grid(texts[0], 12, 7) === null, where, "wrong size / scale must not decode");
  const z = encodeI16Grids([new Float64Array(6)]);
  check(z.scale === 0 && decodeI16Grid(z.texts[0], 2, 3, 0).flat().every((v) => v === 0), where, "all-zero arrays");
  // the float32 fixture decodes and matches the committed (int16) bundle to within one step
  const fx = JSON.parse(readFileSync(join(root, "examples/fixtures/element-patterns-f32.json"), "utf8"));
  const b16 = JSON.parse(readFileSync(join(root, "public/projects/patch-array-2x1.json"), "utf8"));
  check(fx.results.element_patterns.encoding === ENC_F32 && b16.results.element_patterns.encoding === ENC_I16, where, "fixture / bundle encodings");
  const so = elementPatterns(fx)[0], sn = elementPatterns(b16)[0];
  check(!!so && so.elements.length === 2 && !!sn, where, "float32 fixture not read");
  const ti = so.theta.map((x) => sn.theta.indexOf(x)), pj = so.phi.map((x) => sn.phi.indexOf(x));
  let worstStep = 0;
  so.elements.forEach((eo, n) => {
    const en = sn.elements[n];
    const step = b16.results.element_patterns.ports[n].fields[0].scale / I16_FULL;
    for (const k of ["eThetaRe", "eThetaIm", "ePhiRe", "ePhiIm"]) eo[k].forEach((row, i) => row.forEach((v, j) => {
      worstStep = Math.max(worstStep, Math.abs(v - en[k][ti[i]][pj[j]]) / step);
    }));
  });
  check(worstStep <= 0.5 + 1e-6, where, `fixture vs int16 bundle: ${worstStep.toFixed(3)} steps apart`);
  // synthesis accuracy: the fixture's float32 data vs the same data quantised to int16
  const q = structuredClone(fx);
  const ep = q.results.element_patterns;
  const [nt, np] = ep.shape;
  for (const p of ep.ports) p.fields = p.fields.map((e) => {
    const enc = encodeI16Grids(KEYS.map((k) => decodeF32Grid(e[k], nt, np).flat()));
    return { f: e.f, scale: enc.scale, ...Object.fromEntries(KEYS.map((k, i) => [k, enc.texts[i]])) };
  });
  ep.encoding = ENC_I16;
  const sq = elementPatterns(q)[0];
  const ports = so.elements.map((e) => e.port);
  let worst = 0, worstBw = 0;
  for (const t0 of [0, 30, 60]) {
    const ph = steeringPhases(fx, ports, so.f, t0, 90);
    const w = new Map(ports.map((p) => [p, { ampDb: 0, phaseDeg: ph.get(p) }]));
    const a = arrayFarField(fx, so, w), c = arrayFarField(q, sq, w);
    a.directivity_dbi.forEach((row, i) => row.forEach((v, j) => {
      if (v > a.dmax_dbi - 40) worst = Math.max(worst, Math.abs(v - c.directivity_dbi[i][j]));
    }));
    const ba = mainBeam(a.theta, a.phi, a.directivity_dbi, false), bc = mainBeam(c.theta, c.phi, c.directivity_dbi, false);
    check(ba.theta === bc.theta && ba.phi === bc.phi, where, `scan ${t0}°: beam (${ba.theta}, ${ba.phi}) vs (${bc.theta}, ${bc.phi}) after quantisation`);
    worstBw = Math.max(worstBw, Math.abs((ba.hpbwTheta ?? 0) - (bc.hpbwTheta ?? 0)), Math.abs((ba.hpbwPhi ?? 0) - (bc.hpbwPhi ?? 0)));
    check(near(a.dmax_dbi, c.dmax_dbi, 0.005), where, `scan ${t0}°: Dmax ${a.dmax_dbi} vs ${c.dmax_dbi}`);
  }
  check(worst < 0.05, where, `int16 vs float32 directivity differs by ${worst.toFixed(4)} dB within 40 dB of the peak`);
  check(worstBw < 0.05, where, `int16 vs float32 HPBW differs by ${worstBw.toFixed(4)}°`);
  // at a pole the φ of the maximum is noise; the cut plane is the narrowest one at the neighbouring ring
  const T = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90], P = [0, 90, 180, 270];
  const d = T.map((th, i) => P.map((ph, j) => (i === 0 ? 10 + 1e-4 * [3, 1, 4, 2][j] : 10 - th * (ph % 180 === 0 ? 0.05 : 0.2))));
  const pb = mainBeam(T, P, d, true);
  check(pb.theta === 0 && pb.phi % 180 === 90 && pb.dmaxDbi === d[0][2] && near(pb.hpbwTheta, 30, 0.1), where, `pole beam cut plane φ=${pb.phi}, HPBW ${pb.hpbwTheta} (want the narrow plane 90/270, 30°)`);
  // the elevation cut continues through the pole into the opposite half-plane φ0 + 180°
  const T2 = Array.from({ length: 19 }, (_, i) => i * 5);
  const d2 = T2.map((th) => P.map((ph) => (ph === 0 ? 10 - 0.01 * (th - 10) ** 2 : ph === 180 ? 10 - 0.01 * (th + 10) ** 2 : 9 - 0.05 * th)));
  const ob = mainBeam(T2, P, d2, true);
  check(ob.theta === 10 && ob.phi === 0 && near(ob.hpbwTheta, 2 * Math.sqrt(300), 1), where, `beam across the pole: (${ob.theta}, ${ob.phi}), HPBW ${ob.hpbwTheta} (want ${(2 * Math.sqrt(300)).toFixed(2)}°)`);
  console.log(`encodings: int16 round trip ≤ ½ step, float32 fixture within ${worstStep.toFixed(2)} step of the int16 bundle, ` +
    `synthesis difference ${worst.toExponential(1)} dB (D > Dmax − 40 dB), HPBW ${worstBw.toExponential(1)}°`);
}

// ------------------------------------------------------------------ 6. synthetic 2×1 array bundle
function syntheticArray() {
  const base = JSON.parse(readFileSync(join(root, "public/projects/patch-antenna.json"), "utf8"));
  const b = structuredClone(base);
  const f0 = base.results.farfield[0].f;
  const lam = C0 / f0;
  const d = 60; // mm, ≈ 0.49 λ at 2.43 GHz
  const sub = [120, 70];
  b.name = "SYNTHETIC 2×1 patch array (test data, not a simulation)";
  b.created = base.created;
  b.model = {
    id: "synthetic-array2x1",
    name: "SYNTHETIC 2×1 patch array",
    description: "Synthetic test data for the multi-port and beam-steering views: two copies of the patch antenna 60 mm apart with analytic element patterns and a made-up −20 dB coupling. NOT a simulation.",
    reference: "Generated by scripts/check-array.mjs",
    params: [
      { key: "spacing", label: "Element spacing (x)", unit: "mm", value: d, default: d, description: "", minimum: null, maximum: null },
      { key: "patch_w", label: "Patch length (x)", unit: "mm", value: 32, default: 32, description: "", minimum: null, maximum: null },
      { key: "patch_l", label: "Patch width (y)", unit: "mm", value: 40, default: 40, description: "", minimum: null, maximum: null },
      { key: "sub_h", label: "Substrate thickness", unit: "mm", value: 1.524, default: 1.524, description: "", minimum: null, maximum: null },
      { key: "feed_x", label: "Feed offset (x)", unit: "mm", value: -6, default: -6, description: "", minimum: null, maximum: null },
    ],
  };
  const h = 1.524;
  const patch = (cx) => ({ priority: 10, kind: "box", start: [cx - 16, -20, h], stop: [cx + 16, 20, h], bbox: [[cx - 16, -20, h], [cx + 16, 20, h]], exact: true });
  b.parts = [
    { name: "substrate", label: "Substrate", type: "Material", material: base.parts.find((p) => p.name === "substrate").material,
      primitives: [{ priority: 0, kind: "box", start: [-sub[0] / 2, -sub[1] / 2, 0], stop: [sub[0] / 2, sub[1] / 2, h], bbox: [[-sub[0] / 2, -sub[1] / 2, 0], [sub[0] / 2, sub[1] / 2, h]], exact: true }],
      bbox: [[-sub[0] / 2, -sub[1] / 2, 0], [sub[0] / 2, sub[1] / 2, h]] },
    { name: "gnd", label: "Ground plane", type: "Metal",
      primitives: [{ priority: 10, kind: "box", start: [-sub[0] / 2, -sub[1] / 2, 0], stop: [sub[0] / 2, sub[1] / 2, 0], bbox: [[-sub[0] / 2, -sub[1] / 2, 0], [sub[0] / 2, sub[1] / 2, 0]], exact: true }],
      bbox: [[-sub[0] / 2, -sub[1] / 2, 0], [sub[0] / 2, sub[1] / 2, 0]] },
    { name: "patch", label: "Patches", type: "Metal", primitives: [patch(-d / 2), patch(d / 2)], bbox: [[-d / 2 - 16, -20, h], [d / 2 + 16, 20, h]] },
  ];
  b.ports = [-d / 2, d / 2].map((cx, i) => ({ number: i + 1, type: "lumped", R: 50, direction: "z", start: [cx - 6, 0, 0], stop: [cx - 6, 0, h], excite: true }));
  b.focus = { min: [-sub[0] / 2 - 5, -sub[1] / 2 - 5, -3], max: [sub[0] / 2 + 5, sub[1] / 2 + 5, h + 5] };
  b.fields = undefined;
  delete b.fields;
  // S-matrix: both reflections = the patch's S11, coupling −20 dB with the free-space phase delay
  const pr = base.results.ports["1"];
  const f = base.results.frequency;
  const s21 = { re: [], im: [] };
  f.forEach((fh) => {
    const a = 0.1 * (0.8 + 0.2 * Math.exp(-(((fh - f0) / 3e8) ** 2)));
    const ph = (-2 * Math.PI * fh * d * 1e-3) / C0 - Math.PI / 2;
    s21.re.push(Number((a * Math.cos(ph)).toFixed(6)));
    s21.im.push(Number((a * Math.sin(ph)).toFixed(6)));
  });
  const s11 = { re: pr.s11_re, im: pr.s11_im };
  let pass = 0;
  f.forEach((_, k) => (pass = Math.max(pass, s11.re[k] ** 2 + s11.im[k] ** 2 + s21.re[k] ** 2 + s21.im[k] ** 2)));
  b.results.sparams = { ports: [1, 2], z_ref: [50, 50], excited: [1, 2], s: { "1,1": s11, "2,1": s21, "1,2": s21, "2,2": s11 }, reciprocity_max: 0, passivity_max: Number(pass.toFixed(5)) };
  b.results.ports = { 1: pr, 2: { ...pr } };
  // element patterns: a patch-like element (E_θ = cos φ, E_φ = −sin φ cos θ, −20 dB behind the
  // ground), times the phase of its centre ±d/2 on x (common phase reference at the origin)
  const k = (2 * Math.PI) / lam;
  const back = 0.1;
  const amp = (t) => (t <= 90 ? 1 : t >= 100 ? back : 1 + ((back - 1) * (t - 90)) / 10);
  const els = [-d / 2, d / 2].map((cx, n) => {
    const e = { port: n + 1, e_theta: { re: [], im: [] }, e_phi: { re: [], im: [] } };
    for (const t of THETA) {
      const r1 = [], i1 = [], r2 = [], i2 = [];
      for (const p of PHI) {
        const ph = k * cx * 1e-3 * Math.sin(t * rad) * Math.cos(p * rad);
        const a = amp(t);
        const et = a * Math.cos(p * rad);
        const ep = -a * Math.sin(p * rad) * Math.cos(t * rad);
        r1.push(Number((et * Math.cos(ph)).toFixed(5))); i1.push(Number((et * Math.sin(ph)).toFixed(5)));
        r2.push(Number((ep * Math.cos(ph)).toFixed(5))); i2.push(Number((ep * Math.sin(ph)).toFixed(5)));
      }
      e.e_theta.re.push(r1); e.e_theta.im.push(i1); e.e_phi.re.push(r2); e.e_phi.im.push(i2);
    }
    return e;
  });
  b.results.element_patterns = [{ f: f0, theta: THETA, phi: PHI, elements: els }];
  // the stored far field = uniform excitation of both ports
  const set = elementPatterns(b)[0];
  const ff = arrayFarField(b, set, uniformWeights([1, 2]));
  b.results.farfield = [{ ...base.results.farfield[0], ...ff, directivity_dbi: ff.directivity_dbi.map((row) => row.map((v) => Number(v.toFixed(2)))), dmax_dbi: Number(ff.dmax_dbi.toFixed(3)), gain_dbi: undefined, realized_gain_dbi: undefined, rad_efficiency: null, prad_w: 0, pacc_w: 0, mirror_planes: 0 }];
  delete b.results.farfield[0].gain_dbi;
  delete b.results.farfield[0].realized_gain_dbi;
  b.results.signals = {};
  b.run = null; // no solver run behind synthetic data
  return b;
}

{
  const where = "synthetic array";
  const b = syntheticArray();
  mkdirSync(join(root, "examples/synthetic"), { recursive: true });
  writeFileSync(join(root, "examples/synthetic/array2x1.json"), JSON.stringify(b));
  const index = readFileSync(join(root, "public/projects/index.json"), "utf8");
  check(!index.includes("synthetic"), where, "a synthetic bundle is listed in public/projects/index.json");
  const S = sMatrix(b);
  check(S && !S.legacy && S.ports.length === 2 && S.pairs.length === 4, where, "S-matrix not read as 2-port");
  check(pairLabel([2, 1]) === "S21" && magDb(S.get(2, 1)).every((v) => v < -15 && v > -25), where, "S21 level");
  const sets = elementPatterns(b);
  check(sets.length === 1 && sets[0].elements.length === 2, where, "element patterns not read");
  const w = uniformWeights([1, 2]);
  const ff = arrayFarField(b, sets[0], w);
  const beam = mainBeam(ff.theta, ff.phi, ff.directivity_dbi, false);
  check(beam.theta === 0, where, `uniform beam not at broadside (θ=${beam.theta})`);
  const ph = steeringPhases(b, [1, 2], sets[0].f, 25, 0);
  const st = arrayFarField(b, sets[0], new Map([...ph].map(([p, deg]) => [p, { ampDb: 0, phaseDeg: deg }])));
  const sb = mainBeam(st.theta, st.phi, st.directivity_dbi, false);
  check(sb.theta > 5 && sb.phi === 0, where, `steered to 25°: beam at θ=${sb.theta}°, φ=${sb.phi}°`);
  const g = activeReflection(S, w, sets[0].f);
  check(g.get(1) && gammaDb(g.get(1)) < 0, where, "active reflection");
  // figures, drawing, package, report
  const figs = figureSet(b);
  check(figs.some((x) => x.name === "sparams_reflection.svg") && figs.some((x) => x.name === "sparams_transmission.svg"), where, "S-matrix figures missing");
  const tf = sparamFigure(b, "transmission");
  check(tf.includes("|S21| = |S12|"), where, "reciprocal transmission label");
  const dr = technicalDrawing(b, { sheet: "A3", date: "2026-09-24" });
  check(!dr.warnings.length && dr.dimensionKeys.length === new Set(dr.dimensionKeys).size, where, `drawing: ${dr.warnings} ${dr.dimensions}`);
  const all = { project: true, readme: true, report: false, data: true, drawings: false, figures: true, cst: false, image: false };
  const weights = new Map([[1, { ampDb: 0, phaseDeg: 0 }], [2, { ampDb: 0, phaseDeg: ph.get(2) }]]);
  const files = packageFiles(b, all, { arrayWeights: weights }, new Date("2026-09-24T22:36:00+03:00"));
  const paths = files.map((x) => x.path);
  for (const p of ["data/sparams.csv", "data/array_weights.csv", "figures/sparams_reflection.svg", "figures/sparams_transmission.svg", `figures/array_pattern_${(Math.round(sets[0].f / 1e6) / 1e3).toFixed(3)}GHz.svg`]) check(paths.includes(p), where, `package lacks ${p}`);
  const csv = String(files.find((x) => x.path === "data/sparams.csv").data).split("\n");
  check(csv[0].includes("S21_dB") && csv.length - 2 === b.results.frequency.length, where, `sparams.csv header/rows: ${csv[0]} ${csv.length}`);
  const pages = reportPages(b, { generated: "2026-09-24 22:36", date: "2026-09-24", arrayWeights: weights });
  const txt = pages.join(" ");
  check(txt.includes("S-parameters") && txt.includes("Array pattern"), where, "report lacks the S-parameter / array pages");
  console.log(`synthetic array: 2 ports, uniform Dmax ${ff.dmax_dbi.toFixed(2)} dBi, steered beam θ=${sb.theta}°, ${files.length} package files, ${pages.length} report pages`);
}

console.log(`\n${checks} checks, ${failures} failed.`);
if (failures) process.exit(1);
