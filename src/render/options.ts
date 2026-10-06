// The options of a rendered image, kept in one plain object so every renderer reads the same thing:
// the in-app one (src/render/capture.ts, three.js) and the Blender one (src/render/blender.ts and a
// server endpoint, which take this object as it is).
//
// No three.js and no DOM here: this file is loaded straight into Node by scripts/check-render.mjs.
import type { ViewName } from "../scene/cameraViews.ts";

/** Every named angle of the viewport's camera presets, plus the camera as it is now. */
export type RenderAngle = ViewName | "current";
export type RenderBackground = "transparent" | "studio" | "dark";
/** "connector": a procedural SMA where one fits (a board edge, a ground plane), else the marker. */
export type RenderPorts = "connector" | "marker" | "hidden";
export type SolderMask = "none" | "green";
export type RenderProjection = "perspective" | "orthographic";
/** "app": drawn here with three.js; "blender": the user's Blender (src/render/blender.ts). */
export type RenderEngine = "app" | "blender";
/** draft: no supersampling; standard: 2x supersampling; high: 3x (each capped by the GPU and a pixel budget). */
export type RenderQuality = "draft" | "standard" | "high";

export interface RenderOptions {
  angles: RenderAngle[];
  /** output size in pixels */
  width: number;
  height: number;
  background: RenderBackground;
  ports: RenderPorts;
  solderMask: SolderMask;
  groundShadow: boolean;
  projection: RenderProjection;
  engine: RenderEngine;
  quality: RenderQuality;
}

/** The angles in the order the dialog lists and renders them (the viewport's presets, then "current view"). */
export const RENDER_ANGLES: readonly RenderAngle[] = ["iso", "top", "front", "right", "back", "left", "bottom", "current"];
export const RENDER_BACKGROUNDS: readonly RenderBackground[] = ["transparent", "studio", "dark"];
export const RENDER_PORTS: readonly RenderPorts[] = ["connector", "marker", "hidden"];
export const RENDER_QUALITIES: readonly RenderQuality[] = ["draft", "standard", "high"];

/** Output sizes offered as presets (the dialog adds "custom"). */
export const RESOLUTION_PRESETS = [
  { id: "fullhd", width: 1920, height: 1080 },
  { id: "uhd", width: 3840, height: 2160 },
] as const;

export const MIN_SIDE = 64;
export const MAX_SIDE = 8192;

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  angles: ["iso"],
  width: 1920,
  height: 1080,
  background: "studio",
  ports: "connector",
  solderMask: "none",
  groundShadow: true,
  projection: "perspective",
  engine: "app",
  quality: "standard",
};

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

function side(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.round(n))) : fallback;
}

/** A complete, valid options object from anything (a stored draft, a half-filled form, the Blender
 *  engine's request): unknown values fall back to the defaults, sizes are rounded and clamped,
 *  angles are deduplicated and put in the standard order, and at least one angle is always kept. */
export function normalizeRenderOptions(input: Partial<Record<keyof RenderOptions, unknown>> = {}): RenderOptions {
  const d = DEFAULT_RENDER_OPTIONS;
  const asked = Array.isArray(input.angles) ? input.angles : d.angles;
  let angles = RENDER_ANGLES.filter((a) => asked.includes(a));
  if (!angles.length) angles = [...d.angles];
  return {
    angles,
    width: side(input.width, d.width),
    height: side(input.height, d.height),
    background: pick(input.background, RENDER_BACKGROUNDS, d.background),
    ports: pick(input.ports, RENDER_PORTS, d.ports),
    solderMask: pick(input.solderMask, ["none", "green"] as const, d.solderMask),
    groundShadow: typeof input.groundShadow === "boolean" ? input.groundShadow : d.groundShadow,
    projection: pick(input.projection, ["perspective", "orthographic"] as const, d.projection),
    engine: pick(input.engine, ["app", "blender"] as const, d.engine),
    quality: pick(input.quality, RENDER_QUALITIES, d.quality),
  };
}

/** The preset id whose size is this one, or "custom". */
export function resolutionPreset(width: number, height: number): string {
  return RESOLUTION_PRESETS.find((p) => p.width === width && p.height === height)?.id ?? "custom";
}

/** How a render is drawn at a requested size: the supersampling factor and whether the size can be
 *  honoured. The factor is the quality's (1, 2, 3), reduced until the drawn image fits `maxSide` (the
 *  GPU's largest renderbuffer) and `maxPixels`, and never below 1. */
export function supersampling(options: Pick<RenderOptions, "width" | "height" | "quality">, maxSide = 8192, maxPixels = 36_000_000): number {
  const wanted = options.quality === "high" ? 3 : options.quality === "standard" ? 2 : 1;
  const bySide = maxSide / Math.max(options.width, options.height);
  const byPixels = Math.sqrt(maxPixels / (options.width * options.height));
  const factor = Math.min(wanted, bySide, byPixels);
  // whole steps only: a fractional factor would resample the picture unevenly
  return Math.max(1, Math.floor(factor * 2) / 2);
}

/** Letters, digits, dot, dash and underscore only: a name that is the same on every file system and
 *  safe as a server path component. */
export function renderStem(name: string): string {
  return (name || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "").slice(0, 60) || "design";
}

/** "20261004-153012": local time, sorts by time as a name. */
export function renderTimestamp(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(date.getFullYear(), 4)}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/** `<design>_<angle>_<timestamp>.png` (the workspace folder renders/<design-id>/ holds them). */
export function renderFileName(design: string, angle: RenderAngle, date: Date): string {
  return `${renderStem(design)}_${angle}_${renderTimestamp(date)}.png`;
}

/** The design's folder name below the workspace's renders/ (the server applies the same rule). */
export function renderFolderId(designId: string): string {
  return renderStem(designId).replace(/\./g, "_");
}

/** renders/<design-id>, relative to the workspace. */
export function renderFolder(designId: string): string {
  return `renders/${renderFolderId(designId)}`;
}
