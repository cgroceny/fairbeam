// The Design workspace's main area as document tabs (resultTabs.ts, mainTabsState.ts): the
// 3D view is the first tab and never closes; result views of the shown run open as further tabs from
// the navigation tree's result nodes (which show the open ones and close them too) or the ribbon's
// Post-processing tab. A result tab is its toolbar (the shown run, Compare, data format, Copy data,
// CSV, Touchstone) over the whole plot (ResultViews.tsx); the dock's Runs tab lists the runs. The 3D
// stage stays mounted under a result tab (camera, picking and drawing state survive) and comes back
// to the front for geometry work and for the results drawn in 3D (the 3D pattern, surface currents).
import { createEffect, For, type JSX, on, Show, untrack } from "solid-js";
import { CircleX, X } from "lucide-solid";
import PanelBoundary from "../components/PanelBoundary";
import { tabKeyTarget } from "../lib/tabKeys";
import { designResult, designResultError, failedResultLoad, retryResultLoad } from "../runner/designRun";
import { booleanPending } from "./booleanUi";
import { extrudeFacePicking, facePicking, tool } from "./draw";
import { activateMainTab, activeMainResult, closeMainTab, focusActiveMainTab, mainTabs } from "./mainTabsState";
import { resultDataFormat } from "./resultDataPreference";
import { resultFocus } from "./resultFocus";
import { MAIN_TAB_LABELS, mainTabIds, type MainTabId } from "./resultTabs";
import { ResultBody, ResultToolbar } from "./ResultViews";
import { RunQualityBanner } from "./RunQualityView";
import { showView } from "./runResults";
import { SHORTCUTS } from "./shortcuts";
import { selection } from "./store";
import { vertexTarget } from "./vertexEdit";
import { t } from "../i18n";
import { TransformDialogHost } from "./dialogs/TransformDialog";
import { transformRequest, setTransformRequest } from "./transforms";

// the tab names in the UI language (MAIN_TAB_LABELS holds the English ones)
const TAB_KEYS: Record<MainTabId, string> = {
  "3d": "mainTabs.view3d", sparams: "mainTabs.sparams", impedance: "mainTabs.impedance", vswr: "mainTabs.vswr", smith: "mainTabs.smith",
  efficiency: "mainTabs.efficiency", pattern: "mainTabs.pattern", table: "mainTabs.table", summary: "mainTabs.summary", fieldmap: "mainTabs.fieldmap",
};
const tabLabel = (id: MainTabId) => (TAB_KEYS[id] ? t(TAB_KEYS[id]) : MAIN_TAB_LABELS[id]);

export default function MainArea(props: { children: JSX.Element }) {
  const ids = () => mainTabIds(mainTabs());
  const active = () => mainTabs().active;
  // a result tab focuses that view of the shown run, like a dock tab (the tree and the ribbon's
  // Post-processing tab follow); without a result it only shows its empty state
  const choose = (id: MainTabId) => {
    if (id !== "3d") setTransformRequest(null);
    if (id !== "3d" && designResult()) showView(id, undefined, "main");
    else activateMainTab(id);
  };
  // the closed tab's button goes away: the focus moves to the tab shown instead when it was there
  const close = (id: MainTabId, refocus: boolean) => {
    closeMainTab(id);
    if (refocus) focusActiveMainTab();
  };
  const stripFocused = () => !!document.activeElement?.closest(".dw-main-tabs");
  createEffect(on(transformRequest, (request) => { if (request) activateMainTab("3d"); }));
  // geometry work needs the 3D view: a drawing or picking tool, point editing, a Boolean, and a part,
  // shape, port or resistor chosen in the tree bring it to the front
  createEffect(on(() => [tool(), facePicking(), extrudeFacePicking(), vertexTarget(), (booleanPending()?.a ?? -1) >= 0], (flags) => {
    if (flags.some(Boolean)) activateMainTab("3d");
  }, { defer: true }));
  createEffect(on(selection, (s) => {
    if (s.type === "part" || s.type === "primitive" || s.type === "port" || s.type === "resistor") activateMainTab("3d");
  }, { defer: true }));

  const onKey: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (e) => {
    const el = e.target as HTMLElement;
    if (el.getAttribute("role") !== "tab") return;
    const list = ids();
    const at = list.indexOf(el.dataset.tab as MainTabId);
    if (at < 0) return;
    // Delete closes a result tab (and never reaches the designer's Delete of the selected geometry)
    if (e.key === "Delete" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (list[at] !== "3d") close(list[at], true);
      return;
    }
    const next = tabKeyTarget(e.key, at, list.length);
    if (next === null || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    choose(list[next]);
    focusActiveMainTab();
  };
  // a result tab in front however it got there (Ctrl+Tab, closing a neighbour) focuses its view like
  // a click: the tree highlights it, the dock shows the Runs tab, and a result drawn in 3D (the 3D
  // pattern, surface currents) is switched off rather than left on under the tab
  createEffect(on(activeMainResult, (view) => {
    if (view) setTransformRequest(null);
    if (view && designResult() && untrack(resultFocus)?.view !== view) showView(view, undefined, "main");
  }, { defer: true }));
  const loading = () => { const f = resultFocus(); return !!f && f.file !== designResult()?.file; };

  return (
    <div class="dw-main">
      <div class="dw-main-bar">
        <div class="dw-main-tabs" role="tablist" aria-label={t("mainTabs.label")} onKeyDown={onKey}>
          <For each={ids()}>{(id) => (
            <button type="button" role="tab" class="dw-main-tab" id={`dw-main-tab-${id}`} data-tab={id}
              aria-selected={active() === id} tabindex={active() === id ? 0 : -1}
              aria-controls={id === "3d" ? "dw-main-panel-3d" : active() === id ? "dw-main-panel-result" : undefined}
              aria-keyshortcuts={id === "3d" ? undefined : "Delete"}
              title={id === "3d" ? t("mainTabs.view3d.title", { key: SHORTCUTS.mainTabs.key }) : t("mainTabs.result.title", { tab: tabLabel(id) })}
              onClick={() => choose(id)}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
              onAuxClick={(e) => { if (e.button === 1 && id !== "3d") { e.preventDefault(); close(id, stripFocused()); } }}>
              <span>{tabLabel(id)}</span>
              <Show when={id !== "3d"}>
                <span class="dw-main-tab-x" aria-hidden="true" title={t("mainTabs.close", { tab: tabLabel(id) })}
                  onClick={(e) => { e.stopPropagation(); close(id, true); }}><X size={12} /></span>
              </Show>
            </button>
          )}</For>
        </div>
      </div>
      <div class="dw-main-body" classList={{ "has-transform": !!transformRequest() }}>
        <div class="stage" id="dw-main-panel-3d" role="tabpanel" aria-labelledby="dw-main-tab-3d" inert={active() !== "3d"}>
          {props.children}
        </div>
        <Show when={activeMainResult()}>{(view) => (
          <section class="dw-result" id="dw-main-panel-result" role="tabpanel" aria-labelledby={`dw-main-tab-${view()}`} tabIndex={0}>
            <PanelBoundary name={t("mainTabs.resultTab")}>
              <Show when={designResultError()}>
                <p class="status-block status-critical" role="alert"><CircleX size={14} aria-hidden="true" /><span>{designResultError()}</span><Show when={failedResultLoad()}><button class="btn btn-ghost btn-sm" onClick={retryResultLoad}>{t("common.retry")}</button></Show></p>
              </Show>
              <Show when={loading()}><p class="dw-result-note" role="status">{t("mainTabs.reading")}</p></Show>
              <Show when={designResult()} fallback={
                <div class="panel-empty">{t("mainTabs.empty")}</div>
              }>{(r) => (
                <>
                  <ResultToolbar view={view()} />
                  <RunQualityBanner file={r().file} b={r().bundle} />
                  <div class="dw-result-plot"><ResultBody view={view()} b={r().bundle} format={resultDataFormat()} /></div>
                </>
              )}</Show>
            </PanelBoundary>
          </section>
        )}</Show>
        <TransformDialogHost />
      </div>
    </div>
  );
}
