import type { Bundle } from "../types";
import { appMode } from "../workspace";
import { viewerArray } from "./arrayStore";
import { designerArray } from "../designer/arraySession";
import { displayedRun } from "../designer/displayedRun";
import { snapshotArrayFeed } from "./arraySession";

export const currentArray = () => appMode() === "design" ? designerArray : viewerArray;
export const arraySourceMatches = (b: Bundle | null) => {
  const s = currentArray(), shown = displayedRun();
  return !!b && (s.source() === b || appMode() === "design" && shown?.view === b && shown.source === s.source());
};
/** An export or viewport must never borrow another result's weights. */
export const arrayWeightsFor = (b: Bundle) => {
  const s = currentArray();
  return s.source() === b && s.hasArray() ? s.weights() : null;
};
export const arrayFeedFor = (b: Bundle) => snapshotArrayFeed(currentArray(), b);
export const arrayOverrideFor = (b: Bundle | null) => {
  const s = currentArray();
  return arraySourceMatches(b) ? s.override() : null;
};
