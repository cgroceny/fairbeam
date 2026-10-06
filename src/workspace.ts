// Which screen the app shows: the start screen, the designer (a design file open in the designer
// workspace, with the results of its runs in place) or the examples ("results": the viewer on an
// example or saved project bundle; the header distinguishes Examples and Results).
import { createSignal, type Setter } from "solid-js";

export type AppMode = "home" | "design" | "results";
const [appModeSignal, writeAppMode] = createSignal<AppMode>("results");
export const appMode = appModeSignal;
let modeRevision = 0;
export const appModeRevision = () => modeRevision;
// Navigation intent also cancels pending opens when the selected screen is already active.
export const setAppMode = ((value: AppMode | ((previous: AppMode) => AppMode)) => {
  modeRevision++;
  return writeAppMode(value);
}) as Setter<AppMode>;
