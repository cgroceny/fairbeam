// Analytical display-math checks only: no browser, server, solver or files written.
// node --experimental-strip-types scripts/check-sparam-phase.mjs
import assert from "node:assert/strict";
import { analyzeSParameterPhase, unwrapDeg } from "../src/lib/sparamPhase.ts";

let assertions = 0;
const near = (actual, expected, label, tolerance = 1e-10) => {
  assertions++;
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, received ${actual}`);
};
const same = (actual, expected, label) => { assertions++; assert.deepEqual(actual, expected, label); };
const unavailable = (values, label) => {
  assertions++;
  assert.ok(values.every(Number.isNaN), `${label}: expected only NaN, received ${values}`);
};
const complex = (phases, amplitudes = phases.map(() => 1)) => ({
  re: phases.map((p, i) => amplitudes[i] * Math.cos(p * Math.PI / 180)),
  im: phases.map((p, i) => amplitudes[i] * Math.sin(p * Math.PI / 180)),
});
const analyze = (f, phases, options, amplitudes) => {
  const c = complex(phases, amplitudes);
  return analyzeSParameterPhase(f, c.re, c.im, options);
};

// Delay sign and GHz-to-ns units: S=exp(-j*2*pi*f_GHz*tau_ns), with loss and phase offset.
const regular = Array.from({ length: 81 }, (_, i) => 1 + i * .025), tau = .75;
const phase = regular.map(f => 27 - 360 * tau * f);
for (const aperturePoints of [3, 5, 11, 21, 101]) {
  const out = analyze(regular, phase, { aperturePoints }, regular.map((_, i) => .2 + i / 1000));
  out.delayNs.forEach((v, i) => near(v, tau, `constant delay, aperture ${aperturePoints}, point ${i}`));
  out.phaseDeg.forEach((v, i) => near(v - out.phaseDeg[0], phase[i] - phase[0], `continuous phase ${i}`));
}
const advance = analyze([0, .1, .2, .3], [0, 18, 36, 54]);
advance.delayNs.forEach(v => near(v, -.5, "positive phase slope has negative delay"));
const flat = analyze([0, .2, .4], [42, 42, 42]);
flat.delayNs.forEach(v => near(v, 0, "constant phase has zero delay"));

// Irregular spacing uses physical frequency, not index differences. Every endpoint is fitted.
const irregular = [0, .03, .11, .26, .42, .7, .95];
const irregularOut = analyze(irregular, irregular.map(f => -360 * .6 * f), { aperturePoints: 5 });
irregularOut.delayNs.forEach(v => near(v, .6, "irregular-grid pure delay"));

// Two reference grids use their union. Unwrap each original grid before interpolation.
const first = [0, .12, .28, .51, .8], second = [.06, .18, .4, .8];
const union = [...new Set([...first, ...second])].sort((a, b) => a - b);
for (const original of [first, second]) {
  const out = analyze(original, original.map(f => -360 * .7 * f), { gridGHz: union, aperturePoints: 3 });
  union.forEach((f, i) => {
    if (f < original[0] || f > original.at(-1)) {
      unavailable([out.phaseDeg[i], out.delayNs[i]], "no extrapolation beyond a reference grid");
    } else {
      near(out.phaseDeg[i], -360 * .7 * f, "continuous phase on union grid");
      near(out.delayNs[i], .7, "delay on union grid");
    }
  });
}

// This piecewise phase makes interpolation order observable: native 3-point slopes are all
// 60 deg/GHz, whereas phase interpolation has local slopes 30/90 away from the corner.
const fine = Array.from({ length: 9 }, (_, i) => i / 4);
const piecewise = analyze([0, 1, 2], [0, -30, -120], { gridGHz: fine });
near(piecewise.delayNs[2], 30 / 360, "interpolate phase before differentiating: left segment");
near(piecewise.delayNs[4], 60 / 360, "local fit at phase corner");
near(piecewise.delayNs[6], 90 / 360, "interpolate phase before differentiating: right segment");
near(analyze([0, 1, 2], [0, -30, -120]).delayNs[1], 60 / 360, "native-grid local fit");

// A quadratic phase has linearly dispersive delay; a symmetric 3-point fit is exact inside.
const dispersionGrid = Array.from({ length: 17 }, (_, i) => i / 20);
const intercept = .2, dispersion = .3;
const dispersive = analyze(dispersionGrid, dispersionGrid.map(f => -360 * (intercept * f + dispersion * f * f / 2)));
dispersive.delayNs.forEach((v, i) => {
  const center = Math.max(1, Math.min(i, dispersionGrid.length - 2));
  near(v, intercept + dispersion * dispersionGrid[center], "quadratic phase / one-sided endpoint fit");
});

// A wider aperture reduces a known phase ripple. This is synthetic noise suppression,
// not increased measurement resolution or an assertion about an antenna's physical delay.
const noisyGrid = Array.from({ length: 101 }, (_, i) => i * .05);
const noisyPhase = noisyGrid.map((f, i) => -360 * .2 * f + .8 * Math.sin(Math.PI * i / 2));
const narrow = analyze(noisyGrid, noisyPhase, { aperturePoints: 3 });
const wide = analyze(noisyGrid, noisyPhase, { aperturePoints: 11 });
const rms = values => Math.sqrt(values.slice(6, -6).reduce((sum, v) => sum + (v - .2) ** 2, 0) / (values.length - 12));
assertions++;
assert.ok(rms(wide.delayNs) < .08 * rms(narrow.delayNs), "11-point fit suppresses the declared phase ripple");
same(analyze(noisyGrid, noisyPhase, { aperturePoints: 4 }), analyze(noisyGrid, noisyPhase, { aperturePoints: 5 }), "even aperture rounds up");
same(analyze(noisyGrid, noisyPhase, { aperturePoints: -5 }), narrow, "aperture minimum is 3");
same(analyze(noisyGrid, noisyPhase, { aperturePoints: 1000 }), analyze(noisyGrid, noisyPhase, { aperturePoints: 101 }), "aperture maximum is 101");
same(analyze(noisyGrid, noisyPhase, { aperturePoints: NaN }), narrow, "nonfinite aperture uses default 3");

// Invalid source or destination grids are rejected as given; never sorted/deduplicated.
for (const f of [[0, 0, 1], [0, 2, 1], [-.1, 0, 1], [0, NaN, 1], [0, Infinity, 1], [0, 1, ,]]) {
  const out = analyzeSParameterPhase(f, [1, 1, 1], [0, 0, 0]);
  same(out.warnings, ["invalidGrid"], "invalid source grid warning");
  unavailable(out.phaseDeg, "invalid source phase");
  unavailable(out.delayNs, "invalid source delay");
}
for (const gridGHz of [[0, 0, 1], [0, 2, 1], [-1, 0, 1], [0, NaN], [0, Infinity]]) {
  const out = analyze([0, 1, 2], [0, -20, -40], { gridGHz });
  same(out.phaseDeg.length, gridGHz.length, "invalid target preserves output length");
  same(out.warnings, ["invalidGrid"], "invalid target grid warning");
  unavailable(out.phaseDeg, "invalid target phase");
  unavailable(out.delayNs, "invalid target delay");
}
const mismatch = analyzeSParameterPhase([0, 1, 2], [1, 1], [0, 0, 0]);
same(mismatch.warnings, ["invalidSample"], "mismatched sample arrays rejected");
unavailable(mismatch.phaseDeg, "mismatched sample phase");
unavailable(mismatch.delayNs, "mismatched sample delay");
same(analyzeSParameterPhase([], [], []), { phaseDeg: [], delayNs: [], warnings: [] }, "empty input");
const singleton = analyze([1], [45]);
near(singleton.phaseDeg[0], 45, "one sample has phase");
unavailable(singleton.delayNs, "one sample has no slope");
const two = analyze([1, 1.25], [-20, -65], { aperturePoints: 101 });
two.delayNs.forEach(v => near(v, .5, "two-point segment has a secant slope"));

// Invalid complex samples and zero magnitude split independent phase branches. Interpolating
// a grid that omits the missing frequency must still NOT fit across that hidden source gap.
for (const bad of [[NaN, 0], [0, Infinity], [0, 0], [-0, -0]]) {
  const c = complex([0, -36, -72, 80, 8]);
  [c.re[2], c.im[2]] = bad;
  const out = analyzeSParameterPhase([0, 1, 2, 3, 4], c.re, c.im, { gridGHz: [0, .5, 1, 1.5, 2, 2.5, 3, 3.5, 4], aperturePoints: 21 });
  same(out.warnings, ["invalidSample"], "invalid sample warning");
  unavailable(out.phaseDeg.slice(3, 6), "invalid source segment is not interpolated");
  unavailable(out.delayNs.slice(3, 6), "invalid source segment has no delay");
  out.delayNs.slice(0, 3).forEach(v => near(v, .1, "left segment slope"));
  out.delayNs.slice(6).forEach(v => near(v, .2, "right segment slope"));
  const omitGap = analyzeSParameterPhase([0, 1, 2, 3, 4], c.re, c.im, { gridGHz: [0, 1, 3, 4], aperturePoints: 101 });
  omitGap.delayNs.forEach((v, i) => near(v, i < 2 ? .1 : .2, "segment identity survives omitted gap on target grid"));
}
const isolated = analyzeSParameterPhase([0, 1, 2], [NaN, 1, NaN], [0, 1, 0], { gridGHz: [.5, 1, 1.5] });
near(isolated.phaseDeg[1], 45, "isolated source point retained at exact frequency");
unavailable([isolated.phaseDeg[0], isolated.phaseDeg[2], ...isolated.delayNs], "isolated point cannot interpolate or differentiate");
const noExtra = analyze([1, 2], [0, -90], { gridGHz: [0, 1, 1.5, 2, 3] });
unavailable([noExtra.phaseDeg[0], noExtra.phaseDeg[4], noExtra.delayNs[0], noExtra.delayNs[4]], "both extrapolation ends unavailable");
noExtra.delayNs.slice(1, 4).forEach(v => near(v, .25, "bounded interpolated delay"));

// Tiny nonzero amplitudes remain valid (do not underflow by squaring |S|); huge finite ones
// also remain valid (do not overflow a norm). Only the exact complex origin is undefined.
for (const amplitude of [1e-300, 1e300]) {
  const out = analyze([0, .1, .2], [0, -9, -18], {}, [amplitude, amplitude, amplitude]);
  out.delayNs.forEach(v => near(v, .25, "finite amplitude scale leaves phase delay unchanged"));
  same(out.warnings, [], "finite nonzero amplitudes accepted");
}

// Raw principal phase can cross the branch cut while the actual increment is only 20 degrees.
const wrapped = analyze([0, 1, 2], [170, 190, 210]);
same(wrapped.warnings, ["phaseStep"], "observed wrap warning is not proof of aliasing");
wrapped.phaseDeg.forEach((v, i) => near(v, 170 + 20 * i, "ordinary branch wrap unwrapped"));
wrapped.delayNs.forEach(v => near(v, -20 / 360, "ordinary wrap keeps the physical slope"));
const halfTurn = analyzeSParameterPhase([0, 1, 2, 3], [1, -1, -Math.SQRT1_2, 0], [0, 0, Math.SQRT1_2, 1]);
same(halfTurn.warnings, ["phaseStep"], "exact half-turn warning");
unavailable([halfTurn.phaseDeg[1], halfTurn.delayNs[0], halfTurn.delayNs[1]], "ambiguous half-turn splits the data");
halfTurn.delayNs.slice(2).forEach(v => near(v, .125, "post-half-turn segment starts independently"));
const nearHalfTurn = analyze([0, 1], [0, 179.999999]);
near(nearHalfTurn.delayNs[0], -179.999999 / 360, "resolved step below180 degrees is retained");
same(nearHalfTurn.warnings, [], "sub-half-turn is not warned");
same(unwrapDeg([170, -170, NaN, -170, -150]), [170, 190, NaN, -170, -150], "unwrap helper resets after gaps");
same(unwrapDeg([0, 180, 135, 90]), [0, NaN, 135, 90], "unwrap helper preserves half-turn ambiguity");

// Sampling 1.25 ns and 0.25 ns delays at integer GHz produces indistinguishable complex values.
// Two samples can contain a true 450-degree step but show only -90 degrees and no warning.
const aliased = complex([0, -450]), resolved = complex([0, -90]);
aliased.re.forEach((v, i) => near(v, resolved.re[i], "aliased complex real sample"));
aliased.im.forEach((v, i) => near(v, resolved.im[i], "aliased complex imaginary sample"));
const aliasOut = analyzeSParameterPhase([0, 1], aliased.re, aliased.im);
aliasOut.delayNs.forEach(v => near(v, .25, "unobservable extra turn cannot be recovered"));
same(aliasOut.warnings, [], "absence of phaseStep cannot certify absence of true aliasing");

// Inputs are caller-owned and must not be changed by analysis/interpolation/aperture fitting.
const frozenF = Object.freeze([0, .1, .2]), frozenRe = Object.freeze([1, .5, 0]), frozenIm = Object.freeze([0, -.5, -1]);
analyzeSParameterPhase(frozenF, frozenRe, frozenIm, Object.freeze({ gridGHz: Object.freeze([0, .05, .1, .15, .2]) }));
assertions++;
console.log(`S-parameter phase and group delay: ${assertions} analytical assertions passed`);
