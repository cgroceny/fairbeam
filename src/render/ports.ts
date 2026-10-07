// Ports in a render: a small procedural SMA connector, a red marker bead/rod, a waveguide flange
// outline and a surface-mount body for lumped elements. Everything is built from simple primitives
// at real SMA dimensions (millimetres), scaled to the drawing unit of the design.
//
// Two halves: the placement math (plain numbers, no three.js objects: where does a connector fit and
// which way does it point?) and the geometry builders. scripts/check-render.mjs tests both.
import * as THREE from "three";
import type { LumpedElement, Port } from "../types";
import { MATERIAL_LOOKS, type MaterialClass } from "./materials.ts";
import type { RenderPorts } from "./options.ts";

export type V3 = [number, number, number];
export type PortInput = Pick<Port, "number" | "type" | "direction" | "start" | "stop">;
/** A drawn solid reduced to its bounding box and whether it conducts. */
export interface Solid { name: string; kind: "metal" | "dielectric"; min: V3; max: V3 }

/** A real SMA jack, in millimetres (the connector is built along +Z, the mating end pointing out): a
 *  4-hole square flange, a hex nut on the flange, a hollow barrel with its PTFE insert and the centre
 *  pin. The Blender renderer (python/fairbeam/blender_render.py, SMA) draws the same jack with the same
 *  numbers, so both engines show one connector style. */
export const SMA_MM = {
  /** hex nut across the flats, and its length */
  hex: 6.35,
  nut: 2.6,
  /** the square mounting flange: side, thickness, hole diameter and hole pitch (centre to centre) */
  flangeSize: 12.7,
  flange: 1.6,
  holeD: 2.2,
  holePitch: 9.5,
  /** threaded barrel, outside diameter, and the bore inside it (the outer conductor's inner diameter) */
  barrel: 5.4,
  bore: 4.3,
  barrelLength: 6.4,
  /** flange + nut + barrel */
  length: 10.6,
  /** the PTFE insert: its length, and how far short of the barrel's mouth it stops */
  ptfeLength: 4.4,
  recess: 0.6,
  /** the pin reaches the barrel's mouth: this much past the PTFE face */
  pinStub: 0.6,
  pin: 1.27,
  /** how far the pin lies on an edge-launch trace */
  reach: 1.8,
  /** clear space needed beyond a ground plane, round the axis: the barrel plus a margin */
  clearance: 12,
} as const;

const AXIS: Record<"x" | "y" | "z", 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

export interface SmaPlacement {
  mount: "edge" | "bottom";
  port: number;
  /** where the centre pin's axis crosses the mounting plane (the board edge, or the ground plane's outer face) */
  origin: V3;
  /** unit vector pointing away from the board, along the connector */
  axis: V3;
  /** unit vector perpendicular to the axis that the hex flats are parallel to (the board's normal) */
  flats: V3;
  /** drawing units the centre pin runs back from the mounting plane towards the feed point */
  pinLength: number;
  /** the dielectric the connector sits on, when there is one */
  board?: string;
}

const size = (s: Solid, k: number) => s.max[k] - s.min[k];
const unitVec = (k: number, sign: number): V3 => { const v: V3 = [0, 0, 0]; v[k] = sign; return v; };
const contains = (s: Solid, p: V3, tol: number) => [0, 1, 2].every((k) => p[k] >= s.min[k] - tol && p[k] <= s.max[k] + tol);

/** Thin along axis k: a sheet or a plane, not a block. */
function thinAlong(s: Solid, k: number): boolean {
  const others = [0, 1, 2].filter((i) => i !== k).map((i) => size(s, i));
  return size(s, k) <= 0.35 * Math.min(...others) + 1e-9;
}
const planArea = (s: Solid, k: number) => [0, 1, 2].filter((i) => i !== k).reduce((a, i) => a * size(s, i), 1);

/**
 * Where an SMA fits on a lumped port, or null (the caller then draws the marker).
 *
 * A connector fits a port that feeds through a board: the port axis k is the board's thin direction,
 * and one end of it sits on a ground plane (the larger of the metal sheets at its two ends). Then:
 *  - near a board edge (within a few millimetres or 3 % of the board): an edge-launch connector
 *    pointing out of that edge, its pin lying on the trace end of the port;
 *  - otherwise, with free space beyond the ground plane: a bottom-mount connector under the ground
 *    plane (a probe feed), its pin running up the port to the feed point.
 * Anything else (a dipole's gap in free air, a port between two traces, a connector that would be
 * larger than the board) gets no connector.
 *
 * @param unitMm millimetres per drawing unit
 */
export function placeSma(port: PortInput, solids: readonly Solid[], unitMm = 1): SmaPlacement | null {
  if (port.type !== "lumped") return null;
  const k = AXIS[port.direction];
  const c: V3 = [0, 1, 2].map((i) => (port.start[i] + port.stop[i]) / 2) as V3;
  const k0 = Math.min(port.start[k], port.stop[k]), k1 = Math.max(port.start[k], port.stop[k]);
  const mm = (v: number) => v / unitMm; // millimetres -> drawing units
  if (k1 - k0 < 1e-12) return null;
  const tol = Math.max(mm(0.05), 1e-9);
  const pinR = mm(SMA_MM.pin / 2);
  const hex = mm(SMA_MM.hex);
  const flange = mm(SMA_MM.flangeSize);

  // the metal at each end of the port (a point on its sheet), the larger one is the ground plane
  const end = (value: number): Solid | undefined => {
    const p = [...c] as V3; p[k] = value;
    return solids.filter((s) => s.kind === "metal" && thinAlong(s, k) && contains(s, p, tol))
      .sort((a, b) => planArea(b, k) - planArea(a, k))[0];
  };
  const low = end(k0), high = end(k1);
  if (!low && !high) return null;
  const lowArea = low ? planArea(low, k) : 0, highArea = high ? planArea(high, k) : 0;
  const groundLow = lowArea >= highArea;
  const ground = groundLow ? low! : high!;
  const groundAt = groundLow ? k0 : k1;
  const traceAt = groundLow ? k1 : k0;
  const outward = groundLow ? -1 : 1; // away from the port, through the ground plane's outer face
  const [u, v] = [0, 1, 2].filter((i) => i !== k);

  // the board: a dielectric sheet this port passes through
  const board = solids.filter((s) => s.kind === "dielectric" && thinAlong(s, k) && contains(s, c, tol * 2)
    && s.min[k] <= k1 + tol && s.max[k] >= k0 - tol).sort((a, b) => planArea(a, k) - planArea(b, k))[0];

  if (board) {
    const edgeTol = Math.max(mm(2), 0.03 * Math.max(size(board, u), size(board, v)));
    const faces: { axis: number; sign: -1 | 1; d: number }[] = [
      { axis: u, sign: -1, d: c[u] - board.min[u] }, { axis: u, sign: 1, d: board.max[u] - c[u] },
      { axis: v, sign: -1, d: c[v] - board.min[v] }, { axis: v, sign: 1, d: board.max[v] - c[v] },
    ];
    const near = faces.sort((a, b) => a.d - b.d)[0];
    // an edge launch needs both conductors: the trace at one end of the port, the ground at the other
    if (near.d <= edgeTol && low && high) {
      const across = [u, v].find((i) => i !== near.axis)!; // the board's width at the edge
      if (hex > 1.1 * size(board, across)) return null;
      const origin = [...c] as V3;
      origin[near.axis] = near.sign < 0 ? board.min[near.axis] : board.max[near.axis];
      // the pin lies on the trace, on the side of the board the trace is on
      const traceSign = groundLow ? 1 : -1;
      origin[k] = traceAt + traceSign * pinR;
      const depth = size(board, near.axis);
      return {
        mount: "edge", port: port.number, origin, axis: unitVec(near.axis, near.sign), flats: unitVec(k, 1),
        pinLength: Math.min(mm(SMA_MM.reach), depth / 2), board: board.name,
      };
    }
  }

  // bottom mount: free space beyond the ground plane, and a connector no larger than the plane
  if (flange * 0.9 > Math.min(size(ground, u), size(ground, v))) return null;
  const reach = mm(SMA_MM.clearance);
  const lo = groundAt + (outward < 0 ? -reach : 0), hi = groundAt + (outward < 0 ? 0 : reach);
  const half = flange * 0.5;
  const blocked = solids.some((s) => s !== ground && s.min[k] < hi - tol && s.max[k] > lo + tol
    && s.min[u] < c[u] + half && s.max[u] > c[u] - half && s.min[v] < c[v] + half && s.max[v] > c[v] - half);
  if (blocked) return null;
  const origin = [...c] as V3; origin[k] = groundAt;
  return { mount: "bottom", port: port.number, origin, axis: unitVec(k, outward), flats: unitVec(u, 1), pinLength: k1 - k0, board: board?.name };
}

// ---------------------------------------------------------------- geometry

export type MaterialFactory = (id: MaterialClass) => THREE.Material;

/** A cylinder along +Z from z0 to z1. */
function rod(radius: number, z0: number, z1: number, segments = 32): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, z1 - z0, segments, 1);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, (z0 + z1) / 2);
  return g;
}
/** A hexagonal prism along +Z, `across` flats: vertices on the Y axis, the flats face +-X. */
function hexPrism(across: number, z0: number, z1: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(across / Math.sqrt(3), across / Math.sqrt(3), z1 - z0, 6, 1);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, (z0 + z1) / 2);
  return g;
}
/** A tube along +Z. */
function tube(inner: number, outer: number, z0: number, z1: number, segments = 48): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry([new THREE.Vector2(inner, z0), new THREE.Vector2(outer, z0), new THREE.Vector2(outer, z1), new THREE.Vector2(inner, z1), new THREE.Vector2(inner, z0)], segments);
  g.rotateX(Math.PI / 2);
  return g;
}

/** Local frame with Z along `axis` and X along `flats`, as a quaternion. */
function frame(axis: V3, flats: V3): THREE.Quaternion {
  const z = new THREE.Vector3(...axis).normalize();
  const x = new THREE.Vector3(...flats).addScaledVector(z, -new THREE.Vector3(...flats).dot(z)).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

const mesh = (g: THREE.BufferGeometry, m: THREE.Material, name: string) => {
  const o = new THREE.Mesh(g, m);
  o.name = name;
  o.castShadow = true;
  return o;
};

/** A square plate in the XY plane, from z = 0 to `depth`, with four round holes at the corners of a square. */
function flangePlate(side: number, depth: number, holeD: number, pitch: number): THREE.BufferGeometry {
  const h = side / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-h, -h); shape.lineTo(h, -h); shape.lineTo(h, h); shape.lineTo(-h, h); shape.closePath();
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const hole = new THREE.Path();
    hole.absarc(sx * pitch / 2, sy * pitch / 2, holeD / 2, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 20 });
}

/** An SMA jack at a placement: a gold 4-hole flange, a hex nut on it, a hollow threaded barrel, a PTFE
 *  insert in the bore and the centre pin (which runs back along the port). */
export function smaConnector(p: SmaPlacement, unitMm: number, mk: MaterialFactory): THREE.Group {
  const s = SMA_MM;
  const group = new THREE.Group();
  group.name = `sma-${p.port}`;
  const pinBack = p.pinLength * unitMm; // mm
  const barrelAt = s.flange + s.nut, mouth = barrelAt + s.barrelLength;
  const ptfeTop = mouth - s.recess;
  const body = [
    mesh(flangePlate(s.flangeSize, s.flange, s.holeD, s.holePitch), mk("sma-body"), "flange"),
    mesh(hexPrism(s.hex, s.flange, barrelAt), mk("sma-nut"), "nut"),
    mesh(tube(s.bore / 2, s.barrel / 2, barrelAt, mouth), mk("sma-body"), "barrel"),
    mesh(tube(s.pin / 2, s.bore / 2, ptfeTop - s.ptfeLength, ptfeTop), mk("sma-dielectric"), "dielectric"),
    mesh(rod(s.pin / 2, -pinBack, ptfeTop + s.pinStub, 16), mk("sma-pin"), "pin"),
    // a disc closing the back of the barrel, so the body is not hollow from behind
    mesh(rod(s.bore / 2, barrelAt, ptfeTop - s.ptfeLength, 32), mk("sma-body"), "backplate"),
  ];
  // thread crests on the barrel: three rings, as in the Blender jack
  for (const f of [0.2, 0.45, 0.7]) body.push(mesh(rod(s.barrel / 2 * 1.015, barrelAt + s.barrelLength * (f - 0.035), barrelAt + s.barrelLength * (f + 0.035), 40), mk("sma-body"), "thread"));
  group.add(...body);
  group.scale.setScalar(1 / unitMm);
  group.quaternion.copy(frame(p.axis, p.flats));
  group.position.set(...p.origin);
  return group;
}

/** The port marker: a thin red rod along the port with a bead at each end. Its beads keep a minimum size on screen
 *  (updateMarkerSizes), so a port stays visible in a full-model view of a large board. */
export function portMarker(port: PortInput, bead: number, mk: MaterialFactory): THREE.Group {
  const group = new THREE.Group();
  group.name = `marker-${port.number}`;
  group.userData.marker = { bead };
  // along the port's direction through the middle of its cross-section (start and stop are opposite
  // corners of the port's box, so the straight line between them would run diagonally)
  const k = AXIS[port.direction];
  const centre = new THREE.Vector3(...[0, 1, 2].map((i) => (port.start[i] + port.stop[i]) / 2) as V3);
  const a = centre.clone().setComponent(k, port.start[k]), b = centre.clone().setComponent(k, port.stop[k]);
  const along = b.clone().sub(a);
  const length = along.length();
  const material = mk("marker");
  if (length > 1e-12) {
    const r = new THREE.Mesh(new THREE.CylinderGeometry(bead * 0.45, bead * 0.45, length, 16), material);
    r.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), along.clone().normalize());
    r.position.copy(a).add(b).multiplyScalar(0.5);
    r.castShadow = true;
    r.userData.markerPart = "rod";
    group.add(r);
  }
  for (const at of [a, b]) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(bead, 20, 14), material);
    s.position.copy(at);
    s.castShadow = true;
    s.userData.markerPart = "bead";
    group.add(s);
  }
  return group;
}

/** The smallest on-screen diameter of a marker bead, in output pixels. */
export const MARKER_MIN_PX = 8;

/** The factor a marker bead of radius `bead` (drawing units) is enlarged by so that it is at least `minPx` pixels across
 *  where one pixel spans `worldPerPixel` drawing units; 1 when it is large enough already. */
export function markerScale(bead: number, worldPerPixel: number, minPx = MARKER_MIN_PX): number {
  if (!(bead > 0) || !(worldPerPixel > 0)) return 1;
  return Math.max(1, (minPx / 2) * worldPerPixel / bead);
}

/** Drawing units per output pixel at `point` for this camera and an image `heightPx` pixels tall. */
export function worldPerPixel(camera: THREE.Camera, point: THREE.Vector3, heightPx: number): number {
  if (!(heightPx > 0)) return 0;
  const o = camera as THREE.OrthographicCamera;
  if (o.isOrthographicCamera) return (o.top - o.bottom) / (o.zoom || 1) / heightPx;
  const p = camera as THREE.PerspectiveCamera;
  if (!p.isPerspectiveCamera) return 0;
  // the depth of the point along the view direction
  const dir = new THREE.Vector3();
  p.getWorldDirection(dir);
  const depth = Math.max(point.clone().sub(p.getWorldPosition(new THREE.Vector3())).dot(dir), p.near);
  return (2 * depth * Math.tan(THREE.MathUtils.degToRad(p.fov) / 2)) / (p.zoom || 1) / heightPx;
}

/** Keep every port marker under `root` at least MARKER_MIN_PX across for this camera: the beads grow (and the rod
 *  thickens) when the view would draw them smaller, whatever the zoom; they never shrink below their own size. */
export function updateMarkerSizes(root: THREE.Object3D, camera: THREE.Camera, heightPx: number): void {
  root.traverse((g) => {
    const info = g.userData.marker as { bead: number } | undefined;
    if (!info) return;
    const centre = new THREE.Box3();
    for (const c of g.children) if (c.userData.markerPart === "bead") centre.expandByPoint(c.getWorldPosition(new THREE.Vector3()));
    if (centre.isEmpty()) return;
    const k = markerScale(info.bead, worldPerPixel(camera, centre.getCenter(new THREE.Vector3()), heightPx));
    for (const c of g.children) {
      if (c.userData.markerPart === "bead") c.scale.setScalar(k);
      else if (c.userData.markerPart === "rod") c.scale.set(k, 1, k);   // the cylinder runs along its local y
    }
  });
}

/** A waveguide port: a thin flange frame round the port's opening, in the port plane. */
export function waveguideFlange(port: PortInput, mk: MaterialFactory): THREE.Group {
  const group = new THREE.Group();
  group.name = `flange-${port.number}`;
  const k = AXIS[port.direction];
  const [u, v] = [0, 1, 2].filter((i) => i !== k);
  const lo = (i: number) => Math.min(port.start[i], port.stop[i]), hi = (i: number) => Math.max(port.start[i], port.stop[i]);
  const wu = hi(u) - lo(u), wv = hi(v) - lo(v);
  if (wu <= 0 || wv <= 0) return group;
  const rim = 0.08 * Math.min(wu, wv), thick = 0.04 * Math.min(wu, wv);
  const at = port.start[k];
  const add = (cu: number, cv: number, du: number, dv: number) => {
    const size: V3 = [0, 0, 0], pos: V3 = [0, 0, 0];
    size[k] = thick; size[u] = du; size[v] = dv; pos[k] = at; pos[u] = cu; pos[v] = cv;
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size), mk("steel"));
    m.position.set(...pos);
    m.castShadow = true;
    group.add(m);
  };
  const cu = (lo(u) + hi(u)) / 2, cv = (lo(v) + hi(v)) / 2;
  add(cu, lo(v) - rim / 2, wu + 2 * rim, rim); add(cu, hi(v) + rim / 2, wu + 2 * rim, rim);
  add(lo(u) - rim / 2, cv, rim, wv); add(hi(u) + rim / 2, cv, rim, wv);
  return group;
}

/** A surface-mount body for a lumped element: a dark body with tin end caps along its current direction. */
export function smdElement(e: Pick<LumpedElement, "name" | "direction" | "start" | "stop">, mk: MaterialFactory): THREE.Group {
  const group = new THREE.Group();
  group.name = `smd-${e.name}`;
  const k = AXIS[e.direction];
  const length = Math.abs(e.stop[k] - e.start[k]);
  if (length < 1e-12) return group;
  const transverse = [0, 1, 2].filter((i) => i !== k).map((i) => Math.abs(e.stop[i] - e.start[i]));
  const width = Math.min(Math.max(...transverse, length * 0.5), length * 1.3);
  const height = width * 0.6;
  const centre = new THREE.Vector3(...[0, 1, 2].map((i) => (e.start[i] + e.stop[i]) / 2) as V3);
  // sits on the board: a body along x or y is lifted by half its height
  if (k !== 2) centre.z += height / 2;
  const dims: V3 = [width, width, width];
  dims[k] = length;
  if (k !== 2) dims[2] = height; else { dims[0] = width; dims[1] = width; }
  const cap = length * 0.22;
  const body = new THREE.Mesh(new THREE.BoxGeometry(...dims), mk("smd-body"));
  body.position.copy(centre); body.castShadow = true;
  group.add(body);
  for (const sign of [-1, 1]) {
    const d: V3 = [...dims] as V3; d[k] = cap;
    const m = new THREE.Mesh(new THREE.BoxGeometry(d[0] * 1.02, d[1] * 1.02, d[2] * 1.02), mk("smd-cap"));
    m.position.copy(centre); m.position.setComponent(k, centre.getComponent(k) + sign * (length - cap) / 2);
    m.castShadow = true;
    group.add(m);
  }
  return group;
}

export interface PortBuild {
  group: THREE.Group;
  /** how each port was drawn, by port number */
  drawn: Record<number, "sma" | "marker" | "flange" | "hidden">;
  placements: SmaPlacement[];
}

export interface PortBuildOptions {
  mode: RenderPorts;
  /** millimetres per drawing unit */
  unitMm: number;
  /** the scene's radius in drawing units: sizes the marker bead */
  sceneRadius: number;
  mk: MaterialFactory;
}

/** The marker bead radius, in drawing units: visible in a full-model view, never below 0.3 mm. */
export function markerBead(sceneRadius: number, unitMm: number): number {
  return Math.max(sceneRadius * 0.012, 0.3 / unitMm);
}

/** Every port of a design as the chosen option says: connector (where one fits, else the marker),
 *  marker, or nothing. */
export function buildPorts(ports: readonly PortInput[], solids: readonly Solid[], o: PortBuildOptions): PortBuild {
  const group = new THREE.Group();
  group.name = "ports";
  const drawn: PortBuild["drawn"] = {};
  const placements: SmaPlacement[] = [];
  const bead = markerBead(o.sceneRadius, o.unitMm);
  for (const port of ports) {
    if (o.mode === "hidden") { drawn[port.number] = "hidden"; continue; }
    if (port.type === "waveguide") {
      group.add(waveguideFlange(port, o.mk));
      drawn[port.number] = "flange";
      continue;
    }
    const placement = o.mode === "connector" ? placeSma(port, solids, o.unitMm) : null;
    if (placement) {
      group.add(smaConnector(placement, o.unitMm, o.mk));
      placements.push(placement);
      drawn[port.number] = "sma";
      // a connector under the ground plane (a probe feed) is hidden from above: the marker shows where the feed is
      if (placement.mount === "bottom") group.add(portMarker(port, bead, o.mk));
    } else {
      group.add(portMarker(port, bead, o.mk));
      drawn[port.number] = "marker";
    }
  }
  return { group, drawn, placements };
}

/** The look table entry for a connector or component part, for callers that build materials themselves. */
export const PORT_LOOKS = (["sma-body", "sma-nut", "sma-dielectric", "sma-pin", "smd-body", "smd-cap", "marker", "steel"] as const).map((id) => MATERIAL_LOOKS[id]);
