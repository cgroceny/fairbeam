/** Small, renderer independent state for face hover and modal selection. */
export interface FaceHighlightState<T> { hover: T | null; selected: T | null }
export const emptyFaceHighlight = <T>(): FaceHighlightState<T> => ({ hover: null, selected: null });
export function hoverFace<T>(s: FaceHighlightState<T>, face: T | null): FaceHighlightState<T> { return { ...s, hover: face }; }
export function selectFace<T>(s: FaceHighlightState<T>, face: T | null): FaceHighlightState<T> { return { ...s, selected: face }; }
export function clearFaceHighlight<T>(_s: FaceHighlightState<T>): FaceHighlightState<T> { return emptyFaceHighlight<T>(); }

/** Return the unique perimeter segments of a triangle soup, removing shared triangle edges. */
export function faceBoundary(tris: readonly (readonly [number, number, number])[], digits = 7): [number, number, number][] {
  const key = (p: readonly number[]) => p.map((v) => Number(v.toFixed(digits))).join(",");
  const edges = new Map<string, { a: readonly [number, number, number]; b: readonly [number, number, number]; count: number }>();
  for (let i = 0; i + 2 < tris.length; i += 3) for (const [a, b] of [[tris[i], tris[i + 1]], [tris[i + 1], tris[i + 2]], [tris[i + 2], tris[i]]] as const) {
    const ka = key(a), kb = key(b), id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    const old = edges.get(id);
    if (old) old.count++;
    else edges.set(id, { a, b, count: 1 });
  }
  return [...edges.values()].filter((e) => e.count === 1).flatMap(({ a, b }) => [ [...a], [...b] ] as [number, number, number][]);
}
