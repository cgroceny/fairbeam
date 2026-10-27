// Independent analytical RLC input for software/UI controls. No new EM propagation evidence.
import { readFileSync } from 'node:fs';
const base = JSON.parse(readFileSync(new URL('../../examples/synthetic/array2x1.json', import.meta.url), 'utf8'));

export function smallAntennaFixture({ f0 = 1e9, q = 20, scale = 1, multiple = false, name = 'Synthetic small-antenna RLC control' } = {}) {
  const bundle = structuredClone(base), resistance = 50, w0 = 2 * Math.PI * f0;
  const inductance = q * resistance / w0, capacitance = 1 / (w0 * w0 * inductance);
  const f = Array.from({ length: 501 }, (_, i) => f0 * (0.9 + i * 0.0004));
  f[250] = f0;
  const re = f.map(() => resistance), im = f.map(value => 2 * Math.PI * value * inductance - 1 / (2 * Math.PI * value * capacitance));
  im[250] = 0;
  if (multiple) {
    f[150] = f0 * 0.96; f[350] = f0 * 1.04;
    f.forEach((value, i) => { im[i] = 1e5 * (value / f0 - 0.96) * (value / f0 - 1.04); });
    im[150] = im[350] = 0;
  }
  const gammaRe = im.map(x => x * x / (4 * resistance * resistance + x * x));
  const gammaIm = im.map(x => 2 * resistance * x / (4 * resistance * resistance + x * x));
  const part = (name, lo, hi) => ({ name, label: name, type: 'Metal', bbox: [lo, hi],
    primitives: [{ kind: 'box', start: lo, stop: hi, priority: 1, bbox: [lo, hi], exact: true }] });
  bundle.name = bundle.model.name = name;
  bundle.model.description = 'Analytical series RLC and artificial bounds/power samples; UI software control only.';
  bundle.model.params = [];
  bundle.units = { length: 'mm', length_m: 1e-3, frequency: 'Hz' };
  bundle.parts = [part('Radiator, "A"', [0, 0, 0], [3 * scale, 4 * scale, 0]),
    part('Finite ground', [-4 * scale, -5 * scale, -0.1 * scale], [4 * scale, 5 * scale, 0]),
    { ...part('Vacuum carver', [0, 0, 0], [1, 1, 1]), void: true }];
  bundle.ports = [{ number: 7, type: 'lumped', R: resistance, excite: true, direction: 'x', start: [1, 2, 0], stop: [2, 2, 0] }];
  bundle.half_space = null;
  bundle.solver.boundaries = { 'x-': 'PML_8', 'x+': 'PML_8', 'y-': 'PML_8', 'y+': 'PML_8', 'z-': 'PML_8', 'z+': 'PML_8' };
  bundle.solver.excitation = { type: 'gaussian', f_min: f[0], f_max: f.at(-1), dc_free: false };
  bundle.run = { ...(bundle.run ?? {}), engine: 'cpu', engine_requested: 'cpu', timesteps: 1000, excitation_timesteps: 100, solver_time_s: 0,
    final_energy_db: -60, hit_timestep_limit: false, converged: true, threads: 1,
    energy_trace: [], host: { os: 'Synthetic', machine: 'Software control', cpu: null }, log_tail: ['Synthetic RLC fixture; no solver run.'] };
  delete bundle.run.final_energy_bound_db;
  bundle.results = { frequency: f, ports: { '7': { s11_re: gammaRe, s11_im: gammaIm, zin_re: re, zin_im: im, z_ref: resistance } },
    bands: [], farfield: [], signals: {}, efficiency: [{ port: 7, f: [f0], prad_w: [0.8], pacc_w: [1], rad_efficiency: [0.8],
      mirror_planes: 0, theta_step: 5, phi_step: 5, reliable: [true], pacc_error: [0], qa_warnings: [] }] };
  return bundle;
}

/** RFC-style quoted cells for both Copy TSV and CSV, including embedded delimiters/newlines. */
export function parseDelimited(text, separator = ',') {
  const rows = [], row = []; let value = '', quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && char === separator) { row.push(value); value = ''; }
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(value); rows.push([...row]); row.length = 0; value = '';
    } else value += char;
  }
  if (value || row.length) { row.push(value); rows.push([...row]); }
  return rows;
}
