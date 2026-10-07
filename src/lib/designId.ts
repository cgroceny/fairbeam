/** Shared design id rules used by the start screen and Save As. */
// loaded straight into Node by scripts/check-save-as.mjs, hence the explicit extension
import { t } from "../i18n/index.ts";

export const DESIGN_ID_RE = /^[a-z][a-z0-9_]{1,40}$/;
/** Windows device names (python/fairbeam/modelfiles.py RESERVED_ID_RE). */
export const RESERVED_DESIGN_ID_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
/** The ids of the bundled examples' sources (python/fairbeam/modelfiles.py BUNDLED; the Python tests
 * compare the two lists). The server refuses them for a new model or design, whether or not the
 * example's file is in the models folder. */
export const BUNDLED_EXAMPLE_IDS = [
  "branchline_coupler", "dipole", "helix_axial", "inset_patch", "lowpass_stepped", "microstrip_line", "minkowski_patch",
  "patch_antenna", "patch_array_2x1", "patch_array_4x1", "pyramidal_horn", "sierpinski_monopole", "wilkinson_divider",
  "blade_867", "collinear_867", "meander_dipole_867", "sleeve_dipole_867", "wideband_dipole_867", "yagi_867",
] as const;
const bundledIds = new Set<string>(BUNDLED_EXAMPLE_IDS);

/** An id no new file may take: a Windows device name or a bundled example's id. */
export const isReservedDesignId = (id: string) => RESERVED_DESIGN_ID_RE.test(id) || bundledIds.has(id);

export function suggestDesignId(name: string): string {
  return name.toLowerCase().replace(/ı/g, "i").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "").slice(0, 41);
}

/** The file id for a new design called `name`: its ASCII form, or, when that is a bundled example's
 * id, the first free "<id>_2", "<id>_3"… ("Patch antenna" becomes patch_antenna_2). `reserved` is
 * the id the name asked for when it had to be changed. An id that an existing design or model
 * already uses, or a Windows device name, is left as it is: designIdError says so. */
export function freeDesignId(name: string, existingIds: readonly string[]): { id: string; reserved: string | null } {
  const base = suggestDesignId(name);
  if (!DESIGN_ID_RE.test(base) || !bundledIds.has(base)) return { id: base, reserved: null };
  const taken = new Set(existingIds);
  for (let n = 2; n < 1000; n++) {
    const tail = `_${n}`;
    const id = `${base.slice(0, 41 - tail.length)}${tail}`;
    if (!taken.has(id) && !isReservedDesignId(id)) return { id, reserved: base };
  }
  return { id: base, reserved: null };
}

export function designIdError(id: string, existingIds: readonly string[]): string {
  if (!DESIGN_ID_RE.test(id)) return t("designId.invalid");
  if (RESERVED_DESIGN_ID_RE.test(id)) return t("designId.reserved");
  if (bundledIds.has(id)) return t("designId.bundled");
  if (existingIds.includes(id)) return t("designId.exists");
  return "";
}

/** The line under a Name field: the file the design is saved as, and why its id has a suffix. */
export function designFileHint(name: string, existingIds: readonly string[]): string {
  const { id, reserved } = freeDesignId(name, existingIds);
  const file = `${id}.design.json`;
  return reserved ? t("designId.fileReserved", { file, id: reserved }) : t("designId.file", { file });
}
