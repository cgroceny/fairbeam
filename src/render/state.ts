// The small, always-loaded part of the render feature: the switches and the options the rest of the
// app reads. Everything heavy (three.js scene, materials, capture, the dialog) is imported on first
// use, so this file stays tiny and the designer's startup is unchanged.
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { DEFAULT_RENDER_OPTIONS, normalizeRenderOptions, type RenderOptions } from "./options.ts";
import type { ViewState } from "./frame.ts";

/** The 3D viewport shows the rendered scene instead of the modelling view. */
export const [renderedView, setRenderedView] = createSignal(false);
/** The Render image dialog is open. */
export const [renderDialogOpen, setRenderDialogOpen] = createSignal(false);
/** True while the Render image dialog renders (app or Blender engine): leaving the screen must not cancel it. */
export const [renderBusy, setRenderBusy] = createSignal(false);

const KEY = "fairbeam.render.options";
function stored(): RenderOptions {
  try {
    const raw = localStorage.getItem(KEY);
    return normalizeRenderOptions(raw ? JSON.parse(raw) : {});
  } catch { return { ...DEFAULT_RENDER_OPTIONS, angles: [...DEFAULT_RENDER_OPTIONS.angles] }; }
}

/** The options of the dialog and of the rendered view (its ports, solder mask, ground shadow,
 *  background and projection follow them), remembered between sessions. */
export const [renderOptions, setRenderOptionsRaw] = createStore<RenderOptions>(stored());
export function setRenderOptions(patch: Partial<RenderOptions>): void {
  const next = normalizeRenderOptions({ ...renderOptions, ...patch });
  setRenderOptionsRaw(next);
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: keep it for this session */ }
}

// The viewport registers how to read its camera, so "current view" can be rendered
let viewProvider: (() => ViewState | null) | null = null;
export function registerViewProvider(provider: () => ViewState | null): () => void {
  viewProvider = provider;
  return () => { if (viewProvider === provider) viewProvider = null; };
}
export const currentViewState = (): ViewState | null => viewProvider?.() ?? null;

/** Asks the rendered view (when mounted) to draw again, e.g. after the options changed. */
export const RENDER_OPTIONS_EVENT = "fairbeam:render-options";
