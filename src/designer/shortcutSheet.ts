// The Keyboard shortcuts sheet (ShortcutHelp.tsx) as data: the rows grouped by what they act on, the
// most used first in each group, and the chords a browser keeps for itself marked "desktop app only"
// in the web build (Ctrl+T opens a tab, Ctrl+W closes it, Ctrl+Tab switches tabs: the page never
// receives them). No DOM, so check-shortcuts.mjs runs it for real.
import type { ShortcutId } from "./shortcuts.ts";

export type SheetGroup = "edit" | "view" | "panels" | "tools" | "boolean" | "mouse";

/** a row that is not in the shortcut table (a mouse gesture, a key inside one tool or the tree) */
export type ExtraId = "applyBoolean" | "drawSolid" | "base" | "cameras" | "mainTabsLocal" | "closeShown" | "orbit" | "select3d" | "treeNav" | "treeMulti";

export interface SheetRow { id: ShortcutId | ExtraId; label: string; context: string; key: string; desktopOnly: boolean }

/** group order and, in each group, the row order: the common commands first */
export const SHEET_ORDER: Readonly<Record<SheetGroup, readonly (ShortcutId | ExtraId)[]>> = {
  edit: ["save", "undo", "redo", "saveAs", "duplicate", "delete", "rename", "transform", "close", "cancel"],
  view: ["fit", "cameras", "mainTabs", "mainTabsLocal", "closeShown", "markers"],
  panels: ["help", "tree", "dock", "side", "ribbon", "panes"],
  tools: ["run", "brick", "drawSolid", "base", "extrudeFace", "export"],
  boolean: ["booleanAdd", "booleanSubtract", "booleanIntersect", "booleanInsert", "applyBoolean"],
  mouse: ["orbit", "select3d", "treeNav", "treeMulti"],
};

/** chords the browser keeps: Ctrl/⌘+T, Ctrl/⌘+W, Ctrl+Tab */
export const BROWSER_RESERVED: ReadonlySet<ShortcutId> = new Set<ShortcutId>(["transform", "close", "mainTabs"]);

type Entry = { label: string; context: string; key: string };

/** The sheet's groups with their rows. In the browser (desktop false) a reserved chord stays listed,
 * marked desktop-only, so the user learns why it does nothing there. */
export function shortcutSheet(table: Record<ShortcutId, Entry>, extras: Record<ExtraId, Entry>, desktop: boolean): { group: SheetGroup; rows: SheetRow[] }[] {
  const entry = (id: ShortcutId | ExtraId): Entry | undefined => (id in table ? table[id as ShortcutId] : extras[id as ExtraId]);
  return (Object.keys(SHEET_ORDER) as SheetGroup[]).map((group) => ({
    group,
    rows: SHEET_ORDER[group].flatMap((id) => {
      const e = entry(id);
      return e ? [{ id, label: e.label, context: e.context, key: e.key, desktopOnly: !desktop && BROWSER_RESERVED.has(id as ShortcutId) }] : [];
    }),
  }));
}
