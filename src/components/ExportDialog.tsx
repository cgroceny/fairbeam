import { createMemo, createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { strToU8, zipSync } from "fflate";
import { Check, Copy, Download, TriangleAlert, X } from "lucide-solid";
import { bundle, setExportOpen } from "../state";
import { cstInsertPairs, cstMacro, DEFAULT_CST_OPTIONS, type CstOptions } from "../export/cst";
import { useModal } from "../lib/dialog";
import { downloadFailedMessage, downloadMessage, revealDownloadedFile, saveDownload } from "../lib/download";
import { t } from "../i18n";
import { cssVar } from "../lib/cssvar";
import { appMode } from "../workspace";
import { draft } from "../designer/store";
import { api } from "../runner/api";
import NumberField from "./NumberField";
import { DEFAULT_SHEET_THICKNESS_UM, SHEET_THICKNESS_UM } from "../export/mesh";
import type { Bundle } from "../types";
import { designStem } from "../lib/exportNames";

/** the macro's options; their label and hint are export.option.<key>.label / .hint */
const OPTIONS: (keyof Omit<CstOptions, "component">)[] = ["mergeParts", "includePorts", "farfieldMonitors", "solverSettings"];
type GeometryFormat = "blender" | "glb" | "stl" | "cst";
/** the CST files' name (<stem>.bas, <stem>-cst.zip): the design's file stem, as every export of it */
const cstFileStem = (modelId: string | undefined) => designStem(modelId);

export default function ExportDialog() {
  let dialog!: HTMLDivElement;
  // Order matters here: createMemo runs at once, while the dialog mounts, so the state and helpers it reads
  // are declared above it. Outside the Design tab (Examples, Results) the bundle is there at once and the
  // format starts as CST, so the macro is built during the first render.
  const [opt, setOpt] = createStore<CstOptions>({ ...DEFAULT_CST_OPTIONS });
  const [copied, setCopied] = createSignal(false);
  const inDesign = appMode() === "design";
  // Export the draft captured when the dialog opens, even before its debounced viewport preview.
  // Never fall back to an earlier result when the current design fails to build.
  const design = inDesign ? structuredClone(unwrap(draft)) : null;
  const [source, setSource] = createSignal<Bundle | null>(inDesign ? null : bundle());
  const [sourceBusy, setSourceBusy] = createSignal(inDesign);
  const [sourceError, setSourceError] = createSignal("");
  const [format, setFormat] = createSignal<GeometryFormat>(inDesign ? "blender" : "cst");
  const [blenderBusy, setBlenderBusy] = createSignal(false);
  // the last download request (never proof of a saved file) or failure, shown in the footer
  const [note, setNote] = createSignal<{ text: string; warn: boolean; path?: string } | null>(null);
  // Sheets (traces, ground planes) have no volume. "Give sheets a thickness" turns each into a closed slab (default
  // 1 oz copper, 35 um) for CAD, slicers and viewers that cannot show a surface; off keeps two-sided surfaces.
  const [sheetSolid, setSheetSolid] = createSignal(true);
  const [sheetUm, setSheetUm] = createSignal(String(DEFAULT_SHEET_THICKNESS_UM));
  const [perSolid, setPerSolid] = createSignal(false);

  const isCst = () => format() === "cst";
  const macroBase = () => cstFileStem(source()?.model.id);
  const fileName = () => `${macroBase()}.bas`;
  // the macro carries independent discrete ports only: grouped ports are refused, geometry alone can still go
  const groupedPortsBlocked = () => isCst() && opt.includePorts && !!source()?.ports.some((p) => p.group);
  const result = createMemo(() => {
    const b = source();
    return b && isCst() && !groupedPortsBlocked() ? cstMacro(b, { ...opt }, { macroBase: cstFileStem(b.model.id), ...(design ? { inserts: cstInsertPairs(design), parametric: design } : {}) }) : null;
  });
  const previewText = () => result()?.text ?? "";
  /** polyhedra travel as .stl files next to the macro, so the download is a .zip with the macro and the files */
  const stlCount = () => result()?.files.length ?? 0;
  const formatHint = () => t(format() === "cst" ? "export.description" : `export.${format()}.hint`);
  /** what the chosen mesh format carries, and what it leaves out */
  const formatScope = () => t(format() === "stl" ? "export.stl.scope" : format() === "glb" ? "export.glb.scope" : "export.blender.scope");
  const downloadLabel = () => t(blenderBusy() ? "export.blender.preparing" : format() === "cst" ? (stlCount() ? "export.downloadZip" : "export.download") : `export.${format()}.download`);
  // the thickness typed, within SHEET_THICKNESS_UM, else null: the field shows the range and the export waits (never
  // another thickness than the one shown)
  const sheetUmValue = () => {
    const text = sheetUm().trim(), v = Number(text);
    return text !== "" && Number.isFinite(v) && v >= SHEET_THICKNESS_UM.min && v <= SHEET_THICKNESS_UM.max ? v : null;
  };
  const sheetInvalid = () => !isCst() && sheetSolid() && sheetUmValue() === null;
  const meshOptions = () => ({ sheetThicknessUm: sheetSolid() ? sheetUmValue()! : 0 });

  let controller: AbortController | undefined;
  const prepare = async () => {
    if (!design) return;
    controller?.abort();
    const ctl = controller = new AbortController();
    setSourceBusy(true); setSourceError(""); setSource(null);
    try {
      const result = await api.previewDesign(design, {}, ctl.signal);
      if (!ctl.signal.aborted) setSource(result.bundle);
    } catch (error) {
      if (!ctl.signal.aborted) setSourceError(String(error instanceof Error ? error.message : error));
    } finally { if (!ctl.signal.aborted) setSourceBusy(false); }
  };
  onMount(() => { if (design) void prepare(); });
  onCleanup(() => controller?.abort());
  const downloadGeometry = async () => {
    const b = source();
    if (!b || blenderBusy() || sheetInvalid()) return;
    setBlenderBusy(true);
    setNote({ text: t("export.blender.preparing"), warn: false });
    const chosen = format();
    let name = chosen === "blender" ? "fairbeam-blender.zip" : `fairbeam.${chosen}`;
    try {
      const { blenderPackage, blenderFileStem } = await import("../export/blender");
      name = `${blenderFileStem(b.model.id)}${chosen === "blender" ? "-blender.zip" : `.${chosen}`}`;
      const color = (role: string) => cssVar(role);
      const colors = {
        metal: color("--al-3d-metal"), dielectric: color("--al-3d-dielectric"), port: color("--al-3d-port"),
        edge: color("--al-3d-edge"), domain: color("--al-3d-domain"), nf2ff: color("--al-3d-nf2ff"),
        ground: color("--al-3d-ground"), grid: color("--al-viewport-grid"), gridMajor: color("--al-viewport-grid-major"),
      };
      const components = design ? Object.fromEntries(design.parts.map(part => [part.name, part.component ?? ""])) : {};
      const options = meshOptions();
      const split = chosen === "stl" && perSolid();
      if (split) name = `${blenderFileStem(b.model.id)}-stl.zip`;
      const bytes = split ? zipSync(Object.fromEntries((await import("../export/mesh")).binaryStlParts(b, options).map(f => [f.name, f.bytes])))
        : chosen === "stl" ? (await import("../export/mesh")).binaryStl(b, options)
        : chosen === "glb" ? new Uint8Array(await (await import("../export/blender")).blenderGlb(b, colors, components, options))
        : await blenderPackage(b, colors, components, options);
      const outcome = await saveDownload(name, bytes, split || chosen === "blender" ? "application/zip" : chosen === "stl" ? "model/stl" : "model/gltf-binary");
      setNote({ text: downloadMessage(outcome), warn: outcome.status === "failed" || outcome.status === "cancelled", path: outcome.status === "saved" ? outcome.path : undefined });
    } catch (error) {
      setNote({ text: downloadFailedMessage(name, error), warn: true });
    } finally { setBlenderBusy(false); }
  };

  const download = async () => {
    const r = result();
    if (!r) return;
    const zip = r.files.length > 0;
    const name = zip ? `${macroBase()}-cst.zip` : fileName();
    try {
      const outcome = zip
        ? await saveDownload(name, zipSync({ [fileName()]: strToU8(r.text), ...Object.fromEntries(r.files.map((f) => [f.name, strToU8(f.data)])) }), "application/zip")
        : await saveDownload(name, r.text, "text/plain");
      setNote({ text: downloadMessage(outcome), warn: outcome.status === "cancelled" || outcome.status === "failed", path: outcome.status === "saved" ? outcome.path : undefined });
    } catch (e) {
      console.error(e);
      setNote({ text: downloadFailedMessage(name, e), warn: true });
    }
  };
  const copy = async () => {
    const r = result();
    if (!r) return;
    setCopied(false);
    setNote(null);
    try {
      await navigator.clipboard.writeText(r.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setNote({ text: t("export.copyFailed"), warn: true });
    }
  };

  useModal(() => dialog, () => setExportOpen(false));
  /** "Home → Macros → Run Macro…, pick <file>." around the file name */
  const runMacro = () => t("export.step.run", { file: "\u0001" }).split("\u0001");

  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && setExportOpen(false)}>
      <div class="dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title" aria-describedby="export-desc" tabindex={-1} ref={dialog}>
        <header class="dialog-head">
          <div>
            <h2 id="export-title">{t("export.title")}</h2>
            <p class="muted" id="export-desc">{formatHint()}</p>
          </div>
          <button class="icon-btn" onClick={() => setExportOpen(false)} aria-label={t("common.close")}><X size={16} aria-hidden="true" /></button>
        </header>
        <div class="dialog-body">
          <div class="export-options">
            <label class="field"><span>{t("export.format")}</span><select value={format()} disabled={blenderBusy()} onChange={e => { setFormat(e.currentTarget.value as GeometryFormat); setNote(null); }}>
              <option value="blender">Blender (.glb / .blend)</option><option value="glb">glTF (.glb)</option><option value="stl">STL (.stl)</option><option value="cst">{t("export.cst.option")}</option>
            </select></label>
            <Show when={sourceBusy()}><p role="status">{t("export.sourcePreparing")}</p></Show>
            <Show when={groupedPortsBlocked()}><p class="status-block status-warn" role="status">{t("export.groupedPorts")}</p></Show>
            <Show when={sourceError()}><p class="status-block status-warn" role="alert">{sourceError()}</p><button class="btn" onClick={() => void prepare()}>{t("common.retry")}</button></Show>
            <Show when={isCst()}>
            <label class="field">
              <span>{t("export.componentName")}</span>
              <input autocomplete="off" type="text" value={opt.component} onInput={(e) => setOpt("component", e.currentTarget.value.replace(/[^A-Za-z0-9_]/g, "_") || "fairbeam")} />
            </label>
            <div class="toggle-list">
              <For each={OPTIONS}>
                {(key) => (
                  <label class="toggle" title={t(`export.option.${key}.hint`)}>
                    <input type="checkbox" checked={opt[key]} onChange={(e) => setOpt(key, e.currentTarget.checked)} />
                    <span class="toggle-box" aria-hidden="true" />
                    <span>{t(`export.option.${key}.label`)}</span>
                  </label>
                )}
              </For>
            </div>
            <div class="export-steps">
              <h3 class="section-label">{t("export.inCst")}</h3>
              <ol>
                <li>{t("export.step.create")}</li>
                <li>{runMacro()[0]}<span class="mono">{fileName()}</span>{runMacro()[1]}</li>
                <li>{t("export.step.check")}</li>
              </ol>
            </div>
            <p class="muted export-note" role="note">{t("export.notValidated")}</p>
            <Show when={stlCount()}>
              <p class="muted export-note" role="note">{t("export.stlNote", { count: stlCount() })}</p>
            </Show>
            <Show when={result()?.parameters.length}>
              <p class="muted export-note" role="note">{t("export.parametric.summary", { count: result()!.parameters.length })}</p>
            </Show>
            <Show when={result()?.notes.length}>
              <div class="export-warnings">
                <h3 class="section-label">{t("export.parametric.numbers")}</h3>
                <ul><For each={result()!.notes}>{(w) => <li>{w}</li>}</For></ul>
              </div>
            </Show>
            <Show when={result()?.warnings.length}>
              <div class="export-warnings">
                <h3 class="section-label">{t("export.skipped")}</h3>
                <ul><For each={result()!.warnings}>{(w) => <li>{w}</li>}</For></ul>
              </div>
            </Show>
            </Show>
            <Show when={!isCst()}>
              <p class="muted">{formatScope()}</p>
              <div class="toggle-list">
                <label class="toggle" title={t("export.sheet.hint")}>
                  <input type="checkbox" checked={sheetSolid()} disabled={blenderBusy()} onChange={e => setSheetSolid(e.currentTarget.checked)} />
                  <span class="toggle-box" aria-hidden="true" />
                  <span>{t("export.sheet.label")}</span>
                </label>
                <Show when={format() === "stl"}>
                  <label class="toggle" title={t("export.perSolid.hint")}>
                    <input type="checkbox" checked={perSolid()} disabled={blenderBusy()} onChange={e => setPerSolid(e.currentTarget.checked)} />
                    <span class="toggle-box" aria-hidden="true" />
                    <span>{t("export.perSolid.label")}</span>
                  </label>
                </Show>
              </div>
              <Show when={sheetSolid()}>
                <label class="field export-sheet">
                  <span>{t("export.sheet.thickness")}</span>
                  <NumberField min={SHEET_THICKNESS_UM.min} max={SHEET_THICKNESS_UM.max} step="1" value={sheetUm()} disabled={blenderBusy()} aria-invalid={sheetInvalid()}
                    aria-describedby={sheetInvalid() ? "export-sheet-error" : undefined} onInput={e => setSheetUm(e.currentTarget.value)} />
                  <Show when={sheetInvalid()}><span id="export-sheet-error" class="rp-error nm-hint" role="alert">{t("export.sheet.range", { min: SHEET_THICKNESS_UM.min, max: SHEET_THICKNESS_UM.max })}</span></Show>
                </label>
              </Show>
              <p class="muted">{t(sheetSolid() ? "export.sheet.onNote" : "export.sheet.offNote")}</p>
            </Show>
          </div>
          <Show when={isCst()} fallback={<div class="export-options export-side">
            {/* what is exported, as a summary row on top; the header already says what the format is */}
            <Show when={source()}>{b => <p class="export-summary"><span>{b().model.name}</span><span class="muted">{t("export.blender.solidCount", { count: b().parts.length })}</span></p>}</Show>
            <Show when={format() === "blender"} fallback={<><h3>{t("export.mesh.title")}</h3><p class="muted">{t("export.mesh.limitations")}</p></>}>
              <h3>{t("export.blender.stepsTitle")}</h3>
              <ol class="export-render-steps"><li>{t("export.blender.stepExtract")}</li><li>{t("export.blender.stepRender")}</li><li>{t("export.blender.stepEdit")}</li></ol>
            </Show>
          </div>}><pre class="code" aria-label={t("export.previewAria")} tabindex={0}>{previewText()}</pre></Show>
        </div>
        <footer class="dialog-foot">
          <Show when={!note() && isCst()}><span class="muted mono">{t("export.lines", { count: result()?.text.split("\n").length ?? 0 })} · {fileName()}</span></Show>
          {/* always mounted so the first request is announced */}
          <span class="package-status" role="status" aria-live="polite">
            <Show when={note()?.warn}><TriangleAlert size={14} aria-hidden="true" /></Show>
            {note()?.text}
            <Show when={note()?.path}>{(path) => <button class="linklike" onClick={() => void revealDownloadedFile(path()).catch((e) => setNote({ text: t("export.revealFailed", { error: String(e) }), warn: true }))}>{t("export.reveal")}</button>}</Show>
          </span>
          <div class="dialog-actions">
            <Show when={format() === "cst"}><button class="btn btn-ghost" disabled={!result()} onClick={copy}>
              <Show when={copied()} fallback={<><Copy size={14} aria-hidden="true" /> {t("common.copy")}</>}><Check size={14} aria-hidden="true" /> {t("export.copied")}</Show>
            </button></Show>
            <button class="btn btn-primary" disabled={!source() || sourceBusy() || blenderBusy() || (isCst() && !result()) || sheetInvalid()} onClick={() => format() === "cst" ? void download() : void downloadGeometry()}><Download size={14} aria-hidden="true" /> {downloadLabel()}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
