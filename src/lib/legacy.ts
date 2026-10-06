// The names Fairbeam still reads from files, and from the browser's storage, that antenlab
// (versions up to 0.6.x) wrote. This is the one place in the viewer that knows those names; the
// readers call it. Nothing here is written to new files: a legacy schema id is turned into the
// current one when the file is read.

/** schema id written by antenlab -> the id Fairbeam writes (python/fairbeam/legacy.py LEGACY_SCHEMAS) */
export const LEGACY_SCHEMAS: Readonly<Record<string, string>> = {
  "antenlab.design/1": "fairbeam.design/1",
  "antenlab.project/1": "fairbeam.project/1",
  "antenlab.study/1": "fairbeam.study/1",
  "antenlab.optimization/1": "fairbeam.optimization/1",
  "antenlab.parameter-sweep/1": "fairbeam.parameter-sweep/1",
};

/** The Fairbeam id for a schema id, whichever program wrote it (other values come back unchanged). */
export function currentSchema<T>(schema: T): T | string {
  return typeof schema === "string" ? LEGACY_SCHEMAS[schema] ?? schema : schema;
}

export const isLegacySchema = (schema: unknown): boolean => typeof schema === "string" && schema in LEGACY_SCHEMAS;

/** `schema` is any version of a family such as "fairbeam.project/" (or its antenlab spelling). */
export function schemaFamily(schema: unknown, family: string): boolean {
  if (typeof schema !== "string") return false;
  const legacy = family.startsWith("fairbeam.") ? "antenlab." + family.slice("fairbeam.".length) : family;
  return schema.startsWith(family) || schema.startsWith(legacy);
}

/** Names that belong to the program itself (dump boxes, helper parts): a user part may not take them. */
export const RESERVED_PREFIXES = ["fairbeam_", "antenlab_"] as const;
export const isReservedName = (name: string): boolean => RESERVED_PREFIXES.some((p) => name.startsWith(p));

type Store = Pick<Storage, "length" | "key" | "getItem" | "setItem">;
/** Set once the carry-over ran, so a draft the app later clears is not copied back from the old key. */
export const CARRY_OVER_DONE_KEY = "fairbeam.legacyCarryOver";
const STORAGE_PREFIXES: readonly [string, string][] = [["antenlab.", "fairbeam."], ["antenlab:", "fairbeam:"]];

/**
 * One-time carry-over of the viewer's preferences and drafts from the old key names, for the web
 * demo, which keeps its origin when the site changes name: every `antenlab.*` and `antenlab:*`
 * entry is copied to its `fairbeam` key when that key is not there yet, once (a marker records
 * it). The old entries stay (the old site may still be open in another tab). The desktop app
 * never has old keys: it gets its preferences from the import step (take_imported_viewer_prefs).
 * Returns how many keys were copied.
 */
export function carryOverLegacyStorage(storage?: Store): number {
  let copied = 0;
  try {
    storage ??= localStorage;
    if (storage.getItem(CARRY_OVER_DONE_KEY) !== null) return 0;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k) keys.push(k); }
    for (const key of keys) {
      for (const [from, to] of STORAGE_PREFIXES) {
        if (!key.startsWith(from)) continue;
        const next = to + key.slice(from.length);
        if (storage.getItem(next) !== null) break;
        const value = storage.getItem(key);
        if (value !== null) { storage.setItem(next, value); copied++; }
        break;
      }
    }
    storage.setItem(CARRY_OVER_DONE_KEY, "1");
  } catch { /* storage unavailable or full: the defaults apply */ }
  return copied;
}
