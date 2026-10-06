import { projectUrl } from "../env";
import { summarize, validateBundle } from "../lib/validate";
import { addResultToComparison as addRun, copyResultData as copyData, exportResultCsv as exportCsv } from "./resultData";
import type { ResultView } from "./resultFocus";
import { t } from "../i18n";

export type TreeResultRef = { file: string; view: ResultView; f?: number; map?: number };

async function readResult(ref: TreeResultRef) {
  const response = await fetch(projectUrl(ref.file), { cache: "no-store" });
  if (!response.ok) throw new Error(t("tree.result.readFailed", { file: ref.file, status: response.status }));
  const result = validateBundle(await response.json());
  if (!result.bundle) throw new Error(summarize(result.errors));
  return result.bundle;
}

/** The data of a view: the 3D pattern's is its pattern (the cuts' table). */
const dataView = (view: ResultView): ResultView => (view === "pattern3d" ? "pattern" : view);

export async function copyResultData(ref: TreeResultRef): Promise<string> {
  const result = await copyData(await readResult(ref), dataView(ref.view), ref.f, undefined, { fieldPlane: ref.map });
  if (!result.ok) throw new Error(result.message);
  return result.message;
}

export async function exportResultCsv(ref: TreeResultRef): Promise<string> {
  const filename = `${ref.file.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "result"}-${dataView(ref.view)}.csv`;
  await exportCsv(await readResult(ref), dataView(ref.view), filename, ref.f, undefined, { fieldPlane: ref.map });
  return t("tree.result.downloadRequested", { file: filename });
}

export async function addResultToComparison(ref: Pick<TreeResultRef, "file">): Promise<string> {
  if (!await addRun(ref.file)) throw new Error(t("tree.result.compareFull"));
  return t("tree.result.addedToComparison");
}
