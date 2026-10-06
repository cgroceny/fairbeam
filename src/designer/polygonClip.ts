// Exact 2D Boolean operations on polygons (union, subtract, intersect) for the Boolean of extruded
// polygons and polygon sheets (booleanParts.ts). python/fairbeam/polyclip.py is the same routine,
// operation by operation (the same float arithmetic in the same order, the same tie-breaks), so a
// live result recomputed by the build is the one the designer shows: keep the two in step.
//
// Method: a vertical-strip decomposition. The x of every vertex and of every edge crossing splits
// the plane into strips in which no two edges cross; in a strip, the edges are ordered by their
// height at the strip's middle and a walk from below counts the winding of each operand (each ring
// counter-clockwise, nonzero rule, so the rings of one operand are united). The runs where the
// operation holds are trapezoids, which is exact: every boundary is a piece of an input edge.
// Trapezoids continuing along the same two lines in the next strip are merged, then pieces sharing
// one contiguous boundary chain are joined. The result is a list of simple polygons without holes
// (CSXCAD and CST polygons have none): a hole leaves its surround split into several polygons.
export type Pt = [number, number];
export type Ring = Pt[];
export type ClipMode = "union" | "subtract" | "intersect";

export const MAX_CLIP_EDGES = 2000;
const MAX_PIECES = 5000;
const MERGE_LIMIT = 400;

interface Edge { x0: number; y0: number; x1: number; y1: number; w: number; op: number; id: number; slope: number; ym: number }
interface Trap { xa: number; xb: number; yba: number; ybb: number; yta: number; ytb: number }

/** Signed area (counter-clockwise positive). */
export function ringArea(r: Ring): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

/** The tolerance of a set of rings: 1e-9 of their largest coordinate (at least 1e-9). */
export function clipTolerance(groups: Ring[][]): number {
  let scale = 1;
  for (const rings of groups) for (const r of rings) for (const p of r) scale = Math.max(scale, Math.abs(p[0]), Math.abs(p[1]));
  return 1e-9 * scale;
}

/** Without repeated and collinear points (spikes included). */
function simplify(r: Ring, eps: number): Ring {
  const pts = r.slice();
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
      const dup = Math.abs(ux) <= eps && Math.abs(uy) <= eps;
      const cross = ux * vy - uy * vx;
      const len = Math.sqrt(ux * ux + uy * uy) + Math.sqrt(vx * vx + vy * vy);
      if (dup || Math.abs(cross) <= eps * len) { pts.splice(i, 1); changed = true; break; }
    }
  }
  return pts;
}

/** A clean counter-clockwise ring, or null when it has no area. */
export function normaliseRing(r: Ring, eps: number): Ring | null {
  const pts = simplify(r, eps);
  if (pts.length < 3) return null;
  const a = ringArea(pts);
  if (Math.abs(a) <= eps * eps) return null;
  return a < 0 ? pts.reverse() : pts;
}

const yAt = (e: Edge, x: number) => x <= e.x0 ? e.y0 : x >= e.x1 ? e.y1 : e.y0 + (e.y1 - e.y0) * ((x - e.x0) / (e.x1 - e.x0));

/** The trapezoids where `mode` holds for the rings of A (op 0) and B (op 1). */
function trapezoids(A: Ring[], B: Ring[], mode: ClipMode, eps: number): Trap[] {
  const edges: Edge[] = [];
  const xs: number[] = [];
  [A, B].forEach((rings, op) => {
    for (const r of rings) {
      for (let i = 0; i < r.length; i++) {
        const p = r[i], q = r[(i + 1) % r.length];
        xs.push(p[0]);
        if (Math.abs(q[0] - p[0]) <= eps) continue; // vertical: it bounds no strip
        const up = p[0] < q[0], a = up ? p : q, b = up ? q : p;
        edges.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1], w: up ? 1 : -1, op, id: edges.length, slope: (b[1] - a[1]) / (b[0] - a[0]), ym: 0 });
      }
    }
  });
  if (edges.length > MAX_CLIP_EDGES) throw Error(`the polygons have more than ${MAX_CLIP_EDGES} edges`);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    for (let j = i + 1; j < edges.length; j++) {
      const f = edges[j];
      if (f.x0 >= e.x1 || e.x0 >= f.x1) continue;
      const dx1 = e.x1 - e.x0, dy1 = e.y1 - e.y0, dx2 = f.x1 - f.x0, dy2 = f.y1 - f.y0;
      const den = dx1 * dy2 - dy1 * dx2;
      if (den === 0) continue;
      const t = ((f.x0 - e.x0) * dy2 - (f.y0 - e.y0) * dx2) / den;
      const u = ((f.x0 - e.x0) * dy1 - (f.y0 - e.y0) * dx1) / den;
      if (t > 0 && t < 1 && u > 0 && u < 1) xs.push(e.x0 + t * dx1);
    }
  }
  xs.sort((a, b) => a - b);
  const cuts: number[] = [];
  for (const x of xs) if (!cuts.length || x - cuts[cuts.length - 1] > eps) cuts.push(x);
  const out: Trap[] = [];
  let open: Trap[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const xa = cuts[k], xb = cuts[k + 1], xm = (xa + xb) / 2;
    const act = edges.filter((e) => e.x0 < xm && e.x1 > xm);
    for (const e of act) e.ym = yAt(e, xm);
    act.sort((a, b) => a.ym - b.ym || a.slope - b.slope || a.id - b.id);
    const next: Trap[] = [];
    let wa = 0, wb = 0, inside = false, bottom: Edge | null = null, g = 0;
    while (g < act.length) {
      const y0 = act[g].ym;
      let h = g;
      while (h < act.length && act[h].ym - y0 <= eps) {
        if (act[h].op === 0) wa += act[h].w; else wb += act[h].w;
        h++;
      }
      const ina = wa !== 0, inb = wb !== 0;
      const now = mode === "union" ? ina || inb : mode === "subtract" ? ina && !inb : ina && inb;
      if (now && !inside) bottom = act[g];
      else if (!now && inside && bottom) {
        const top = act[g];
        const t: Trap = { xa, xb, yba: yAt(bottom, xa), ybb: yAt(bottom, xb), yta: yAt(top, xa), ytb: yAt(top, xb) };
        if (t.yta - t.yba > eps || t.ytb - t.ybb > eps) {
          // the same two lines on from the previous strip: one longer trapezoid
          const o = open.find((o) => Math.abs(o.ybb - t.yba) <= eps && Math.abs(o.ytb - t.yta) <= eps
            && Math.abs(o.yba + (o.ybb - o.yba) * ((t.xb - o.xa) / (o.xb - o.xa)) - t.ybb) <= eps
            && Math.abs(o.yta + (o.ytb - o.yta) * ((t.xb - o.xa) / (o.xb - o.xa)) - t.ytb) <= eps);
          if (o) { o.xb = t.xb; o.ybb = t.ybb; o.ytb = t.ytb; next.push(o); }
          else {
            out.push(t); next.push(t);
            if (out.length > MAX_PIECES) throw Error("the Boolean result is too fragmented");
          }
        }
      }
      inside = now;
      g = h;
    }
    open = next;
  }
  return out;
}

const same = (p: Pt, q: Pt, eps: number) => Math.abs(p[0] - q[0]) <= eps && Math.abs(p[1] - q[1]) <= eps;

function onBoundary(p: Pt, r: Ring, eps: number): boolean {
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = a[0] + t * dx - p[0], ey = a[1] + t * dy - p[1];
    if (ex * ex + ey * ey <= eps * eps) return true;
  }
  return false;
}

/** The one contiguous run of true flags (start, end, forward), or null. */
function run(flags: boolean[]): [number, number] | null {
  const n = flags.length;
  let count = 0, starts = 0, s = -1;
  for (let i = 0; i < n; i++) {
    if (flags[i]) count++;
    if (flags[i] && !flags[(i + n - 1) % n]) { starts++; s = i; }
  }
  if (count < 2 || count >= n || starts !== 1) return null;
  return [s, (s + count - 1) % n];
}

/** P and Q (counter-clockwise, disjoint interiors) joined along their one shared chain, or null. */
function join(P: Ring, Q: Ring, eps: number): Ring | null {
  const rp = run(P.map((p) => onBoundary(p, Q, eps)));
  if (!rp) return null;
  const rq = run(Q.map((q) => onBoundary(q, P, eps)));
  if (!rq) return null;
  // P's chain runs P[s] -> P[e]; Q meets it the other way round, Q[s'] = P[e] ... Q[e'] = P[s]
  if (!same(P[rp[0]], Q[rq[1]], eps) || !same(P[rp[1]], Q[rq[0]], eps)) return null;
  const n = P.length, m = Q.length;
  for (let k = rp[0]; k !== rp[1]; k = (k + 1) % n) {
    const a = P[k], b = P[(k + 1) % n];
    if (!onBoundary([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], Q, eps)) return null;
  }
  for (let k = rq[0]; k !== rq[1]; k = (k + 1) % m) {
    const a = Q[k], b = Q[(k + 1) % m];
    if (!onBoundary([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], P, eps)) return null;
  }
  const out: Ring = [];
  for (let k = rp[1]; ; k = (k + 1) % n) { out.push(P[k]); if (k === rp[0]) break; }
  for (let k = (rq[1] + 1) % m; k !== rq[0]; k = (k + 1) % m) out.push(Q[k]);
  return out;
}

function bounds(r: Ring): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of r) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return [x0, y0, x1, y1];
}

/**
 * A op B for rings (any orientation; the rings of one operand are united): simple
 * counter-clockwise polygons without holes, in a deterministic order. `eps`: see clipTolerance.
 */
export function clipPolygons(A: Ring[], B: Ring[], mode: ClipMode, eps = clipTolerance([A, B])): Ring[] {
  const clean = (rings: Ring[]) => rings.map((r) => normaliseRing(r, eps)).filter((r): r is Ring => !!r);
  const traps = trapezoids(clean(A), clean(B), mode, eps);
  let pieces: Ring[] = traps.map((t) => {
    const r: Ring = [[t.xa, t.yba], [t.xb, t.ybb]];
    if (t.ytb - t.ybb > eps) r.push([t.xb, t.ytb]);
    if (t.yta - t.yba > eps) r.push([t.xa, t.yta]);
    return r;
  });
  // T-junctions: the corners of the other pieces on a vertical side become points of that side,
  // so pieces meeting along a strip boundary share whole edges
  const corners = new Map<number, number[]>();
  for (const r of pieces) for (const p of r) {
    const list = corners.get(p[0]);
    if (list) list.push(p[1]); else corners.set(p[0], [p[1]]);
  }
  pieces = pieces.map((r) => {
    const out: Ring = [];
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      out.push(p);
      if (p[0] !== q[0]) continue;
      const lo = Math.min(p[1], q[1]) + eps, hi = Math.max(p[1], q[1]) - eps;
      const ys = (corners.get(p[0]) ?? []).filter((y) => y > lo && y < hi);
      ys.sort((a, b) => q[1] > p[1] ? a - b : b - a);
      let last = p[1];
      for (const y of ys) if (Math.abs(y - last) > eps) { out.push([p[0], y]); last = y; }
    }
    return out;
  });
  if (pieces.length <= MERGE_LIMIT) {
    const box = pieces.map(bounds);
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < pieces.length; i++) {
        let j = i + 1;
        while (j < pieces.length) {
          const a = box[i], b = box[j];
          const touch = a[0] <= b[2] + eps && b[0] <= a[2] + eps && a[1] <= b[3] + eps && b[1] <= a[3] + eps;
          const joined = touch ? join(pieces[i], pieces[j], eps) : null;
          if (joined) {
            pieces[i] = joined; box[i] = bounds(joined);
            pieces.splice(j, 1); box.splice(j, 1);
            changed = true; j = i + 1;
          } else j++;
        }
      }
    }
  }
  return pieces.map((r) => normaliseRing(r, eps)).filter((r): r is Ring => !!r);
}
