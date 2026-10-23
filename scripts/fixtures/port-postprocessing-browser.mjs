// Explicitly synthetic browser fixture; this module is pure and can be validated without launching a browser.
export const PORT_CONTROL_DELAYS = [31, 77, -18];
const delays = PORT_CONTROL_DELAYS;
export function portProcessingBrowserFixture(geometry, circuit) {
  const b = structuredClone(geometry), f = circuit.frequency_hz, s = {};
  b.name = b.model.name = 'Synthetic ideal circuit control, not an EM run';
  b.created = '2026-10-24T00:00:00Z'; b.run = null;
  b.model.params = b.model.params.filter(p => p.name !== 'reference_impedance');
  b.ports = circuit.physical_ports.map((number, i) => ({ ...b.ports[i], number, excite: i === 0, type: 'lumped', R: circuit.source_references_ohm[i] }));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const v = { re: [], im: [] };
    f.forEach((frequency, k) => {
      const [re, im] = circuit.source[k][i][j], phase = -2 * Math.PI * frequency * (delays[i] + delays[j]) * 1e-12;
      v.re.push(re * Math.cos(phase) - im * Math.sin(phase));
      v.im.push(re * Math.sin(phase) + im * Math.cos(phase));
    }); s[`${i + 1},${j + 1}`] = v;
  }
  // No measured/historical scalar, power or radiation array is borrowed from the geometry.
  b.results = { frequency: f, farfield: [], bands: [], signals: {},
    ports: Object.fromEntries(circuit.physical_ports.map((id, i) => [id, {
      z_ref: circuit.source_references_ohm[i], s11_re: s[`${i + 1},${i + 1}`].re, s11_im: s[`${i + 1},${i + 1}`].im,
      zin_re: f.map(() => 0), zin_im: f.map(() => 0),
    }])), sparams: { ports: [1, 2, 3], port_numbers: circuit.physical_ports, z_ref: circuit.source_references_ohm,
      excited: [1, 2, 3], complete: true, method: 'synthetic independent nodal circuit control', s, qa: {} } };
  return b;
}
