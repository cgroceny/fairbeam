import { captureActiveSurface, exportNotice, geometryAvailable } from "./components/exportContext";
import PanelResizeHandles from "./components/PanelResizeHandles";
import ToastHost from "./components/ToastHost";
import { dismissToast, downloadToast, showToast } from "./lib/toast";
import { createEffect, createSignal, For, lazy, on, onCleanup, onMount, Show } from "solid-js";
import { instanceLazy } from "./lib/instanceLazy";
import { ChevronsLeft, ChevronsRight, PanelLeft, PanelRight, TriangleAlert } from "lucide-solid";
import Header from "./components/Header";
import ModelPanel from "./components/ModelPanel";
import SpecPanel from "./components/SpecPanel";
import Dock from "./components/Dock";
import ViewSwitch from "./components/ViewSwitch";
import PanelBoundary from "./components/PanelBoundary";
import { researchOpen, setResearchOpen } from "./runner/researchState";
import { openDroppedFile } from "./runner/dropFile";
import Home from "./home/Home";
import { DesignDock, DesignKeys, DesignSide, DesignTreePanel, DrawHint, Ribbon } from "./designer/DesignWorkspace";
import { file as designFile, draft as designDraft, removeSelected, canRemove, save as saveDesign, enterDesign, reopenLastDesign, openNativeDocument, undo as undoDesign, redo as redoDesign } from "./designer/store";
import { dismissPendingNativeDocument, nativeDocumentsAvailable, pendingNativeDocument } from "./lib/nativeDocuments";
import SaveAsDialog, { canSaveAs, openSaveAs, saveAsOpen, setSaveAsOpen } from "./designer/SaveAsDialog";
import { MeshViewPanel } from "./designer/MeshView";
import MainArea from "./designer/MainArea";
import StatusBar from "./designer/StatusBar";
import CloseProjectHost from "./designer/CloseProject";
import { appMode, setAppMode } from "./workspace";
import { bottomDockCollapsed, leftTreeCollapsed, setLeftTreeCollapsed, setSidePanelCollapsed, sidePanelCollapsed, toggleBottomDock, toggleLeftTree, toggleSidePanel } from "./designer/layoutState";
import { SHORTCUTS } from "./designer/shortcuts";

// Loaded on first use, not with the app: the 3D viewport, drawing code (+ jsPDF), export dialogs
// (+ CST macro, zip, report), and the run/editor drawer.
const Viewport = instanceLazy(() => import("./scene/Viewport"));
const DrawingView = lazy(() => import("./components/DrawingView"));
const ExportDialog = lazy(() => import("./components/ExportDialog"));
const PackageDialog = lazy(() => import("./components/PackageDialog"));
const RenderDialog = lazy(() => import("./render/RenderDialog"));
const RunPanel = lazy(() => import("./components/RunPanel"));
const ResearchDialog = lazy(() => import("./designer/ResearchDialog"));
const CstImportDialog = lazy(() => import("./components/CstImportDialog"));
const PcbImportDialog = lazy(() => import("./components/PcbImportDialog"));
// usage statistics (docs/TELEMETRY.md): asks once, only in a desktop build with the feature
const UsageStatsPrompt = lazy(() => import("./components/UsageStatsPrompt"));
import { PreviewBadge, RunNotice } from "./runner/Overlays";
import { openExamples } from "./runner/designRun";
import { openUserProject, retryUserProject } from "./runner/openProject";
import { fileDropHandlers } from "./lib/fileDrop";
import { currentModel, probeServer, recheckServer, runOpen, setRunOpen, watchServer } from "./runner/store";
import { setStartedPythonModel, startedPythonModel } from "./runner/startPython";
import { DEMO } from "./env";
import { panelTab } from "./editor/store";
import ExampleCopyDialog from "./runner/ExampleCopyDialog";
import { renderBusy, renderDialogOpen, setRenderDialogOpen } from "./render/state";
import { bundle, centerView, exportOpen, index, indexLoadError, lastProject, failedProject, loadError, loadIndex, loadProject, loadWarnings, packageOpen, setExportOpen, setIndexLoadError, setLoadError, setLoadWarnings, setPackageOpen, source } from "./state";
import { createMenuActionRouter } from "./lib/menuActions";
import { ShortcutHelp, showShortcutHelp } from "./designer/ShortcutHelp";
import { exportResultTouchstone } from "./designer/resultTouchstone";
import { exampleEntries, linkedExample } from "./runner/examples";
import { cstImportOpen, setCstImportOpen } from "./lib/cstImport";
import { pcbImportOpen, setPcbImportOpen } from "./lib/pcbImport";
import { isDesktopShell } from "./lib/telemetry";
import { t } from "./i18n";
import ConfirmDialog from "./lib/ConfirmDialog";
import UpdateProgress from "./components/UpdateProgress";
import { watchUpdate } from "./lib/updateProgress";

export default function App() {
  let disposed = false, cleanupDocuments = () => {};
  onCleanup(() => { disposed = true; cleanupDocuments(); });
  const onScreenshot=()=>{void captureActiveSurface().catch(error=>exportNotice(t("contextExport.failed",{error:String(error)}),{tone:"error"}));};
  onMount(()=>{window.addEventListener("fairbeam:screenshot",onScreenshot);onCleanup(()=>window.removeEventListener("fairbeam:screenshot",onScreenshot));});
  const [dragging, setDragging] = createSignal(false);
  // Tree-part drags remain local; file drops report their outcome wherever they arrive.
  const drop = fileDropHandlers((on) => setDragging(on && !pcbImportOpen() && !cstImportOpen()), (file) => void openDroppedFile(file));
  const [booting, setBooting] = createSignal(true);
  const [leftClosed, setLeftClosed] = createSignal(false);
  const [rightClosed, setRightClosed] = createSignal(false);
  const [compactViewport, setCompactViewport] = createSignal(false);
  const [viewportPresent, setViewportPresent] = createSignal(false);
  const [compactResultsPanel, setCompactResultsPanel] = createSignal<"left" | "right" | null>(null);
  let appRoot!: HTMLDivElement;
  const leftPanelOpen = () => compactViewport() ? compactResultsPanel() === "left" : !leftClosed();
  const rightPanelOpen = () => compactViewport() ? compactResultsPanel() === "right" : !rightClosed();
  const toggleResultsPanel = (side: "left" | "right") => {
    if (compactViewport()) setCompactResultsPanel((current) => current === side ? null : side);
    else if (side === "left") setLeftClosed(!leftClosed());
    else setRightClosed(!rightClosed());
  };
  // The export dialogs belong to the screen they were opened on: going to another one (Start, Design,
  // Examples) closes them, and with them a dialog's error panel. A running render
  // keeps its dialog: closing it on a screen change would cancel the render.
  createEffect(on(appMode, () => { setExportOpen(false); if (!renderBusy()) setRenderDialogOpen(false); setPackageOpen(false); }, { defer: true }));
  // The Run panel belongs to the Examples screen (a Python model opened from Start). Leaving it closes
  // the panel, so Design gets its Properties back instead of another model's Run panel; it is only
  // hidden (closeRunPanel would put back the project from before the preview, over the design's).
  createEffect(on(appMode, (mode, previous) => {
    if (previous !== "results" || mode === "results") return;
    setStartedPythonModel(null);
    if (runOpen()) setRunOpen(false);
  }));
  createEffect(() => {
    if (runOpen() && appMode() === "design") {
      setSidePanelCollapsed(false);
    } else if (runOpen() && appMode() === "results") {
      if (compactViewport()) setCompactResultsPanel("right");
      else setRightClosed(false);
    }
  });
  // the results workspace waits for the server probe: with a server the app opens on the start
  // screen, and building the 3D view first only to drop it again (a WebGL context and its shaders)
  // cost ~130 ms of the start screen's first paint
  const [probed, setProbed] = createSignal(DEMO);
  // Examples are a read-only viewer: no Run panel for a bundled (read-only) example there. A Python
  // model chosen on Start (Start > Python models: the user's own, or a bundled one) runs in this workspace.
  const resultsRunOpen = () => runOpen() && !DEMO && appMode() === "results"
    && (!currentModel()?.readonly || currentModel()?.key === startedPythonModel());
  // a project that could not be opened: a persistent error toast with Retry. It goes when the user
  // closes it or when the next open starts (which clears loadError).
  createEffect(() => {
    const error = loadError();
    if (!error) { dismissToast("load-error"); return; }
    const file = failedProject();
    showToast(error, { tone: "error", key: "load-error", onClose: () => setLoadError(null),
      action: file ? { label: t("common.retry"), run: () => void retryUserProject(file) } : undefined });
  });
  // Refreshing the list is independent of opening a file: keep both recovery actions available.
  createEffect(() => {
    const error = indexLoadError();
    if (!error) { dismissToast("index-load-error"); return; }
    const message = error === "invalid" ? t("load.indexInvalid") : t("load.indexUnavailable");
    const context = index().length ? t("load.indexPreserved") : t("load.indexRetry");
    showToast(`${message} ${context}`, { tone: "error", key: "index-load-error", onClose: () => setIndexLoadError(null),
      action: { label: t("common.retry"), run: () => void loadIndex() } });
  });
  let openInput: HTMLInputElement | undefined;
  // Native menu accelerators bypass the page's key handlers. Use the same modal
  // boundary as queued OS opens so neither can replace the screen behind a dialog.
  const hasOpenModal = () => !!document.querySelector(".scrim, [aria-modal='true'], dialog[open]");
  const menuAction = createMenuActionRouter({
    "file-new": () => { if (!hasOpenModal()) setAppMode("home"); },
    "file-open": () => { if (hasOpenModal()) return; if (nativeDocumentsAvailable()) void openNativeDocument(); else openInput?.click(); },
    "file-import-cst": () => { if (DEMO) notice(t("app.notice.cstImportDesktop")); else setCstImportOpen(true); },
    "file-import-pcb": () => { if (DEMO) notice(t("app.notice.pcbImportDesktop")); else setPcbImportOpen(true); },
    "file-save": () => { if (appMode() === "design" && designFile()) void saveDesign(); else window.dispatchEvent(new Event("fairbeam:menu-notice")); },
    "file-save-as": () => { if (appMode() === "design" && designFile()) openSaveAs(); },
    "export-cst": () => { if (appMode() !== "home" && geometryAvailable()) import("./state").then((s) => s.setExportOpen(true)); },
    "export-package": () => { if (bundle()) import("./state").then((s) => s.setPackageOpen(true)); },
    "export-python": () => { if (appMode() === "design") document.querySelector<HTMLButtonElement>(".rb-btn[data-action='open-python']")?.click(); },
    "export-touchstone": () => { const current = bundle(); if (!current?.results) { notice(t("app.notice.touchstoneNeedsResult")); return; }
      void exportResultTouchstone(current, source() || current.model.id).then((result) => { downloadToast(result); }).catch((error) => showToast(t("app.notice.touchstoneFailed", { error: String(error) }), { tone: "error" })); },
    "file-close": () => window.dispatchEvent(new Event("fairbeam:close-project")),
    "file-open-recent:": (id) => { if (!hasOpenModal() && id) void enterDesign(decodeURIComponent(id.slice("file-open-recent:".length))); },
    settings: () => window.dispatchEvent(new Event("fairbeam:open-settings")), about: () => window.dispatchEvent(new Event("fairbeam:open-about")),
    "edit-undo": () => editHistory("undo"),
    "edit-redo": () => editHistory("redo"),
    "edit-delete": () => { if (isTextTarget()) document.execCommand("delete"); else if (appMode() === "design" && canRemove()) removeSelected(); },
    "view-start": () => { if (!hasOpenModal()) setAppMode("home"); }, "view-design": () => { if (!hasOpenModal() && designFile()) setAppMode("design"); },
    "view-examples": () => { if (!hasOpenModal()) void openExamples(); },
    "view-tree": () => { if (appMode() === "design") toggleLeftTree(); }, "view-dock": () => { if (appMode() === "design") toggleBottomDock(); }, "view-properties": () => { if (appMode() === "design") toggleSidePanel(); },
    "view-ribbon": () => { if (appMode() === "design") document.querySelector<HTMLButtonElement>(".rb-minimize")?.click(); },
    "view-iso": () => viewEvent("iso"), "view-top": () => viewEvent("top"), "view-front": () => viewEvent("front"), "view-right": () => viewEvent("right"), "view-bottom": () => viewEvent("bottom"),
    "view-back": () => viewEvent("back"), "view-left": () => viewEvent("left"),
    "view-zoom-in": () => zoomEvent("in"), "view-zoom-out": () => zoomEvent("out"), "view-zoom-reset": () => document.querySelector<HTMLButtonElement>(".viewport [data-action='fit']")?.click(),
    "help-shortcuts": showShortcutHelp,
  }, (message) => window.dispatchEvent(new CustomEvent("fairbeam:menu-notice", { detail: message })));
  const notice = (detail: string) => window.dispatchEvent(new CustomEvent("fairbeam:menu-notice", { detail }));
  const viewEvent = (detail: string) => { if (appMode() === "design" || appMode() === "results") document.querySelector(".viewport")?.dispatchEvent(new CustomEvent("fairbeam:view", { detail })); };
  const zoomEvent = (detail: "in" | "out") => document.querySelector(".viewport")?.dispatchEvent(new CustomEvent("fairbeam:zoom", { detail }));
  const isTextTarget = () => { const el = document.activeElement; return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable); };
  const editHistory = (action: "undo" | "redo") => {
    if (isTextTarget()) {
      const focused = document.activeElement;
      if (focused?.closest(".cm-editor")) focused.dispatchEvent(new CustomEvent("fairbeam:text-history", { bubbles: true, detail: action }));
      else document.execCommand(action);
    } else if (appMode() === "design") {
      // like the designer's own ⌘Z (DesignWorkspace keydown): not while a dialog, popover or menu is
      // open. ⌘Z pressed on a dialog button is not prevented by the page, so it reaches this menu item.
      const overlay = ".dialog, .scrim, .rb-pop, [role=menu], dialog[open]";
      if (document.activeElement?.closest(overlay) || document.querySelector(".scrim, dialog[open]")) return;
      if (action === "undo") undoDesign(); else redoDesign();
    }
  };
  createEffect(() => {
    const mode = appMode();
    const hasDesign = !!designFile();
    const inDesign = mode === "design" && hasDesign;
    const currentBundle = bundle();
    const hasViewport = !!currentBundle && viewportPresent() && (mode === "design" || mode === "results");
    const availability: Record<string, boolean> = {
      "file-save": inDesign,
      "file-save-as": canSaveAs(),
      "file-close": hasDesign,
      "export-cst": appMode() !== "home" && geometryAvailable(),
      "export-python": inDesign,
      "export-touchstone": !!currentBundle?.results,
      "export-package": !!currentBundle,
      "view-design": hasDesign,
      "view-tree": inDesign,
      "view-dock": inDesign,
      "view-properties": inDesign,
      "view-ribbon": inDesign,
      "view-iso": hasViewport,
      "view-top": hasViewport,
      "view-front": hasViewport,
      "view-right": hasViewport,
      "view-bottom": hasViewport,
      "view-back": hasViewport,
      "view-left": hasViewport,
      "view-zoom-in": hasViewport,
      "view-zoom-out": hasViewport,
      "view-zoom-reset": hasViewport,
    };
    const native = (window as Window & {
      __TAURI_INTERNALS__?: { invoke: (command: string, args: { availability: Record<string, boolean> }) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    if (native) void native.invoke("sync_native_menu_availability", { availability }).catch(() => {});
  });
  createEffect(() => {
    const saved = designFile();
    if (!saved) return;
    const native = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (command: string, args: { id: string; title: string }) => Promise<unknown> } }).__TAURI_INTERNALS__;
    if (native) void native.invoke("remember_recent_design", { id: saved.id, title: saved.design.model.name }).catch(() => {});
  });

  onMount(async () => {
    const syncViewportPresence = () => setViewportPresent(!!appRoot.querySelector(".viewport"));
    const viewportObserver = new MutationObserver(syncViewportPresence);
    viewportObserver.observe(appRoot, { childList: true, subtree: true });
    syncViewportPresence();
    onCleanup(() => viewportObserver.disconnect());

    const compact = window.matchMedia("(max-width: 1040px)");
    const syncCompact = () => {
      if (compact.matches && !compactViewport()) {
        const leftOpen = !leftClosed(), rightOpen = !rightClosed();
        // Keep a deliberate single-panel desktop choice. If both were open, the compact view
        // starts with the canvas clear and lets the user open either side on demand.
        setCompactResultsPanel(leftOpen === rightOpen ? null : leftOpen ? "left" : "right");
      }
      setCompactViewport(compact.matches);
      queueMicrotask(() => {
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest(".workspace > .panel-left") && !leftPanelOpen())
          document.querySelector<HTMLElement>("[data-panel-toggle='left']")?.focus({ preventScroll: true });
        else if (active?.closest(".workspace > .panel-right") && !rightPanelOpen())
          document.querySelector<HTMLElement>("[data-panel-toggle='right']")?.focus({ preventScroll: true });
      });
    };
    compact.addEventListener("change", syncCompact);
    syncCompact();
    onCleanup(() => compact.removeEventListener("change", syncCompact));
    (window as Window & { fairbeamMenuAction?: (raw: string) => boolean }).fairbeamMenuAction = menuAction;
    const onAction = (event: Event) => menuAction((event as CustomEvent<string>).detail);
    // menu, export and download feedback: a toast over the app (lib/toast.ts), never a bar in the layout
    const onNotice = (event: Event) => { const text = (event as CustomEvent<string>).detail; if (typeof text === "string") showToast(text); };
    // the desktop shell's update progress (downloading, installing, restarting); a failed install
    // restarts the server, which the store looks for again
    onCleanup(watchUpdate(undefined, () => window.setTimeout(() => void recheckServer(), 3000)));
    window.addEventListener("fairbeam:menu-action", onAction);
    window.addEventListener("fairbeam:menu-notice", onNotice);
    onCleanup(() => { window.removeEventListener("fairbeam:menu-action", onAction); window.removeEventListener("fairbeam:menu-notice", onNotice); delete (window as Window & { fairbeamMenuAction?: (raw: string) => boolean }).fairbeamMenuAction; });
    // quiet: the start screen and the Run panel explain how to start the server if it is absent;
    // with a server the app opens on the start screen, without one on the examples
    const probe = DEMO ? Promise.resolve(false) : probeServer().then((ok) => { if (ok && appMode() === "results") setAppMode("home"); setProbed(true); return ok; });
    // runs another client starts (a terminal, a script, an agent) show up within seconds, and when
    // the window comes back to the front
    if (!DEMO) onCleanup(watchServer());
    const list = exampleEntries(await loadIndex());
    const last = lastProject();
    const pick = (DEMO ? linkedExample(list, window.location.search) : undefined)
      ?? list.find((p) => p.file === last) ?? list.find((p) => p.simulated) ?? list[0];
    if (pick) await loadProject(pick.file);
    setBooting(false);
    // a reload does not drop the open design: it comes back once the example bundle is in (it must
    // not replace the design's preview) and the server has listed its models
    if (await probe && !disposed) {
      let ready = false, busy = false, receivedOpenRequest = false;
      const attempted = new Set<string>();
      const openPending = async () => {
        if (!ready || busy || !nativeDocumentsAvailable() || hasOpenModal()) return false;
        busy = true;
        try {
          // A temporary IPC failure must not resurrect a canceled request on the next OS
          // event. Keep it excluded until the idempotent native dismissal succeeds.
          for (const handle of attempted) {
            try { await dismissPendingNativeDocument(handle); attempted.delete(handle); }
            catch { /* Retry cleanup on the next poll; other queued requests remain usable. */ }
          }
          const pending = await pendingNativeDocument([...attempted]);
          // A modal can open while the shell is finding the next request. Leave the
          // request queued until it closes; do not replace its underlying document.
          if (!ready || hasOpenModal()) return false;
          if (!pending || attempted.has(pending.handle)) return false;
          receivedOpenRequest = true;
          let opened: boolean | null = false;
          try {
            opened = await openNativeDocument(pending.handle, pending.displayName);
            return opened === true;
          } finally {
            // Null means a save/open is finishing: retry on the next poll. A final result,
            // cancellation or thrown failure consumes only this request.
            if (opened !== null) {
              attempted.add(pending.handle);
              await dismissPendingNativeDocument(pending.handle);
              attempted.delete(pending.handle);
            }
          }
        } catch { return false; } finally { busy = false; }
      };
      ready = true;
      if (!(await openPending()) && !disposed && !receivedOpenRequest) await reopenLastDesign();
      if (disposed) { ready = false; return; }
      const onOpen = () => { void openPending(); };
      window.addEventListener("fairbeam:native-document-open", onOpen);
      // OS launch can arrive while the renderer was starting; the shell keeps the queue.
      const timer = nativeDocumentsAvailable() ? setInterval(() => void openPending(), 2500) : undefined;
      cleanupDocuments = () => { ready = false; clearInterval(timer); window.removeEventListener("fairbeam:native-document-open", onOpen); };
    }
  });

  return (
    <div
      ref={appRoot}
      class="app"
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
    >
      <Header />
      <ShortcutHelp />
      {/* the one host of confirmDraftDiscard (the designer asks too, with the Run panel closed) */}
      <ConfirmDialog />
      <UpdateProgress />
      <ToastHost />
      <input ref={openInput} type="file" accept=".fb,.json,application/json" hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void openUserProject(f); e.currentTarget.value = ""; }} />
      <ExampleCopyDialog />
      <Show when={!DEMO && cstImportOpen()}><CstImportDialog /></Show>
      <Show when={!DEMO && pcbImportOpen()}><PcbImportDialog /></Show>
      <Show when={saveAsOpen() && canSaveAs()}>
        <SaveAsDialog source={{ id: designFile()!.id, name: designDraft.model?.name ?? designFile()!.id }} close={() => setSaveAsOpen(false)} />
      </Show>
      <Show when={!DEMO}><CloseProjectHost /></Show>
      <Show when={!DEMO && isDesktopShell()}><UsageStatsPrompt /></Show>
      <Show when={appMode() === "results"}>
        <div class="workspace-panels" role="group" aria-label={t("app.panels.aria")}>
          <button class="btn btn-ghost btn-sm" data-panel-toggle="left" aria-pressed={leftPanelOpen()} onClick={() => toggleResultsPanel("left")}
            title={t("app.panels.leftTitle")}>
            <PanelLeft aria-hidden="true" /> {t("app.panels.model")}
          </button>
          <button class="btn btn-ghost btn-sm" data-panel-toggle="right" aria-pressed={rightPanelOpen()} onClick={() => toggleResultsPanel("right")}
            title={t("app.panels.rightTitle")}>
            <PanelRight aria-hidden="true" /> {t("app.panels.specs")}
          </button>
        </div>
      </Show>
      <Show when={loadWarnings().length}>
        <div class="banner banner-warn" role="status">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>
            {t("app.loadWarnings", { count: loadWarnings().length })}{" "}
            <Show when={loadWarnings().length > 1} fallback={loadWarnings()[0]}>
              <details class="banner-details">
                <summary>{loadWarnings()[0]}</summary>
                <ul>
                  <For each={loadWarnings().slice(1)}>{(w) => <li>{w}</li>}</For>
                </ul>
              </details>
            </Show>
          </span>
          <button class="btn btn-ghost btn-sm" onClick={() => setLoadWarnings([])}>{t("app.dismiss")}</button>
        </div>
      </Show>
      <Show when={!DEMO}>
        <RunNotice />
      </Show>
      <Show when={appMode() === "home"}>
        <PanelBoundary name={t("panel.name.start")} class="home-wrap">
          <Home />
        </PanelBoundary>
      </Show>
      <Show when={appMode() === "design"}>
        <Show when={designFile() && designDraft.schema} fallback={
          <div class="empty">
            <h1>{t("app.noDesign.title")}</h1>
            <p class="muted">{t("app.noDesign.body")}</p>
            <button class="btn btn-primary" onClick={() => setAppMode("home")}>{t("app.noDesign.startScreen")}</button>
          </div>
        }>
          <DesignKeys />
          {/* Collapsed tree / properties: the panel stays mounted (filter, scroll, inspector state) but
              hidden, and a thin strip in the same grid cell opens it again (designer.css). */}
          <div class="workspace design-mode" classList={{ "run-open": runOpen(), "tree-collapsed": leftTreeCollapsed(), "side-collapsed": sidePanelCollapsed(), "dock-collapsed": bottomDockCollapsed() }}>
            <PanelResizeHandles />
            <PanelBoundary name={t("panel.name.tree")} class="panel panel-left">
              <DesignTreePanel />
            </PanelBoundary>
            <Show when={leftTreeCollapsed()}>
              <button class="dw-strip dw-strip-left" data-layout-focus="tree-strip" type="button" aria-expanded="false" aria-label={t("app.strip.treeAria")}
                title={t("app.strip.treeTitle", { key: SHORTCUTS.tree.key })} onClick={() => setLeftTreeCollapsed(false)}>
                <ChevronsRight size={14} aria-hidden="true" /><span>{t("app.strip.tree")}</span>
              </button>
            </Show>
            <main class="center">
              <PanelBoundary name={t("panel.name.ribbon")} class="rb-wrap">
                <div class="rb-stack">
                  <Ribbon />
                </div>
              </PanelBoundary>
              {/* the 3D view is the first of the main area's document tabs; result tabs open beside it */}
              <MainArea>
                <PanelBoundary name={t("panel.name.view3d")} class="stage-fill">
                  <Viewport />
                </PanelBoundary>
                <MeshViewPanel />
                {/* tool hints float over the top of the 3D view: the canvas keeps its size */}
                <DrawHint />
              </MainArea>
              <PanelBoundary name={t("panel.name.checks")} class="dock dw-dock-wrap">
                <DesignDock />
              </PanelBoundary>
              <PanelBoundary name={t("panel.name.status")} class="sb-wrap">
                <StatusBar />
              </PanelBoundary>
            </main>
            <Show when={runOpen()} fallback={
              <PanelBoundary name={t("panel.name.properties")} class="panel panel-right">
                <DesignSide />
              </PanelBoundary>
            }>
              <PanelBoundary name={t("panel.name.run")} class="panel panel-right">
                <RunPanel />
              </PanelBoundary>
            </Show>
            <Show when={sidePanelCollapsed()}>
              <button class="dw-strip dw-strip-right" data-layout-focus="side-strip" type="button" aria-expanded="false" aria-label={runOpen() ? t("app.strip.runAria") : t("app.strip.propertiesAria")}
                title={runOpen() ? t("app.strip.runTitle", { key: SHORTCUTS.side.key }) : t("app.strip.propertiesTitle", { key: SHORTCUTS.side.key })} onClick={() => setSidePanelCollapsed(false)}>
                <ChevronsLeft size={14} aria-hidden="true" /><span>{runOpen() ? t("app.strip.run") : t("app.strip.properties")}</span>
              </button>
            </Show>
          </div>
        </Show>
      </Show>
      <Show when={appMode() === "results" && !probed()}>
        <div class="loading home-wrap" role="status">{t("app.lookingForServer")}</div>
      </Show>
      <Show when={appMode() === "results" && probed()}>
      <div class="workspace" classList={{ "run-open": resultsRunOpen(), "code-open": resultsRunOpen() && panelTab() === "code", "left-closed": !leftPanelOpen(), "right-closed": !rightPanelOpen() }}>
        <PanelResizeHandles />
        <PanelBoundary name={t("panel.name.model")} class="panel panel-left">
          <ModelPanel />
        </PanelBoundary>
        <main class="center" classList={{ "center-no-dock": !bundle() }}>
          <Show
            when={bundle() || index().length}
            fallback={
              <Show when={!booting()} fallback={<div class="loading" role="status">{t("app.loadingProject")}</div>}>
                <div class="empty">
                  <h1>{t("app.noProjects.title")}</h1>
                  <p>{t(DEMO || isDesktopShell() ? "app.noProjects.body" : "app.noProjects.bodyServer")}</p>
                  <p class="muted">{t("app.noProjects.drop")}</p>
                  <Show when={!DEMO}><button class="btn btn-primary" onClick={() => setAppMode("home")}>{t("app.noDesign.startScreen")}</button></Show>
                </div>
              </Show>
            }
          >
            <div class="stage">
              <PanelBoundary name={t("panel.name.view3d")} class="stage-fill">
                <Viewport />
              </PanelBoundary>
              <Show when={bundle() && centerView() === "drawing"}>
                <PanelBoundary name={t("panel.name.drawing")} class="stage-fill stage-over">
                  <DrawingView />
                </PanelBoundary>
              </Show>
              <Show when={bundle()}>
                <ViewSwitch />
              </Show>
            </div>
          </Show>
          {/* nothing open: no result tabs to show */}
          <Show when={bundle()}>
            <PanelBoundary name={t("panel.name.results")} class="dock">
              <Dock />
            </PanelBoundary>
          </Show>
          <PreviewBadge />
        </main>
        <Show
          when={resultsRunOpen()}
          fallback={
            <PanelBoundary name={t("panel.name.spec")} class="panel panel-right">
              <SpecPanel />
            </PanelBoundary>
          }
        >
          <PanelBoundary name={t("panel.name.run")} class="panel panel-right">
            <RunPanel />
          </PanelBoundary>
        </Show>
      </div>
      </Show>
      <Show when={exportOpen() && (appMode() === "design" ? designFile() : bundle())}>
        <PanelBoundary name={t("panel.name.geometryExport")} loading={<div class="scrim" />} onClose={() => setExportOpen(false)}>
          <ExportDialog />
        </PanelBoundary>
      </Show>
      <Show when={renderDialogOpen() && bundle()}>
        <PanelBoundary name={t("panel.name.render")} loading={<div class="scrim" />} onClose={() => setRenderDialogOpen(false)}>
          <RenderDialog />
        </PanelBoundary>
      </Show>
      <Show when={packageOpen() && bundle()}>
        <PanelBoundary name={t("panel.name.packageExport")} loading={<div class="scrim" />} onClose={() => setPackageOpen(false)}>
          <PackageDialog />
        </PanelBoundary>
      </Show>
      <Show when={researchOpen()}>
        <PanelBoundary name={t("research.title")} loading={<div class="scrim" />} onClose={() => setResearchOpen(false)}>
          <ResearchDialog />
        </PanelBoundary>
      </Show>
      <Show when={dragging() && !pcbImportOpen() && !cstImportOpen()}>
        <div class="drop-hint" aria-hidden="true">{t("app.dropHint")}</div>
      </Show>
    </div>
  );
}
