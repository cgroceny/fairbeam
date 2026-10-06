/** Shared design id rules used by the start screen and Save As. */
// loaded straight into Node by scripts/check-save-as.mjs, hence the explicit extension
import { t } from "../i18n/index.ts";

export const DESIGN_ID_RE = /^[a-z][a-z0-9_]{1,40}$/;
/** Windows device names (python/fairbeam/modelfiles.py RESERVED_ID_RE). */
export const RESERVED_DESIGN_ID_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

export function suggestDesignId(name: string): string {
  return name.toLowerCase().replace(/ı/g, "i").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "").slice(0, 41);
}

export function designIdError(id: string, existingIds: readonly string[]): string {
  if (!DESIGN_ID_RE.test(id)) return t("designId.invalid");
  if (RESERVED_DESIGN_ID_RE.test(id)) return t("designId.reserved");
  if (existingIds.includes(id)) return t("designId.exists");
  return "";
}
