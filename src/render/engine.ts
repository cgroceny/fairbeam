// The contract between the Render image dialog and a render engine that is not in the app: Blender.
//
// The Blender engine lives in src/render/blender.ts, which exports `blenderEngine` (a
// BlenderEngine). The dialog finds that file at build time (import.meta.glob), so the dialog builds
// with or without it; without it the "Blender" choice is shown but disabled. The options come as the
// one RenderOptions object (src/render/options.ts, `engine: "blender"`); the engine reads angles,
// size, background, ports, solder mask, ground shadow, projection and quality from it, and the
// material look from src/render/materials.ts (the same numbers).
import type { Bundle } from "../types";
import type { ViewState } from "./frame.ts";
import type { RenderAngle, RenderOptions } from "./options.ts";

export interface EngineRequest {
  bundle: Bundle;
  /** the design id: the pictures belong in renders/<design-id>/ (python/fairbeam/renders.py) */
  designId: string;
  options: RenderOptions;
  /** the live camera, for the "current" angle */
  view: ViewState | null;
  signal: AbortSignal;
  /** `done` pictures are finished of `total`; `angle` is the one being drawn */
  onProgress?: (done: number, total: number, angle: RenderAngle) => void;
}

/** One finished picture. An engine that already saved it into the renders folder sets `path`; the
 *  dialog shows `blob` or `url` as the thumbnail. */
export interface EngineImage {
  angle: RenderAngle;
  name: string;
  blob?: Blob;
  url?: string;
  path?: string;
}

export interface BlenderEngine {
  render(request: EngineRequest): Promise<EngineImage[]>;
}
