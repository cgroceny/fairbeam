// The state of the Blender render in progress (or the last one), kept outside any dialog: the render runs on the
// server in the background, so closing the dialog that started it neither stops it nor loses its images, and the
// panel finds it again when it is opened. Lazy-loaded together with BlenderRenderPanel.
import { createSignal } from "solid-js";
import type { Bundle } from "../types";
import type { Design } from "../designer/types";
import { renderWithBlender, type BlenderQuality, type BlenderRenderProgress, type BlenderRenderRun } from "./blender.ts";
import type { RenderOptions } from "./options.ts";
import type { ViewState } from "./frame.ts";

const [progress, setProgress] = createSignal<BlenderRenderProgress | null>(null);
const [failure, setFailure] = createSignal<string | null>(null);
const [starting, setStarting] = createSignal(false);
let current: BlenderRenderRun | null = null;

/** The latest progress snapshot of the running or last finished Blender render (null before any). */
export const blenderProgress = progress;
/** The message of the last failed start or render, cleared by the next start. */
export const blenderFailure = failure;
export const blenderBusy = () => starting() || progress()?.status === "queued" || progress()?.status === "running";

export interface StartOptions { bundle?: Bundle; designId?: string; view?: ViewState | null; quality?: BlenderQuality; saveBlend?: boolean; device?: "auto" | "cpu" | "gpu"; blenderPath?: string }

/** Starts a render unless one is already running. Resolves when it ended (never rejects: see `blenderFailure`). */
export async function startBlenderRender(options: RenderOptions, design: Design | null, extra: StartOptions = {}): Promise<void> {
  if (blenderBusy()) return;
  setFailure(null);
  setStarting(true);
  setProgress(null);
  const run = renderWithBlender(options, design, { ...extra, onProgress: p => { setStarting(false); setProgress(p); } });
  current = run;
  try {
    await run.result;
  } catch (e) {
    setFailure(e instanceof Error ? e.message : String(e));
  } finally {
    setStarting(false);
    if (current === run) current = null;
  }
}

export async function cancelBlenderRender(): Promise<void> {
  await current?.cancel();
}

/** For tests and for forgetting a finished render. */
export function clearBlenderRender(): void {
  if (blenderBusy()) return;
  setProgress(null);
  setFailure(null);
}
