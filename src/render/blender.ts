// Rendering through the user's Blender (docs/RENDER-BLENDER.md): the client of the run server's /api/render-jobs (and /api/renders/<design> for the saved files).
// Blender is started by the server in the background (-b, no add-on, no window); this file builds the job
// (GLB geometry, per-part material info, ports) and follows it. Lazy-load it: nothing here is needed at startup.
//
// The Render image dialog (RenderDialog.tsx) embeds `<BlenderRenderPanel>` (BlenderRenderPanel.tsx), which wraps all of this
// for the UI. `blenderEngine` below is the same render as a `BlenderEngine` (engine.ts: one call, the finished pictures back);
//   const run = renderWithBlender(options, design, { bundle, onProgress });
//   run.result    // Promise<BlenderRenderResult>  (rejects with Error when the render fails; resolves on cancel with status "cancelled")
//   run.cancel()  // kills only that Blender process
// Both engines save into <workspace>/renders/<design-id>/ with the same names (python/fairbeam/renders.py).
import type { Bundle, Part } from "../types";
import type { RenderAngle, RenderOptions } from "./options.ts";
import { renderFolderId } from "./options.ts";
import type { ViewState } from "./frame.ts";
import type { BlenderEngine, EngineImage } from "./engine.ts";
import type { Design, DesignPart } from "../designer/types";
import { partKind } from "../scene/partKind.ts";
import { withoutVoids } from "../lib/voidParts.ts";

/** Blender's own quality names: "preview" (Cycles 32 samples + denoiser) and "final" (256 samples + denoiser). */
export type BlenderQuality = "preview" | "final";
export const BLENDER_QUALITIES: readonly BlenderQuality[] = ["preview", "final"];
/** The app's draft/standard/high mapped onto Blender's two (for callers that only have a RenderOptions). */
export const blenderQualityFor = (quality: RenderOptions["quality"]): BlenderQuality => (quality === "high" ? "final" : "preview");

/** The options as the server takes them: RenderOptions with Blender's quality, and "current view" as the camera object. */
export interface BlenderWireOptions extends Omit<RenderOptions, "angles" | "quality" | "engine"> {
  angles: (RenderAngle | { name: string; direction: [number, number, number]; up: [number, number, number] })[];
  quality: BlenderQuality;
  engine: "blender";
}

/** RenderOptions -> the request's options. The live camera ("current") travels as a direction (camera minus target) and up. */
export function toBlenderOptions(options: RenderOptions, quality: BlenderQuality = blenderQualityFor(options.quality), view?: ViewState | null): BlenderWireOptions {
  const angles = options.angles.map(angle => {
    if (angle !== "current" || !view) return angle;
    const direction = view.position.map((v, i) => v - view.target[i]) as [number, number, number];
    return direction.some(v => Math.abs(v) > 0) ? { name: "current", direction, up: view.up } : angle;
  });
  return { ...options, angles, quality, engine: "blender" };
}

export interface BlenderInfo {
  found: boolean;
  ok: boolean;
  path: string | null;
  source: "settings" | "env" | "path" | "install" | null;
  version: string | null;
  label: string | null;
  message?: string;
  configured_error?: string | null;
  download_url: string;
}
export interface BlenderImage { index: number; angle: string; name: string; path: string; seconds: number; url: string }
export interface BlenderRenderProgress {
  id: string;
  design: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  stage: string;
  /** 0..1 over all angles */
  progress: number;
  angleIndex: number;
  angleCount: number;
  angle: string;
  sample: number;
  samples: number;
  device: string;
  note: string;
  /** every image written so far, in angle order */
  images: BlenderImage[];
  /** the saved .blend, once written (its file name; see blenderFileUrl) */
  blend: string | null;
  folder: string;
  error: string | null;
  elapsedS: number;
  imageSeconds: number[];
  blender: { path?: string; version?: string; label?: string };
}
export type BlenderRenderResult = BlenderRenderProgress;
export interface BlenderRenderRun { result: Promise<BlenderRenderResult>; cancel: () => Promise<void> }
export interface BlenderRenderExtras {
  /** the design id the pictures are filed under (renders/<id>/); the same id the in-app renderer uses */
  designId?: string;
  /** the viewer's live camera, for the "current" angle */
  view?: ViewState | null;
  /** preview (default for draft/standard) or final (default for high) */
  quality?: BlenderQuality;
  /** the design's geometry bundle (the viewer's live preview); built through /api/preview when omitted */
  bundle?: Bundle;
  onProgress?: (progress: BlenderRenderProgress) => void;
  /** also keep the scene as a .blend next to the images (default true) */
  saveBlend?: boolean;
  /** "auto" (GPU when Cycles finds one), "cpu" or "gpu" */
  device?: "auto" | "cpu" | "gpu";
  signal?: AbortSignal;
  /** Blender executable chosen in Settings; the server falls back to its own search when empty */
  blenderPath?: string;
}

const NEUTRAL = ["metal", "dielectric", "port", "edge", "domain", "nf2ff", "ground", "grid", "gridMajor"];

/** The part list the Blender script needs: kind, the design's material name and library entry, colour override. */
export function blenderParts(bundle: Bundle, design?: Pick<Design, "parts" | "materials"> | null) {
  const designParts = new Map<string, DesignPart>((design?.parts ?? []).map(p => [p.name, p]));
  const materials = new Map((design?.materials ?? []).map(m => [m.name, m]));
  return bundle.parts.map((part: Part) => {
    const dp = designParts.get(part.name);
    const material = dp ? materials.get(dp.material) : undefined;
    const kind = part.void ? "void" : partKind(part) === "metal" ? "metal" : "dielectric";
    const color = dp?.color || part.color;
    return {
      name: part.name, label: part.label || part.name, kind,
      ...(dp?.material ? { material: dp.material } : {}),
      ...((material as { library?: string } | undefined)?.library ? { library: (material as { library?: string }).library } : {}),
      ...(color && /^#[0-9a-f]{3,8}$/i.test(color) ? { color } : {}),
      ...(part.material && Number.isFinite(part.material.eps_r) ? { eps_r: part.material.eps_r } : {}),
    };
  });
}

/** Ports and lumped elements in metres (the GLB is in metres, Z up like the design). */
export function blenderPorts(bundle: Bundle) {
  const m = bundle.units.length_m;
  const conv = (v: number[]) => v.map(x => x * m);
  return {
    ports: bundle.ports.map(p => ({ number: p.number, type: p.type, direction: p.direction, start: conv(p.start), stop: conv(p.stop) })),
    lumped: (bundle.lumped_elements ?? []).map(e => ({
      name: e.name, label: e.label, type: e.type, direction: e.direction, start: conv(e.start), stop: conv(e.stop),
      ...(e.R !== undefined ? { R: e.R } : {}), ...(e.L !== undefined ? { L: e.L } : {}), ...(e.C !== undefined ? { C: e.C } : {}),
    })),
  };
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(out);
}

function sceneColors(): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const key of NEUTRAL) colors[key] = "#888888";
  return colors;
}

/** The request body of POST /api/render-jobs. */
export async function buildBlenderRequest(options: RenderOptions, design: Design | null, bundle: Bundle, extras: Pick<BlenderRenderExtras, "saveBlend" | "device" | "blenderPath" | "designId" | "view" | "quality"> = {}) {
  const { blenderGlb } = await import("../export/blender.ts");
  const clean = withoutVoids(bundle);
  const components = design ? Object.fromEntries(design.parts.map(part => [part.name, part.component ?? ""])) : {};
  const glb = await blenderGlb(clean, sceneColors() as never, components);
  return {
    // the same folder id the in-app renderer saves under (options.ts renderFolderId, python/fairbeam/renders.py)
    design_id: renderFolderId(extras.designId ?? design?.model.id ?? bundle.model.id),
    options: toBlenderOptions(options, extras.quality, extras.view),
    glb_base64: toBase64(glb),
    parts: blenderParts(bundle, design),
    ...blenderPorts(bundle),
    save_blend: extras.saveBlend ?? true,
    device: extras.device ?? "auto",
    ...(extras.blenderPath ? { blender: extras.blenderPath } : {}),
  };
}

// ---------------------------------------------------------------------------------------------- HTTP
async function api<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`/api${path}`, {
      method, signal, cache: "no-store",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Error("The Fairbeam server is not reachable");
  }
  const text = await r.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* below */ }
  if (!r.ok) throw new Error((data as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
  return data as T;
}

/** Where Blender is (Settings path, FAIRBEAM_BLENDER, PATH, the usual install folder) and which version. */
export function detectBlender(path = ""): Promise<BlenderInfo> {
  return api<BlenderInfo>("GET", `/blender${path ? `?path=${encodeURIComponent(path)}` : ""}`);
}

export function blenderFileUrl(design: string, name: string): string {
  return `/api/renders/${encodeURIComponent(design)}/file/${encodeURIComponent(name)}`;
}

interface RawJob {
  id: string; design: string; status: BlenderRenderProgress["status"]; stage: string; progress: number;
  angle_index: number; angle_count: number; angle: string; sample: number; samples: number; device: string; note: string;
  images: BlenderImage[]; blend: string | null; folder: string; error: string | null; elapsed_s: number;
  image_seconds: number[]; blender: BlenderRenderProgress["blender"];
}
export function progressFromJob(j: RawJob): BlenderRenderProgress {
  return {
    id: j.id, design: j.design, status: j.status, stage: j.stage, progress: j.progress, angleIndex: j.angle_index,
    angleCount: j.angle_count, angle: j.angle, sample: j.sample, samples: j.samples, device: j.device, note: j.note,
    images: j.images, blend: j.blend, folder: j.folder, error: j.error, elapsedS: j.elapsed_s,
    imageSeconds: j.image_seconds, blender: j.blender,
  };
}

/** Starts a Blender render and follows it. Progress arrives through `onProgress` (about every 400 ms, and once at the end). */
export function renderWithBlender(options: RenderOptions, design: Design | null, extras: BlenderRenderExtras = {}): BlenderRenderRun {
  let jobId: string | null = null;
  let cancelled = false;
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const result = (async () => {
    let bundle = extras.bundle;
    if (!bundle) {
      if (!design) throw new Error("renderWithBlender needs a design or its geometry bundle");
      const { api: runnerApi } = await import("../runner/api.ts");
      bundle = (await runnerApi.previewDesign(design, {}, extras.signal)).bundle;
    }
    if (cancelled) throw new DOMException("cancelled", "AbortError");
    const request = await buildBlenderRequest(options, design, bundle, extras);
    const created = await api<RawJob>("POST", "/render-jobs", request, extras.signal);
    jobId = created.id;
    let last = progressFromJob(created);
    extras.onProgress?.(last);
    if (cancelled) void api("POST", `/render-jobs/${jobId}/cancel`, {});
    while (last.status === "queued" || last.status === "running") {
      await sleep(last.status === "queued" ? 700 : 350);
      last = progressFromJob(await api<RawJob>("GET", `/render-jobs/${jobId}`, undefined, extras.signal));
      extras.onProgress?.(last);
    }
    if (last.status === "failed") throw new Error(last.error || "Blender render failed");
    return last;
  })();
  return {
    result,
    cancel: async () => {
      cancelled = true;
      if (jobId) await api("POST", `/render-jobs/${jobId}/cancel`, {}).catch(() => undefined);
    },
  };
}

/** Ask the server to open the images' folder (its answer: the folder's absolute path), or the saved .blend in Blender
 *  (GUI), on the computer it runs on. */
export function openRenderFolder(design: string): Promise<{ id: string; dir: string }> {
  return api("POST", `/renders/${encodeURIComponent(design)}/open`, { what: "folder" });
}
export function openBlendInBlender(design: string, file: string, blenderPath = ""): Promise<{ ok: true }> {
  return api("POST", `/renders/${encodeURIComponent(design)}/open`, { what: "blend", file, ...(blenderPath ? { blender: blenderPath } : {}) });
}

/** Open blender.org/download in the system browser (the server opens its one fixed address). */
export async function openBlenderDownload(): Promise<void> {
  const url = "https://www.blender.org/download/";
  try {
    const r = await api<{ opened: boolean }>("POST", "/blender/open-download", {});
    if (!r.opened) window.open(url, "_blank", "noopener,noreferrer");
  } catch { window.open(url, "_blank", "noopener,noreferrer"); }
}

// ---------------------------------------------------------------------------------------------- BlenderEngine
/** The design the pictures belong to, as a plain object (names and material library entries steer the Blender look), when
 *  the app is in the designer; null for an opened result bundle. Loaded on demand: nothing here is needed at startup. */
async function currentDesign(): Promise<Design | null> {
  try {
    const [{ appMode }, { draft }, { unwrap }] = await Promise.all([import("../workspace"), import("../designer/store"), import("solid-js/store")]);
    return appMode() === "design" ? JSON.parse(JSON.stringify(unwrap(draft))) as Design : null;
  } catch { return null; }
}

/** The Render image dialog's contract for rendering through Blender (engine.ts): the pictures come back when all angles are done. */
export const blenderEngine: BlenderEngine = {
  async render(request) {
    const design = await currentDesign();
    const { blenderPath } = await import("../lib/generalSettings.ts").then(m => ({ blenderPath: m.readGeneralSettings().blenderPath.trim() }));
    const run = renderWithBlender(request.options, design, {
      bundle: request.bundle, designId: request.designId, view: request.view, quality: blenderQualityFor(request.options.quality),
      blenderPath: blenderPath || undefined, signal: request.signal,
      onProgress: p => request.onProgress?.(p.images.length, Math.max(p.angleCount, request.options.angles.length), (p.angle || request.options.angles[0]) as RenderAngle),
    });
    const onAbort = () => void run.cancel();
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await run.result;
      if (result.status === "cancelled") throw new DOMException("cancelled", "AbortError");
      return result.images.map((image): EngineImage => ({ angle: image.angle as RenderAngle, name: image.name, url: image.url, path: image.path }));
    } finally {
      request.signal.removeEventListener("abort", onAbort);
    }
  },
};
