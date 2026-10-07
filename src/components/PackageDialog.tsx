import { createMemo, createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { Download, FileText, TriangleAlert, X } from "lucide-solid";
import { setPackageOpen } from "../state";
import { PACKAGE_GROUPS, cstGeometryOnly, fabUnavailable, packageFiles, packageName, zipPackage, type PackageGroup } from "../export/package";
import { technicalDrawing } from "../drawing/drawing";
import { capture3d, reportPdfFor, svgToPdf } from "../drawing/render";
import { useModal } from "../lib/dialog";
import { arrayWeights, hasArray } from "../lib/arrayStore";
import { reference } from "../compare/store";
import { downloadFailedMessage, downloadMessage, revealDownloadedFile, saveDownload } from "../lib/download";
import { hasKey, t } from "../i18n";
import { appMode } from "../workspace";
import { designResultState, exportBundle } from "../designer/activeResult";
import { activeExportSurface, geometryAvailable } from "./exportContext";
import { models } from "../runner/store";
import type { ModelFileRef } from "../export/report";
import type { Bundle } from "../types";

/** The workspace file a bundle was run from, as the run server lists it (the reproduce command runs it). */
function modelFileOf(b: Bundle): ModelFileRef | null {
  const m = models().find((x) => x.model?.id === b.model.id && !x.error);
  return m ? { file: m.file, kind: m.kind ?? (m.file.endsWith(".design.json") ? "design" : "python") } : null;
}

/** A package group's label or hint in the UI language (package.group.<id>.*), else its English text. */
const groupText = (g: { id: PackageGroup; label: string; hint: string }, field: "label" | "hint") =>
  hasKey(`package.group.${g.id}.${field}`) ? t(`package.group.${g.id}.${field}`) : g[field];

export default function PackageDialog() {
  let dialog!: HTMLDivElement;
  // in Design mode the design's run (else its geometry), never the preview or an Examples bundle (designer/activeResult.ts)
  const bundle = exportBundle;
  const hasResults = () => !!bundle()?.results;
  /** why Data and Publication figures are not offered */
  const resultsReason = () => appMode() !== "design" ? t("package.needsResults")
    : designResultState().loading ? t("package.readingRun") : t("package.noRunYet");
  /** why the 3D view cannot be captured: the viewport is not on screen (a result tab, the drawing) */
  const imageReason = () => activeExportSurface() === "viewport" && geometryAvailable() ? null
    : activeExportSurface() === "design-result" ? t("package.image.resultTab") : t("package.image.noView");
  const [inc, setInc] = createStore<Record<PackageGroup, boolean>>({
    project: true, readme: true, report: true, data: true, drawings: true, figures: true, cst: true, fab: true, image: true,
  });
  const [busy, setBusy] = createSignal<string | null>(null);
  // the last outcome: a download request (never proof of a saved file) or a failure; warn adds the alert icon
  const [note, setNote] = createSignal<{ text: string; warn: boolean; path?: string } | null>(null);
  // fabrication export needs a printed board; the reason is shown in place of the hint
  const fabReason = createMemo(() => (bundle() ? fabUnavailable(bundle()!) : null));
  // the CST macro of a design with a grouped port carries the geometry only (src/export/package.ts)
  const cstNoPorts = createMemo(() => !!bundle() && cstGeometryOnly(bundle()!));
  const hint = (g: (typeof PACKAGE_GROUPS)[number]) => (g.id === "cst" && cstNoPorts() ? t("package.group.cst.noPorts") : groupText(g, "hint"));
  const available = (g: PackageGroup) => (g === "fab" ? !fabReason() : g === "image" ? !imageReason() : hasResults() || !(g === "data" || g === "figures"));
  const unavailableText = (g: PackageGroup) => g === "fab" ? t("package.unavailable", { reason: fabReason() }) : g === "image" ? imageReason() : resultsReason();
  const effective = () => Object.fromEntries(PACKAGE_GROUPS.map((g) => [g.id, inc[g.id] && available(g.id)])) as Record<PackageGroup, boolean>;
  // preview of the file list (placeholders for the browser-rendered PNG and PDF)
  const preview = createMemo(() => {
    const b = bundle();
    if (!b) return [];
    const ph = new Uint8Array(0);
    return packageFiles(b, effective(), { isoPng: ph, drawingPdf: ph, reportPdf: ph, arrayWeights: hasArray() ? arrayWeights() : null, reference: reference() }).map((f) => f.path);
  });
  // the time in the file name: when the dialog opened, then the moment of the last export (the name shown is the name saved)
  const [stampAt, setStampAt] = createSignal(new Date());
  const name = () => (bundle() ? packageName(bundle()!, stampAt()) : "");

  const download = async () => {
    const b = bundle();
    if (!b || busy()) return;
    const now = new Date();
    setStampAt(now);
    const want = effective();
    const problems: string[] = [];
    const file = packageName(b, now);
    const model = modelFileOf(b);
    setNote(null);
    try {
      let isoPng: Uint8Array | null = null;
      let drawingPdf: Uint8Array | null = null;
      let reportPdf: Uint8Array | null = null;
      if (want.image) {
        setBusy(t("package.busy.capture"));
        isoPng = await capture3d();
        if (!isoPng) problems.push(t("package.missing.image"));
      }
      if (want.drawings) {
        setBusy(t("package.busy.drawing"));
        try {
          const y = now.getFullYear();
          const date = `${y}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
          drawingPdf = await svgToPdf(technicalDrawing(b, { sheet: "A3", date }).svg, b.name);
        } catch (e) {
          console.error(e);
          problems.push(t("package.missing.drawing"));
        }
      }
      if (want.report) {
        setBusy(t("package.busy.report"));
        try {
          // the report lists the files of this package: the ones captured and rendered so far, the report itself
          const ph = new Uint8Array(1);
          const paths = packageFiles(b, want, { isoPng, drawingPdf, reportPdf: ph, arrayWeights: hasArray() ? arrayWeights() : null, reference: reference(), model }, now).map((f) => f.path);
          reportPdf = await reportPdfFor(b, now, hasArray() ? arrayWeights() : null, reference(), { files: paths, model });
        } catch (e) {
          console.error(e);
          problems.push(t("package.missing.report"));
        }
      }
      setBusy(t("package.busy.zip"));
      await new Promise((r) => setTimeout(r, 0));
      const files = packageFiles(b, want, { isoPng, drawingPdf, reportPdf, arrayWeights: hasArray() ? arrayWeights() : null, reference: reference(), model }, now);
      const r = await saveDownload(file, zipPackage(files, file.replace(/\.zip$/, ""), now), "application/zip");
      setNote(problems.length
        ? { text: downloadMessage(r, t("package.filesWithout", { count: files.length, missing: problems.join(", ") })), warn: true, path: r.status === "saved" ? r.path : undefined }
        : { text: downloadMessage(r, t("package.files", { count: files.length })), warn: r.status === "failed" || r.status === "cancelled", path: r.status === "saved" ? r.path : undefined });
    } catch (e) {
      console.error(e);
      setNote({ text: downloadFailedMessage(file, e), warn: true });
    } finally {
      setBusy(null);
    }
  };

  const downloadReport = async () => {
    const b = bundle();
    if (!b || busy()) return;
    setBusy(t("package.busy.report"));
    setNote(null);
    const now = new Date();
    setStampAt(now);
    const file = packageName(b, now).replace(/\.zip$/, "_report.pdf");
    try {
      const r = await saveDownload(file, await reportPdfFor(b, now, hasArray() ? arrayWeights() : null, reference(), { model: modelFileOf(b) }), "application/pdf");
      setNote({ text: downloadMessage(r), warn: r.status === "failed" || r.status === "cancelled", path: r.status === "saved" ? r.path : undefined });
    } catch (e) {
      console.error(e);
      setNote({ text: downloadFailedMessage(file, e), warn: true });
    } finally {
      setBusy(null);
    }
  };

  useModal(() => dialog, () => setPackageOpen(false), () => dialog.querySelector<HTMLElement>(".dialog-actions .btn-primary"));

  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && setPackageOpen(false)}>
      <div class="dialog dialog-package" role="dialog" aria-modal="true" aria-labelledby="package-title" aria-describedby="package-desc" tabindex={-1} ref={dialog}>
        <header class="dialog-head">
          <div>
            <h2 id="package-title">{t("package.title")}</h2>
            <p class="muted" id="package-desc">{t("package.description")}</p>
          </div>
          <button class="icon-btn" onClick={() => setPackageOpen(false)} aria-label={t("common.close")}><X size={16} aria-hidden="true" /></button>
        </header>
        <div class="dialog-body package-body">
          <fieldset class="package-options">
            <legend class="section-label">{t("package.include")}</legend>
            <For each={PACKAGE_GROUPS}>
              {(g) => (
                <label class="toggle package-toggle" classList={{ disabled: !available(g.id) }}>
                  <input type="checkbox" checked={inc[g.id] && available(g.id)} disabled={!available(g.id)} onChange={(e) => setInc(g.id, e.currentTarget.checked)} />
                  <span class="toggle-box" aria-hidden="true" />
                  <span class="package-text">
                    <span>{groupText(g, "label")}</span>
                    <span class="package-hint">{available(g.id) ? hint(g) : unavailableText(g.id)}</span>
                  </span>
                </label>
              )}
            </For>
          </fieldset>
          <div class="package-files">
            <h3 class="section-label">{t("package.filesHeading")} · {preview().length}</h3>
            <ul class="package-list mono" aria-label={t("package.filesAria")} tabindex={0}>
              <li class="package-root">{name().replace(/\.zip$/, "")}/</li>
              <For each={preview()}>{(p) => <li>{p}</li>}</For>
            </ul>
          </div>
        </div>
        <footer class="dialog-foot">
          <Show
            when={busy() ?? note()?.text}
            fallback={<span class="muted mono">{name()}</span>}
          >
            <span class="package-status" role="status" aria-live="polite">
              <Show when={!busy() && note()?.warn}><TriangleAlert size={14} aria-hidden="true" /></Show>
              {busy() ?? note()?.text}
              <Show when={!busy() && note()?.path}>{(path) => <button class="linklike" onClick={() => void revealDownloadedFile(path()).catch((e) => setNote({ text: t("package.revealFailed", { error: String(e) }), warn: true }))}>{t("package.reveal")}</button>}</Show>
            </span>
          </Show>
          <div class="dialog-actions">
            <button class="btn btn-ghost" onClick={downloadReport} disabled={!!busy() || !bundle()} title={t("package.reportTitle")}>
              <FileText size={14} aria-hidden="true" /> {t("package.exportReport")}
            </button>
            <button class="btn btn-primary" onClick={download} disabled={!!busy() || !preview().length}>
              <Download size={14} aria-hidden="true" /> {busy() ? t("package.preparing") : t("package.download")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
