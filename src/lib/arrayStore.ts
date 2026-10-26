// Existing viewer adapter. Designer feeds live in their own result-owned session.
import { createRoot } from "solid-js";
import { bundle, farfieldIndex } from "../state";
import { comparing } from "../compare/store";
import { appMode } from "../workspace";
import { createArraySession } from "./arraySession";
export { arrayAxisPhi, type ScanPlane } from "./arraySession";

export const viewerArray = createRoot(() => createArraySession(
  () => appMode() === "design" ? null : bundle(),
  () => { const list = bundle()?.results?.farfield ?? []; return list[Math.min(farfieldIndex(), list.length - 1)]?.f; },
  { comparing },
));
export const arrayWeights = viewerArray.weights, setArrayWeights = viewerArray.setWeights;
export const arrayActive = viewerArray.active, setArrayActive = viewerArray.setActive;
export const scanTheta = viewerArray.scanTheta, setScanTheta = viewerArray.setScanTheta;
export const scanPhi = viewerArray.scanPhi, setScanPhi = viewerArray.setScanPhi;
export const arraySet = viewerArray.set, hasArray = viewerArray.hasArray;
export const steeredFarField = viewerArray.steered, steeredBeam = viewerArray.beam;
export const farfieldOverride = viewerArray.override, steer = viewerArray.steer;
