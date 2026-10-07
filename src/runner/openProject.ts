import { loadFile, loadProject, setLoadError } from "../state";
import { appModeRevision, setAppMode } from "../workspace";
import { invalidatePreview, models } from "./store";
import { schemaFamily } from "../lib/legacy";
import { DESIGN_ID_RE, RESERVED_DESIGN_ID_RE, suggestDesignId } from "../lib/designId";
import { t } from "../i18n";
import type { Design } from "../designer/types";
import { createDesign } from "../designer/store";

/** The file's JSON when it is a design file (fairbeam.design/1, e.g. Export > Current design JSON), else null (a result
 * file, or anything the result loader reports). */
export async function designIn(f: Pick<File, "text">): Promise<Design | null> {
  try {
    const json = JSON.parse(await f.text()) as { schema?: unknown; model?: unknown };
    return json && typeof json === "object" && schemaFamily(json.schema, "fairbeam.design/") && json.model && typeof json.model === "object" ? (json as Design) : null;
  } catch {
    return null;
  }
}

/** A free file id for an imported design, from its name as the Start page derives it (python/fairbeam/server.py
 * App._free_design_id does the same when no id is sent): never a bundled example's, a reserved or a taken one. */
export function importedDesignId(name: string, taken: readonly string[]): string {
  let base = suggestDesignId(name);
  if (!DESIGN_ID_RE.test(base)) base = "imported_design";
  const free = (id: string) => DESIGN_ID_RE.test(id) && !RESERVED_DESIGN_ID_RE.test(id) && !taken.includes(id);
  if (free(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const id = `${base.slice(0, 41 - String(n).length - 1)}_${n}`;
    if (free(id)) return id;
  }
  return base;
}

/** A design file opened or dropped in the app: created as a new design in the workspace and opened in Design. */
async function importDesign(design: Design, fileName: string): Promise<boolean> {
  const name = (design.model?.name || design.model?.id || fileName.replace(/(\.design)?\.json$/i, "")).trim();
  try {
    const res = await createDesign({ id: importedDesignId(name, models().map((m) => m.key)), name: name.slice(0, 80), design });
    return !!res;
  } catch (e) {
    setLoadError(t("load.designImportFailed", { file: fileName, error: e instanceof Error ? e.message : String(e) }));
    return false;
  }
}

/** All user opens cancel pending previews; the loaders report failures through loadError. A design file becomes a new
 * design (Design mode); a result file opens in Examples. */
export async function openUserProject(file: string | File): Promise<boolean> {
  const revision = appModeRevision();
  const current = () => appModeRevision() === revision;
  // before anything is read: a preview that lands meanwhile must not replace what is opened
  invalidatePreview();
  if (typeof file !== "string") {
    const design = await designIn(file);
    if (design) return importDesign(design, file.name);
  }
  const opened = await (typeof file === "string" ? loadProject(file, current) : loadFile(file, current));
  if (opened && current()) setAppMode("results");
  return opened;
}
