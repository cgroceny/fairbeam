// The rendered scene: a design's parts with physically based materials, studio lights, a soft ground
// shadow and the ports. One Stage serves both the live "Rendered" view (it is added to the viewport's
// scene) and the offscreen image renderer (src/render/capture.ts), so the two look the same.
//
// Lazy-loaded (dynamic import on first use of Rendered or Render image): nothing here is in the
// designer's startup bundle.
import * as THREE from "three";
import type { Bundle, Part } from "../types";
import { primitiveGeometry } from "../scene/geometry.ts";
import { isGhostPart } from "../scene/partKind.ts";
import { lookFor, MATERIAL_LOOKS, partInfo, type MaterialClass, type MaterialLook, type RenderPartInfo } from "./materials.ts";
import type { RenderBackground, RenderPorts, SolderMask } from "./options.ts";
import { buildPorts, smdElement, type PortBuild, type Solid } from "./ports.ts";

export interface StageOptions {
  background: RenderBackground;
  groundShadow: boolean;
  ports: RenderPorts;
  solderMask: SolderMask;
}

/** A three.js material from a look-table entry. `thickness` is the part's thickness in drawing units
 *  (the depth light travels through a translucent part). */
export function makeMaterial(look: MaterialLook, env: THREE.Texture | null, thickness = 1): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: look.baseColor,
    metalness: look.metallic,
    roughness: look.roughness,
    ior: look.ior,
    transmission: look.transmission,
    transparent: look.opacity < 1,
    opacity: look.opacity,
    clearcoat: look.coat,
    clearcoatRoughness: look.coatRoughness,
    envMap: env,
    envMapIntensity: look.kind === "metal" ? 0.9 : 0.35,
    side: THREE.DoubleSide,
    // zero-thickness metal lies exactly on dielectric faces: pull metal forward, push dielectrics back
    polygonOffset: true,
    polygonOffsetFactor: look.kind === "metal" ? -1 : 1,
    polygonOffsetUnits: look.kind === "metal" ? -4 : 4,
  });
  if (look.transmission > 0) {
    m.thickness = thickness;
    if (look.attenuation) {
      m.attenuationColor = new THREE.Color(look.attenuation.color);
      m.attenuationDistance = Math.max(thickness * look.attenuation.thicknessMultiple, 1e-9);
    }
  }
  m.name = look.id;
  return m;
}

export interface BuiltModel {
  group: THREE.Group;
  bounds: THREE.Box3;
  /** the bounding sphere's radius, in drawing units */
  radius: number;
  center: THREE.Vector3;
  /** millimetres per drawing unit */
  unitMm: number;
  ports: PortBuild;
  /** parts that were drawn / skipped (air, vacuum, cut-outs) */
  drawn: string[];
  skipped: string[];
  dispose(): void;
}

/** Resolves a bundle part to its render info (the design adds the material names the bundle lacks). */
export type PartInfoLookup = (part: Part) => RenderPartInfo;

/** The model's meshes, ports and bounds. The caller owns the result and calls dispose(). */
export function buildModel(bundle: Bundle, infoOf: PartInfoLookup | undefined, o: Pick<StageOptions, "ports" | "solderMask"> & { hidden?: ReadonlySet<string> }, env: THREE.Texture | null): BuiltModel {
  const group = new THREE.Group();
  group.name = "render-model";
  const owned: { geometries: THREE.BufferGeometry[]; materials: THREE.Material[] } = { geometries: [], materials: [] };
  const drawn: string[] = [], skipped: string[] = [];
  const solids: Solid[] = [];
  const bounds = new THREE.Box3();
  const cache = new Map<MaterialClass, THREE.Material>();
  const shared = (id: MaterialClass) => {
    let m = cache.get(id);
    if (!m) { m = makeMaterial(MATERIAL_LOOKS[id], env); cache.set(id, m); owned.materials.push(m); }
    return m;
  };
  for (const part of bundle.parts) {
    // a part hidden in the tree (its eye) is not in the picture either
    const look = isGhostPart(part) || o.hidden?.has(part.name) ? null : lookFor((infoOf ?? partInfo)(part), o.solderMask);
    if (!look) { skipped.push(part.name); continue; }
    const geometries = part.primitives.map((p) => primitiveGeometry(p)).filter((g): g is THREE.BufferGeometry => !!g);
    if (!geometries.length) { skipped.push(part.name); continue; }
    drawn.push(part.name);
    const box = new THREE.Box3();
    geometries.forEach((g) => { g.computeBoundingBox(); box.union(g.boundingBox!); });
    bounds.union(box);
    const sizes = box.getSize(new THREE.Vector3()).toArray().filter((s) => s > 1e-9);
    const thickness = sizes.length ? Math.min(...sizes) : 1;
    // a custom thickness only matters to translucent parts; opaque ones share one material per look
    const material = look.transmission > 0 || look.baseColor !== MATERIAL_LOOKS[look.id].baseColor
      ? (() => { const m = makeMaterial(look, env, thickness); owned.materials.push(m); return m; })()
      : shared(look.id);
    const holder = new THREE.Group();
    holder.name = part.name;
    holder.userData.look = look.id;
    for (const g of geometries) {
      owned.geometries.push(g);
      const mesh = new THREE.Mesh(g, material);
      mesh.castShadow = true;
      mesh.renderOrder = look.kind === "metal" ? 1 : 0;
      holder.add(mesh);
    }
    group.add(holder);
    solids.push({ name: part.name, kind: look.kind, min: box.min.toArray() as [number, number, number], max: box.max.toArray() as [number, number, number] });
  }
  // (the designer's quick preview bundles carry millimetres without saying so)
  const metres = bundle.units?.length_m;
  const unitMm = typeof metres === "number" && Number.isFinite(metres) && metres > 0 ? metres * 1000 : 1;
  if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 1e-6);

  const ports = buildPorts(bundle.ports ?? [], solids, { mode: o.ports, unitMm, sceneRadius: radius, mk: shared });
  group.add(ports.group);
  if (o.ports !== "hidden") {
    for (const e of bundle.lumped_elements ?? []) group.add(smdElement(e, shared));
  }
  const all = new THREE.Box3().setFromObject(group);
  if (!all.isEmpty()) bounds.copy(all);
  const fullSphere = bounds.getBoundingSphere(new THREE.Sphere());
  ports.group.traverse((x) => { const m = x as THREE.Mesh; if (m.geometry) owned.geometries.push(m.geometry); });
  group.traverse((x) => { const m = x as THREE.Mesh; if (m.isMesh && m.castShadow) m.receiveShadow = false; });
  return {
    group, bounds, radius: Math.max(fullSphere.radius, 1e-6), center: bounds.getCenter(new THREE.Vector3()), unitMm, ports, drawn, skipped,
    dispose() {
      owned.geometries.forEach((g) => g.dispose());
      owned.materials.forEach((m) => m.dispose());
      cache.clear();
    },
  };
}

// ---------------------------------------------------------------- stage

function gradientTexture(inner: string, outer: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(256, 230, 20, 256, 256, 400);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const BACKDROP = {
  studio: ["#f4f5f6", "#b9bdc3"],
  dark: ["#2b3038", "#0b0c0f"],
} as const;

/** The key, fill and rim lights, the ground that catches the shadow, and the background. */
export class Stage {
  readonly root = new THREE.Group();
  private readonly key = new THREE.DirectionalLight(0xfff3e4, 1.9);
  private readonly fill = new THREE.DirectionalLight(0xe9f0ff, 0.55);
  private readonly rim = new THREE.DirectionalLight(0xdfe9ff, 1.2);
  private readonly ground: THREE.Mesh;
  private readonly blob: THREE.Mesh;
  private model: BuiltModel | null = null;
  private backdrop: THREE.CanvasTexture | null = null;
  private backdropKind: RenderBackground | null = null;
  private options: StageOptions;
  readonly shadowSize: number;

  readonly env: THREE.Texture | null;

  constructor(options: StageOptions, env: THREE.Texture | null, shadowSize = 2048) {
    this.env = env;
    this.options = options;
    this.shadowSize = shadowSize;
    this.root.name = "render-stage";
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(shadowSize, shadowSize);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0;
    this.key.shadow.radius = 40;
    this.key.shadow.blurSamples = 25;
    this.root.add(this.key, this.key.target, this.fill, this.fill.target, this.rim, this.rim.target);
    const shadowMaterial = new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.2, side: THREE.FrontSide, depthWrite: false });
    shadowMaterial.polygonOffset = true; shadowMaterial.polygonOffsetFactor = 2; shadowMaterial.polygonOffsetUnits = 2;
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMaterial);
    this.ground.receiveShadow = true;
    this.ground.name = "ground-shadow";
    this.ground.renderOrder = -1;
    // a soft contact patch under the footprint, so the model sits on the floor even where the key
    // light's own shadow is thin
    const spot = document.createElement("canvas");
    spot.width = spot.height = 128;
    const g = spot.getContext("2d")!;
    const rg = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    rg.addColorStop(0, "rgba(0,0,0,0.55)"); rg.addColorStop(0.55, "rgba(0,0,0,0.22)"); rg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
    const spotTexture = new THREE.CanvasTexture(spot);
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: spotTexture, transparent: true, depthWrite: false, toneMapped: false, opacity: 0.55 }));
    this.blob.name = "contact-shadow";
    this.blob.renderOrder = -2;
    this.root.add(this.ground, this.blob);
    this.setOptions(options);
  }

  /** The scene background for the chosen option: a colour texture, or null (transparent). */
  background(): THREE.Texture | null {
    const kind = this.options.background;
    if (this.backdrop && this.backdropKind === kind) return this.backdrop;
    this.backdrop?.dispose();
    this.backdrop = null;
    this.backdropKind = kind;
    if (kind === "transparent") return null;
    const [inner, outer] = BACKDROP[kind];
    this.backdrop = gradientTexture(inner, outer);
    return this.backdrop;
  }

  setOptions(o: StageOptions): void {
    this.options = o;
    this.ground.visible = o.groundShadow;
    this.blob.visible = o.groundShadow;
    this.key.castShadow = o.groundShadow;
  }

  setModel(model: BuiltModel | null): void {
    if (this.model) this.root.remove(this.model.group);
    this.model = model;
    if (!model) return;
    this.root.add(model.group);
    const { center, radius, bounds } = model;
    // the key light is fixed in the world, up and a little in front of the model: the ground shadow
    // then falls the same way in every view
    this.key.position.copy(center).add(new THREE.Vector3(0.4, -0.55, 1.4).normalize().multiplyScalar(radius * 6));
    this.key.target.position.copy(center);
    const cam = this.key.shadow.camera;
    cam.left = cam.bottom = -radius * 1.5; cam.right = cam.top = radius * 1.5;
    cam.near = radius * 2; cam.far = radius * 11;
    cam.updateProjectionMatrix();
    this.key.target.updateMatrixWorld();
    const floor = bounds.min.z - radius * 1e-3;
    const span = radius * 14;
    this.ground.scale.set(span, span, 1);
    this.ground.position.set(center.x, center.y, floor);
    this.blob.scale.set(Math.max(bounds.max.x - bounds.min.x, radius * 0.3) * 1.8, Math.max(bounds.max.y - bounds.min.y, radius * 0.3) * 1.8, 1);
    this.blob.position.set(center.x, center.y, floor + radius * 5e-4);
  }

  /** Fill and rim follow the camera, like lights on a photographer's stand: every view is lit. */
  update(camera: THREE.Camera): void {
    if (!this.model) return;
    const { center, radius } = this.model;
    const toCamera = camera.position.clone().sub(center).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const place = (light: THREE.DirectionalLight, v: THREE.Vector3) => {
      light.position.copy(center).addScaledVector(v.normalize(), radius * 6);
      light.target.position.copy(center);
      light.target.updateMatrixWorld();
    };
    place(this.fill, right.clone().multiplyScalar(-1.1).addScaledVector(up, 0.35).addScaledVector(toCamera, 1));
    place(this.rim, right.clone().multiplyScalar(0.9).addScaledVector(up, 0.9).addScaledVector(toCamera, -1.2));
  }

  dispose(): void {
    this.backdrop?.dispose();
    this.key.shadow.map?.dispose();
    this.ground.geometry.dispose(); (this.ground.material as THREE.Material).dispose();
    this.blob.geometry.dispose();
    const bm = this.blob.material as THREE.MeshBasicMaterial; bm.map?.dispose(); bm.dispose();
  }
}

/** Renderer settings of a rendered image: ACES filmic tone mapping, sRGB output, soft shadows. */
export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
}
