import { loadFile, loadProject } from "../state";
import { appModeRevision, setAppMode } from "../workspace";
import { invalidatePreview } from "./store";

/** All user opens cancel pending previews; the loaders report failures through loadError. */
export async function openUserProject(file: string | File): Promise<boolean> {
  const revision = appModeRevision();
  const current = () => appModeRevision() === revision;
  invalidatePreview();
  const opened = await (typeof file === "string" ? loadProject(file, current) : loadFile(file, current));
  if (opened && current()) setAppMode("results");
  return opened;
}
