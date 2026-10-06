// The Examples picker in the header (src/components/ExamplePicker.tsx): its rows, the search filter
// and the keyboard movement over the filtered rows. Pure, so scripts/check-example-picker.mjs can
// exercise it without a DOM.
import type { ProjectIndexEntry } from "../types";
import { compact } from "./format.ts";
import { listKeyTarget } from "./tabKeys.ts";
import { fmt, t, decimalComma } from "../i18n/index.ts";

export interface PickerItem {
  file: string;
  /** the picker label (src/lib/projectLabels.ts): the project name, suffixed when names repeat */
  label: string;
  /** secondary line: matched bands and mesh size, from the project index */
  detail: string;
  /** the index says the project carries simulation results */
  results: boolean;
}

export interface PickerGroup {
  /** the existing group key (the model id); shown as a heading when the group holds several rows */
  label: string;
  items: PickerItem[];
  /** the "Opened project" group (a project opened from a file or a run), always shown with its heading */
  opened?: boolean;
}

const ghz = (f: number) => fmt.num(f, 2);

/** The example categories, in display order; their headings are the `examples.group.<id>` texts. */
export const EXAMPLE_CATEGORIES = ["uav", "printed", "horns", "arrays", "wire", "other"] as const;
export type ExampleCategory = (typeof EXAMPLE_CATEGORIES)[number];

/** The category of an example's model id: "patch-array-2x1" is an array, "microstrip-line" is printed, and so on. */
export function exampleCategory(model: string): ExampleCategory {
  const m = model.toLowerCase();
  if (/867/.test(m)) return "uav";
  if (/array/.test(m)) return "arrays";
  if (/patch|microstrip|coupler|divider|lowpass|filter|sierpinski|minkowski/.test(m)) return "printed";
  if (/horn|waveguide/.test(m)) return "horns";
  if (/dipole|helix|monopole|yagi|wire|loop/.test(m)) return "wire";
  return "other";
}

/** "2.41 GHz · 75.7 k cells"; bands and cells are left out when the index does not have them. */
export function exampleDetail(p: Pick<ProjectIndexEntry, "bands" | "cells" | "engine">): string {
  const bands = (p.bands ?? []).filter((f) => Number.isFinite(f) && f > 0);
  const parts: string[] = [];
  // Turkish numbers have a decimal comma, so its bands are separated by a semicolon
  if (bands.length) parts.push(`${bands.map(ghz).join(decimalComma() ? "; " : ", ")} GHz`);
  if (Number.isFinite(p.cells) && p.cells > 0) parts.push(t("examples.detail.cells", { cells: compact(p.cells) }));
  if (p.engine) parts.push(p.engine);
  return parts.join(" · ");
}

const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** Every whitespace-separated term of the query occurs in the row's label, detail, group or file. */
export function matchesQuery(item: PickerItem, group: string, query: string): boolean {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = fold(`${item.label} ${item.detail} ${group} ${item.file}`);
  return terms.every((t) => hay.includes(t));
}

/** The groups with only their matching rows; groups left empty are dropped. */
export function filterGroups(groups: readonly PickerGroup[], query: string): PickerGroup[] {
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => matchesQuery(i, g.label, query)) }))
    .filter((g) => g.items.length > 0);
}

/** The rows in display order, which is the order the arrow keys walk. */
export const flatItems = (groups: readonly PickerGroup[]): PickerItem[] => groups.flatMap((g) => g.items);

/** The row the list opens on (or a new filter lands on): the open project if it is listed, else the first row. */
export function initialActive(items: readonly PickerItem[], current: string): number {
  if (!items.length) return -1;
  const i = items.findIndex((it) => it.file === current);
  return i >= 0 ? i : 0;
}

/**
 * The active row after a key in the search field: Up/Down move one row and stop at the ends,
 * Home/End jump to the first/last row (the shared listbox keys, src/lib/tabKeys.ts). Null for any
 * other key, which then edits the query as usual.
 */
export const pickerKeyTarget = (key: string, index: number, count: number): number | null => listKeyTarget(key, index, count);
