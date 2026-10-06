import { appearanceTokens, COLOR_DEFAULTS } from "./appearanceOptions.ts";
import type { GeneralSettings } from "./generalSettings";

export type AppearanceSettings = Pick<GeneralSettings, "theme" | "uiFont" | "monoFont" | "colorPreset" | "accent" | "chartPalette" | "chartWeight" | "viewportPalette" | "customAccent" | "traceColor" | "viewportColor" | "gridColor">;
export const APPEARANCE_DEFAULTS: AppearanceSettings = { ...COLOR_DEFAULTS, theme: "system", uiFont: "plex", monoFont: "plex" };
const uiFonts = {
  system: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  arial: 'Arial, Helvetica, sans-serif',
};
const monoFonts = {
  system: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  consolas: 'Consolas, "SF Mono", Menlo, monospace',
};
/** Remove overrides for Plex so the exact incumbent token stacks remain authoritative. */
export function applyFonts(value: Pick<GeneralSettings, "uiFont" | "monoFont">, root = document.documentElement): void {
  const ui = uiFonts[value.uiFont as keyof typeof uiFonts];
  const mono = monoFonts[value.monoFont as keyof typeof monoFonts];
  if (ui) root.style.setProperty("--al-font-sans", ui);
  else root.style.removeProperty("--al-font-sans");
  if (mono) root.style.setProperty("--al-font-mono", mono);
  else root.style.removeProperty("--al-font-mono");
}

let current: GeneralSettings | undefined;
let applied = new Set<string>();
let viewportSignature: string | undefined;
let viewportFrame: number | undefined;
// These are the override roles read by the viewport; chart/font roles do not affect 3D.
const viewportKeys = ["--al-viewport", "--al-viewport-grid", "--al-viewport-grid-major", "--al-focus"];

export function applyAppearance(value: GeneralSettings, root = document.documentElement): void {
  current = value;
  applyFonts(value, root);
  const dark = root.dataset.theme === "dark" || (!root.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const tokens = appearanceTokens(value, dark);
  for (const key of applied) if (!(key in tokens)) root.style.removeProperty(key);
  for (const [key, token] of Object.entries(tokens)) root.style.setProperty(key, token);
  applied = new Set(Object.keys(tokens));
  const signature = JSON.stringify([dark, ...viewportKeys.map(key => tokens[key] ?? "")]);
  const changed = viewportSignature !== undefined && signature !== viewportSignature;
  viewportSignature = signature;
  // Native color pickers can emit many input events in a single frame.
  if (changed && viewportFrame === undefined) viewportFrame = window.requestAnimationFrame(() => {
    viewportFrame = undefined;
    window.dispatchEvent(new CustomEvent("fairbeam:appearance"));
  });
}
/** Follow header/OS theme changes without changing the persisted appearance choices. */
export function watchAppearanceTheme(): void {
  const refresh = () => { if (current) applyAppearance(current); };
  const observer = new MutationObserver(refresh);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", refresh);
}
