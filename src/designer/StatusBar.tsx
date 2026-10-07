// The designer's status bar, under the bottom dock: the cursor position in the 3D view,
// the work plane (WCS), units, the mesh size of the preview (a click toggles the mesh view), the
// check summary, a run in progress, the preview and the run server. On a narrow window the less
// important items give way first (container queries in designer-sim.css), so nothing is clipped.
// After a failed server preview the mesh numbers are labelled as the last successful ones and the
// failure (with Retry) stays visible at every width until a preview of the current draft succeeds.
import { onCleanup, onMount, Show } from "solid-js";
import { CircleAlert, CircleCheck, Clock, Info, LoaderCircle, LocateFixed, RotateCw, TriangleAlert, X } from "lucide-solid";
import { num } from "../lib/format";
import { viewCursor } from "../state";
import { isTerminal } from "../runner/api";
import { health, liveInfo, liveProgress, meshFreshness, previewFailure, previewMs, previewState, recheckServer, serverActivity, serverState } from "../runner/store";
import { runFraction } from "../runner/liveRun";
import { designJob, setDesignDockTab } from "../runner/designRun";
import { localFrame, plane, resetWcsToGlobal, snap, tool, wcs, wcsIsGlobal, worldToWcs } from "./draw";
import { shown as fmt } from "./displayNumber.ts";
import { evaluate } from "./expr";
import { cellsText } from "./meshStats";
import { draftMeshStats } from "./draftMesh";
import { meshView, toggleMeshView } from "./MeshView";
import { checks, names, retryPreview } from "./store";
import { setBottomDockCollapsed } from "./layoutState";
import { t } from "../i18n";

export default function StatusBar() {
  const c = () => viewCursor();
  const fresh = meshFreshness;
  // no numbers of another project or design once a preview failed without one of this design
  const stats = () => fresh() === "unknown" ? null : draftMeshStats();
  const meshText = () => {
    const s = stats();
    if (!s) return t(fresh() === "unknown" ? "status.mesh.unknown" : "status.mesh.none");
    const text = t("status.mesh.cells", { cells: cellsText(s.cells), min: num(s.minCell, 3) });
    return fresh() === "stale" ? t("status.mesh.lastGood", { text }) : text;
  };
  const meshTitle = () => {
    const s = stats();
    if (fresh() === "unknown") return t("status.mesh.unknown.title");
    if (!s) return t("status.mesh.none.title");
    const lines = t("status.mesh.lines", { lines: s.lines.join(" × ") });
    if (fresh() === "stale") return t("status.mesh.stale.title", { lines });
    if (fresh() === "updating") return t("status.mesh.updating.title", { lines });
    return t("status.mesh.title", { lines });
  };
  const errs = () => checks().filter((x) => x.severity === "error").length;
  const warns = () => checks().filter((x) => x.severity === "warning").length;
  // notes (e.g. a thin metal modelled as a sheet) do not block a run but do change the model
  const notes = () => checks().filter((x) => x.severity === "info").length;
  const running = () => {
    const j = designJob();
    return j && !isTerminal(j.status) ? j : null;
  };
  /** short, so the server item keeps its place: "Server busy" (a run the dock does not show) and/or "n queued" */
  const queueText = () => {
    const a = serverActivity();
    if (!a.otherRunning) return t("status.queue", { count: a.queued });
    return a.queued ? t("status.queue.busyQueued", { count: a.queued }) : t("status.queue.busy");
  };
  // the phase and the solver's progress (runner/liveRun.ts), as the dock's progress bar shows it
  const pct = () => {
    const j = running();
    return j ? Math.round(100 * runFraction(j, liveProgress(), liveInfo())) : 0;
  };
  /** The cursor in the active WCS: x y z for the global one, u v w for a local one. */
  const cursorText = () => {
    const p = c();
    if (!p) return wcsIsGlobal() ? "x —  y —  z —" : "u —  v —  w —";
    if (wcsIsGlobal()) return `x ${num(p.x, 2)}  y ${num(p.y, 2)}  z ${num(p.z, 2)}`;
    const l = worldToWcs([p.x, p.y, p.z]);
    return l ? `u ${num(l[0], 2)}  v ${num(l[1], 2)}  w ${num(l[2], 2)}` : "u —  v —  w —";
  };
  const wcsOrigin = () => {
    try { return localFrame().origin.map((e) => fmt(evaluate(e, names().names))).join(", "); } catch { return "?"; }
  };
  const wcsDirection = () => `${wcs().flip ? "−" : "+"}${plane().normal}`;
  // the preview stopped because the design has errors (not because the server failed): the server
  // answered, and Retry cannot help until the errors are fixed
  const paused = () => serverState() === "online" && errs() > 0;
  const showChecks = () => { setDesignDockTab("checks"); setBottomDockCollapsed(false); };
  // "Server online" must not go stale: while the server is online the app looks every 5 s
  // (watchServer, which also picks up runs other clients start); while it is not, look again here
  onMount(() => {
    const timer = setInterval(() => { if (!document.hidden && serverState() !== "online") void recheckServer(); }, 10_000);
    onCleanup(() => clearInterval(timer));
  });
  const server = () => serverState() === "online" ? `${t("status.server.online")}${health()?.engines?.includes("gpu") ? " · GPU" : ""}`
    : t(serverState() === "offline" ? "status.server.offline" : serverState() === "checking" ? "status.server.checking" : "status.server.unknown");
  return (
    <footer class="sb" role="group" aria-label={t("status.label")}>
      <span class="sb-item sb-cursor mono" title={t("status.cursor.title")}>
        <span class="sb-text">{cursorText()}</span>
      </span>
      <Show when={wcsIsGlobal()} fallback={
        <button class="sb-item sb-btn sb-wcs-local" type="button" onClick={resetWcsToGlobal}
          title={t("status.wcs.localTitle", { w: wcsDirection(), origin: wcsOrigin() })}>
          <LocateFixed size={12} aria-hidden="true" /> <span>{t("status.wcs.local")}</span>
          <span class="mono muted">w {wcsDirection()}</span>
          <span class="sb-wcs-reset"><X size={11} aria-hidden="true" /> {t("status.wcs.reset")}</span>
        </button>
      }>
        <span class="sb-item sb-t2" title={tool() ? t("status.wcs.titleDrawing", { tool: tool(), snap: snap() }) : t("status.wcs.title", { snap: snap() })}>
          WCS <span class="mono">{t("status.wcs.global")}</span>
        </span>
      </Show>
      <span class="sb-item sb-t1" title={t("status.units.title")}>mm · GHz</span>
      <button class="sb-item sb-btn sb-mesh" aria-pressed={meshView()} onClick={toggleMeshView} data-fresh={fresh()} title={meshTitle()}>
        <span class="mono sb-text">{meshText()}</span>
      </button>
      <button class="sb-item sb-btn" onClick={showChecks} title={t("status.checks.title")}>
        <Show when={errs() + warns()} fallback={<><CircleCheck size={12} class="sb-good" aria-hidden="true" /> {t(notes() ? "status.checks.noErrors" : "status.checks.passed")}</>}>
          <Show when={errs()}><CircleAlert size={12} class="sb-bad" aria-hidden="true" /><span class="sb-bad">{t("status.checks.errors", { count: errs() })}</span></Show>
          <Show when={warns()}><TriangleAlert size={12} class="sb-warn" aria-hidden="true" /><span>{t("status.checks.warnings", { count: warns() })}</span></Show>
        </Show>
        <Show when={notes()}><span class="muted" aria-hidden="true">·</span><Info size={12} class="muted" aria-hidden="true" /><span class="muted">{t("status.checks.notes", { count: notes() })}</span></Show>
      </button>
      <Show when={running()}>
        <button class="sb-item sb-btn" onClick={() => { setDesignDockTab("run"); setBottomDockCollapsed(false); }} title={t("status.running.title")}>
          <LoaderCircle size={12} class="rs-spin" aria-hidden="true" /> <span class="sb-text">{running()!.status === "queued" ? t("progress.status.queued") : t("status.running", { pct: pct() })}</span>
        </button>
      </Show>
      {/* the server is busy with runs the dock does not show (a terminal, another window, another
          design; #7): say so, and open the dock's Queue tab on a click */}
      <Show when={serverActivity().otherRunning || serverActivity().queued > 0}>
        <button class="sb-item sb-btn sb-queue" data-testid="sb-queue" onClick={() => setDesignDockTab("queue")} title={t("status.queue.title")}>
          <Clock size={12} aria-hidden="true" /> <span class="sb-text">{queueText()}</span>
        </button>
      </Show>
      <span class="sb-item sb-grow" />
      <Show when={previewFailure()} fallback={
        <span class="sb-item sb-t1 sb-fixed muted" title={t("status.preview.title")}>
          {previewState() === "loading" ? t("status.preview.updating") : previewMs() !== null ? t("status.preview.ms", { ms: previewMs() }) : t("status.preview.none")}
        </span>
      }>
        {(why) => (
          <Show when={!paused()} fallback={
            <button class="sb-item sb-btn sb-fail sb-fixed" onClick={showChecks} title={t("status.preview.paused.title")}>
              <CircleAlert size={12} aria-hidden="true" />
              <span>{t("status.preview.paused", { count: errs() })}</span>
            </button>
          }>
            <button class="sb-item sb-btn sb-fail sb-fixed" onClick={retryPreview}
              title={t("status.preview.failed.title", { why: why() })}>
              <Show when={previewState() === "loading"} fallback={<CircleAlert size={12} aria-hidden="true" />}>
                <LoaderCircle size={12} class="rs-spin" aria-hidden="true" />
              </Show>
              <span>{t("status.preview.failed")}</span>
              <span class="sb-fail-retry"><RotateCw size={11} aria-hidden="true" /> {t("status.preview.retry")}</span>
            </button>
          </Show>
        )}
      </Show>
      <button class="sb-item sb-btn sb-fixed sb-server" onClick={() => void recheckServer()} title={serverState() === "online" ? `Fairbeam ${health()?.fairbeam ?? ""} · openEMS ${health()?.openems ?? "?"}` : t("status.server.probe")}>
        <span class={`sb-dot sb-dot-${serverState()}`} aria-hidden="true" /> <span class="sb-t3">{server()}</span>
      </button>
    </footer>
  );
}
