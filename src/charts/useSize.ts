import { createSignal, onCleanup, onMount } from "solid-js";

/** The element's content size, followed with a ResizeObserver. A change after the first size is
 * applied in the next animation frame: a chart redrawn inside the observer's callback can change the size it observes
 * (a live chart in the dock while notes come and go above it), which the browser reports as
 * "ResizeObserver loop completed with undelivered notifications". */
export function useSize(el: () => HTMLElement | undefined) {
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  onMount(() => {
    const node = el();
    if (!node) return;
    let frame = 0;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      const next = { w: Math.floor(r.width), h: Math.floor(r.height) };
      const apply = () => { const now = size(); if (now.w !== next.w || now.h !== next.h) setSize(next); };
      cancelAnimationFrame(frame);
      // the first size at once, so a chart draws in its first frame; later changes a frame later
      if (!size().w && !size().h) apply();
      else frame = requestAnimationFrame(apply);
    });
    ro.observe(node);
    onCleanup(() => { cancelAnimationFrame(frame); ro.disconnect(); });
  });
  return size;
}
