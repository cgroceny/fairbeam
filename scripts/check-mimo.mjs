// Synthetic formula, admission and exported-provenance checks; no native solver or browser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mimoAnalysis, networkDiversity, fieldCorrelation, diversityGain } from "../src/lib/mimo.ts";
import { strictElementPatternsAt, MATCHED_PATTERN_NORMALIZATION } from "../src/lib/patternAdmission.ts";
import { diversityCsv, DIVERSITY_ASSUMPTIONS } from "../src/export/diversity.ts";

let checks = 0;
const check = (name, test) => { test(); checks++; console.log(`ok ${name}`); };
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const complex = n => [n, 0], zero = () => [[complex(0), complex(0)], [complex(0), complex(0)]];
const equal = [complex(1), complex(1)];
const grid = (theta, phi, n) => theta.map(() => phi.map(() => n));
const encode = g => { const data = Buffer.alloc(g.flat().length * 4); g.flat().forEach((n, i) => data.writeFloatLE(n, i * 4)); return data.toString("base64"); };
function fixture() {
  const theta = [0, 37, 90, 143, 180], phi = [0, 53, 180, 286], f = [1e9, 2e9, 3e9];
  const fields = (port, frequency) => ({ f: frequency, e_theta_re: encode(grid(theta, phi, port === 7 ? 1 : 0)), e_theta_im: encode(grid(theta, phi, 0)), e_phi_re: encode(grid(theta, phi, port === 42 ? 1 : 0)), e_phi_im: encode(grid(theta, phi, 0)) });
  return { units: { length_m: .001 }, nf2ff_center: [0, 0, 0],
    solver: { boundaries: Object.fromEntries(['x-', 'x+', 'y-', 'y+', 'z-', 'z+'].map(k => [k, 'PML_8'])) },
    ports: [7, 42].map(number => ({ number, excite: true, start: [-1, 0, 0], stop: [1, 0, 0] })), half_space: false,
    results: { frequency: f, ports: {}, farfield: [], sparams: { ports: [1, 2], port_numbers: [7, 42], excited: [1, 2], z_ref: [50, 75], complete: true, method: "B A^-1",
      s: Object.fromEntries(["1,1", "1,2", "2,1", "2,2"].map(k => [k, { re: [0, 0, 0], im: [0, 0, 0] }])) },
      element_patterns: { normalization: MATCHED_PATTERN_NORMALIZATION, basis: "matched-incident-waves", radius_m: 1, mirror_planes: 0, phase_center: [0, 0, 0], decimation: 1,
        encoding: "f32le-base64", shape: [theta.length, phi.length], theta, phi, frequencies: [1e9, 3e9], ports: [7, 42].map(port => ({ port, position: [0, 0, 0], fields: [1e9, 3e9].map(frequency => fields(port, frequency)) })) } } };
}
const weightMap = () => new Map([[7, complex(1)], [42, complex(1)]]);

check("ideal complete network has ECC 0, DG proxy 10, CCL 0, MEG 0.5 and TARC 0", () => {
  const a = mimoAnalysis(fixture(), weightMap());
  assert.deepEqual(a.ports, [7, 42]);
  for (const row of a.rows) { near(row.pairs[0].eccS.value, 0); near(row.pairs[0].dgS.value, 10); near(row.ccl.value, 0); near(row.tarc.value, 0); row.meg.forEach(m => near(m.estimate.value, .5)); }
});
check("field ECC uses exact sparse frequencies and preserves both polarizations", () => {
  const a = mimoAnalysis(fixture(), weightMap());
  assert.deepEqual(a.rows.map(r => r.pairs[0].eccField.value), [0, null, 0]);
  assert.equal(a.rows[1].pairs[0].eccField.reason, "mimo.reason.pattern");
});
check("identical complex fields have ECC 1 and DG 0; phase/scaling do not change ECC", () => {
  const set = strictElementPatternsAt(fixture(), 1e9).set;
  const x = set.elements[0], y = set.elements[1];
  y.eThetaRe = x.eThetaRe.map(row => row.map(v => 3 * v)); y.eThetaIm = x.eThetaRe.map(row => row.map(v => 4 * v));
  y.ePhiRe = y.ePhiRe.map(row => row.map(() => 0));
  const ecc = fieldCorrelation(set, 7, 42); near(ecc.value, 1); near(diversityGain(ecc).value, 0);
  for (const e of set.elements) for (const k of ["eThetaRe", "eThetaIm", "ePhiRe", "ePhiIm"]) e[k] = e[k].map(row => row.map(v => v * 1e200));
  near(fieldCorrelation(set, 7, 42).value, 1);
});
check("independent analytic angular integral uses periodic nonuniform phi weights", () => {
  const set = strictElementPatternsAt(fixture(), 1e9).set, y = set.elements[1];
  y.eThetaRe = set.theta.map(() => set.phi.map(p => Math.cos(p * Math.PI / 180)));
  y.ePhiRe = y.ePhiRe.map(row => row.map(() => 0));
  const phi = set.phi, widths = phi.map((p, j) => ((j + 1 === phi.length ? phi[0] + 360 : phi[j + 1]) - (j ? phi[j - 1] : phi.at(-1) - 360)) / 2);
  const sum = widths.reduce((s, w, j) => s + w * Math.cos(phi[j] * Math.PI / 180), 0);
  const norm = widths.reduce((s, w, j) => s + w * Math.cos(phi[j] * Math.PI / 180) ** 2, 0);
  near(fieldCorrelation(set, 7, 42).value, sum ** 2 / (360 * norm));
});
check("TARC depends on explicit excitation phase and is scale invariant", () => {
  const s = [[complex(.4), complex(.4)], [complex(.4), complex(.4)]];
  near(networkDiversity(s, equal).tarc.value, .8);
  near(networkDiversity(s, [complex(1), complex(-1)]).tarc.value, 0);
  near(networkDiversity(s, [complex(1e200), complex(1e200)]).tarc.value, .8);
  assert.equal(networkDiversity(s, [complex(0), complex(0)]).tarc.reason, "mimo.reason.weights");
});
check("CCL uses whole Hermitian determinant and MEG uses column accepted power", () => {
  const s = [[complex(.5), complex(0)], [complex(0), complex(.2)]], d = networkDiversity(s, equal);
  near(d.ccl.value, -Math.log2(.75 * .96)); near(d.meg[0].value, .375); near(d.meg[1].value, .48);
  const withPhase = [[[.1, .2], [.15, -.1]], [[.15, -.1], [.05, .2]]], q = networkDiversity(withPhase, equal);
  const g = q.gram; near(q.ccl.value, -Math.log2(g[0][0][0] * g[1][1][0] - (g[0][1][0] ** 2 + g[0][1][1] ** 2)));
});
check("all column powers below one do not conceal a nonpassive singular value", () => {
  assert.equal(networkDiversity([[complex(.6), complex(.6)], [complex(.6), complex(.6)]], equal).reason, "mimo.reason.passivity");
});
check("singular passive Gram preserves TARC but refuses finite CCL", () => {
  const d = networkDiversity([[complex(1), complex(0)], [complex(0), complex(1)]], equal);
  near(d.tarc.value, 1); assert.equal(d.ccl.reason, "mimo.reason.singular");
  const b = fixture(); b.results.sparams.s["1,1"].re = [1, 1, 1];
  assert.equal(mimoAnalysis(b, weightMap()).rows[0].pairs[0].eccS.reason, "mimo.reason.denominator");
});
check("nonfinite, nonsquare and gain matrices never return valid metrics", () => {
  for (const s of [[[complex(NaN), complex(0)], [complex(0), complex(0)]], [[complex(0)]], [[complex(1.1), complex(0)], [complex(0), complex(0)]]])
    assert.equal(networkDiversity(s, equal).tarc.value, null);
});
check("incomplete, missing and physically corrupt mappings are refused", () => {
  for (const mutate of [b => b.results.sparams.complete = false, b => delete b.results.sparams.s["2,1"], b => b.results.sparams.excited = [1],
    b => b.results.sparams.port_numbers = [7, 7], b => b.results.sparams.port_numbers = [7, 99], b => b.results.sparams.ports = [1, 1]]) {
    const b = fixture(); mutate(b); assert.notEqual(mimoAnalysis(b).reason, null);
  }
});
check("unknown phase, bad references and repeated/unsorted frequencies are refused", () => {
  for (const mutate of [b => b.reference = { phaseKnown: false }, b => b.results.sparams.z_ref = [50, 0], b => b.results.frequency = [1e9, 1e9, 3e9], b => b.results.frequency = [3e9, 2e9, 1e9]]) {
    const b = fixture(); mutate(b); assert.notEqual(mimoAnalysis(b).reason, null);
  }
});
check("quantitative admission never inherits display defaults for references, ports or excitation", () => {
  for (const key of ["z_ref", "ports", "excited"]) {
    const b = fixture(); delete b.results.sparams[key];
    assert.notEqual(mimoAnalysis(b).reason, null);
  }
  const canonical = fixture(); canonical.ports = [{ number: 1, excite: true }, { number: 2, excite: true }];
  delete canonical.results.sparams.port_numbers; delete canonical.results.sparams.excited;
  assert.equal(mimoAnalysis(canonical).reason, "mimo.reason.complete");
});
check("invalid ECC cannot silently turn into a finite diversity-gain proxy", () => {
  for (const value of [-.1, 1.1, NaN, Infinity]) assert.equal(diversityGain({ value, reason: null }).value, null);
  assert.deepEqual(diversityGain({ value: null, reason: "missing" }), { value: null, reason: "missing" });
});
check("physical IDs and matrix reordering preserve TARC and pair provenance", () => {
  const b = fixture(); b.results.sparams.port_numbers = [42, 7]; b.results.sparams.s["1,1"].re = [.2, .2, .2]; b.results.sparams.s["2,2"].re = [.4, .4, .4];
  const a = mimoAnalysis(b, new Map([[7, complex(2)], [42, complex(1)]]));
  assert.deepEqual(a.rows[0].pairs[0].ports, [42, 7]); near(a.rows[0].tarc.value, Math.sqrt((.04 + .64) / 5));
});
check("missing or malformed fields, stale basis and mirrors remain unavailable", () => {
  for (const mutate of [b => delete b.results.element_patterns.basis, b => b.results.element_patterns.frequencies = [1e9, 1e9],
    b => b.results.element_patterns.ports[1].fields[0].e_phi_re = "bad", b => b.results.element_patterns.mirror_planes = 1,
    b => b.half_space = true, b => b.results.element_patterns.ports[1].fields[0].f += 1]) {
    const b = fixture(); mutate(b); assert.equal(mimoAnalysis(b).rows[0].pairs[0].eccField.value, null);
  }
});
check("zero fields, nonfinite samples, duplicate angles and half sphere are refused", () => {
  for (const mutate of [s => s.theta = [0, 90], s => s.phi[1] = s.phi[0], s => s.elements[0].eThetaRe[0][0] = NaN,
    s => s.elements[0].eThetaRe = s.elements[0].eThetaRe.map(row => row.map(() => 0))]) {
    const s = strictElementPatternsAt(fixture(), 1e9).set; mutate(s); assert.equal(fieldCorrelation(s, 7, 42).value, null);
  }
});
check("nearby field frequency never becomes a new measurement; field-only points retain their actual frequency", () => {
  const b = fixture(), p = b.results.element_patterns; p.frequencies[0] += 1; p.ports.forEach(port => port.fields[0].f += 1);
  const a = mimoAnalysis(b); assert.equal(a.rows.find(r => r.frequency === 1e9).pairs[0].eccField.value, null);
  const exact = a.rows.find(r => r.frequency === 1e9 + 1); near(exact.pairs[0].eccField.value, 0); assert.equal(exact.pairs[0].eccS.reason, "mimo.reason.exactS");
});
check("lossy, unknown efficiency and S/field disagreement warnings are independent", () => {
  const b = fixture(), ep = b.results.element_patterns;
  ep.ports[1].fields = structuredClone(ep.ports[0].fields);
  b.results.farfield = [{ port: 7, f: 1e9, rad_efficiency: .8 }];
  const p = mimoAnalysis(b).rows[0].pairs[0];
  assert.ok(p.warnings.includes("mimo.warning.lossy")); assert.ok(p.warnings.includes("mimo.warning.efficiencyUnknown")); assert.ok(p.warnings.includes("mimo.warning.disagreement"));
  near(p.eccS.value, 0); near(p.eccField.value, 1);
});
check("an invalid sample creates a gap, and new input does not retain old values", () => {
  const b = fixture(); b.results.sparams.s["1,2"].re[1] = Infinity;
  const a = mimoAnalysis(b, weightMap()); assert.deepEqual(a.rows.map(r => r.pairs[0].eccS.value), [0, null, 0]);
  const fresh = fixture(); fresh.results.sparams.complete = false; assert.equal(mimoAnalysis(fresh, weightMap()).rows.length, 0);
});
check("CSV retains exact values, unavailable reasons, physical weights and assumptions", () => {
  const a = mimoAnalysis(fixture(), weightMap()), csv = diversityCsv(a, [7, 42]);
  assert.ok(csv.includes("1000000000,P7 / P42,ECC_field,1,0,"));
  assert.ok(csv.includes("2000000000,P7 / P42,ECC_field,1,,mimo.reason.pattern"));
  assert.ok(csv.includes("P7=1+j(0); P42=1+j(0)")); assert.ok(csv.includes("CCL_S_estimate,bits/s/Hz,0"));
  assert.ok(DIVERSITY_ASSUMPTIONS.includes("not measured outage gain")); assert.ok(DIVERSITY_ASSUMPTIONS.includes("not measured channel capacity"));
});
check("UI retains sparse symbol rendering, session reset and explicit excitation labels", () => {
  const ui = readFileSync(new URL("../src/designer/ResultDiversity.tsx", import.meta.url), "utf8");
  assert.ok(ui.includes('points={[{ id: "ecc-field"')); assert.ok(ui.includes('setInputs(Object.fromEntries'));
  assert.ok(ui.includes('data-mimo-real={port}')); assert.ok(ui.includes('data-mimo-imag={port}'));
});
console.log(`MIMO: ${checks} synthetic formula/admission/export groups passed. No solver or browser.`);
