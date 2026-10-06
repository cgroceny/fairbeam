import { createMemo, createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { Download, FileText, TriangleAlert, X } from "lucide-solid";
import { bundle, setPackageOpen } from "../state";
import { PACKAGE_GROUPS, cstGeometryOnly, fabUnavailable, packageFiles, packageName, zipPackage, type PackageGroup } from "../export/package";
import { technicalDrawing } from "../drawing/drawing";
import { capture3d, reportPdfFor, svgToPdf } from "../drawing/render";
import { useModal } from "../lib/dialog";
import { arrayWeights, hasArray } from "../lib/arrayStore";
import { reference } from "../compare/store";
import { downloadFailedMessage, downloadMessage, revealDownloadedFile, saveDownload } from "../lib/download";
import { countUsage } from "../lib/telemetry";
import { hasKey, t } from "../i18n";

/** A package group's label or hint in the UI language (package.group.<id>.*), else its English text. */
const groupText = (g: { id: PackageGroup; label: string; hint: string }, field: "label" | "hint") =>
  hasKey(`package.group.${g.id}.${field}`) ? t(`package.group.${g.id}.${field}`) : g[field];

export default function PackageDialog() {
  let dialog!: HTMLDivElement;
  const hasResults = () => !!bundle()?.results;
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
  const available = (g: PackageGroup) => (g === "fab" ? !fabReason() : hasResults() || !(g === "data" || g === "figures"));
  const effective = () => Object.fromEntries(PACKAGE_GROUPS.map((g) => [g.id, inc[g.id] && available(g.id)])) as Record<PackageGroup, boolean>;
  // preview of the file list (placeholders for the browser-rendered PNG and PDF)
  const preview = createMemo(() => {
    const b = bundle();
    if (!b) return [];
    const ph = new Uint8Array(0);
    return packageFiles(b, effective(), { isoPng: ph, drawingPdf: ph, reportPdf: ph, arrayWeights: hasArray() ? arrayWeights() : null, reference: reference() }).map((f) => f.path);
  });
  const name = () => (bundle() ? packageName(bundle()!, new Date()) : "");

  const download = async () => {
    const b = bundle();
    if (!b || busy()) return;
    const now = new Date();
    const want = effective();
    const problems: string[] = [];
    const file = packageName(b, now);
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
          reportPdf = await reportPdfFor(b, now, hasArray() ? arrayWeights() : null, reference());
        } catch (e) {
          console.error(e);
          problems.push(t("package.missing.report"));
        }
      }
      setBusy(t("package.busy.zip"));
      await new Promise((r) => setTimeout(r, 0));
      const files = packageFiles(b, want, { isoPng, drawingPdf, reportPdf, arrayWeights: hasArray() ? arrayWeights() : null, reference: reference() }, now);
      const r = await saveDownload(file, zipPackage(files, file.replace(/\.zip$/, ""), now), "application/zip");
      if (reportPdf && r.status !== "cancelled" && r.status !== "failed") countUsage("feature.pdf_report");
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
    const file = packageName(b, now).replace(/\.zip$/, "_report.pdf");
    try {
      const r = await saveDownload(file, await reportPdfFor(b, now, hasArray() ? arrayWeights() : null, reference()), "application/pdf");
      if (r.status !== "cancelled" && r.status !== "failed") countUsage("feature.pdf_report");
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
                    <span class="package-hint">{available(g.id) ? hint(g) : g.id === "fab" ? t("package.unavailable", { reason: fabReason() }) : t("package.needsResults")}</span>
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
            <button class="btn btn-ghost" onClick={downloadReport} disabled={!!busy()} title={t("package.reportTitle")}>
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
