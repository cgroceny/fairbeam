import * as THREE from "three";
import type { Vec3 } from "../types";

/**
 * Port and lumped-element glyphs for the 3D view.
 *
 * A feed is usually a tiny gap (a dipole's is ~1 mm in a 150 mm scene) buried between two metal
 * arms, so a world-sized, depth-tested line disappears. These glyphs are sized in screen pixels
 * (with the model size as a lower bound), and every part is drawn twice: a solid pass that is
 * occluded like the model, and a translucent x-ray pass that ignores the depth buffer so the port
 * is still readable inside metal or a dielectric. Geometries are shared; the only per-frame work is
 * `userData.update(worldPerPixel)`, which rescales a handful of meshes.
 */

export interface PortGlyphData {
  /** rescale for the current view: `worldPerPixel` at the glyph's distance from the camera */
  update: (worldPerPixel: number) => void;
  /** stronger look for a selected port; `color` replaces the base colour */
  setHighlight: (on: boolean, color?: string) => void;
  /** world position the CSS2D label sits at (kept current by update) */
  labelAnchor: THREE.Vector3;
  kind: "lumped" | "waveguide" | "element";
}
export type PortGlyph = THREE.Group & { userData: PortGlyphData };

type Shared = { cyl: THREE.BufferGeometry; cone: THREE.BufferGeometry; sphere: THREE.BufferGeometry; box: THREE.BufferGeometry; boxEdges: THREE.BufferGeometry };
// Shared unit geometries, oriented along +Z so a glyph only scales them. Never mutated.
let shared: Shared | null = null;
function unit(): Shared {
  if (!shared) {
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 14);
    cyl.rotateX(Math.PI / 2);
    const cone = new THREE.ConeGeometry(1, 1, 16);
    cone.rotateX(Math.PI / 2);
    const box = new THREE.BoxGeometry(1, 1, 1);
    shared = { cyl, cone, sphere: new THREE.SphereGeometry(1, 14, 10), box, boxEdges: new THREE.EdgesGeometry(box) };
  }
  return shared;
}

interface Look { solid: THREE.MeshBasicMaterial; xray: THREE.MeshBasicMaterial; line: THREE.LineBasicMaterial; fill: THREE.MeshBasicMaterial }
function looks(color: string): Look {
  return {
    solid: new THREE.MeshBasicMaterial({ color }),
    // the x-ray pass: on top of the model, translucent so it never hides what it marks
    xray: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false }),
    line: new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }),
    fill: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
  };
}
function applyHighlight(l: Look, on: boolean, base: string, hl?: string) {
  const c = on ? hl ?? base : base;
  l.solid.color.set(c); l.xray.color.set(c); l.line.color.set(c); l.fill.color.set(c);
  l.xray.opacity = on ? 0.9 : 0.55;
  l.fill.opacity = on ? 0.4 : 0.2;
}

const Z = new THREE.Vector3(0, 0, 1);
const AX = ["x", "y", "z"] as const;
const UNIT_AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
/** Turn a +Z unit mesh onto axis n, pointing along `dir`. */
const orient = (o: THREE.Object3D, n: number, dir: 1 | -1) => {
  o.quaternion.setFromUnitVectors(Z, UNIT_AXES[n].clone().multiplyScalar(dir));
};
const sgn = (x: number): 1 | -1 => (x < 0 ? -1 : 1);

/** Tail ball + shaft + arrowhead, each drawn solid and x-ray, from shared unit meshes. */
function arrowParts(group: THREE.Group, l: Look) {
  const u = unit();
  const pair = (geo: THREE.BufferGeometry): [THREE.Mesh, THREE.Mesh] => {
    const solid = new THREE.Mesh(geo, l.solid);
    const xray = new THREE.Mesh(geo, l.xray);
    solid.renderOrder = 59;
    xray.renderOrder = 60;
    group.add(solid, xray);
    return [solid, xray];
  };
  const shaft = pair(u.cyl), head = pair(u.cone), tail = pair(u.sphere);
  return {
    /** ball at `from`, tip at `to`, along axis n; all sizes in world units */
    place(from: THREE.Vector3, to: THREE.Vector3, n: number, dir: 1 | -1, shaftR: number, headR: number, headLen: number, ballR: number) {
      const len = Math.max(Math.abs(to.getComponent(n) - from.getComponent(n)), 1e-9);
      const mid = from.clone().add(to).multiplyScalar(0.5);
      const hl = Math.min(headLen, len);
      const hp = to.clone();
      hp.setComponent(n, to.getComponent(n) - dir * hl / 2);
      for (const m of shaft) { m.position.copy(mid); m.scale.set(shaftR, shaftR, len); orient(m, n, dir); }
      for (const m of head) { m.position.copy(hp); m.scale.set(headR, headR, hl); orient(m, n, dir); }
      for (const m of tail) { m.position.copy(from); m.scale.setScalar(ballR); }
    },
  };
}

function extents(start: Vec3, stop: Vec3) {
  const lo = [0, 1, 2].map((i) => Math.min(start[i], stop[i]));
  const hi = [0, 1, 2].map((i) => Math.max(start[i], stop[i]));
  return { ext: [0, 1, 2].map((i) => hi[i] - lo[i]), mid: [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2) };
}
const axisOf = (direction: "x" | "y" | "z" | undefined, ext: number[]) => {
  const n = direction ? AX.indexOf(direction) : -1;
  return n >= 0 ? n : ext.indexOf(Math.max(...ext));
};

/**
 * Discrete (lumped) port: a red line from start to stop with a ball at the start and an arrowhead
 * at the stop (the reference direction), plus a translucent block with an outline when the port
 * spans an area (a strip feed). `minRadius` is the model-size lower bound; on screen the line is at
 * least ~3 px wide, the ball ~8 px and the head ~11 px across.
 */
export function portObject(start: Vec3, stop: Vec3, color: string, minRadius: number, direction?: "x" | "y" | "z"): PortGlyph {
  const g = new THREE.Group() as PortGlyph;
  const b = extents(start, stop);
  const n = axisOf(direction, b.ext);
  const dir = sgn(stop[n] - start[n]);
  const l = looks(color);
  const arrow = arrowParts(g, l);
  const fill = new THREE.Mesh(unit().box, l.fill);
  fill.renderOrder = 58;
  const outline = new THREE.LineSegments(unit().boxEdges, l.line);
  outline.renderOrder = 61;
  g.add(fill, outline);
  const mid = new THREE.Vector3(...(b.mid as Vec3));
  const labelAnchor = mid.clone();
  let boost = 1;
  const update = (wpp: number) => {
    const px = (k: number) => k * wpp * boost;
    const half = Math.max(b.ext[n], px(14)) / 2;
    const from = mid.clone(); from.setComponent(n, mid.getComponent(n) - dir * half);
    const to = mid.clone(); to.setComponent(n, mid.getComponent(n) + dir * half);
    arrow.place(from, to, n, dir, Math.max(minRadius * 0.4, px(1.6)), Math.max(minRadius, px(5.5)), Math.max(minRadius * 2.4, px(13)), Math.max(minRadius * 0.9, px(4)));
    // an area port: a translucent block over its true footprint, never thinner than a few pixels
    const size = [0, 1, 2].map((i) => Math.max(b.ext[i], i === n ? px(14) : px(3)));
    const spans = [0, 1, 2].some((i) => i !== n && b.ext[i] > px(2));
    for (const m of [fill, outline]) { m.visible = spans; m.position.copy(mid); m.scale.set(size[0], size[1], size[2]); }
    labelAnchor.copy(to);
    labelAnchor.z += px(12);
  };
  g.userData = {
    update,
    setHighlight(on, hl) { boost = on ? 1.5 : 1; applyHighlight(l, on, color, hl); },
    labelAnchor,
    kind: "lumped",
  };
  update(minRadius / 2);
  return g;
}

/**
 * Waveguide port: the excitation plane (start) as a translucent sheet with an always-visible
 * outline, the probe plane (stop) as a dashed outline, and a direction arrow through the middle.
 */
export function waveguidePortObject(start: Vec3, stop: Vec3, direction: "x" | "y" | "z", color: string, minRadius: number): PortGlyph {
  const g = new THREE.Group() as PortGlyph;
  const n = AX.indexOf(direction);
  const u = (n + 1) % 3, v = (n + 2) % 3;
  const du = Math.abs(stop[u] - start[u]), dv = Math.abs(stop[v] - start[v]);
  const cu = (start[u] + stop[u]) / 2, cv = (start[v] + stop[v]) / 2;
  const l = looks(color);
  const quad = (w: number) => {
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => {
      const p = [0, 0, 0];
      p[u] = cu + (a * du) / 2; p[v] = cv + (c * dv) / 2; p[n] = w;
      return p;
    });
    const sheet = new THREE.BufferGeometry();
    sheet.setAttribute("position", new THREE.Float32BufferAttribute(pts.flat(), 3));
    sheet.setIndex([0, 1, 2, 0, 2, 3]);
    const edges = new THREE.BufferGeometry();
    edges.setAttribute("position", new THREE.Float32BufferAttribute([0, 1, 1, 2, 2, 3, 3, 0].flatMap((i) => pts[i]), 3));
    return { sheet, edges };
  };
  const exc = quad(start[n]);
  const sheet = new THREE.Mesh(exc.sheet, l.fill);
  sheet.renderOrder = 58;
  const o1 = new THREE.LineSegments(exc.edges, l.line);
  o1.renderOrder = 61;
  g.add(sheet, o1);
  if (Math.abs(stop[n] - start[n]) > 1e-9) {
    const probe = quad(stop[n]);
    const m = Math.min(du, dv);
    const o2 = new THREE.LineSegments(probe.edges, new THREE.LineDashedMaterial({ color, dashSize: m / 24, gapSize: m / 36, depthTest: false }));
    o2.computeLineDistances();
    o2.renderOrder = 61;
    g.add(o2);
  }
  const arrow = arrowParts(g, l);
  const dir = sgn(stop[n] - start[n]);
  const c = new THREE.Vector3();
  c.setComponent(u, cu); c.setComponent(v, cv); c.setComponent(n, start[n]);
  const labelAnchor = c.clone();
  labelAnchor.setComponent(n, stop[n]);
  let boost = 1;
  const update = (wpp: number) => {
    const px = (k: number) => k * wpp * boost;
    const len = Math.max(Math.abs(stop[n] - start[n]), 0.25 * Math.min(du, dv), px(24));
    const to = c.clone();
    to.setComponent(n, c.getComponent(n) + dir * len);
    arrow.place(c, to, n, dir, Math.max(minRadius * 0.4, px(1.6)), Math.max(minRadius * 2, px(6)), Math.max(len * 0.3, px(14)), Math.max(minRadius, px(4)));
  };
  g.userData = {
    update,
    setHighlight(on, hl) { boost = on ? 1.5 : 1; applyHighlight(l, on, color, hl); },
    labelAnchor,
    kind: "waveguide",
  };
  update(minRadius / 2);
  return g;
}

/**
 * Lumped R/L/C element (not a port): a dark body over its footprint plus an amber zig-zag along the
 * current direction, drawn through the metal, so it reads as a component and never as a red port.
 */
export function lumpedObject(start: Vec3, stop: Vec3, color: string, minT: number, accent: string, direction?: "x" | "y" | "z"): PortGlyph {
  const g = new THREE.Group() as PortGlyph;
  const b = extents(start, stop);
  const n = axisOf(direction, b.ext);
  const body = new THREE.Mesh(unit().box, new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  const lineMat = new THREE.LineBasicMaterial({ color: accent, depthTest: false, transparent: true, opacity: 0.95 });
  // unit zig-zag along local +Z (-0.5..0.5)
  const zig = new THREE.Line(new THREE.BufferGeometry(), lineMat);
  zig.geometry.setAttribute("position", new THREE.Float32BufferAttribute(
    [[0, 0, -0.5], [0, 0, -0.3], [0.35, 0, -0.2], [-0.35, 0, 0], [0.35, 0, 0.2], [0, 0, 0.3], [0, 0, 0.5]].flat(), 3));
  zig.renderOrder = 61;
  const out = new THREE.LineSegments(unit().boxEdges, lineMat);
  out.renderOrder = 61;
  g.add(body, zig, out);
  const mid = new THREE.Vector3(...(b.mid as Vec3));
  const labelAnchor = mid.clone();
  let boost = 1;
  const update = (wpp: number) => {
    const px = (k: number) => k * wpp * boost;
    const size = [0, 1, 2].map((i) => Math.max(b.ext[i], i === n ? px(14) : px(6), minT));
    body.position.copy(mid); body.scale.set(size[0], size[1], size[2]);
    out.position.copy(mid); out.scale.copy(body.scale);
    const w = Math.max(px(6), ...size.filter((_, i) => i !== n));
    zig.position.copy(mid);
    zig.scale.set(w, w, size[n]);
    orient(zig, n, 1);
    labelAnchor.set(mid.x, mid.y, mid.z + size[2] / 2 + px(10));
  };
  g.userData = {
    update,
    setHighlight(on, hl) { boost = on ? 1.4 : 1; lineMat.color.set(on ? hl ?? accent : accent); },
    labelAnchor,
    kind: "element",
  };
  update(minT / 4);
  return g;
}

/** Rescale every glyph under `root` for the current camera; call once per frame before rendering. */
export function updatePortGlyphs(root: THREE.Object3D, camera: THREE.PerspectiveCamera, viewportHeightPx: number) {
  const k = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(1, viewportHeightPx);
  for (const child of root.children) {
    const data = child.userData as Partial<PortGlyphData>;
    if (typeof data.update !== "function" || !data.labelAnchor) continue;
    data.update(Math.max(camera.position.distanceTo(data.labelAnchor), 1e-6) * k);
  }
}
