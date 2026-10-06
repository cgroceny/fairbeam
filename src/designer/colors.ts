// Display colors of the 3D view: a part's own color wins over its material's, which wins over the
// theme's. A color is "#rrggbb"; anything else is ignored (the solver never sees colors).

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The color as lowercase "#rrggbb", or undefined when it is not one. */
export function validColor(c: unknown): string | undefined {
  return typeof c === "string" && HEX.test(c) ? c.toLowerCase() : undefined;
}

/** Part color over material color over the theme default. */
export function resolveColor(part: { color?: string } | undefined, material: { color?: string } | undefined, theme: string): string {
  return validColor(part?.color) ?? validColor(material?.color) ?? theme;
}

/** The theme's solid color for a metal or dielectric (read from the CSS tokens of the 3D view). */
export function themeColor(metal: boolean): string {
  const v = typeof getComputedStyle === "undefined" ? "" : getComputedStyle(document.documentElement).getPropertyValue(metal ? "--al-3d-metal" : "--al-3d-dielectric").trim();
  return HEX.test(v) ? v : metal ? "#c8a040" : "#6f9a7e";
}
