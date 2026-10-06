// The one clock behind the field-plane animation (Animate): while playing it steps the instant of
// the period (state.ts fieldPlanePhase), and the 3D layer and the 2D tab both follow that signal. It
// runs only while a map is on screen in Animate mode, the page is visible and the person has not
// asked the system for reduced motion; anything else pauses it.
import { createEffect, createRoot, createSignal, onCleanup } from "solid-js";
import { fieldPlaneMap, fieldPlaneMode, fieldPlanePlaying, setFieldPlanePhase, setFieldPlanePlaying } from "../state";

/** the instant advances this many degrees of the period per frame: 24 frames, one second, per period */
export const PHASE_STEP_DEG = 15;
export const FRAME_MS = 40;

/** whether the designer's 2D field-map tab is on screen (the 3D view is the other consumer) */
export const [fieldMapTabOpen, setFieldMapTabOpen] = createSignal(false);

export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Step an instant of the period: 0 <= result < 360. */
export const stepPhase = (deg: number, step = PHASE_STEP_DEG): number => (((deg + step) % 360) + 360) % 360;

createRoot(() => {
  // pause when there is nothing to animate or nobody to see it
  createEffect(() => {
    if (fieldPlanePlaying() && (fieldPlaneMode() !== "animate" || !(fieldMapTabOpen() || fieldPlaneMap() !== null))) setFieldPlanePlaying(false);
  });
  createEffect(() => {
    if (!fieldPlanePlaying()) return;
    const timer = setInterval(() => setFieldPlanePhase((p) => stepPhase(p)), FRAME_MS);
    onCleanup(() => clearInterval(timer));
  });
});

if (typeof document !== "undefined" && typeof window !== "undefined") {
  const pause = () => { if (document.hidden || prefersReducedMotion()) setFieldPlanePlaying(false); };
  document.addEventListener("visibilitychange", pause);
  window.matchMedia?.("(prefers-reduced-motion: reduce)")?.addEventListener?.("change", pause);
}
