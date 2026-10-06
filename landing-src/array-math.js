// Beam steering of the 4 × 1 patch array from its embedded element patterns (media/array-story.json),
// the same math as src/lib/array.ts: E = Σ w_n E_n, D = 4π U / P_rad, active Γ_n = Σ_m S_nm w_m / w_n.

const C0 = 299_792_458;

function decode(text, scale) {
  const bin = atob(text);
  const out = new Float32Array(bin.length / 2);
  const k = scale / 32767;
  for (let i = 0; i < out.length; i++) {
    let q = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (q > 32767) q -= 65536;
    out[i] = q * k;
  }
  return out;
}

export function arrayModel(data) {
  const nt = data.theta.length, np = data.phi.length;
  const ports = data.ports.map((p) => {
    const [tr, ti, pr, pi] = p.e.map((t) => decode(t, p.scale));
    return { port: p.port, position: p.position, tr, ti, pr, pi };
  });
  // solid angle of each grid cell: θ rings between midpoints, φ evenly spaced over 360°
  const rad = Math.PI / 180;
  const wt = data.theta.map((t, i) => {
    const lo = i === 0 ? 0 : ((data.theta[i - 1] + t) / 2) * rad;
    const hi = i === nt - 1 ? Math.PI : ((t + data.theta[i + 1]) / 2) * rad;
    return Math.cos(lo) - Math.cos(hi);
  });
  const wp = (2 * Math.PI) / np;
  const k = (2 * Math.PI * data.f) / C0;
  const U = new Float32Array(nt * np);

  /** complex weights [re, im] per port that steer to θ0 (signed, in the yz plane) */
  function steering(theta0) {
    const t = Math.abs(theta0) * rad, p = (theta0 < 0 ? 270 : 90) * rad;
    const u = [Math.sin(t) * Math.cos(p), Math.sin(t) * Math.sin(p), Math.cos(t)];
    const r0 = ports[0].position;
    return ports.map(({ position: r }) => {
      const ph = -k * 1e-3 * ((r[0] - r0[0]) * u[0] + (r[1] - r0[1]) * u[1] + (r[2] - r0[2]) * u[2]);
      return [Math.cos(ph), Math.sin(ph)];
    });
  }

  /** directivity in dBi on the grid (row-major [θ][φ]) for the weights, plus the main beam */
  function pattern(w, out = new Float32Array(nt * np)) {
    let prad = 0;
    for (let i = 0; i < nt; i++) {
      for (let j = 0; j < np; j++) {
        const q = i * np + j;
        let tr = 0, ti = 0, pr = 0, pi = 0;
        for (let n = 0; n < ports.length; n++) {
          const [a, b] = w[n];
          if (a === 0 && b === 0) continue;
          const e = ports[n];
          tr += a * e.tr[q] - b * e.ti[q]; ti += a * e.ti[q] + b * e.tr[q];
          pr += a * e.pr[q] - b * e.pi[q]; pi += a * e.pi[q] + b * e.pr[q];
        }
        U[q] = tr * tr + ti * ti + pr * pr + pi * pi;
        prad += U[q] * wt[i] * wp;
      }
    }
    let best = 0;
    for (let q = 0; q < U.length; q++) {
      out[q] = 10 * Math.log10(Math.max(1e-12, (4 * Math.PI * U[q]) / prad));
      if (out[q] > out[best]) best = q;
    }
    const bi = Math.floor(best / np), bj = best % np;
    const phiB = data.phi[bj];
    // signed angle in the scan plane: negative towards −y
    const thetaB = data.theta[bi] * (phiB > 180 ? -1 : 1);
    return { d: out, dmax: out[best], beam: thetaB };
  }

  /** active reflection per port in dB */
  function activeGamma(w) {
    return ports.map((_, n) => {
      let re = 0, im = 0;
      for (let m = 0; m < ports.length; m++) {
        const [sr, si] = data.s[n][m], [a, b] = w[m];
        re += sr * a - si * b; im += sr * b + si * a;
      }
      const [a, b] = w[n];
      const den = a * a + b * b;
      if (den === 0) return null;
      const gr = (re * a + im * b) / den, gi = (im * a - re * b) / den;
      return 10 * Math.log10(Math.max(1e-30, gr * gr + gi * gi));
    });
  }

  return { nt, np, ports, steering, pattern, activeGamma };
}
