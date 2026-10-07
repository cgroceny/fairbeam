import { withoutVoids } from "../lib/voidParts.ts";
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { strToU8, zipSync } from "fflate";
import type { Bundle } from "../types";
import { designStem } from "../lib/exportNames.ts";
import { buildParts, type SceneColors } from "../scene/geometry.ts";
import { prepareSheets, sheetThicknessUnits, validateMeshPrimitive, validMeshGeometry, type MeshOptions } from "./mesh.ts";

export function blenderFileStem(id: string): string {
  return designStem(id);
}

/** Uses the viewport's tessellation (including affine transforms), never a bounding-box substitute. */
export function blenderScene(bundle: Bundle, colors: SceneColors, components: Record<string, string> = {}, options: MeshOptions = {}): THREE.Scene {
  const b = withoutVoids(bundle);
  if (!Number.isFinite(b.units.length_m) || b.units.length_m <= 0) throw new Error("Invalid physical length unit");
  if (b.parts.some(p => p.primitives.some(primitive => !primitive.exact))) throw new Error("The scene contains approximate geometry; resolve it before exporting to Blender");
  b.parts.forEach(part => part.primitives.forEach(validateMeshPrimitive));
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  root.name = b.model.name || b.model.id;
  // glTF is Y-up and metres; Fairbeam is Z-up in bundle drawing units.
  root.rotation.x = -Math.PI / 2;
  root.scale.setScalar(b.units.length_m);
  root.userData = { source: "Fairbeam", lengthUnit: b.units.length, metresPerUnit: b.units.length_m };
  const groups = new Map<string, THREE.Group>();
  const parent = (path: string): THREE.Group => {
    if (!path) return root;
    const found = groups.get(path);
    if (found) return found;
    const group = new THREE.Group();
    const parts = path.split("/");
    group.name = parts.pop()!;
    group.userData = { component: path };
    groups.set(path, group);
    parent(parts.join("/")).add(group);
    return group;
  };
  const objects = buildParts(b, colors, null, false);
  let meshCount = 0;
  let invalid = false;
  for (const object of objects) {
    for (const edge of object.edges) { object.group.remove(edge); edge.geometry.dispose(); (edge.material as THREE.Material).dispose(); }
    object.group.userData = { component: object.part.name, label: object.part.label || object.part.name, materialType: object.part.type };
    object.meshes.forEach((mesh, index) => {
      meshCount++;
      if (!validMeshGeometry(mesh.geometry)) invalid = true;
      mesh.name = `${object.part.name}_${index + 1}`;
      mesh.userData = { component: object.part.name, primitiveKind: object.part.primitives[index]?.kind };
      // Rendering material, without viewport x-ray transparency or selection overlays.
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.name = object.part.name;
      material.opacity = 1; material.transparent = false;
    });
    if (object.meshes.length !== object.part.primitives.length) invalid = true;
    parent(components[object.part.name] ?? "").add(object.group);
  }
  if (invalid || !meshCount) {
    root.traverse(object => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); const materials = Array.isArray(object.material) ? object.material : [object.material]; materials.forEach(material => material.dispose()); } });
    throw new Error(invalid ? "A solid has invalid or missing mesh geometry" : "The scene has no exportable solids");
  }
  // Sheets: a closed slab of the chosen thickness, or a two-sided surface (glTF doubleSided). Meshes are
  // swapped in place; the viewport tessellation is never cached here (buildParts got no cache).
  const meshes = objects.flatMap(object => object.meshes);
  const prepared = prepareSheets(meshes.map(mesh => mesh.geometry), sheetThicknessUnits(b, options));
  prepared.forEach(({ geometry, flat }, i) => {
    meshes[i].geometry = geometry;
    if (flat) (meshes[i].material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
  });
  scene.add(root); scene.updateMatrixWorld(true);
  return scene;
}

export async function blenderGlb(b: Bundle, colors: SceneColors, components: Record<string, string> = {}, options: MeshOptions = {}): Promise<ArrayBuffer> {
  const scene = blenderScene(b, colors, components, options);
  try {
    const glb = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true });
    if (!(glb instanceof ArrayBuffer)) throw new Error("The GLB exporter returned invalid data");
    return glb;
  } finally {
    scene.traverse(object => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); const materials = Array.isArray(object.material) ? object.material : [object.material]; materials.forEach(material => material.dispose()); } });
  }
}

export async function blenderPackage(b: Bundle, colors: SceneColors, components: Record<string, string> = {}, options: MeshOptions = {}): Promise<Uint8Array> {
  const { default: blenderScript } = await import("./blender-render.py?raw");
  const glb = await blenderGlb(b, colors, components, options);
  const readme = `Fairbeam Blender render package\n\nExtract all files into one folder.\nWindows: double-click Render.cmd. Blender 4.2 in its default location or Blender on PATH is supported.\nOther systems: blender --background --threads 4 --python-exit-code 1 --python blender-render.py\n\nThe script creates model.blend and render.png beside the model. You can also import model.glb through Blender File > Import > glTF 2.0.\nGeometry is tessellated, with component names, material colours, affine transforms and physical dimensions in metres. Simulation fields, ports, grid and selection overlays are not included. ${options.sheetThicknessUm ? `Zero-thickness metal (traces, ground planes) was given a thickness of ${options.sheetThicknessUm} um.` : "Zero-thickness metal remains a two-sided surface."} The script adds camera and lights; it does not simulate RF behaviour.\nSource: ${b.model.id}\nLength unit: ${b.units.length}; metres per unit: ${b.units.length_m}\n`;
  const launcher = '@echo off\r\ncd /d "%~dp0"\r\nset "FAIRBEAM_BLENDER=blender"\r\nif exist "%ProgramFiles%\\Blender Foundation\\Blender 4.2\\blender.exe" set "FAIRBEAM_BLENDER=%ProgramFiles%\\Blender Foundation\\Blender 4.2\\blender.exe"\r\n"%FAIRBEAM_BLENDER%" --background --threads 4 --python-exit-code 1 --python blender-render.py\r\nif errorlevel 1 (echo Render failed. Install Blender or add it to PATH. See the error above. & pause & exit /b 1)\r\nstart "" render.png\r\n';
  return zipSync({ "model.glb": new Uint8Array(glb), "blender-render.py": strToU8(blenderScript), "Render.cmd": strToU8(launcher), "README.txt": strToU8(readme) });
}
