// Planar polygon helpers for fabrication output: exact union of rectilinear polygons (grid of
// breakpoints, boundary tracing), overlap tests for arbitrary polygons, areas and containment.

export type Pt = [number, number];
export type Ring = Pt[];

/** A filled area: one outer ring (counter-clockwise) and its holes (clockwise). */
export interface Region {
  outer: Ring;
  holes: Ring[];
  /** nesting depth: 0 = top level, 1 = island inside a hole of a depth-0 region, … */
  depth: number;
}

const Q = 1e6; // coordinates snapped to 1 nm (Gerber format 4.6 resolution)
export const snap = (v: number) => Math.round(v * Q) / Q;

export function area(r: Ring): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const [x0, y0] = r[i];
    const [x1, y1] = r[(i + 1) % r.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

export const regionArea = (g: Region) => Math.abs(area(g.outer)) - g.holes.reduce((s, h) => s + Math.abs(area(h)), 0);

export function bboxOf(rings: Ring[]): [number, number, number, number] {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const r of rings) for (const [x, y] of r) {
    a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y);
  }
  return [a, b, c, d];
}

export function inside(p: Pt, r: Ring): boolean {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

export const isRectilinear = (r: Ring) => r.every((p, i) => {
  const q = r[(i + 1) % r.length];
  return Math.abs(p[0] - q[0]) < 1e-9 || Math.abs(p[1] - q[1]) < 1e-9;
});

/** Remove repeated and collinear vertices. */
export function simplify(r: Ring): Ring {
  let pts = r.filter((p, i) => {
    const q = r[(i + r.length - 1) % r.length];
    return Math.abs(p[0] - q[0]) > 1e-12 || Math.abs(p[1] - q[1]) > 1e-12;
  });
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-12) {
        pts = pts.filter((_, k) => k !== i);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

/** Group rings into regions: counter-clockwise rings are outers, clockwise ones holes of the
 * smallest outer that contains them; depth = how many regions enclose the outer. */
export function toRegions(rings: Ring[]): Region[] {
  const outers = rings.filter((r) => area(r) > 0);
  const holes = rings.filter((r) => area(r) < 0);
  const regs: Region[] = outers.map((o) => ({ outer: o, holes: [], depth: 0 }));
  for (const h of holes) {
    const p = interiorPoint(h);
    let best: Region | null = null;
    for (const g of regs) if (inside(p, g.outer) && (!best || Math.abs(area(g.outer)) < Math.abs(area(best.outer)))) best = g;
    best?.holes.push(h);
  }
  for (const g of regs) {
    const p = interiorPoint(g.outer);
    // islands sit inside a hole of an enclosing region, i.e. inside its outer ring
    g.depth = regs.filter((o) => o !== g && inside(p, o.outer)).length;
  }
  return regs.sort((a, b) => a.depth - b.depth);
}

/** A point strictly inside a simple ring (midpoint of the first edge nudged inwards). */
function interiorPoint(r: Ring): Pt {
  const s = Math.sign(area(r)) || 1;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    // left normal for counter-clockwise rings points inwards
    const n: Pt = [(-(b[1] - a[1]) / len) * s, ((b[0] - a[0]) / len) * s];
    for (const eps of [1e-6, 1e-4, 1e-3]) {
      const p: Pt = [m[0] + n[0] * eps, m[1] + n[1] * eps];
      if (inside(p, r) === (s > 0)) return p;
    }
  }
  return r[0];
}

/**
 * Exact union of rectilinear polygons: breakpoint grid, cells filled by point-in-polygon tests of
 * their centres, boundary edges traced with the filled side on the left (outers counter-clockwise,
 * holes clockwise). Corner-touching cells stay separate rings (left-most turn at pinch vertices).
 */
export function rectilinearUnion(polys: Ring[]): Region[] {
  const P = polys.map((r) => r.map(([x, y]) => [snap(x), snap(y)] as Pt)).filter((r) => r.length >= 3 && Math.abs(area(r)) > 1e-12);
  if (!P.length) return [];
  const uniq = (v: number[]) => [...new Set(v)].sort((a, b) => a - b);
  const xs = uniq(P.flat().map((p) => p[0]));
  const ys = uniq(P.flat().map((p) => p[1]));
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const filled = new Uint8Array(nx * ny);
  const bbs = P.map((r) => bboxOf([r]));
  for (let i = 0; i < nx; i++) {
    const cx = (xs[i] + xs[i + 1]) / 2;
    for (let j = 0; j < ny; j++) {
      const cy = (ys[j] + ys[j + 1]) / 2;
      for (let k = 0; k < P.length; k++) {
        const b = bbs[k];
        if (cx < b[0] || cx > b[2] || cy < b[1] || cy > b[3]) continue;
        if (inside([cx, cy], P[k])) {
          filled[i * ny + j] = 1;
          break;
        }
      }
    }
  }
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && filled[i * ny + j] === 1;
  // directed edges keyed by start vertex (grid indices)
  type E = { a: [number, number]; b: [number, number]; used: boolean };
  const out = new Map<string, E[]>();
  const add = (a: [number, number], b: [number, number]) => {
    const e: E = { a, b, used: false };
    const k = `${a[0]},${a[1]}`;
    (out.get(k) ?? out.set(k, []).get(k)!).push(e);
  };
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    if (!at(i, j)) continue;
    if (!at(i, j - 1)) add([i, j], [i + 1, j]); // bottom, +x
    if (!at(i + 1, j)) add([i + 1, j], [i + 1, j + 1]); // right, +y
    if (!at(i, j + 1)) add([i + 1, j + 1], [i, j + 1]); // top, −x
    if (!at(i - 1, j)) add([i, j + 1], [i, j]); // left, −y
  }
  const rings: Ring[] = [];
  for (const list of out.values()) for (const start of list) {
    if (start.used) continue;
    const ring: [number, number][] = [];
    let e = start;
    for (let guard = 0; guard < 4 * nx * ny + 8; guard++) {
      e.used = true;
      ring.push(e.a);
      // among all edges leaving e.b take the left-most turn (the filled side stays on the left,
      // so cells that only touch at a corner end up in separate rings)
      const cands = out.get(`${e.b[0]},${e.b[1]}`) ?? [];
      const d = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
      const score = (c: E) => {
        const v = [c.b[0] - c.a[0], c.b[1] - c.a[1]];
        return Math.sign(d[0] * v[1] - d[1] * v[0]) * 2 + (d[0] * v[0] + d[1] * v[1] > 0 ? 1 : 0);
      };
      const next = [...cands].sort((p, q) => score(q) - score(p))[0];
      if (!next || next === start || next.used) break;
      e = next;
    }
    rings.push(simplify(ring.map(([i, j]) => [xs[i], ys[j]] as Pt)));
  }
  return toRegions(rings.filter((r) => r.length >= 3));
}

/** Segment intersection (proper or touching) test. */
function segHit(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  const on = (p: Pt, q: Pt, r: Pt) => Math.min(p[0], q[0]) - 1e-12 <= r[0] && r[0] <= Math.max(p[0], q[0]) + 1e-12 && Math.min(p[1], q[1]) - 1e-12 <= r[1] && r[1] <= Math.max(p[1], q[1]) + 1e-12;
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}

/** Do two simple polygons overlap or touch? */
export function overlaps(p: Ring, q: Ring): boolean {
  const [a, b, c, d] = bboxOf([p]);
  const [e, f, g, h] = bboxOf([q]);
  if (a > g || e > c || b > h || f > d) return false;
  for (let i = 0; i < p.length; i++) for (let j = 0; j < q.length; j++) if (segHit(p[i], p[(i + 1) % p.length], q[j], q[(j + 1) % q.length])) return true;
  return inside(p[0], q) || inside(q[0], p);
}

/** Counter-clockwise copy of a ring. */
export const ccw = (r: Ring): Ring => (area(r) < 0 ? [...r].reverse() : r);
