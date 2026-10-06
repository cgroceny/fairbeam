// A local copy of the unsaved draft of the open design, so that a reload, a crash or a closed
// window does not lose work: reopening the design restores it (see store.ts take()). Kept per
// workspace and design file in localStorage; every access is guarded (blocked storage).
import type { Design } from "./types";
import { currentSchema } from "../lib/legacy.ts";

export interface Backup { at: number; base: string; design: Design }
interface ScopedBackup extends Backup { version: 2; scope: string; id: string }
export const validBackupScope = (scope: unknown): scope is string => typeof scope === "string" && /^models-v1:[a-f0-9]{64}$/.test(scope);
const prefix = (id: string, scope: string) => `fairbeam:draft:v2:${scope}:${encodeURIComponent(id)}:`;
const key = (id: string, scope: string, base: string) => prefix(id, scope) + encodeURIComponent(base);
const lastKey = (scope: string) => `fairbeam:lastDesign:v2:${scope}`;
function isBackup(value: unknown): value is Backup {
  const b = value as Backup | null;
  return !!b && Number.isFinite(b.at) && b.at > 0 && typeof b.base === "string" && !!b.base
    && currentSchema(b.design?.schema) === "fairbeam.design/1" && typeof b.design.model?.id === "string"
    && Array.isArray(b.design.parts) && Array.isArray(b.design.materials) && Array.isArray(b.design.params);
}

export function writeBackup(id: string, base: string, design: Design, scope?: string) {
  if (!validBackupScope(scope)) return;
  try { localStorage.setItem(key(id, scope, base), JSON.stringify({ version: 2, scope, id, at: Date.now(), base, design } satisfies ScopedBackup)); } catch { /* storage unavailable */ }
}

/** The backup of design `id` made on top of the saved version `base`, if there is one. */
export function readBackup(id: string, base: string, scope?: string): Backup | null {
  if (!validBackupScope(scope)) return null;
  try {
    const raw = localStorage.getItem(key(id, scope, base));
    if (!raw) return null;
    const b = JSON.parse(raw) as ScopedBackup;
    if (isBackup(b) && b.version === 2 && b.scope === scope && b.id === id && b.base === base) {
      b.design.schema = "fairbeam.design/1"; // a draft kept under the older id (carried over in the web demo)
      return b;
    }
  } catch { /* storage unavailable or unreadable */ }
  return null;
}

export function clearBackup(id: string, scope?: string, base?: string) {
  if (!validBackupScope(scope)) return;
  try {
    if (base !== undefined) { localStorage.removeItem(key(id, scope, base)); return; }
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    for (const candidate of keys) if (candidate?.startsWith(prefix(id, scope))) localStorage.removeItem(candidate);
  } catch { /* storage unavailable */ }
}

/** Other saved bases need manual recovery; a newer edit must not overwrite their drafts. */
export function readOlderBackups(id: string, base: string, scope?: string): Backup[] {
  if (!validBackupScope(scope)) return [];
  const records: Backup[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const candidate = localStorage.key(i);
      if (!candidate?.startsWith(prefix(id, scope))) continue;
      const savedBase = decodeURIComponent(candidate.slice(prefix(id, scope).length));
      if (savedBase === base) continue;
      const record = readBackup(id, savedBase, scope);
      if (record) records.push(record);
    }
  } catch { /* storage unavailable */ }
  return records.sort((a, b) => b.at - a.at);
}

/** Legacy records have no proven workspace owner. Offer a download; never auto-restore/delete. */
export function readLegacyBackup(id: string): Backup | null {
  try {
    const raw = localStorage.getItem(`fairbeam:draft:${id}`);
    if (!raw) return null;
    const b: unknown = JSON.parse(raw);
    return isBackup(b) ? b : null;
  } catch { return null; }
}

// The design that was open when the page reloaded (or the dev server hot-reloaded): reopened at
// start-up so a reload does not drop the user on the Start screen. sessionStorage, so it lives as
// long as the window does; closing the design on purpose (or the window) forgets it.
export function rememberLastDesign(id: string, scope?: string) {
  if (!validBackupScope(scope)) return;
  try { sessionStorage.setItem(lastKey(scope), id); } catch { /* storage unavailable */ }
}
export function readLastDesign(scope?: string): string | null {
  if (!validBackupScope(scope)) return null;
  try { return sessionStorage.getItem(lastKey(scope)); } catch { return null; }
}
export function forgetLastDesign(scope?: string) {
  if (!validBackupScope(scope)) return;
  try { sessionStorage.removeItem(lastKey(scope)); } catch { /* storage unavailable */ }
}
