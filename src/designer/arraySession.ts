import { createRoot } from "solid-js";
import { designResult, pendingDesignResultFile } from "../runner/designRun";
import { farfieldIndex } from "../state";
import { appMode } from "../workspace";
import { createArraySession } from "../lib/arraySession";
import { resultFocus } from "./resultFocus";
import { mainTabs } from "./mainTabsState";
import { file } from "./store";

// Closing Array, changing documents/runs or leaving Design invalidates the feed. Pattern/3D
// views may use it while Array remains open. A comparison always displays stored patterns.
export const designerArray = createRoot(() => createArraySession(() => {
  const r = designResult(), f = resultFocus();
  return appMode() === "design" && mainTabs().open.includes("array") && !pendingDesignResultFile()
    && r && f?.file === r.file && r.bundle.model.id === file()?.design.model.id ? r.bundle : null;
}, () => {
  const r = designResult(), f = resultFocus(), list = r?.bundle.results?.farfield ?? [];
  return f?.view === "pattern3d" ? list[Math.min(farfieldIndex(), list.length - 1)]?.f : f?.f ?? list[0]?.f;
}, { minElements: 2, identity: () => `${file()?.id ?? ""}\n${designResult()?.file ?? ""}`, comparing: () => !!resultFocus()?.compare?.length }));
