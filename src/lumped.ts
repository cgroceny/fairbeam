/** A circuit description shared by the viewport, drawing and fabrication exports. */
export function lumpedLabel(e: { R?: number | string; L?: number | string; C?: number | string; topology?: string }): string {
  const values = (["R", "L", "C"] as const).filter((key) => e[key] !== undefined).map((key) => `${key} ${e[key]} ${key === "R" ? "Ω" : key === "L" ? "H" : "F"}`);
  return values.join(" · ") + (values.length > 1 ? ` (${e.topology ?? "parallel"})` : "");
}
