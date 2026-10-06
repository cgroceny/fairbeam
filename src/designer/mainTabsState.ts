// The open main-area tabs of each design (resultTabs.ts has the transitions, MainArea.tsx draws
// them). Kept in memory for the session: a design opened again shows the tabs it had.
import { createSignal, untrack } from "solid-js";
import { file as designFile } from "./store";
import { ONLY_3D, type MainResultView, type MainTabId, type MainTabs } from "./resultTabs";
import { createMainTabsState } from "./resultSessionState";

type TabState = ReturnType<typeof createMainTabsState>;
const [byDesign, setByDesign] = createSignal<ReadonlyMap<string, TabState>>(new Map());
const designKey = () => designFile()?.id ?? "";

/** The tabs of the open design. */
export const mainTabs = (): MainTabs => byDesign().get(designKey())?.mainTabs() ?? ONLY_3D;

function update(action: (state: TabState) => boolean) {
  const key = untrack(designKey);
  let state = untrack(byDesign).get(key);
  if (!state) {
    state = createMainTabsState(ONLY_3D);
    if (!action(state)) { state.dispose(); return; }
    setByDesign(map => new Map(map).set(key, state!));
    return;
  }
  action(state);
}

/** Open (or show) a result view as a main-area tab. */
export const openMainResult = (view: MainResultView) => update(state => state.openMainResult(view));
export const activateMainTab = (id: MainTabId) => update(state => state.activateMainTab(id));
export const closeMainTab = (id: MainTabId) => update(state => state.closeMainTab(id));
export const cycleMainTabs = (delta: number) => update(state => state.cycleMainTabs(delta));

/** The result view of the shown main-area tab, null while the 3D view is shown. */
export const activeMainResult = (): MainResultView | null => {
  const a = mainTabs().active;
  return a === "3d" ? null : a;
};

/** Move the focus to the shown tab of the strip (after a keyboard switch from inside the main area,
 * whose previous panel is gone). */
export function focusActiveMainTab() {
  queueMicrotask(() => document.querySelector<HTMLElement>(".dw-main-tabs [role='tab'][aria-selected='true']")?.focus());
}
