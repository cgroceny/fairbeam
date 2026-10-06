// The user's material library ("My materials", userMaterials.ts) as app state. With the run server
// connected it lives in the workspace (GET/PUT /api/materials/user -> <workspace>/materials.json, so
// it survives a reinstall); without one (the web demo) it is kept in localStorage. Every read and
// write of the browser's storage is wrapped: it can be missing or blocked.
import { createSignal } from "solid-js";
import { api } from "../runner/api";
import { cleanUserMaterials, exportUserMaterials, importUserMaterials, newUserMaterialId, upsertByName, userMaterialFromDesign, type UserMaterial } from "./userMaterials";
import type { DesignMaterial } from "./types";
import { draft, setMessage } from "./store";
import { t } from "../i18n";

const KEY = "fairbeam.userMaterials";

export const [userMaterials, setUserMaterialsSignal] = createSignal<UserMaterial[]>([]);
/** where the list is kept now: the workspace file or this browser */
export const [userMaterialsWhere, setUserMaterialsWhere] = createSignal<"server" | "browser">("browser");
/** warnings of the last load or import: one line per skipped entry */
export const [userMaterialsWarnings, setUserMaterialsWarnings] = createSignal<string[]>([]);

function readLocal(): { materials: UserMaterial[]; skipped: string[] } {
  try {
    const text = localStorage.getItem(KEY);
    if (text) return cleanUserMaterials(JSON.parse(text));
  } catch { /* storage blocked or damaged: start empty */ }
  return { materials: [], skipped: [] };
}

function writeLocal(list: UserMaterial[]) {
  try { localStorage.setItem(KEY, JSON.stringify({ version: 1, materials: list })); } catch { /* not persisted */ }
}

let loaded: Promise<void> | null = null;

/** Read the list (server first, else this browser); the dialog calls it again each time it opens. */
export function refreshUserMaterials(): Promise<void> {
  loaded = (async () => {
    try {
      const r = await api.userMaterials();
      const { materials, skipped } = cleanUserMaterials(r.materials);
      setUserMaterialsSignal(materials);
      setUserMaterialsWarnings([...r.skipped, ...skipped]);
      setUserMaterialsWhere("server");
    } catch {
      const { materials, skipped } = readLocal();
      setUserMaterialsSignal(materials);
      setUserMaterialsWarnings(skipped);
      setUserMaterialsWhere("browser");
    }
  })();
  return loaded;
}

/** Load once (a picker that opens before anything else did). */
export function ensureUserMaterials(): Promise<void> {
  return loaded ?? refreshUserMaterials();
}

/** Keep a new list: shown at once, then written to the workspace or the browser. */
export async function commitUserMaterials(list: UserMaterial[]): Promise<void> {
  setUserMaterialsSignal(list);
  if (userMaterialsWhere() === "server") {
    try {
      await api.saveUserMaterials(list);
      return;
    } catch {
      setMessage({ tone: "warn", text: t("userMaterials.saveFailed") });
      setUserMaterialsWhere("browser");
    }
  }
  writeLocal(list);
}

/** Save design material `i` to My materials (an entry of the same name is updated). */
export async function saveDesignMaterial(i: number): Promise<void> {
  const m: DesignMaterial | undefined = draft.materials[i];
  if (!m) return;
  await ensureUserMaterials();
  const made = userMaterialFromDesign(m, newUserMaterialId(userMaterials().map((q) => q.id)));
  if ("why" in made) {
    setMessage({ tone: "warn", text: t("userMaterials.notPlain", { name: m.name, field: made.why }) });
    return;
  }
  const { list, updated } = upsertByName(userMaterials(), made.entry);
  await commitUserMaterials(list);
  setMessage({ tone: "good", text: t(updated ? "userMaterials.updated" : "userMaterials.saved", { name: m.name }) });
}

/** JSON text of the list, for the export file. */
export const userMaterialsJson = () => exportUserMaterials(userMaterials());

/** Merge an exported file into the list; returns how many were added and the skipped lines. */
export async function importUserMaterialsText(text: string): Promise<{ added: number; skipped: string[] }> {
  await ensureUserMaterials();
  const r = importUserMaterials(text, userMaterials());
  if (r.added) await commitUserMaterials(r.list);
  setUserMaterialsWarnings(r.skipped);
  return { added: r.added, skipped: r.skipped };
}
