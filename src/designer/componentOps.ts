// Component folders (components) as operations on the design: a folder is the `component`
// path its parts share (types.ts DesignPart.component, navModel.ts componentTree), so renaming,
// ungrouping or deleting one rewrites or removes those parts. The simulation ignores components;
// every operation is one undo step with a message. The tree's folder menu (NavTree.tsx) calls these.
import { componentFolders, draft, edit, normComponent, selection, setMessage, setSelection } from "./store";
import { t } from "../i18n";

/** Is `component` the folder `path` or inside it? */
export const inComponent = (component: string | undefined, path: string) => {
  const c = normComponent(component), p = normComponent(path);
  return !!p && (c === p || c.startsWith(`${p}/`));
};

/** The parts in folder `path`, its subfolders included. */
export const componentMembers = (parts: readonly { component?: string }[], path: string) =>
  parts.flatMap((p, i) => (inComponent(p.component, path) ? [i] : []));

/** A folder name as typed: one segment (a "/" would make a new level), trimmed. */
export const componentName = (name: string) => name.replace(/\//g, " ").replace(/\s+/g, " ").trim();

/** `component` after folder `path` is renamed to `name` (the last segment changes). */
export function renamedComponent(component: string | undefined, path: string, name: string): string {
  const c = normComponent(component), p = normComponent(path), n = componentName(name);
  if (!n || !inComponent(c, p)) return c;
  const parent = p.split("/").slice(0, -1).join("/");
  const to = parent ? `${parent}/${n}` : n;
  return to + c.slice(p.length);
}

/** `component` after folder `path` is dissolved: its contents move up one level. */
export function ungroupedComponent(component: string | undefined, path: string): string {
  const c = normComponent(component), p = normComponent(path);
  if (!inComponent(c, p)) return c;
  const parent = p.split("/").slice(0, -1).join("/");
  const rest = c.slice(p.length).replace(/^\//, "");
  return [parent, rest].filter(Boolean).join("/");
}

const setComponent = (part: { component?: string }, path: string) => {
  if (path) part.component = path; else delete part.component;
};
export function newComponent(parent = ""): string {
  const base = t("tree.newComponentName");
  const prefix = normComponent(parent);
  const taken = new Set(componentFolders());
  let name = prefix ? `${prefix}/${base}` : base, n = 2;
  while (taken.has(name)) name = `${prefix ? `${prefix}/` : ""}${base} ${n++}`;
  edit(d => { d.components = [...(d.components ?? []), name]; }, "", t("tree.add.component"));
  return name;
}
const label = (path: string) => normComponent(path).split("/").at(-1) ?? path;

/** Rename folder `path` (its last segment) to `name`; parts in its subfolders follow. Returns the
 * new path, or null when nothing changed. */
export function renameComponent(path: string, name: string): string | null {
  const members = componentMembers(draft.parts, path);
  const n = componentName(name);
  if ((!members.length && !(draft.components ?? []).some(c => inComponent(c, path))) || !n) return null;
  const to = renamedComponent(path, path, n);
  if (to === normComponent(path)) return null;
  const merged = draft.parts.some((p, i) => !members.includes(i) && inComponent(p.component, to));
  edit((d) => { d.components = [...new Set((d.components ?? []).map(c => renamedComponent(c, path, n)))]; for (const i of members) setComponent(d.parts[i], renamedComponent(d.parts[i].component, path, n)); }, "", t("componentOps.rename.step", { name: label(path) }));
  setMessage({ tone: "good", text: t(merged ? "componentOps.rename.merged" : "componentOps.rename.done", { from: label(path), to: n, path: to }) });
  return to;
}

/** Dissolve folder `path`: its parts and subfolders move to the folder above it (or the top level). */
export function ungroupComponent(path: string) {
  const members = componentMembers(draft.parts, path);
  if (!members.length && !(draft.components ?? []).some(c => inComponent(c, path))) return;
  const parent = normComponent(path).split("/").slice(0, -1).join("/");
  edit((d) => { d.components = [...new Set((d.components ?? []).map(c => ungroupedComponent(c, path)).filter(Boolean))]; for (const i of members) setComponent(d.parts[i], ungroupedComponent(d.parts[i].component, path)); }, "", t("componentOps.ungroup.step", { name: label(path) }));
  setMessage({ tone: "good", text: t("componentOps.ungroup.done", { name: label(path), count: members.length, parent: parent || t("componentOps.topLevel") }) });
}

/** Delete folder `path` with every part in it and their shapes. Undo
 * brings them back. */
export function deleteComponent(path: string) {
  const members = componentMembers(draft.parts, path);
  if (!members.length && !(draft.components ?? []).some(c => inComponent(c, path))) return;
  const s = selection();
  const drop = new Set<number>(members);
  edit((d) => { d.components = (d.components ?? []).filter(c => !inComponent(c, path)); for (const i of [...members].sort((a, b) => b - a)) d.parts.splice(i, 1); }, "", t("componentOps.delete.step", { name: label(path) }));
  if ((s.type === "part" || s.type === "primitive") && drop.has(s.i)) setSelection({ type: "design" });
  else if (s.type === "part" || s.type === "primitive") {
    // the selected part keeps its selection after the parts before it went
    const shift = members.filter((i) => i < s.i).length;
    if (shift) setSelection({ ...s, i: s.i - shift });
  }
  setMessage({ tone: "good", text: t("componentOps.delete.done", { name: label(path), count: members.length }) });
}
