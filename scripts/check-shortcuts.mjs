// Designer keyboard shortcuts and the modelling history list (#133). The shortcut table and its
// matcher run for real on both platforms (macOS: ⌘ only; elsewhere: Ctrl only); how DesignKeys,
// the navigation tree and the history dialog use them is checked in their sources. No DOM, no build.
//
//   node --experimental-strip-types scripts/check-shortcuts.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesShortcut, shortcutTable } from "../src/designer/shortcuts.ts";
import { commandModifier, modifierShortcut } from "../src/lib/shortcut.ts";
import { listKeyTarget } from "../src/lib/tabKeys.ts";
import { viewportChangeCloses } from "../src/lib/menuDismiss.ts";
import { BROWSER_RESERVED, SHEET_ORDER, shortcutSheet } from "../src/designer/shortcutSheet.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8").replaceAll("\r\n", "\n");
let checks = 0;
let failures = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) { failures++; console.error(`FAIL ${what}`); }
};
const eq = (got, want, what) => check(Object.is(got, want), `${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const key = (k, mods = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
const MAC = true, PC = false;

eq(matchesShortcut("tree", key("!", { code: "Digit1", ctrlKey: true, shiftKey: true }), PC), true, "Shift+1 uses its physical digit code");
eq(matchesShortcut("dock", key("@", { code: "Digit2", ctrlKey: true, shiftKey: true }), PC), true, "Shift+2 uses its physical digit code");
eq(matchesShortcut("side", key("#", { code: "Digit3", ctrlKey: true, shiftKey: true }), PC), true, "Shift+3 uses its physical digit code");
eq(matchesShortcut("side", key("3", { code: "Digit3", ctrlKey: true }), PC), false, "Ctrl+3 alone is not the properties toggle");
eq(matchesShortcut("tree", key("1", { code: "Digit1", metaKey: true, shiftKey: true }), MAC), false, "layout toggles use Ctrl, not Cmd, on macOS");
check(!read("src/App.tsx").includes('matchesShortcut("tree"'), "Layout shortcuts have one owner in DesignKeys");
check(/matchesShortcut\("side", e\)\) \{ e\.preventDefault\(\); toggleSidePanel\(\)/.test(read("src/designer/DesignWorkspace.tsx")), "DesignKeys toggles the properties panel");
const layout = read("src/designer/layoutState.ts");
const app = read("src/App.tsx"), navTree = read("src/designer/NavTree.tsx");
check(/data-layout-focus="tree-strip"/.test(app) && /data-layout-focus="tree-collapse"/.test(navTree), "tree collapse and expand share paired focus targets");
check(/data-layout-focus="side-strip"/.test(app) && /data-action="collapse-properties"/.test(layout), "inspector collapse and expand share paired focus targets");
check(/queueMicrotask\(\(\) => document\.querySelector/.test(layout), "layout shortcuts move focus after the panel state updates");

// ---- labels per platform
const mac = shortcutTable(MAC), pc = shortcutTable(PC);
eq(mac.delete.key, "⌫", "macOS: Delete reads ⌫ (the Mac delete key)");
eq(pc.delete.key, "Delete", "Windows/Linux: Delete reads Delete");
eq(mac.redo.key, "⌘Y / ⇧⌘Z", "macOS: redo reads ⇧⌘Z, not Shift+⌘Z");
eq(pc.redo.key, "Ctrl+Y / Shift+Ctrl+Z", "Windows/Linux: redo reads Shift+Ctrl+Z");
eq(mac.save.key, "⌘S", "macOS save label");
eq(pc.save.key, "Ctrl+S", "Windows/Linux save label");
eq(mac.run.key, "⌘Enter", "macOS run label");
eq(pc.run.key, "Ctrl+Enter", "Windows/Linux run label");
eq(mac.transform.context, "Designer desktop; opens Transform when geometry is selected", "macOS Transform help context");
eq(pc.transform.context, "Designer desktop; opens Transform when geometry is selected", "Windows/Linux Transform help context");
eq(pc.extrudeFace.key, "S", "face extrusion shortcut label");
eq(mac.markers.id, "markers", "marker shortcut is registered in the macOS table");
eq(pc.markers.label, "Toggle marker mode", "marker shortcut label");
eq(pc.markers.key, "M", "marker shortcut key label");
eq(pc.markers.context, "Focused plot or active Results dock; outside text fields", "marker shortcut context");
check(/import \{ SHORTCUTS \} from "\.\/shortcuts"/.test(read("src/designer/ShortcutHelp.tsx")) && /shortcutSheet\(SHORTCUTS, extras\(\), !!health\(\)\?\.desktop\)/.test(read("src/designer/ShortcutHelp.tsx")), "ShortcutHelp renders the registered shortcuts through the grouped sheet");

// ---- the sheet: grouped, common commands first, browser-reserved chords marked in the web build
{
  const sheetEntries = Object.fromEntries(Object.entries(pc).map(([id, s]) => [id, { label: s.label, context: s.context, key: s.key }]));
  const extraIds = ["applyBoolean", "drawSolid", "base", "cameras", "mainTabsLocal", "closeShown", "orbit", "select3d", "treeNav", "treeMulti"];
  const extraEntries = Object.fromEntries(extraIds.map((id) => [id, { label: id, context: "", key: "x" }]));
  const groupsOf = (desktop) => shortcutSheet(sheetEntries, extraEntries, desktop);
  const web = groupsOf(false), app = groupsOf(true);
  eq(web.map((g) => g.group).join(","), "edit,view,panels,tools,boolean,mouse", "groups: Edit, View, Panels, Tools, Boolean, Mouse");
  const placed = Object.values(SHEET_ORDER).flat();
  for (const id of Object.keys(pc)) eq(placed.filter((x) => x === id).length, 1, `shortcut ${id} is listed once in the sheet`);
  for (const id of extraIds) eq(placed.filter((x) => x === id).length, 1, `extra row ${id} is listed once`);
  eq(web.flatMap((g) => g.rows).length, Object.keys(pc).length + extraIds.length, "every row is shown in the browser too (none is hidden)");
  eq(web[0].rows.slice(0, 3).map((r) => r.id).join(","), "save,undo,redo", "Edit starts with the most used commands");
  eq(web[1].rows[0].id, "fit", "View starts with Fit");
  const reserved = web.flatMap((g) => g.rows).filter((r) => r.desktopOnly).map((r) => r.id).sort().join(",");
  eq(reserved, "close,mainTabs,transform", "in the browser: Ctrl+W, Ctrl+Tab and Ctrl+T are marked desktop app only");
  eq(app.flatMap((g) => g.rows).some((r) => r.desktopOnly), false, "the desktop app marks nothing");
  for (const id of BROWSER_RESERVED) check(/Ctrl\+(T|W|Tab)\b/.test(pc[id].key), `${id} is a browser chord (${pc[id].key})`);
  const help = read("src/designer/ShortcutHelp.tsx");
  check(/t\(`shortcuts\.group\.\$\{g\.group\}`\)/.test(help) && /<h3 class="shortcut-group-title"/.test(help), "each group has a heading");
  check(/<Show when=\{row\.desktopOnly\}><span class="shortcut-note" title=\{t\("shortcuts\.desktopOnly\.title"\)\}>\{t\("shortcuts\.desktopOnly"\)\}<\/span><\/Show>/.test(help), "a reserved chord says desktop app only, with the reason as tooltip");
  check(!/item\.id !== "transform" && item\.id !== "close"/.test(help), "the browser no longer hides Transform and Close from the sheet");
}
eq(modifierShortcut("W", MAC), "⌘W", "modifierShortcut on macOS");
eq(modifierShortcut("W", PC), "Ctrl+W", "modifierShortcut elsewhere");
for (const t of [mac, pc]) for (const [id, s] of Object.entries(t)) eq(s.id, id, `table entry ${id} carries its id`);

// ---- the command modifier: ⌘ alone on macOS, Ctrl alone elsewhere
eq(commandModifier({ metaKey: true, ctrlKey: false }, MAC), true, "macOS: ⌘ is the modifier");
eq(commandModifier({ metaKey: false, ctrlKey: true }, MAC), false, "macOS: Ctrl is not the modifier");
eq(commandModifier({ metaKey: false, ctrlKey: true }, PC), true, "Windows/Linux: Ctrl is the modifier");
eq(commandModifier({ metaKey: true, ctrlKey: false }, PC), false, "Windows/Linux: the Windows/Super key is not the modifier");

// ---- 1. Delete and Backspace both delete; never with a modifier
for (const plat of [MAC, PC]) {
  const p = plat ? "macOS" : "Windows/Linux";
  eq(matchesShortcut("delete", key("Backspace"), plat), true, `${p}: Backspace deletes the selection`);
  eq(matchesShortcut("delete", key("Delete"), plat), true, `${p}: Delete deletes the selection`);
  eq(matchesShortcut("delete", key("Backspace", { metaKey: true }), plat), false, `${p}: ⌘Backspace is not Delete`);
  eq(matchesShortcut("delete", key("Backspace", { ctrlKey: true }), plat), false, `${p}: Ctrl+Backspace is not Delete`);
  eq(matchesShortcut("delete", key("Delete", { altKey: true }), plat), false, `${p}: Alt+Delete is not Delete`);
}

// ---- 3. on macOS Ctrl does not trigger the ⌘ commands; elsewhere ⌘/Win does not trigger Ctrl ones
for (const [id, k] of [["duplicate", "d"], ["brick", "b"], ["export", "e"], ["save", "s"], ["undo", "z"], ["transform", "t"], ["close", "w"]]) {
  eq(matchesShortcut(id, key(k, { metaKey: true }), MAC), true, `macOS: ⌘${k.toUpperCase()} is ${id}`);
  eq(matchesShortcut(id, key(k, { ctrlKey: true }), MAC), false, `macOS: Ctrl+${k.toUpperCase()} is not ${id}`);
  eq(matchesShortcut(id, key(k, { ctrlKey: true }), PC), true, `Windows/Linux: Ctrl+${k.toUpperCase()} is ${id}`);
  eq(matchesShortcut(id, key(k, { metaKey: true }), PC), false, `Windows/Linux: Win+${k.toUpperCase()} is not ${id}`);
  eq(matchesShortcut(id, key(k.toUpperCase(), { metaKey: true, shiftKey: true }), MAC), false, `macOS: ⇧⌘${k.toUpperCase()} is not ${id}`);
}
eq(matchesShortcut("redo", key("Z", { metaKey: true, shiftKey: true }), MAC), true, "macOS: ⇧⌘Z redoes");
eq(matchesShortcut("redo", key("y", { metaKey: true }), MAC), true, "macOS: ⌘Y redoes");
eq(matchesShortcut("redo", key("Z", { ctrlKey: true, shiftKey: true }), MAC), false, "macOS: Shift+Ctrl+Z does not redo");
eq(matchesShortcut("redo", key("Z", { ctrlKey: true, shiftKey: true }), PC), true, "Windows/Linux: Shift+Ctrl+Z redoes");
eq(matchesShortcut("undo", key("Z", { metaKey: true, shiftKey: true }), MAC), false, "macOS: ⇧⌘Z does not undo");
eq(matchesShortcut("run", key("Enter", { metaKey: true }), MAC), true, "macOS: ⌘Enter runs");
eq(matchesShortcut("run", key("Enter", { ctrlKey: true }), MAC), false, "macOS: Ctrl+Enter does not run");
eq(matchesShortcut("run", key("Enter", { ctrlKey: true }), PC), true, "Windows/Linux: Ctrl+Enter runs");
eq(matchesShortcut("run", key("Enter"), PC), false, "plain Enter does not run");
eq(matchesShortcut("help", key("?", { shiftKey: true }), MAC), true, "? opens the help");
eq(matchesShortcut("help", key("/", { metaKey: true }), MAC), true, "macOS: ⌘/ opens the help");
eq(matchesShortcut("help", key("/", { ctrlKey: true }), MAC), false, "macOS: Ctrl+/ does not open the help");
eq(matchesShortcut("rename", key("F2"), PC), true, "F2 renames");
eq(matchesShortcut("fit", key("f"), PC), true, "F fits the view");
eq(matchesShortcut("fit", key("f", { ctrlKey: true }), PC), false, "Ctrl+F is not Fit");
eq(matchesShortcut("extrudeFace", key("s"), PC), true, "S starts face extrusion");
eq(matchesShortcut("extrudeFace", key("S", { shiftKey: true }), PC), true, "Shift+S starts face extrusion");
eq(matchesShortcut("extrudeFace", key("s", { ctrlKey: true }), PC), false, "Ctrl+S stays Save");
eq(matchesShortcut("extrudeFace", key("s", { altKey: true }), PC), false, "Alt+S stays available to the browser");
eq(matchesShortcut("markers", key("m"), PC), true, "plain M toggles marker mode");
eq(matchesShortcut("markers", key("M", { shiftKey: true }), PC), true, "Shift+M toggles marker mode");
eq(matchesShortcut("markers", key("M", { ctrlKey: true }), PC), false, "Ctrl+M does not toggle marker mode");
eq(matchesShortcut("markers", key("m", { altKey: true }), PC), false, "Alt+M does not toggle marker mode");
eq(matchesShortcut("markers", key("m", { metaKey: true }), PC), false, "Meta+M does not toggle marker mode");

// ---- DesignKeys: save before the field/dialog/tool guards, always preventDefault; platform modifier
const ws = read("src/designer/DesignWorkspace.tsx");
const keys = ws.slice(ws.indexOf("export function DesignKeys"), ws.indexOf("const onPick", ws.indexOf("export function DesignKeys")));
const at = (s) => keys.indexOf(s);
const saveLine = keys.split("\n").find((l) => l.includes('matchesShortcut("save", e)')) ?? "";
check(at('matchesShortcut("save", e)') > 0, "DesignKeys handles save");
check(/e\.preventDefault\(\)/.test(saveLine) && saveLine.indexOf("preventDefault") < saveLine.indexOf("save()"), "save always prevents the browser's Save page as");
check(!/!e\.repeat[^;]*preventDefault/.test(saveLine), "a repeated save key is still suppressed");
check(at('matchesShortcut("save", e)') < at("if (inField || inOverlay || tool()) return;"), "save runs while typing in a field, in a dialog or with a tool active");
check(at('matchesShortcut("save", e)') < at("e.defaultPrevented"), "save is not skipped by a local key handler's preventDefault");
check(/const mod = commandModifier\(e\)/.test(keys), "DesignKeys uses the platform modifier (⌘ on macOS only)");
check(!/metaKey \|\| e\.ctrlKey/.test(keys), "DesignKeys no longer accepts either modifier");
check(at('matchesShortcut("delete", e)') > at("if (inField || inOverlay || tool()) return;"), "Delete/Backspace never fire while typing or drawing");

// ---- the tree leaves ⌘/Ctrl+Enter (Run) to DesignKeys
const tree = read("src/designer/NavTree.tsx");
const treeKeys = tree.slice(tree.indexOf("const onKey: JSX.EventHandler"));
const runAt = treeKeys.indexOf('if (matchesShortcut("run", e)) return;');
check(runAt > 0 && runAt < treeKeys.indexOf('if (e.key === "Enter" || e.key === " ")'), "a focused tree row does not swallow ⌘/Ctrl+Enter");

// ---- labels come from the table (ContextMenu) so the Mac reads ⌫
check(/SHORTCUTS\.delete\.key/.test(read("src/designer/ContextMenu.tsx")), "the context menu shows the platform Delete label");

// ---- the context menu closes on a window resize or an outside scroll, without throwing
{
  // a minimal DOM stand-in: Node, a menu with one child, and the window (not a Node)
  const hadNode = "Node" in globalThis, oldNode = globalThis.Node;
  globalThis.Node = class Node { constructor(parent = null) { this.parent = parent; } contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; } };
  const page = new globalThis.Node(), menuEl = new globalThis.Node(page), item = new globalThis.Node(menuEl), win = {};
  try {
    eq(viewportChangeCloses(menuEl, { type: "resize", target: win }), true, "a window resize closes the menu (its target is not a Node)");
    eq(viewportChangeCloses(menuEl, { type: "scroll", target: page }), true, "a page scroll closes the menu");
    eq(viewportChangeCloses(menuEl, { type: "scroll", target: win }), true, "a scroll targeting the window closes the menu");
    eq(viewportChangeCloses(menuEl, { type: "scroll", target: item }), false, "a list scrolling inside the menu keeps it open");
  } finally { if (hadNode) globalThis.Node = oldNode; else delete globalThis.Node; }
  const contextSrc = read("src/designer/ContextMenu.tsx");
  check(/const viewport = \(e: Event\) => \{ if \(viewportChangeCloses\(menu, e\)\) closeContext\(false\); \};/.test(contextSrc), "the context menu's resize/scroll handler uses viewportChangeCloses");
  check(!/addEventListener\("(resize|scroll)", away/.test(contextSrc), "the pointer handler (which casts its target to a Node) is not used for resize or scroll");
}

// ---- Transform has one consistent entry point from the shortcut, ribbon and context menu
const ribbon = read("src/designer/transformRibbon.ts");
const en = JSON.parse(read("src/i18n/en.json"));
check((ribbon.match(/label: "ribbon\.transform\.transform"/g) ?? []).length === 1 && en["ribbon.transform.transform"] === "Transform…", "the ribbon exposes one Transform command");
check(/openTransform\("move", target\)/.test(ribbon), "the ribbon opens the shared Transform dialog for the selected geometry");
check(/<RGroup label=\{t\("ribbon\.transform\.group"\)\}[^>]*>[\s\S]*?<For each=\{TRANSFORM_RIBBON_ITEMS\}>/.test(ws) && en["ribbon.transform.group"] === "Transform", "the Transform ribbon group renders the shared command items");
const transformTab = ws.slice(ws.indexOf('tab.key === "transform"'), ws.indexOf('tab.key === "sim"'));
check(!transformTab.includes("<ToolsGroup />") && !transformTab.includes("<BooleanMenuButton />") && (ws.match(/<BooleanMenuButton \/>/g) ?? []).length === 1, "Boolean appears only in Modeling tools");
check(!/opItem\("move"/.test(ribbon) && ["rotate", "scale", "mirror", "array"].every((k) => new RegExp(`opItem\\("\\w+", \\w+, "${k}"\\)`).test(ribbon) && en[`ribbon.transform.${k}`] && en[`ribbon.transform.${k}Title`]) && en["ribbon.transform.array"] === "Translate copies", "the Transform tab lists the distinct operations without a duplicate Move");
const homeTab = ws.slice(ws.indexOf('tab.key === "home"'), ws.indexOf('tab.key === "model"'));
const editGroup = homeTab.slice(homeTab.indexOf('label={t("ribbon.home.clipboard")}'));
check(en["ribbon.home.clipboard"] === "Edit" && ["ribbon.home.history", "ribbon.home.undo", "ribbon.home.redo", "ribbon.home.duplicate", "common.delete"].every((k) => editGroup.includes(`t("${k}")`)), "Home groups history, undo, redo, duplicate and delete under Edit");
const context = read("src/designer/ContextMenu.tsx");
check(/openTransform\("move", props\.target\.selection\)[^]*?<Move \/> \{t\("contextMenu\.transform"\)\}/.test(context) && en["contextMenu.transform"] === "Transform…", "the context menu opens Transform for its target");
check(context.includes('setBooleanChoosing(true)') && context.includes('setBooleanOp(op)') && context.includes('role="separator"') && !context.includes('◧'), "the solid menu uses a Boolean submenu, separators and icons");
check(context.indexOf('t("contextMenu.rename"') < context.indexOf('t("contextMenu.hidePart"') && context.indexOf('t("contextMenu.moveToComponent"') < context.indexOf('t("contextMenu.duplicate"'), "the solid menu puts Rename first and Duplicate/Delete last");
const treeMenu = read("src/designer/NavTree.tsx");
check(treeMenu.includes('label:t("tree.add.metal")') && en["tree.add.metal"] === "Add metal" && en["tree.add.dielectric"] === "Add dielectric", "the Materials add menu offers dielectric and metal");
check(!treeMenu.includes('t("tree.menu.select")') && !treeMenu.includes('t("tree.menu.openParameters")') && !treeMenu.includes('t("tree.menu.compareAll")') && !treeMenu.includes('t("tree.menu.openConvergence")'), "single-action tree menus open directly");
check(/if \(matchesShortcut\("transform", e\)\)[\s\S]*?openTransform\("move", selected\)/.test(keys), "Ctrl/⌘+T opens Transform for selected geometry");

// ---- 3. history listbox keys: Up/Down stop at the ends, Home/End
eq(listKeyTarget("ArrowDown", 0, 5), 1, "Down moves to the next step");
eq(listKeyTarget("ArrowDown", 4, 5), 4, "Down stays on the last step");
eq(listKeyTarget("ArrowUp", 2, 5), 1, "Up moves to the previous step");
eq(listKeyTarget("ArrowUp", 0, 5), 0, "Up stays on the first step");
eq(listKeyTarget("Home", 3, 5), 0, "Home goes to the first step");
eq(listKeyTarget("End", 1, 5), 4, "End goes to the last step");
eq(listKeyTarget("ArrowDown", -1, 5), 0, "Down with nothing focused: first step");
eq(listKeyTarget("ArrowUp", -1, 5), 4, "Up with nothing focused: last step");
eq(listKeyTarget("ArrowDown", 0, 0), null, "empty list: no target");
for (const k of ["ArrowLeft", "ArrowRight", "Enter", " ", "Tab", "PageDown", "a"]) eq(listKeyTarget(k, 2, 5), null, `${JSON.stringify(k)} is not a listbox key`);

const hist = read("src/designer/HistoryDialog.tsx");
const listEl = hist.match(/<div class="history-list"[^>]*>/)?.[0] ?? "";
check(/role="listbox"/.test(listEl) && /onKeyDown=\{onListKey\}/.test(listEl), "the history listbox handles its arrow keys");
check(/role="option"[^>]*tabindex=\{isSelected\(\) \? 0 : -1\}/.test(hist), "roving tabindex: only the selected step is in the Tab order");
check(/listKeyTarget\(event\.key/.test(hist) && /setSelected\(all\[target\]\.index\)/.test(hist) && /\.focus\(\)/.test(hist), "selection (and so the preview) follows the focus");
check(/useModal\(\(\) => box, close, \(\) => list/.test(hist), "the dialog opens with the focus on the selected step");

// ---- 4. the preview effect tracks only the selection (no loop through the preview store, #132)
check(/createEffect\(on\(selected, \(index\) =>/.test(hist), "the history preview effect is on(selected, ...)");
check(!/createEffect\(\(\) => \{\s*const index = selected\(\)/.test(hist), "the old effect that tracked everything it read is gone");

// ---- 5. Boolean keys: + − * / by character (Shift, keypad or AltGr as the layout needs), never Ctrl alone
for (const plat of [MAC, PC]) {
  const p = plat ? "macOS" : "Windows/Linux";
  eq(matchesShortcut("booleanAdd", key("+", { shiftKey: true }), plat), true, `${p}: Shift+= (+) is Boolean add`);
  eq(matchesShortcut("booleanSubtract", key("-"), plat), true, `${p}: - is Boolean subtract`);
  eq(matchesShortcut("booleanIntersect", key("*", { shiftKey: true }), plat), true, `${p}: * is Boolean intersect`);
  eq(matchesShortcut("booleanInsert", key("/"), plat), true, `${p}: / is Boolean insert`);
  eq(matchesShortcut("booleanInsert", key("/", { ctrlKey: true }), plat), false, `${p}: Ctrl+/ is not Boolean insert`);
  eq(matchesShortcut("booleanInsert", key("/", { metaKey: true }), plat), false, `${p}: ⌘/ is not Boolean insert`);
  eq(matchesShortcut("booleanIntersect", key("*", { ctrlKey: true, altKey: true }), plat), true, `${p}: AltGr+* (Ctrl+Alt) is Boolean intersect`);
  eq(matchesShortcut("help", key("/"), plat), false, `${p}: / alone is not the help`);
}
eq(pc.booleanSubtract.key, "−", "Boolean subtract reads −");
check(/if \(matchesShortcut\(id, e\)\) \{ if \(booleanShortcut\(op\)\) e\.preventDefault\(\); return; \}/.test(ws), "DesignKeys sends + − * / to the Boolean");
check(ws.indexOf("booleanShortcut(op)") > ws.indexOf("if (inField || inOverlay) return;"), "Boolean keys never fire while typing in a field or a dialog");
check(/<kbd>\{BOOLEAN_KEYS\[op\]\.key\}<\/kbd>/.test(ws), "the Boolean menu shows its keys");
check(/booleanKeysActive\(\)\) return;/.test(read("src/scene/Viewport.tsx")), "the 3D view's +/- zoom yields to the Boolean keys when two parts are set");

if (failures) {
  console.error(`check-shortcuts: ${failures} of ${checks} checks failed`);
  process.exit(1);
}
console.log(`check-shortcuts: ${checks} checks passed`);
