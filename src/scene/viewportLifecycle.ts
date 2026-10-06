/** Coalesces work onto one animation frame and cancels it when its owner is removed. */
export function frameTask(
  run: () => void,
  schedule: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancel: (handle: number) => void = cancelAnimationFrame,
) {
  let handle: number | null = null;
  let disposed = false;
  const request = () => {
    if (disposed || handle !== null) return;
    handle = schedule(() => {
      handle = null;
      if (!disposed) run();
    });
  };
  const runNow = () => {
    if (disposed) return;
    if (handle !== null) cancel(handle);
    handle = null;
    run();
  };
  const dispose = () => {
    disposed = true;
    if (handle !== null) cancel(handle);
    handle = null;
  };
  return { request, runNow, dispose };
}

/** Re-arm the resolution query after each monitor/zoom change, even without a CSS resize. */
export function watchPixelRatio(
  update: () => void,
  target: Pick<Window, "devicePixelRatio" | "matchMedia"> = window,
): () => void {
  let query: MediaQueryList;
  const changed = () => {
    query?.removeEventListener("change", changed);
    query = target.matchMedia(`(resolution: ${target.devicePixelRatio}dppx)`);
    query.addEventListener("change", changed);
    update();
  };
  changed();
  return () => query.removeEventListener("change", changed);
}

/** Keep feed glyphs visible without letting a two-line preview mesh dominate the model. */
export function portMarkerRadius(radius: number, xLines: readonly number[]): number {
  let spacing = Infinity;
  for (let i = 1; i < xLines.length; i++) {
    const delta = xLines[i] - xLines[i - 1];
    if (delta > 0 && delta < spacing) spacing = delta;
  }
  return Math.min(radius * 0.02, Math.max(radius * 0.006, spacing * 0.3));
}

/** Clear a development debug reference only while it still belongs to this viewport. */
export function clearOwnedDebugReference(
  target: { __fairbeam?: unknown },
  viewport: unknown,
): void {
  if (target.__fairbeam === viewport) delete target.__fairbeam;
}
