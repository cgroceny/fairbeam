import { commandModifier, isMacPlatform, modifierShortcut } from "../lib/shortcut.ts";
import { t } from "../i18n/index.ts";

export type ShortcutId = "transform" | "duplicate" | "delete" | "rename" | "save" | "saveAs" | "undo" | "redo" | "close" | "fit" | "brick" | "export" | "run" | "cancel" | "help" | "extrudeFace" | "markers" | "tree" | "dock" | "side" | "ribbon" | "mainTabs" | "panes"
  | "booleanAdd" | "booleanSubtract" | "booleanIntersect" | "booleanInsert";

/** One entry: its label and context are read in the current language each time (getters), so the
 *  table can be built once at import time. */
function entry<I extends ShortcutId>(id: I, key: string) {
  return {
    id, key,
    get label() { return t(`shortcuts.${id}.label`); },
    get context() { return t(`shortcuts.${id}.context`); },
  } as { readonly id: I; readonly key: string; readonly label: string; readonly context: string };
}

/** The shortcut table with the labels of one platform (macOS: ⌘, ⇧⌘Z, ⌫; elsewhere Ctrl+, Shift+Ctrl+Z, Delete). */
export function shortcutTable(mac = isMacPlatform()) {
  const m = (key: string) => modifierShortcut(key, mac);
  return {
    transform: entry("transform", m("T")),
    duplicate: entry("duplicate", m("D")),
    delete: entry("delete", mac ? "⌫" : "Delete"),
    rename: entry("rename", "F2"),
    save: entry("save", m("S")),
    saveAs: entry("saveAs", mac ? "⇧⌘S" : "Shift+Ctrl+S"),
    undo: entry("undo", m("Z")),
    redo: entry("redo", `${m("Y")} / ${mac ? "⇧⌘Z" : "Shift+Ctrl+Z"}`),
    close: entry("close", m("W")),
    fit: entry("fit", "Space / F"),
    brick: entry("brick", m("B")),
    extrudeFace: entry("extrudeFace", "S"),
    markers: entry("markers", "M"),
    export: entry("export", m("E")),
    run: entry("run", m("Enter")),
    cancel: entry("cancel", "Esc"),
    help: entry("help", `? / ${m("/")}`),
    tree: entry("tree", mac ? "⌃⇧1" : "Ctrl+Shift+1"),
    dock: entry("dock", mac ? "⌃⇧2" : "Ctrl+Shift+2"),
    side: entry("side", mac ? "⌃⇧3" : "Ctrl+Shift+3"),
    ribbon: entry("ribbon", mac ? "⌃F1" : "Ctrl+F1"),
    mainTabs: entry("mainTabs", mac ? "⌃Tab / ⌃⇧Tab" : "Ctrl+Tab / Ctrl+Shift+Tab"),
    panes: entry("panes", "F6 / Shift+F6"),
    booleanAdd: entry("booleanAdd", "+"),
    booleanSubtract: entry("booleanSubtract", "−"),
    booleanIntersect: entry("booleanIntersect", "*"),
    booleanInsert: entry("booleanInsert", "/"),
  } satisfies Record<ShortcutId, { id: ShortcutId; label: string; key: string; context: string }>;
}
export const SHORTCUTS = shortcutTable();
export type Shortcut = ReturnType<typeof shortcutTable>[ShortcutId];

type KeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & Partial<Pick<KeyboardEvent, "code">>;

/** Canonical event matching shared by every designer command entry point. On macOS only ⌘ is the
 *  command modifier (Ctrl+D is not Duplicate there); elsewhere only Ctrl. */
export function matchesShortcut(id: ShortcutId, e: KeyEvent, mac = isMacPlatform()): boolean {
  const key = e.key.toLowerCase(), mod = commandModifier(e, mac), plain = !e.metaKey && !e.ctrlKey && !e.altKey;
  switch (id) {
    case "transform": case "duplicate": case "save": case "close": case "brick": case "export":
      return mod && !e.altKey && !e.shiftKey && key === ({ transform: "t", duplicate: "d", save: "s", close: "w", brick: "b", export: "e" } as const)[id];
    // the browser may keep Shift+Ctrl+S for itself (a web capture); the desktop menu has it too
    case "saveAs": return mod && !e.altKey && e.shiftKey && key === "s";
    case "undo": return mod && !e.altKey && key === "z" && !e.shiftKey;
    case "redo": return mod && !e.altKey && (key === "y" && !e.shiftKey || key === "z" && e.shiftKey);
    // the Mac delete key sends Backspace; Delete is the forward delete (fn+delete)
    case "delete": return plain && !e.shiftKey && (e.key === "Delete" || e.key === "Backspace");
    case "rename": return plain && e.key === "F2";
    case "fit": return plain && (e.key === " " || key === "f");
    case "run": return mod && !e.altKey && !e.shiftKey && e.key === "Enter";
    case "extrudeFace": return plain && key === "s";
    case "markers": return plain && key === "m";
    case "cancel": return e.key === "Escape";
    // "?" may need AltGr (Ctrl+Alt on Windows) on some layouts: any modifiers
    case "help": return e.key === "?" || mod && !e.altKey && key === "/";
    case "tree": return e.ctrlKey && !e.metaKey && e.shiftKey && !e.altKey && (e.code === "Digit1" || e.key === "1");
    case "dock": return e.ctrlKey && !e.metaKey && e.shiftKey && !e.altKey && (e.code === "Digit2" || e.key === "2");
    case "side": return e.ctrlKey && !e.metaKey && e.shiftKey && !e.altKey && (e.code === "Digit3" || e.key === "3");
    case "panes": return e.key === "F6" && !e.metaKey && !e.ctrlKey && !e.altKey;
    case "ribbon": return e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key === "F1";
    // Ctrl on every platform (⌘Tab is the macOS app switcher); Shift goes backwards
    case "mainTabs": return e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab";
    // the character, whatever the layout needs for it (Shift, the numeric keypad, AltGr = Ctrl+Alt);
    // never with the command modifier alone (Ctrl+/ is the help)
    case "booleanAdd": case "booleanSubtract": case "booleanIntersect": case "booleanInsert": {
      if (e.metaKey || (e.ctrlKey && !e.altKey)) return false;
      const want = ({ booleanAdd: ["+"], booleanSubtract: ["-", "−"], booleanIntersect: ["*"], booleanInsert: ["/"] } as const)[id] as readonly string[];
      return want.includes(e.key);
    }
  }
}
