// Offscreen image rendering of a design: a private WebGL renderer, one picture per chosen angle, drawn
// at a supersampled size with multisampling and scaled down to the requested size. The picture is
// a PNG blob; saving it is src/render/files.ts.
//
// Lazy-loaded when the Render image dialog first renders.
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { Bundle } from "../types";
import { cameraFromFraming, frameBox, frameFromView, angleDirection, type ViewState } from "./frame.ts";
import { partInfoLookup } from "./context.ts";
import type { PartInfoLookup } from "./scene.ts";
import { supersampling, type RenderAngle, type RenderOptions } from "./options.ts";
import { buildModel, configureRenderer, Stage } from "./scene.ts";

export interface RenderedImage {
  angle: RenderAngle;
  width: number;
  height: number;
  blob: Blob;
  /** the supersampling factor the picture was drawn with */
  factor: number;
}

export interface CaptureRequest {
  bundle: Bundle;
  options: RenderOptions;
  /** the live camera, for the "current view" angle */
  view?: ViewState | null;
  infoOf?: PartInfoLookup;
  /** parts hidden in the tree: left out of the picture */
  hidden?: ReadonlySet<string>;
  onProgress?: (done: number, total: number, angle: RenderAngle) => void;
  signal?: AbortSignal;
}

const toBlob = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) =>
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The browser could not encode the image"))), "image/png"));

// Three keeps one module-wide DFG lookup texture; every renderer adds a dispose listener to it and
// renderer.dispose() never removes it, so each finished render would keep its WebGL context alive.
// Same workaround as the viewport's (src/scene/Viewport.tsx): collect the listeners, remove them at the end.
function lutTracker() {
  const proto = THREE.Texture.prototype as unknown as {
    addEventListener(type: string, listener: (...args: unknown[]) => void): void;
    removeEventListener(type: string, listener: (...args: unknown[]) => void): void;
  };
  const found: { texture: THREE.Texture; listener: (...args: unknown[]) => void }[] = [];
  return {
    run<T>(work: () => T): T {
      if (found.length) return work();
      const original = proto.addEventListener;
      proto.addEventListener = function (this: THREE.Texture, type, listener) {
        if (type === "dispose" && this.name === "DFG_LUT") found.push({ texture: this, listener });
        original.call(this, type, listener);
      };
      try { return work(); } finally { proto.addEventListener = original; }
    },
    release() {
      for (const { texture, listener } of found) proto.removeEventListener.call(texture, "dispose", listener);
      found.length = 0;
    },
  };
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Render every chosen angle. Throws when WebGL is unavailable, or the request is aborted. */
export async function captureImages(req: CaptureRequest): Promise<RenderedImage[]> {
  const { bundle, options } = req;
  const canvas = document.createElement("canvas");
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, premultipliedAlpha: true, powerPreference: "high-performance" });
  } catch (error) {
    throw new Error(`WebGL is not available: ${error instanceof Error ? error.message : String(error)}`);
  }
  const gl = renderer.getContext();
  const maxSide = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    ...(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array));
  const factor = supersampling(options, maxSide);
  const drawW = Math.round(options.width * factor), drawH = Math.round(options.height * factor);
  renderer.setPixelRatio(1);
  renderer.setSize(drawW, drawH, false);
  configureRenderer(renderer);
  renderer.setClearColor(0x000000, 0);

  const lut = lutTracker();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envTarget = lut.run(() => pmrem.fromScene(room, 0.04));
  room.dispose();
  const env = envTarget.texture;

  const scene = new THREE.Scene();
  const stageOptions = { background: options.background, groundShadow: options.groundShadow, ports: options.ports, solderMask: options.solderMask };
  const stage = new Stage(stageOptions, env, 4096);
  const model = buildModel(bundle, req.infoOf ?? partInfoLookup(), { ...stageOptions, hidden: req.hidden }, env);
  const out: RenderedImage[] = [];
  try {
    stage.setModel(model);
    scene.add(stage.root);
    scene.environment = env;
    scene.background = stage.background();
    const aspect = options.width / options.height;
    const target = document.createElement("canvas");
    target.width = options.width;
    target.height = options.height;
    const g2 = target.getContext("2d")!;
    g2.imageSmoothingEnabled = true;
    g2.imageSmoothingQuality = "high";

    let done = 0;
    for (const angle of options.angles) {
      if (req.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      req.onProgress?.(done, options.angles.length, angle);
      await nextFrame(); // let the dialog repaint its progress between the pictures
      const framing = angle === "current" && req.view
        ? frameFromView(req.view, model.bounds, options.projection)
        : frameBox(model.bounds, angleDirection(angle === "current" ? "iso" : angle), aspect, options.projection);
      const camera = cameraFromFraming(framing, aspect);
      stage.update(camera);
      renderer.shadowMap.needsUpdate = true;
      renderer.clear();
      lut.run(() => renderer.render(scene, camera));
      g2.clearRect(0, 0, options.width, options.height);
      g2.drawImage(canvas, 0, 0, drawW, drawH, 0, 0, options.width, options.height);
      out.push({ angle, width: options.width, height: options.height, blob: await toBlob(target), factor });
      done++;
      req.onProgress?.(done, options.angles.length, angle);
    }
  } finally {
    model.dispose();
    stage.dispose();
    scene.environment = null;
    envTarget.dispose();
    pmrem.dispose();
    renderer.dispose();
    lut.release();
    renderer.forceContextLoss();
  }
  return out;
}
