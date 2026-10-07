// "Import CST macro…" (Start page, Home ribbon, File menu): read a CST-compatible VBA macro or
// history list (.bas, .mcs, .txt), show what the import makes of it (python/fairbeam/cst_import.py,
// POST /api/import/cst: nothing is saved yet), then name the new design and create it (POST
// /api/designs with the macro) and open it in Design. The file is read in the page through a file input, so the desktop app needs no file-system
// permission for it.
import { createMemo, createSignal, For, Show } from "solid-js";
import { ClipboardPaste, FileUp, X } from "lucide-solid";
import { useModal } from "../lib/dialog";
import { api, ApiError, type CstImportReport } from "../runner/api";
import { models } from "../runner/store";
import { createDesign } from "../designer/store";
import type { Check } from "../designer/checks";
import { checkMessage } from "../designer/checkText";
import { setCstImportOpen } from "../lib/cstImport";
import { gapCounts, lineRuns, mergeNotes, noteKind, noteText, type NoteKind, type ReportNote } from "../lib/cstReport";
import { fmt, locale, t } from "../i18n";

const ID_RE = /^[a-z][a-z0-9_]{1,40}$/;
/** Windows device names (python/fairbeam/modelfiles.py RESERVED_ID_RE) */
const RESERVED_ID_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
const suggestId = (name: string) =>
  name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "").slice(0, 41);
/** the server takes request bodies up to 1 MiB (JSON-escaped text grows a little) */
const MAX_BYTES = 900_000;

/** A server error in the language of the page (a message the server words in both languages carries both). */
export function importErrorText(a: ApiError): string {
  const tr = a.data?.message_tr;
  return a.status === 0 ? t("common.serverUnreachable") : locale() === "tr" && typeof tr === "string" ? tr : a.message;
}
/** i18n keys of the row labels */
const SEVERITY: Record<NoteKind, string> = { missing: "cstImport.sev.missing", refused: "cstImport.sev.refused", warning: "cstImport.sev.warning", info: "cstImport.sev.info" };

/** A macro file's text: UTF-8, else Windows-1252 (the ANSI text the CST VBA editor saves). */
export async function readMacroText(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export default function CstImportDialog() {
  let box: HTMLDivElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  const [fileName, setFileName] = createSignal("");
  const [source, setSource] = createSignal("");
  const [sourceFile, setSourceFile] = createSignal("");   // "" for pasted text
  const [report, setReport] = createSignal<CstImportReport | null>(null);
  const [checks, setChecks] = createSignal<Check[]>([]);
  const [name, setName] = createSignal("");
  const [reading, setReading] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [fieldErrors, setFieldErrors] = createSignal<Record<string, string>>({});
  // pasted macro text (the History List or VBA editor copied with Ctrl+C): a plain textarea, so the
  // desktop app needs no clipboard permission
  const [pasting, setPasting] = createSignal(false);
  const [pasted, setPasted] = createSignal("");
  let pasteBox: HTMLTextAreaElement | undefined;
  const close = () => { if (!busy()) setCstImportOpen(false); };
  useModal(() => box, close, () => fileInput);

  const id = () => suggestId(name());
  const idError = createMemo(() => {
    if (!name().trim()) return "";
    if (!ID_RE.test(id())) return t("cstImport.id.short");
    if (RESERVED_ID_RE.test(id())) return t("cstImport.id.reserved");
    if (models().some((m) => m.key === id())) return t("cstImport.id.exists");
    return fieldErrors().id ?? "";
  });
  /** The suggested name, or "<name> 2", "<name> 3"… when a model already has it. */
  const freeName = (base: string) => {
    const taken = (n: string) => models().some((m) => m.key === suggestId(n));
    let n = base, k = 2;
    while (taken(n) && k < 100) n = `${base} ${k++}`;
    return n;
  };
  const errorsOf = (sev: string) => checks().filter((c) => c.severity === sev);

  /** Read a macro from a file, or from text pasted into the dialog (`file` = null). */
  const read = async (label: string, file: File | null, pastedText = "") => {
    setError(""); setReport(null); setChecks([]); setFieldErrors({});
    setFileName(label);
    const size = file ? file.size : new Blob([pastedText]).size;
    if (size > MAX_BYTES) {
      setError(t("cstImport.tooLarge", { file: label, size: fmt.fixed(size / 1e6, 1), max: fmt.fixed(0.9, 1) }));
      return;
    }
    setReading(true);
    try {
      const text = file ? await readMacroText(file) : pastedText;
      const res = await api.importCst({ source: text, filename: file ? file.name : undefined });
      setSource(text);
      setSourceFile(file ? file.name : "");
      setReport(res.report);
      setChecks(res.checks ?? []);
      setPasting(false);
      if (!name().trim()) setName(freeName(res.report.suggested_name || (file ? file.name.replace(/\.[^.]+$/, "") : "Imported CST model" /* a name (and id) stored in the design: English */)));
    } catch (err) {
      setError(importErrorText(err as ApiError));
    } finally {
      setReading(false);
    }
  };
  const choose = (file: File | undefined) => file ? read(file.name, file) : undefined;
  const readPasted = () => { if (pasted().trim()) void read(t("cstImport.pastedText"), null, pasted()); };

  const create = async (e: Event) => {
    e.preventDefault();
    if (!report() || !name().trim() || idError() || busy()) return;
    setBusy(true);
    setError("");
    try {
      const res = await createDesign({ id: id(), name: name().trim(), cst: { source: source(), filename: sourceFile() || undefined } });
      if (res) setCstImportOpen(false);
    } catch (err) {
      const a = err as ApiError;
      setFieldErrors(a.fields ?? {});
      setError(importErrorText(a));
    } finally {
      setBusy(false);
    }
  };

  // the report's rows, identical ones merged, and the summary worked out from them
  const rows = () => mergeNotes(report()?.notes ?? []);
  const gaps = () => gapCounts(rows());
  const gapList = () => {
    const g = gaps();
    return [g.missing ? t("cstImport.gap.missing", { count: g.missing }) : "", g.refused ? t("cstImport.gap.refused", { count: g.refused }) : "",
      g.changed ? t("cstImport.gap.changed", { count: g.changed }) : ""].filter(Boolean).join(", ");
  };
  /** "line 199", "lines 199–202", "lines 4, 9–11" */
  const where = (n: ReportNote) => {
    const runs = lineRuns(n.lines?.length ? n.lines : n.line ? [n.line] : []);
    if (!runs.length) return "";
    if (runs.length === 1 && runs[0][0] === runs[0][1]) return t("cstImport.line", { line: runs[0][0] });
    return t("cstImport.lineRange", { list: runs.slice(0, 3).map(([a, b]) => a === b ? String(a) : `${a}–${b}`).join(", ") + (runs.length > 3 ? ", …" : "") });
  };
  const counts = () => {
    const c = report()?.counts;
    if (!c) return "";
    const n = (k: keyof typeof c) => t(`cstImport.count.${k}`, { count: c[k] });
    return [n("part"), n("port"), n("material"), n("parameter")]
      .concat(c.resistor ? [n("resistor")] : []).join(", ");
  };

  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="dialog dialog-sm ci-dialog" role="dialog" aria-modal="true" aria-labelledby="ci-title" aria-describedby="ci-desc" ref={box} tabindex={-1}>
        <div class="dialog-head">
          <div>
            <h2 id="ci-title">{t("cstImport.title")}</h2>
            <p id="ci-desc" class="muted">{t("cstImport.intro")}</p>
          </div>
          <button class="icon-btn" onClick={close} aria-label={t("common.close")}><X size={16} /></button>
        </div>
        <form class="dialog-body nm-body" id="ci-form" onSubmit={create}>
          <div class="ci-pick">
            <input ref={fileInput} id="ci-file" class="ci-file" type="file" accept=".bas,.mcs,.txt,.mac,.vba,text/plain"
              onChange={(e) => { void choose(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }} />
            <label for="ci-file" class="btn btn-ghost" classList={{ "btn-primary": !report() }}>
              <FileUp size={14} aria-hidden="true" /> {report() ? t("cstImport.chooseAnother") : t("cstImport.choose")}
            </label>
            <button type="button" class="btn btn-ghost" aria-expanded={pasting()} aria-controls="ci-paste"
              onClick={() => { setPasting(!pasting()); if (pasting()) queueMicrotask(() => pasteBox?.focus()); }}>
              <ClipboardPaste size={14} aria-hidden="true" /> {t("cstImport.paste")}
            </button>
            <span class="mono ci-name" title={fileName()}>{fileName() || t("cstImport.noFile")}</span>
          </div>
          <Show when={pasting()}>
            <div class="ci-paste" id="ci-paste">
              <textarea ref={pasteBox} class="field-text mono ci-paste-text" rows={8} spellcheck={false}
                aria-label={t("cstImport.macroText")} placeholder={t("cstImport.pastePlaceholder") + "\nWith Brick\n     .Reset\n     .Name \"patch\"\n     ..."}
                value={pasted()} onInput={(e) => setPasted(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); readPasted(); } }} />
              <div class="ci-paste-actions">
                <span class="muted">{pasted().trim() ? t("cstImport.lines", { count: pasted().split("\n").length }) : t("cstImport.nothingPasted")}</span>
                <button type="button" class="btn btn-primary" disabled={!pasted().trim() || reading()} onClick={readPasted}>{t("cstImport.readPasted")}</button>
              </div>
            </div>
          </Show>
          <Show when={reading()}><p class="muted" role="status">{t("cstImport.reading", { file: fileName() })}</p></Show>
          <Show when={report()}>{(r) => (
            <section class="ci-report" aria-label={t("cstImport.report")}>
              <p class="ci-summary" role="status">
                <b>{counts()}</b> {t("cstImport.fromHistory", { count: r().history_items })}{" "}
                <Show when={gaps().total} fallback={<span>{t("cstImport.allImported")}</span>}>
                  <span class="ci-bad">{t("cstImport.gaps", { count: gaps().total, list: gapList() })}</span> {t("cstImport.listedBelow")}
                </Show>
              </p>
              <Show when={gaps().refused || gaps().missing}>
                <p class="ci-bad" role="alert">{t("cstImport.partialGeometry")}</p>
              </Show>
              <Show when={errorsOf("error").length || errorsOf("warning").length}>
                <p class={errorsOf("error").length ? "rp-error" : "note"}>
                  {t("cstImport.checks", { list: [errorsOf("error").length ? t("status.checks.errors", { count: errorsOf("error").length }) : "", errorsOf("warning").length ? t("status.checks.warnings", { count: errorsOf("warning").length }) : ""].filter(Boolean).join(", ") })}
                  <Show when={errorsOf("error")[0] ?? errorsOf("warning")[0]}>{(c) => <>: {checkMessage(c())}</>}</Show>
                </p>
              </Show>
              <Show when={rows().length}>
                <ul class="ci-notes">
                  <For each={rows()}>{(n) => (
                    <li class={`ci-note ci-${noteKind(n)} ci-${n.severity}`}>
                      <span class="ci-sev">{t(SEVERITY[noteKind(n)])}</span>
                      <span class="ci-msg">
                        <Show when={n.where}><span class="ci-where">{where(n) ? `${where(n)} · ` : ""}{n.where}: </span></Show>
                        {noteText(n, locale())}
                        <Show when={(n.count ?? 1) > 1}><span class="ci-count" title={t("cstImport.repeated", { count: n.count })}> ×{n.count}</span></Show>
                      </span>
                    </li>
                  )}</For>
                </ul>
              </Show>
              <details class="ci-created">
                <summary>{t("cstImport.created", { count: r().created.length })}</summary>
                <ul>
                  <For each={r().created}>{(c) => <li><span class="ci-kind">{c.kind}</span> <b>{c.name}</b> <span class="muted">{c.detail}</span></li>}</For>
                </ul>
              </details>
            </section>
          )}</Show>
          <Show when={report()}>
            <label class="field">
              <span>{t("cstImport.designName")}</span>
              <input autocomplete="off" class="field-text" type="text" maxLength={80} value={name()} aria-invalid={!!idError()} aria-describedby="ci-id-hint"
                onInput={(e) => { setName(e.currentTarget.value); setFieldErrors({}); }} />
              <span id="ci-id-hint" class={idError() ? "rp-error nm-hint" : "rp-hint nm-hint"} aria-live="polite">
                {idError() || (name().trim() ? `${id()}.design.json` : t("cstImport.fileHint"))}
              </span>
            </label>
          </Show>
        </form>
        <div class="dialog-foot">
          <span class="muted">
            <Show when={error()} fallback={<>{report() ? t("cstImport.footReady") : t("cstImport.footEmpty")}</>}>
              <span class="rs-critical-text" role="alert">{error()}</span>
            </Show>
          </span>
          <div class="dialog-actions">
            <button class="btn btn-ghost" type="button" onClick={close} disabled={busy()}>{t("common.cancel")}</button>
            <button class="btn btn-primary" type="submit" form="ci-form" disabled={!report() || !name().trim() || !!idError() || busy() || reading()}>
              {busy() ? t("cstImport.creating") : t("cstImport.create")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
