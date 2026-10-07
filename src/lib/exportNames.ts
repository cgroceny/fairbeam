// File names of a design's exports. Every export of one design uses the same stem: its workspace id, as
// the designer names its files (<stem>.design.json, the Python export <stem>.py). Plain Node + browser.

/** The file stem of a design's exports from its model id (a model id writes "-" where the workspace id has
 * "_"): letters, digits and "_" only, so the name is the same on every file system and a valid Python
 * module name. `fallback` when nothing is left. */
export function designStem(modelId: string | null | undefined, fallback = "fairbeam"): string {
  const s = (modelId ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80).replace(/_+$/, "");
  return s || fallback;
}
