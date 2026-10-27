import { createRoot } from "solid-js";
import { appMode } from "../workspace";
import { designResult, pendingDesignResultFile } from "../runner/designRun";
import { createSmallAntennaSession } from "../lib/smallAntennaSession";
import { file } from "./store";
import { resultFocus } from "./resultFocus";
import { displayedPortResult } from "./portProcessingSession";

export const designerSmallAntenna = createRoot(() => createSmallAntennaSession(() => {
  const run = designResult(), focus = resultFocus(), document = file();
  return appMode() === "design" && !pendingDesignResultFile() && run && document
    && (!focus || focus.file === run.file) && run.bundle.model.id === document.design.model.id
    && !run.bundle.preview && run.bundle.results ? displayedPortResult(run.bundle) : null;
}, { identity: () => `${file()?.id ?? ""}\n${designResult()?.file ?? ""}`,
  comparing: () => !!resultFocus()?.compare?.length }));
