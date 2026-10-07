import { createEffect, createSignal, For, on, Show } from "solid-js";
import { Copy, Download, Plus, Tag, Trash2, TriangleAlert, Upload, X } from "lucide-solid";
import { ExprField } from "./DesignPane";
import { type Check, parseLimit } from "./checks";
import { checkMessage } from "./checkText";
import { paramKeyError } from "./expr";
import { shown as fmt } from "./displayNumber.ts";
import { addParam, checks, draft, duplicateParam, edit, fieldId, focusPath, issues, names, paramKeyProblem, removeParam, renameParam, selection, setSelection } from "./store";
import { mode, runOpen } from "../runner/store";
import { parameterRanges, setParameterRanges } from "./dockState";
import type { DesignParam } from "./types";
import { exportCsv, exportJson, parseTransfer, previewTransfer, type PreviewRow, type TransferRow } from "./parameterTransfer";
import { downloadFailedMessage, downloadMessage, saveDownload } from "../lib/download";
import { useModal } from "../lib/dialog";
import { createRowEdit } from "./rowEdit";
import { paramLabelText } from "../lib/paramLabel";
import { t } from "../i18n";
import "../styles/designer-parameters.css";

function TransferDialog(props: { close: () => void }) {
  const [rows, setRows] = createSignal<TransferRow[] | null>(null);
  const [preview, setPreview] = createSignal<PreviewRow[]>([]);
  const [error, setError] = createSignal("");
  let box!: HTMLDivElement;
  let chooser!: HTMLInputElement;
  useModal(() => box, props.close, () => chooser);
  const load = async (file?: File) => {
    if (!file) return;
    setError(""); setRows(null); setPreview([]);
    try {
      const parsed = parseTransfer(await file.text(), file.name.toLowerCase().endsWith(".csv") ? "csv" : "json");
      setRows(parsed); setPreview(previewTransfer(parsed, JSON.parse(JSON.stringify(draft.params))));
    } catch (e) { setError((e as Error).message); }
  };
  const apply = () => {
    if (preview().some((r) => r.kind === "error")) return;
    const good = preview().filter((r) => r.param && (r.kind === "added" || r.kind === "changed"));
    if (!good.length) return;
    edit((d) => {
      for (const r of good) {
        const ix = d.params.findIndex((p) => p.key === r.key);
        const merged = { ...r.param! };
        if (ix >= 0) d.params[ix] = merged; else d.params.push(merged);
      }
    }, "", t("params.import.title"));
    props.close();
  };
  const added = () => preview().filter((r) => r.kind === "added").length;
  const changed = () => preview().filter((r) => r.kind === "changed").length;
  return <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && props.close()}>
    <div ref={box} class="dialog parameter-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="pt-title" tabindex="-1">
      <div class="dialog-head">
        <div>
          <h2 id="pt-title">{t("params.import.title")}</h2>
          <p class="muted">{t("params.import.subtitle")}</p>
        </div>
        <button class="icon-btn" onClick={props.close} aria-label={t("common.close")}><X size={16} /></button>
      </div>
      <div class="pt-body"><input ref={chooser} type="file" accept=".csv,.json,text/csv,application/json" onChange={(e) => { void load(e.currentTarget.files?.[0]); }} />
        <Show when={error()}><p class="dz-bad" role="alert">{error()}</p></Show>
        <Show when={rows()}><p class="muted">{t("params.import.summary", { added: added(), changed: changed(), errors: preview().filter((r) => r.kind === "error").length })}</p>
          <ul class="pt-preview"><For each={preview()}>{(r) => <li classList={{ "dz-bad": r.kind === "error" }}><b>{r.key || t("params.import.row", { row: r.row })}</b> — {t(`params.import.kind.${r.kind}`)}{r.message ? `: ${r.message}` : ""}</li>}</For></ul>
        </Show>
      </div>
      <div class="dialog-foot">
        <span class="muted">{rows() ? t("params.import.review") : ""}</span>
        <div class="dialog-actions">
          <button class="btn btn-ghost" onClick={props.close}>{t("common.cancel")}</button>
          <button class="btn btn-primary"
            disabled={preview().some((r) => r.kind === "error") || !preview().some((r) => r.param && (r.kind === "added" || r.kind === "changed"))}
            onClick={apply}>{t("params.import.title")}</button>
        </div>
      </div>
    </div>
  </div>;
}

/** A parameter's min or max: a plain number, or empty for none. Anything else (an expression such
 * as W/2, a typo) is refused with a message and the stored limit stays (checks.ts parseLimit). */
function LimitField(props: { label: string; name: string; value: number | undefined; path: string; onChange: (v: number | undefined) => void }) {
  // the refused text; `typing` while the field is focused, then a warning that stays until the
  // next valid entry, Escape or a change of the stored limit (undo)
  const [refused, setRefused] = createSignal<{ text: string; typing: boolean } | null>(null);
  createEffect(on(() => props.value, () => setRefused(null), { defer: true }));
  // props.name is "minimum" or "maximum"
  const kept = () => props.value === undefined ? t(`params.limit.${props.name}.none`) : t(`params.limit.${props.name}.kept`, { value: fmt(props.value) });
  const issue = (): Check | undefined => {
    const r = refused();
    if (!r) return undefined;
    return r.typing
      ? { severity: "error", path: props.path, code: "param-limit", message: t("params.limit.typing", { text: r.text, kept: kept() }) }
      : { severity: "warning", path: props.path, code: "param-limit", message: t("params.limit.refused", { text: r.text, kept: kept() }) };
  };
  return <div onFocusOut={() => setRefused((r) => r && { ...r, typing: false })} onKeyDown={(e) => { if (e.key === "Escape") setRefused(null); }}>
    <ExprField inline optional offerParams={false} label={props.label} value={props.value ?? ""} path={props.path} issue={issue()}
      onChange={(v) => {
        const r = parseLimit(v);
        if ("error" in r) setRefused({ text: String(v).trim(), typing: true });
        else { setRefused(null); props.onChange(r.value); }
      }} />
  </div>;
}

/** The Min / Max cells of a derived parameter: it follows its expression, so limits do not apply
 * (design.py design_params leaves it out of Sweep and Optimize). Limits it had are kept in the file
 * and apply again when it gets a plain value (the param-range check then covers them). */
function InactiveLimits(props: { p: DesignParam }) {
  const has = () => props.p.min != null || props.p.max != null;
  const range = () => t("params.inactive.range", { min: props.p.min ?? "—", max: props.p.max ?? "—" });
  const short = () => `${props.p.min ?? "—"}–${props.p.max ?? "—"}`;
  const why = () => t("params.inactive.why", { key: props.p.key })
    + (has() ? ` ${t("params.inactive.kept", { range: range() })}` : "");
  return <span class="param-limits-off" title={why()}>
    <span aria-hidden="true">{t("params.inactive")}{has() ? ` · ${short()}` : ""}</span>
    <span class="visually-hidden">{why()}</span>
  </span>;
}

export default function ParametersDock() {
  const [importing, setImporting] = createSignal(false);
  const exported = () => draft.params.map((p): TransferRow => ({ key: p.key, expression: String(p.expr ?? p.default ?? ""), evaluated: names().names[p.key] === undefined ? "" : String(names().names[p.key]), unit: p.unit ?? "", description: p.description ?? "" }));
  // through the shared save helper: a native Save As in the desktop app, a download in a browser
  // (a blob link revoked at once never reached the desktop WebView's download)
  const [exportNote, setExportNote] = createSignal("");
  const download = async (format: "csv" | "json") => {
    const name = `parameters.${format}`;
    const content = format === "csv" ? "\uFEFF" + exportCsv(exported()) : exportJson(exported());
    try {
      const result = await saveDownload(name, content, format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8");
      setExportNote(result.status === "saved" && result.path ? t("params.export.saved", { path: result.path }) : downloadMessage(result));
    } catch (error) {
      setExportNote(downloadFailedMessage(name, error));
    }
  };
  const needsRanges = () => runOpen() && mode() !== "single";
  const ranges = () => parameterRanges() || needsRanges();
  return <div class="param-dock">
    <div class="param-toolbar cluster">
      <button class="btn btn-sm" onClick={addParam}><Plus size={14} /> {t("params.add")}</button>
      <button class="btn btn-sm" onClick={() => download("csv")}><Download size={14} /> {t("params.exportCsv")}</button>
      <button class="btn btn-sm" onClick={() => download("json")}><Download size={14} /> {t("params.exportJson")}</button>
      <button class="btn btn-sm" onClick={() => setImporting(true)}><Upload size={14} /> {t("params.import")}</button>
      <button class="btn btn-sm" aria-pressed={ranges()} disabled={needsRanges()} title={t(needsRanges() ? "params.ranges.forced" : "params.ranges.title")} onClick={() => setParameterRanges(!parameterRanges())}>{t("params.ranges")}</button>
      <span class="note">{t("params.keys")}</span>
      <Show when={exportNote()}><span class="note" role="status" aria-live="polite">{exportNote()}</span></Show>
    </div>
    <Show when={draft.params.length} fallback={<p class="panel-empty">{t("params.empty")}</p>}>
      <table class="table param-table" classList={{ "param-ranges": ranges() }} aria-label={t("params.table")}>
        <thead><tr><For each={["key", "expression", "evaluated", "unit", ...(ranges() ? ["min", "max"] : []), "description", "actions"]}>{(s) => <th scope="col" classList={{ num: s === "evaluated" }}>{t(`params.col.${s}`)}</th>}</For></tr></thead>
        <tbody><For each={draft.params}>{(p, i) => {
          const path = (key: string) => `params[${i()}].${key}`;
          const set = (fn: (q: DesignParam) => void, key: string) => edit((d) => fn(d.params[i()]), path(key));
          const rowChecks = () => checks().filter((c) => c.path === `params[${i()}]` || c.path.startsWith(`params[${i()}].`));
          // The expression (and a visible Min / Max) cell shows the message of its own check: repeating it in the
          // key cell made one bad expression two error rows. One row per distinct message here.
          const keyCellChecks = () => {
            const seen = new Set<string>();
            return rowChecks().filter((c) => {
              if (/\.(expr|default)$/.test(c.path) || (ranges() && /\.(min|max)$/.test(c.path))) return false;
              const text = checkMessage(c);
              if (seen.has(text)) return false;
              seen.add(text);
              return true;
            });
          };
          // The key as typed, not yet applied: a rename rewrites every expression that uses the key, so it
          // applies once, on Enter or when the cell is left, never per keystroke (a half-typed key would
          // break every field that names it). An invalid or taken key stays here with its error.
          const [keyText, setKeyText] = createSignal<string | null>(null);
          const commitKey = (): boolean => {
            const typed = keyText();
            if (typed === null) return true;
            if (renameParam(i(), typed)) return false;
            setKeyText(null);
            return true;
          };
          const keyError = () => {
            const typed = keyText();
            if (typed !== null) return typed.trim() === p.key ? null : paramKeyProblem(i(), typed.trim());
            const bad = paramKeyError(p.key);
            return bad ? `${bad[0].toUpperCase()}${bad.slice(1)}.`
              : draft.params.some((q, j) => j !== i() && q.key === p.key) ? t("params.keyTwice") : issues()[path("key")]?.message;
          };
          const limit = (key: "min" | "max", v: number | undefined) => set((q) => {
            if (v === undefined) delete q[key]; else q[key] = v;
          }, key);
          let row!: HTMLTableRowElement;
          // the row as last committed (Enter, or moving to another cell): what Escape returns to
          const rowEdit = createRowEdit<DesignParam>();
          const snapshot = (): DesignParam => JSON.parse(JSON.stringify(p));
          const text = (key: "unit" | "description" | "label", label: string) => <input autocomplete="off" class="rp-input dz-input" id={fieldId(path(key))}
            aria-label={`${p.key}: ${label}`} title={p[key] ?? ""}
            placeholder={key === "description" && !p.description ? paramLabelText(p.label) : undefined} value={p[key] ?? ""} onInput={(e) => { const v = e.currentTarget.value; set((q) => { q[key] = v; }, key); }} />;
          const keyInput = () => <input autocomplete="off" class="rp-input dz-input" id={fieldId(path("key"))}
            aria-label={`${p.key}: ${t("params.col.key")}`} aria-invalid={!!keyError()}
            aria-describedby={keyError() ? `${fieldId(path("key"))}-error` : undefined}
            title={paramLabelText(p.label) || p.key} value={keyText() ?? p.key}
            onInput={(e) => setKeyText(e.currentTarget.value)} onBlur={() => commitKey()}
            onKeyDown={(e) => {
              // Enter applies the new key; a refused one keeps the focus here (the row's Enter does not move on)
              if (e.key === "Enter" && !e.isComposing && !commitKey()) e.preventDefault();
              else if (e.key === "Escape") setKeyText(null);
            }} />;
          return <tr ref={row} tabindex={0} data-noprompt class="row-select" classList={{ selected: selection().type === "param" && (selection() as { i: number }).i === i(), "param-row-error": !!keyError() || rowChecks().some((c) => c.severity === "error") }}
            aria-label={t("params.row", { key: p.key })} onFocusIn={(e) => {
              setSelection({ type: "param", i: i() });
              if (e.target !== row) rowEdit.begin(snapshot());
            }} onFocusOut={(e) => { if (!row.contains(e.relatedTarget as Node | null)) rowEdit.end(); }}
            onInput={() => rowEdit.typed()} onKeyDown={(e) => {
              if (e.key === "Escape" && e.target !== row) {
                // only what was typed since the last commit; a committed value stays
                e.preventDefault(); e.stopPropagation();
                const saved = rowEdit.cancel();
                if (saved) edit((d) => { const q = d.params[i()]; for (const key of Object.keys(q) as (keyof DesignParam)[]) delete q[key]; Object.assign(q, saved); }, `${path("cancel")}`);
                row.focus();
              } else if (e.key === "Enter" && e.target instanceof HTMLInputElement && !e.defaultPrevented && !e.isComposing) {
                // commit and move down the same column (a spreadsheet's Enter); the last row stays put
                e.preventDefault();
                rowEdit.commit(snapshot());
                const column = e.target.closest("td")?.cellIndex ?? 0;
                const next = row.nextElementSibling as HTMLTableRowElement | null;
                const cell = next?.cells[column]?.querySelector<HTMLInputElement>("input.dz-input, input.rp-input");
                if (next) { const to = cell && cell.offsetParent ? cell : next; to.focus(); if (to instanceof HTMLInputElement) to.select(); }
                else e.target.select();
              } else if (e.target === row) {
                if (e.key === "Enter") { e.preventDefault(); row.querySelector<HTMLInputElement>("input")?.focus(); }
                if (["ArrowDown", "ArrowUp"].includes(e.key)) {
                  e.preventDefault();
                  const next = e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling;
                  (next as HTMLElement | null)?.focus();
                }
              }
            }}>
            <td>{keyInput()}<div class="param-errors"><Show when={keyError()}><span id={`${fieldId(path("key"))}-error`} class="dz-value dz-bad">{keyError()}</span></Show>
              <For each={keyCellChecks()}>{(c) => <button class="linklike param-check" classList={{ "param-check-error": c.severity === "error" }} onClick={() => focusPath(c.path)} title={checkMessage(c)}><TriangleAlert size={12} />{c.code}: {checkMessage(c)}</button>}</For>
            </div></td>
            <td><div class="param-expression">
              <span class="param-derived" title={t(p.expr !== undefined ? "params.derived" : "params.defaultValue")}>{p.expr !== undefined ? "=" : ""}</span>
              <ExprField inline label={t("params.expression", { key: p.key })} value={p.expr ?? p.default}
                path={path(p.expr !== undefined ? "expr" : "default")} unit={p.unit} newParamAt={i()}
                onChange={(v) => set((q) => {
                  if (typeof v === "number") { q.default = v; delete q.expr; }
                  else { q.expr = v; delete q.default; }
                }, "value")} />
            </div></td>
            <td class="num mono" title={names().errors[p.key]}>{names().names[p.key] === undefined ? "—" : fmt(names().names[p.key])}</td>
            <td>{text("unit", t("params.col.unit"))}</td>
            <Show when={ranges()}><Show when={p.expr === undefined} fallback={<td colSpan={2}><InactiveLimits p={p} /></td>}>
              <td><LimitField label={t("params.min", { key: p.key })} name="minimum" value={p.min ?? undefined} path={path("min")} onChange={(v) => limit("min", v)} /></td>
              <td><LimitField label={t("params.max", { key: p.key })} name="maximum" value={p.max ?? undefined} path={path("max")} onChange={(v) => limit("max", v)} /></td>
            </Show></Show>
            <td>{text("description", t("params.col.description"))}</td>
            <td><div class="param-actions">
              <details class="param-label" classList={{ "param-label-set": !!p.label }}><summary class="icon-btn icon-btn-sm" title={t("params.label.edit")} aria-label={t("params.label.editKey", { key: p.key })}><Tag size={14} aria-hidden="true" /></summary><div>{text("label", t("params.label"))}</div></details>
              <button class="icon-btn icon-btn-sm" aria-label={t("params.duplicate", { key: p.key })} onClick={() => {
                const at = i();
                duplicateParam(at); focusPath(`params[${at + 1}].key`);
              }}><Copy size={14} /></button>
              {/* a parameter a field still uses is not deleted: the banner names the fields (store.removeParam) */}
              <button class="icon-btn icon-btn-sm" aria-label={t("params.delete", { key: p.key })} onClick={() => {
                const at = i();
                if (!removeParam(at)) return;
                if (draft.params.length) focusPath(`params[${Math.min(at, draft.params.length - 1)}].key`);
                else setSelection({ type: "design" });
              }}><Trash2 size={14} /></button>
            </div></td>
          </tr>;
        }}</For></tbody>
      </table>
    </Show>
    <Show when={importing()}><TransferDialog close={() => setImporting(false)} /></Show>
  </div>;
}
