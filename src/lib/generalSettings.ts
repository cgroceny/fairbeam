import type { Theme } from "../state";
import { APPEARANCE_OPTIONS, CUSTOM_COLORS, COLOR_DEFAULTS, validCustomColor, validColorSettings, type ColorSettings } from "./appearanceOptions.ts";

/** language: "system" follows the OS / browser language (src/i18n) */
/** threads: 0 means Auto (the server picks from the host and the grid size); 1.. is a manual choice */
export const AUTO_THREADS = 0;
export type GeneralSettings = ColorSettings & { theme: Theme; uiFont: "plex" | "system" | "arial"; monoFont: "plex" | "system" | "consolas"; engine: "cpu" | "gpu"; threads: number; meshMode: "legacy" | "auto"; confirmShapes: boolean; units: "standard" | "compact"; language: "system" | "en" | "tr"; decimals: "language" | "point" | "comma"; blenderPath: string };
export const GENERAL_SETTINGS_KEY = "fairbeam.generalSettings";
export const GENERAL_DEFAULTS: GeneralSettings = { ...COLOR_DEFAULTS, theme: "system", uiFont: "plex", monoFont: "plex", engine: "cpu", threads: AUTO_THREADS, meshMode: "legacy", confirmShapes: true, units: "standard", language: "system", decimals: "language", blenderPath: "" };
/** Run's remembered choice is deliberately separate from the legacy Settings key below. */
export const RUN_THREADS_KEY = "fairbeam.run.threads";
/** Run's remembered value when the user picked Auto explicitly (a number otherwise). */
export const RUN_THREADS_AUTO = "auto";
/** Set once the old untouched default of 4 threads was turned into Auto (0.5.4). */
export const THREADS_MIGRATED_KEY = "fairbeam.threads.autoMigrated";
/** The thread choice a run starts with: the live choice, else the remembered Run choice, else the
 * Settings default; 0 is Auto. `auto` says the live / remembered choice is an explicit Auto (their
 * number is 0 when unset). Without any of them the server's adaptive default (Auto too). */
export function chooseRunThreads(cpuCount: number, live: number, remembered: number, settingsDefault: number, serverDefault: number,
  auto: { live?: boolean; remembered?: boolean } = {}): number {
  const clamp = (n: number) => Math.max(1, Math.min(cpuCount, n));
  if (Number.isInteger(live) && live > 0) return clamp(live);
  if (auto.live) return AUTO_THREADS;
  if (Number.isInteger(remembered) && remembered > 0) return clamp(remembered);
  if (auto.remembered) return AUTO_THREADS;
  if (Number.isInteger(settingsDefault) && settingsDefault > 0) return clamp(settingsDefault);
  if (settingsDefault === AUTO_THREADS) return AUTO_THREADS;
  return clamp(Number.isInteger(serverDefault) && serverDefault > 0 ? serverDefault : 1);
}
const legacyKeys = { theme: "fairbeam.theme", engine: "fairbeam.engine", threads: "fairbeam.threads", meshMode: "fairbeam.mesh.mode", draw: "fairbeam.designer.draw" };
function valid(v: unknown): v is Partial<GeneralSettings> {
  if (!v || typeof v !== "object") return false;
  const x = v as Record<string, unknown>;
  return validColorSettings(x) && (x.theme === undefined || ["system", "light", "dark"].includes(String(x.theme))) &&
    (x.uiFont === undefined || ["plex", "system", "arial"].includes(String(x.uiFont))) &&
    (x.monoFont === undefined || ["plex", "system", "consolas"].includes(String(x.monoFont))) &&
    (x.engine === undefined || ["cpu", "gpu"].includes(String(x.engine))) &&
    (x.threads === undefined || (Number.isInteger(x.threads) && Number(x.threads) >= 0)) &&
    (x.meshMode === undefined || ["legacy", "auto"].includes(String(x.meshMode))) &&
    (x.confirmShapes === undefined || typeof x.confirmShapes === "boolean") &&
    (x.units === undefined || ["standard", "compact"].includes(String(x.units))) &&
    (x.language === undefined || ["system", "en", "tr"].includes(String(x.language))) &&
    (x.decimals === undefined || ["language", "point", "comma"].includes(String(x.decimals))) &&
    (x.blenderPath === undefined || (typeof x.blenderPath === "string" && x.blenderPath.length <= 1024));
}
function availableStorage() {
  try { return localStorage; } catch { return undefined; }
}
export function readGeneralSettings(storage?: Pick<Storage, "getItem" | "setItem">): GeneralSettings {
  storage ??= availableStorage();
  if (!storage) return { ...GENERAL_DEFAULTS };
  let saved: Partial<GeneralSettings> = {};
  try {
    const raw = storage.getItem(GENERAL_SETTINGS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        // Unknown appearance preferences recover independently, preserving existing settings.
        const candidate = { ...(parsed as Record<string, unknown>) };
        if (!["system", "light", "dark"].includes(String(candidate.theme))) delete candidate.theme;
        if (!["plex", "system", "arial"].includes(String(candidate.uiFont))) delete candidate.uiFont;
        if (!["plex", "system", "consolas"].includes(String(candidate.monoFont))) delete candidate.monoFont;
        if (typeof candidate.blenderPath !== "string") delete candidate.blenderPath;
        for (const [key, options] of Object.entries(APPEARANCE_OPTIONS)) if (!(options as readonly unknown[]).includes(candidate[key])) delete candidate[key];
        for (const key of CUSTOM_COLORS) if (!validCustomColor(candidate[key])) delete candidate[key];
        if (valid(candidate)) saved = candidate;
      }
    }
  } catch { /* recover from legacy keys */ }
  try { if (!saved.theme) { const t = storage.getItem(legacyKeys.theme); if (["system", "light", "dark"].includes(t ?? "")) saved.theme = t as Theme; } } catch { /* optional storage */ }
  try { if (saved.threads === undefined) { const n = Number(storage.getItem(legacyKeys.threads)); if (Number.isInteger(n) && n > 0) saved.threads = n; } } catch { /* optional storage */ }
  try { const e = storage.getItem(legacyKeys.engine); if (!saved.engine && (e === "cpu" || e === "gpu")) saved.engine = e; } catch { /* optional storage */ }
  try { const m = storage.getItem(legacyKeys.meshMode); if (!saved.meshMode && (m === "auto" || m === "design")) saved.meshMode = m === "auto" ? "auto" : "legacy"; } catch { /* optional storage */ }
  try { if (saved.confirmShapes === undefined) { const d = JSON.parse(storage.getItem(legacyKeys.draw) ?? "{}"); if (typeof d.confirm === "boolean") saved.confirmShapes = d.confirm; } } catch { /* optional storage */ }
  // One-time migration: Settings used to default to 4 threads, which bypassed the server's adaptive
  // default. A stored 4 cannot be told apart from a deliberate choice of 4, so it becomes Auto once;
  // the user can pick 4 again and it then stays. Other numbers are never touched.
  try {
    if (storage.getItem(THREADS_MIGRATED_KEY) === null) {
      if (saved.threads === 4) { saved.threads = AUTO_THREADS; storage.setItem(legacyKeys.threads, String(AUTO_THREADS)); }
      storage.setItem(THREADS_MIGRATED_KEY, "1");
      const raw = storage.getItem(GENERAL_SETTINGS_KEY);
      if (raw && saved.threads === AUTO_THREADS) { const p: unknown = JSON.parse(raw); if (p && typeof p === "object") storage.setItem(GENERAL_SETTINGS_KEY, JSON.stringify({ ...(p as object), threads: AUTO_THREADS })); }
    }
  } catch { /* optional storage */ }
  return { ...GENERAL_DEFAULTS, ...saved };
}
export function writeGeneralSettings(value: GeneralSettings, storage?: Pick<Storage, "getItem" | "setItem">): void {
  storage ??= availableStorage();
  if (!storage) throw new Error("Settings storage is unavailable");
  if (!valid(value) || Object.keys(GENERAL_DEFAULTS).some((k) => (value as any)[k] === undefined)) throw new Error("Invalid general settings");
  storage.setItem(GENERAL_SETTINGS_KEY, JSON.stringify(value));
  storage.setItem(legacyKeys.theme, value.theme); storage.setItem(legacyKeys.engine, value.engine); storage.setItem(legacyKeys.threads, String(value.threads));
  storage.setItem(legacyKeys.meshMode, value.meshMode === "auto" ? "auto" : "design");
  let old: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(storage.getItem(legacyKeys.draw) ?? "{}"); if (parsed && typeof parsed === "object") old = parsed as Record<string, unknown>; } catch { /* repair malformed legacy preference */ }
  storage.setItem(legacyKeys.draw, JSON.stringify({ ...old, confirm: value.confirmShapes }));
}

/** Keep Header's authoritative theme choice in an existing settings record without
 * migrating/replacing unrelated values. Missing/malformed records still use legacy fallback. */
export function syncSavedTheme(theme: Theme, storage?: Pick<Storage, "getItem" | "setItem">): void {
  storage ??= availableStorage();
  if (!storage) return;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(GENERAL_SETTINGS_KEY) ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      storage.setItem(GENERAL_SETTINGS_KEY, JSON.stringify({ ...parsed, theme }));
  } catch { /* Theme remains usable per session when optional storage fails. */ }
}
