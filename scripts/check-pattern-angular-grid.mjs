// Analytic synthetic angular grids only: no browser, app build, server or solver.
import assert from "node:assert/strict";
import { patternCut, samplePhi } from "../src/lib/rf.ts";
import { directivity, mainBeam, solidAngleWeights } from "../src/lib/array.ts";

const near = (value, expected, tolerance = 1e-10) => assert.ok(Math.abs(value - expected) <= tolerance, `${value} != ${expected}`);
const theta = Array.from({ length: 61 }, (_, i) => i * 3);
const phi = Array.from({ length: 33 }, (_, i) => i * 11); // last 352: an 8-degree periodic seam
// A triangular periodic profile is exactly linear around 90/270 and across the seam.
const triangle = p => p < 180 ? p : 360 - p;
const grid = theta.map(t => phi.map(p => t / 10 + triangle(p)));
const before = JSON.stringify({ theta, phi, grid });
for (const plane of [90, 450, -270]) {
  const cut = patternCut(theta, phi, grid, plane, false);
  assert.equal(cut.angle.length, 121);
  assert.equal(cut.interpolated, true);
  cut.angle.forEach((angle, i) => near(cut.value[i], Math.abs(angle) / 10 + 90));
}
const half = patternCut(theta, phi, grid, 90, true);
assert.equal(half.angle[0], -90);
assert.equal(half.angle.at(-1), 90);
assert.equal(half.angle.length, 61);
const cut0 = patternCut(theta, phi, grid, 0, false);
assert.equal(cut0.angle.length, 121, "the missing exact opposite sample must not drop half the cut");
assert.equal(cut0.interpolated, true);
// Exact samples preserve values, and the actual 352..360 seam span determines the interpolation.
assert.equal(samplePhi(phi, grid, 22).interpolated, false);
near(samplePhi(phi, grid, 22).values[10], grid[10][2]);
near(samplePhi(phi, grid, 356).values[0], 4);
near(samplePhi(phi, grid, -4).values[0], 4);
assert.deepEqual(samplePhi(phi, grid, 360), samplePhi(phi, grid, 0));
assert.equal(JSON.stringify({ theta, phi, grid }), before, "plotting cannot mutate source coordinates or data");
const invalid = structuredClone(grid);
invalid[2][8] = NaN; // one neighbour of phi=90: keep the gap instead of inventing a value
assert.ok(Number.isNaN(samplePhi(phi, invalid, 90).values[2]));
assert.equal(samplePhi([0, 0], [[1, 2]], 2), null);
assert.equal(samplePhi([0], [[1]], 90), null);
assert.equal(samplePhi([0, NaN], [[1, 2]], 90), null);
assert.equal(samplePhi([0, 180, 360], [[1, 2, 1]], 90), null);
assert.equal(samplePhi([-10, 90], [[1, 2]], 0), null);
assert.equal(samplePhi([90, 0], [[1, 2]], 45), null);
const exact = patternCut([0, 90, 180], [0, 90, 180, 270], [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]], 90, false);
assert.deepEqual(exact, { angle: [-180, -90, 0, 90, 180], value: [12, 8, 2, 6, 10], interpolated: false });

// A rotationally symmetric pole beam has exact -3 dB crossings at +/-15 degrees.
// The 11-degree phi grid has no opposite plane, but interpolation of equal samples is exact.
const beamGrid = theta.map(t => phi.map(() => -(t * t) / 75));
const beam = mainBeam(theta, phi, beamGrid, false);
near(beam.theta, 0);
near(beam.hpbwTheta, 30);
near(mainBeam(theta, phi, beamGrid, true).hpbwTheta, 30);
const beamBefore = JSON.stringify(beamGrid);
const gapBeam = structuredClone(beamGrid);
gapBeam[2][16] = NaN; // phi 176 brackets the negative half of the pole cut
assert.equal(mainBeam(theta, phi, gapBeam, false).hpbwTheta, null, "a gap cannot be crossed to report beamwidth");
assert.equal(JSON.stringify(beamGrid), beamBefore);
// A synthetic beam centred at theta=6 crosses the pole before its negative -3 dB crossing.
// On the requested phi=0 great circle the analytic width is 30 degrees; phi interpolation is an estimate.
const crossPole = theta.map(t => phi.map(p => -(t * t + 36 - 12 * t * Math.cos(p * Math.PI / 180)) / 75));
near(mainBeam(theta, phi, crossPole, false).hpbwTheta, 30, 0.1);
const metadata = { requested_steps: [3, 11], theta, phi, directivity_dbi: crossPole, source_shape: [61, 33] };
const savedMetadata = JSON.stringify(metadata);
patternCut(metadata.theta, metadata.phi, metadata.directivity_dbi, 90, false);
assert.equal(JSON.stringify(metadata), savedMetadata, 'requested/stored-grid metadata remains unchanged');

// Independent known cell weights for nonuniform phi: these sum to a full 2pi circumference.
const irregular = [0, 60, 180, 270];
const weights = solidAngleWeights(theta, irregular);
weights.wp.forEach((w, i) => near(w, [75, 90, 105, 90][i] * Math.PI / 180));
near(weights.wp.reduce((a, b) => a + b, 0), 2 * Math.PI);
const isotropic = directivity(theta, irregular, theta.map(() => irregular.map(() => 1)), false);
near(isotropic.dmaxDbi, 0);
const asymmetric = directivity(theta, irregular, theta.map(() => [1, 2, 3, 4]), false);
near(asymmetric.dmaxDbi, 10 * Math.log10(4 / ((75 + 180 + 315 + 360) / 360)));
console.log("check-pattern-angular-grid: non-divisor cuts, periodic seam, exact samples, gaps, immutable data, pole HPBW and cell-weight controls passed (analytic synthetic data)");
