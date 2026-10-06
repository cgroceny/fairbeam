// The material a new shape starts with, on every creation path (the Shapes dialogs, the drawing tools with and
// without the confirm dialog, the plain Add shape): a metal, since new geometry is a radiator, a ground or a
// feed far more often than a substrate. The metal used last for a new solid in this design, else the first
// metal, else the caller's fallback (a new copper). Pure, no store: the checks call it with plain data.

/** The starting material of a new solid: `last` when it still exists and is a metal, else the first metal, else `fallback`. */
export function pickShapeMaterial(materials: { name: string; kind: string }[], last: string | undefined, fallback: string): string {
  const metals = materials.filter((m) => m.kind === "metal");
  if (last && metals.some((m) => m.name === last)) return last;
  return metals[0]?.name ?? fallback;
}

let lastUsed: { design: string; name: string } | null = null;
/** Remember the material a new solid was made with (per design, until the app closes). */
export function rememberShapeMaterial(design: string | undefined, name: string) {
  if (name) lastUsed = { design: design ?? "", name };
}
/** The material last used for a new solid in this design, if any. */
export function lastShapeMaterial(design: string | undefined): string | undefined {
  return lastUsed && lastUsed.design === (design ?? "") ? lastUsed.name : undefined;
}
