import * as THREE from "three";
import type { Bundle, FieldFrequency, FieldPlane } from "../types";
import { rampColor } from "./pattern";
import { instantaneousMagnitude, padMaskEdge, smoothCurrentMap } from "./currentAnimation";

function decodePhasors(text: string): Int8Array {
  const raw = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  return new Int8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

const phasorCache = new WeakMap<FieldFrequency, Int8Array>();
function entryPhasors(entry: FieldFrequency): Int8Array | null {
  if (!entry.phasors) return null;
  let q = phasorCache.get(entry);
  if (!q) {
    q = decodePhasors(entry.phasors);
    phasorCache.set(entry, q);
  }
  return q;
}

export function hasCurrentPhase(b: Bundle, f: number | null): boolean {
  return b.fields?.phase_version === 1 && (b.fields.planes ?? []).some((p) => !!fieldFor(p, f)?.phasors);
}

/** Pick the map recorded for a far-field frequency (nearest f_target), or null. */
export function fieldFor(plane: FieldPlane, f: number | null): FieldFrequency | null {
  if (!plane.frequencies.length) return null;
  if (f == null) return plane.frequencies[0];
  return plane.frequencies.reduce((a, b) => (Math.abs(b.f_target - f) < Math.abs(a.f_target - f) ? b : a));
}

/** Frequency actually shown for a far-field frequency (first plane), for the colour bar. */
export function shownFieldFrequency(b: Bundle, f: number | null): number | null {
  const plane = b.fields?.planes[0];
  const e = plane ? fieldFor(plane, f) : null;
  return e ? e.f : null;
}

/**
 * The excitation behind a bundle's surface-current maps (#90): the maps come from one run with one
 * driven port. `fields.port` records it. Older bundles do not, but their `ports` are those of the
 * same build that recorded the maps (the first excited port's run of a multi-port run), so exactly
 * one port flagged `excite` identifies it. Otherwise it is unknown, never assumed to be port 1.
 */
export function fieldExcitation(b: Bundle): { port: number | null; text: string } {
  const ports = Array.isArray(b.ports) ? b.ports : [];
  const excited = ports.filter((p) => p.excite === true);
  const port = b.fields?.port ?? (excited.length === 1 ? excited[0].number : null);
  if (port == null) return { port: null, text: "Driven port unknown (not recorded in this result)" };
  return { port, text: ports.length > 1 ? `Port ${port} driven, other ports terminated` : `Port ${port} driven` };
}

function texture(plane: FieldPlane, entry: FieldFrequency, stops: THREE.Color[], phaseDeg = 0, target?: THREE.DataTexture): THREE.DataTexture {
  const { nu, nv } = plane;
  const phasors = entryPhasors(entry);
  const phased = phasors ? instantaneousMagnitude(entry.values, phasors, phaseDeg) : entry.values;
  const map = smoothCurrentMap(phased, nu, nv, 2), w = nu * 2, h = nv * 2;
  const data = target ? (target.image as { data: Uint8Array }).data : new Uint8Array(w * h * 4);
  data.fill(0);
  const c = new THREE.Color();
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = Math.floor(i / w);
    const source = Math.min(nv - 1, Math.floor(y / 2)) * nu + Math.min(nu - 1, Math.floor(x / 2));
    const v = map[i];
    if (entry.values[source] < 0 || v < 0) continue;
    rampColor(stops, v / 1000, c);
    data[i * 4] = Math.round(c.r * 255);
    data[i * 4 + 1] = Math.round(c.g * 255);
    data[i * 4 + 2] = Math.round(c.b * 255);
    data[i * 4 + 3] = 255;
  }
  padMaskEdge(data, w, h);
  const tex = target ?? new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  // The upsampled interior is smooth; alphaTest keeps the exact metal mask crisp.
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function quad(plane: FieldPlane, offset: number, map: THREE.Texture): THREE.Mesh {
  const { axis, u_axis: u, v_axis: v, u_range: ur, v_range: vr } = plane;
  // half a sample beyond the first/last sample so texel centres sit on the sample positions
  const hu = (ur[1] - ur[0]) / Math.max(1, plane.nu - 1) / 2;
  const hv = (vr[1] - vr[0]) / Math.max(1, plane.nv - 1) / 2;
  const corners: [number, number][] = [[ur[0] - hu, vr[0] - hv], [ur[1] + hu, vr[0] - hv], [ur[1] + hu, vr[1] + hv], [ur[0] - hu, vr[1] + hv]];
  const pos = new Float32Array(12);
  corners.forEach(([a, bb], k) => {
    pos[k * 3 + axis] = plane.position + offset;
    pos[k * 3 + u] = a;
    pos[k * 3 + v] = bb;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  // Metal sheets are pulled forward with a polygon offset (geometry.ts, factor -1 / units -4).
  // Seen at an angle that beats the small `offset` above, and with the 24-bit depth buffer of
  // ANGLE on Windows (D3D11) one unit is large, so the copper hid the map outside the Top view:
  // pull the map further forward than the metal.
  const m = new THREE.Mesh(
    g,
    new THREE.MeshBasicMaterial({
      map, transparent: true, side: THREE.DoubleSide, depthWrite: false, toneMapped: false, alphaTest: 0.5,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
    }),
  );
  m.renderOrder = 2;
  return m;
}

/**
 * Surface-current heatmaps, one textured quad per recorded sheet plane, drawn just in front of and
 * behind the sheet so they are visible from both sides. Colour encodes |J_s| / max on the
 * sequential ramp (linear scale).
 */
export function currentLayer(b: Bundle, f: number | null, stops: THREE.Color[], sceneRadius: number): THREE.Group {
  const group = new THREE.Group();
  group.name = "surface-current";
  const eps = sceneRadius * 2e-3;
  for (const plane of b.fields?.planes ?? []) {
    const entry = fieldFor(plane, f);
    if (!entry) continue;
    const tex = texture(plane, entry, stops, 0);
    group.add(quad(plane, eps, tex), quad(plane, -eps, tex));
    if (b.fields?.phase_version === 1 && entry.phasors) {
      const updates = group.userData.currentPhaseUpdates ??= [];
      updates.push(() => {
        texture(plane, entry, stops, group.userData.phaseDeg ?? 0, tex);
      });
    }
  }
  return group;
}

export function updateCurrentPhase(group: THREE.Group, phaseDeg: number): void {
  group.userData.phaseDeg = phaseDeg;
  for (const update of group.userData.currentPhaseUpdates ?? []) update();
}
