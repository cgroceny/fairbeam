import { createSignal, onCleanup, onMount } from "solid-js";

export function useSize(el: () => HTMLElement | undefined) {
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  onMount(() => {
    const node = el();
    if (!node) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
    });
    ro.observe(node);
    onCleanup(() => ro.disconnect());
  });
  return size;
}
