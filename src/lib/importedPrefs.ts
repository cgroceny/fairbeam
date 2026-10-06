// Before the app reads its preferences (src/main.tsx imports this first): the desktop app asks the
// shell for the viewer preferences the import from the older app brought along, once, and writes
// them to localStorage; the web demo carries its old-named keys over (src/lib/legacy.ts).
import { carryOverLegacyStorage } from "./legacy.ts";

type Store = Pick<Storage, "setItem">;
type Native = { invoke: (command: string) => Promise<unknown> };

/**
 * Write the pairs the shell handed over: `{ "fairbeam.theme": "dark", … }`. Only `fairbeam.*` keys
 * with string values are taken; anything else is ignored. Returns how many keys were written.
 */
export function applyImportedViewerPrefs(prefs: unknown, storage?: Store): number {
  if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return 0;
  let written = 0;
  try {
    storage ??= localStorage;
    for (const [key, value] of Object.entries(prefs as Record<string, unknown>)) {
      if (!key.startsWith("fairbeam.") || typeof value !== "string") continue;
      storage.setItem(key, value);
      written++;
    }
  } catch { /* storage unavailable or full: the defaults apply */ }
  return written;
}

/** The desktop shell's one-shot answer (null when there is nothing to import), or null on any failure. */
async function takeFromShell(native: Native): Promise<unknown> {
  try {
    return await Promise.race([
      native.invoke("take_imported_viewer_prefs"),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
  } catch { return null; }
}

export async function bootViewerPrefs(): Promise<void> {
  if (typeof window === "undefined") return;
  const native = (window as unknown as { __TAURI_INTERNALS__?: Native }).__TAURI_INTERNALS__;
  if (native) applyImportedViewerPrefs(await takeFromShell(native));
  else carryOverLegacyStorage();
}
