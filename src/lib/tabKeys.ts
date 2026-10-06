/**
 * Arrow keys in a tablist whose tabs activate as they receive focus (WAI-ARIA tabs, automatic
 * activation, #107): the index of the tab a key moves to, wrapping at both ends, or null when the
 * key is not a tablist key (Tab, Enter, letters ... keep their default behaviour).
 *
 * Up/Down serve a vertical list and Left/Right a horizontal one; both pairs are accepted because a
 * vertical list may be laid out as a row on a narrow screen (the Simulation settings nav is).
 * `index` is the focused tab (-1 when focus is elsewhere in the list: Down/Right then go to the
 * first tab and Up/Left to the last).
 */
export function tabKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "Home": return 0;
    case "End": return count - 1;
    case "ArrowDown":
    case "ArrowRight": return index < 0 ? 0 : (index + 1) % count;
    case "ArrowUp":
    case "ArrowLeft": return index < 0 ? count - 1 : (index - 1 + count) % count;
    default: return null;
  }
}

/**
 * Arrow keys in a vertical single-select listbox whose selection follows focus (WAI-ARIA listbox):
 * Up/Down move one option and stop at the ends, Home/End go to the first/last option. `index` is
 * the focused option (-1: Down goes to the first, Up to the last). Null for any other key.
 */
export function listKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "Home": return 0;
    case "End": return count - 1;
    case "ArrowDown": return index < 0 ? 0 : Math.min(count - 1, index + 1);
    case "ArrowUp": return index < 0 ? count - 1 : Math.max(0, index - 1);
    default: return null;
  }
}
