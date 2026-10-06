/** Convert complex sheet-current vectors to their magnitude at a phase in degrees. */
export function instantaneousMagnitude(values: ArrayLike<number>, phasors: ArrayLike<number>, phaseDeg: number): Float32Array {
  const count = values.length;
  const out = new Float32Array(count);
  const angle = phaseDeg * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  for (let i = 0; i < count; i++) {
    if (values[i] < 0) { out[i] = -1; continue; }
    const j = i * 4;
    const m0 = Math.hypot((phasors[j] * c - phasors[j + 1] * s), (phasors[j + 2] * c - phasors[j + 3] * s));
    const m = m0 < 1e-12 ? 0 : m0;
    // Components are quantised against one fixed phasor peak, not the peak of this frame.
    out[i] = Math.min(1000, m * 1000 / 127);
  }
  return out;
}

/** Bilinear upsample; invalid (-1) source cells are excluded and never contribute across mask edges. */
export function smoothCurrentMap(values: ArrayLike<number>, width: number, height: number, scale = 2): Float32Array {
  const ow = width * scale, oh = height * scale, out = new Float32Array(ow * oh);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    // Preserve the exact source-cell mask; smoothing only changes colours inside metal.
    if (values[Math.floor(y / scale) * width + Math.floor(x / scale)] < 0) {
      out[y * ow + x] = -1;
      continue;
    }
    const sx = Math.max(0, Math.min(width - 1, (x + 0.5) / scale - 0.5));
    const sy = Math.max(0, Math.min(height - 1, (y + 0.5) / scale - 0.5));
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
    const fx = sx - x0, fy = sy - y0;
    let sum = 0, weight = 0;
    const i00 = y0 * width + x0, i10 = y0 * width + x1;
    const i01 = y1 * width + x0, i11 = y1 * width + x1;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy, w11 = fx * fy;
    if (values[i00] >= 0) { sum += values[i00] * w00; weight += w00; }
    if (values[i10] >= 0) { sum += values[i10] * w10; weight += w10; }
    if (values[i01] >= 0) { sum += values[i01] * w01; weight += w01; }
    if (values[i11] >= 0) { sum += values[i11] * w11; weight += w11; }
    out[y * ow + x] = weight ? sum / weight : -1;
  }
  return out;
}

/**
 * Give each transparent texel next to the metal the colour of an opaque neighbour (alpha stays 0).
 * Linear filtering blends colour and alpha across the mask edge; with black transparent texels the
 * edge fragments that pass alphaTest came out darkened, a dark rim around every hole or inner corner.
 * The mask itself does not move: alpha, and so the alphaTest cut, is unchanged.
 */
export function padMaskEdge(data: Uint8Array, w: number, h: number): void {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (data[i + 3]) continue;
    const from = (x > 0 && data[i - 1] === 255) ? i - 4
      : (x < w - 1 && data[i + 7] === 255) ? i + 4
      : (y > 0 && data[i - w * 4 + 3] === 255) ? i - w * 4
      : (y < h - 1 && data[i + w * 4 + 3] === 255) ? i + w * 4 : -1;
    if (from >= 0) { data[i] = data[from]; data[i + 1] = data[from + 1]; data[i + 2] = data[from + 2]; }
  }
}
