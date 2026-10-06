export const MENU_ACTION_IDS = [
  "file-new", "file-import-cst", "file-import-pcb", "file-open", "file-save", "file-save-as", "export-cst", "export-python", "export-touchstone", "export-package", "file-close", "settings",
  "edit-undo", "edit-redo", "edit-delete",
  "view-start", "view-design", "view-examples", "view-tree", "view-dock", "view-properties", "view-ribbon", "view-iso", "view-top", "view-front", "view-right", "view-bottom", "view-back", "view-left", "view-zoom-in", "view-zoom-out", "view-zoom-reset",
  "help-shortcuts", "about",
] as const;
export type MenuActionId = typeof MENU_ACTION_IDS[number] | `file-open-recent:${string}`;
const exact = new Set<string>(MENU_ACTION_IDS);
export function isMenuActionId(value: unknown): value is MenuActionId {
  if (typeof value !== "string") return false;
  if (exact.has(value)) return true;
  if (!value.startsWith("file-open-recent:")) return false;
  const encoded = value.slice("file-open-recent:".length);
  if (!encoded || encoded.length > 2048) return false;
  try { return /^[a-z][a-z0-9_]{1,40}$/.test(decodeURIComponent(encoded)); } catch { return false; }
}
export function createMenuActionRouter(handlers: Partial<Record<MenuActionId, (id?: MenuActionId) => void>>,
  report: (message: string) => void = () => {}) {
  return (raw: string) => {
    // Native eval passes the JavaScript string itself; older callers may pass its JSON encoding.
    let id: unknown = raw;
    if (!isMenuActionId(id)) {
      try { id = JSON.parse(raw); } catch { report("Ignored an invalid menu action."); return false; }
    }
    if (!isMenuActionId(id)) { report("This menu action is not available."); return false; }
    const handler = id.startsWith("file-open-recent:") ? handlers["file-open-recent:"] : handlers[id];
    if (!handler) { report(`“${id}” is unavailable in this context.`); return false; }
    handler(id); return true;
  };
}
