// The live "Rendered" view of the 3D viewport. It borrows the viewport's renderer, scene, camera and
// orbit controls: while it is on, the modelling scene objects are hidden (not removed), the rendered
// stage is added, and the renderer's tone mapping, shadows and background are switched. Turning it off
// puts every one of those back, so the modelling view returns exactly as it was: selection, x-ray,
// edges and the camera all live in objects this file never touches.
//
// Lazy-loaded by the viewport on the first use of Rendered.
import * as THREE from "three";
import type { Bundle } from "../types";
import { partInfoLookup } from "./context.ts";
import type { RenderOptions } from "./options.ts";
import { buildModel, configureRenderer, Stage, type BuiltModel } from "./scene.ts";

export interface RenderedContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** the shared studio environment the viewport already built (PMREM of RoomEnvironment) */
  env: THREE.Texture;
  /** the CSS2D label layer: hidden while rendered */
  labels: HTMLElement;
  /** the modelling background colour, put back on leaving */
  modellingBackground: () => THREE.Color;
  requestRender: () => void;
}

export interface RenderedHandle {
  readonly active: boolean;
  /** show (or refresh) the rendered scene of this bundle with these options */
  show(bundle: Bundle | null, options: RenderOptions, hidden?: ReadonlySet<string>): void;
  /** called before every frame: the camera-relative lights follow the camera */
  beforeRender(camera: THREE.Camera): void;
  /** back to the modelling view */
  hide(): void;
  dispose(): void;
  /** diagnostics for the checks and the UI tests */
  info(): { drawn: string[]; skipped: string[]; ports: Record<number, string>; active: boolean };
}

type Saved = {
  toneMapping: THREE.ToneMapping;
  exposure: number;
  shadows: boolean;
  shadowType: THREE.ShadowMapType;
  shadowAuto: boolean;
  hidden: THREE.Object3D[];
  labelsDisplay: string;
};

export function attachRendered(ctx: RenderedContext): RenderedHandle {
  const { renderer, scene } = ctx;
  let saved: Saved | null = null;
  let stage: Stage | null = null;
  let model: BuiltModel | null = null;

  const enter = () => {
    saved = {
      toneMapping: renderer.toneMapping, exposure: renderer.toneMappingExposure,
      shadows: renderer.shadowMap.enabled, shadowType: renderer.shadowMap.type, shadowAuto: renderer.shadowMap.autoUpdate,
      hidden: scene.children.filter((c) => c.visible), labelsDisplay: ctx.labels.style.display,
    };
    for (const child of saved.hidden) child.visible = false;
    ctx.labels.style.display = "none";
    configureRenderer(renderer);
    // the key light is fixed in the world: its shadow is only redrawn when the model changes
    renderer.shadowMap.autoUpdate = false;
  };

  const leave = () => {
    if (!saved) return;
    for (const child of saved.hidden) if (child.parent === scene) child.visible = true;
    ctx.labels.style.display = saved.labelsDisplay;
    renderer.toneMapping = saved.toneMapping;
    renderer.toneMappingExposure = saved.exposure;
    renderer.shadowMap.enabled = saved.shadows;
    renderer.shadowMap.type = saved.shadowType;
    renderer.shadowMap.autoUpdate = saved.shadowAuto;
    scene.environment = null;
    scene.background = ctx.modellingBackground();
    if (stage) scene.remove(stage.root);
    saved = null;
    ctx.requestRender();
  };

  const clearModel = () => {
    if (model) { stage?.setModel(null); model.dispose(); model = null; }
  };

  const handle: RenderedHandle = {
    get active() { return !!saved; },
    show(bundle, options, hidden) {
      if (!saved) enter();
      const stageOptions = {
        // a live view cannot be transparent: it shows the studio
        background: options.background === "transparent" ? "studio" as const : options.background,
        groundShadow: options.groundShadow, ports: options.ports, solderMask: options.solderMask,
      };
      if (!stage) stage = new Stage(stageOptions, ctx.env, 2048);
      if (stage.root.parent !== scene) scene.add(stage.root);
      stage.setOptions(stageOptions);
      scene.environment = ctx.env;
      scene.background = stage.background();
      clearModel();
      if (bundle) {
        model = buildModel(bundle, partInfoLookup(), { ...stageOptions, hidden }, ctx.env);
        stage.setModel(model);
      }
      renderer.shadowMap.needsUpdate = true;
      ctx.requestRender();
    },
    beforeRender(camera) { stage?.update(camera); },
    hide() { leave(); },
    dispose() {
      leave();
      clearModel();
      stage?.dispose();
      stage = null;
    },
    info() {
      return { drawn: model?.drawn ?? [], skipped: model?.skipped ?? [], ports: model?.ports.drawn ?? {}, active: !!saved };
    },
  };
  return handle;
}
