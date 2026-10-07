// "Import PCB artwork…" (Start page, Home ribbon, File menu): read the DXF, Gerber and Excellon files of a
// printed antenna, show what the import makes of them (python/fairbeam/pcb_import.py, POST
// /api/import/pcb: nothing is saved yet), let the viewer set the role of every layer and the substrate,
// then name the design and create it (POST /api/designs with the files) and open it in Design. The files
// are read in the page and sent as base64, so the desktop app needs no file-system permission for them.
// A change of a role or an option imports again: the report and the layers are always those of the
// values shown. The logic without a page (limits, layer keys, roles, options) is src/lib/pcbLayers.ts.
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { FileUp, RotateCcw, X, Zap } from "lucide-solid";
import { useModal } from "../lib/dialog";
import NumberField from "./NumberField";
import { api, ApiError, type PcbLayer, type PcbImportReport } from "../runner/api";
import { models } from "../runner/store";
import { createDesign } from "../designer/store";
import { openPortTool } from "../designer/DesignWorkspace";
import { libraryLabel } from "../designer/MaterialLibrary";
import { MATERIAL_LIBRARY } from "../designer/materials";
import { ensureUserMaterials, userMaterials } from "../designer/userMaterialsStore";
import type { Check } from "../designer/checks";
import { checkMessage } from "../designer/checkText";
import { setPcbImportOpen } from "../lib/pcbImport";
import { carriesFiles } from "../lib/fileDrop";
import { gapCounts, lineRuns, mergeNotes, type ReportNote } from "../lib/cstReport";
import {
  admitFiles, buildOptions, designNameFromFiles, guessedRoles, isChosen, noteKey, PCB_DEFAULTS, PCB_LIMITS, PCB_RANGES, pruneMap, reasonKey,
  roleChoices, roleValue, toBase64, withoutRole, withRole, type FileProblem, type PcbForm,
} from "../lib/pcbLayers";
import type { PcbRole } from "../runner/api";
import { fmt, hasKey, t } from "../i18n";

const ID_RE = /^[a-z][a-z0-9_]{1,40}$/;
/** Windows device names (python/fairbeam/modelfiles.py RESERVED_ID_RE) */
const RESERVED_ID_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
const suggestId = (name: string) =>
  name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "").slice(0, 41);
/** the dielectrics of the material library the substrate can be picked from (air is no substrate) */
const SUBSTRATES = MATERIAL_LIBRARY.filter((m) => m.kind === "dielectric" && m.id !== "air");
/** i18n keys of the row labels of the report */
const SEVERITY = { refused: "pcbImport.sev.refused", warning: "pcbImport.sev.warning", info: "pcbImport.sev.info" } as const;
const DEBOUNCE_MS = 250;

interface Entry { name: string; size: number; content_base64: string }

const sizeText = (bytes: number) => bytes < 1000 ? `${bytes} B` : bytes < 1e6 ? `${fmt.fixed(bytes / 1e3, 1)} kB` : `${fmt.fixed(bytes / 1e6, 1)} MB`;
/** a problem with a file as text: sizes with the UI language's decimal separator */
const problemText = (p: FileProblem) =>
  t(p.key, Object.fromEntries(Object.entries(p.params).map(([k, v]) => [k, typeof v === "number" && !Number.isInteger(v) ? fmt.fixed(v, 1) : String(v)])));

export default function PcbImportDialog() {
  let box: HTMLDivElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [overrides, setOverrides] = createSignal<Record<string, PcbRole>>({});
  const [form, setForm] = createSignal<PcbForm>({ ...PCB_DEFAULTS });
  const [report, setReport] = createSignal<PcbImportReport | null>(null);
  const [layers, setLayers] = createSignal<PcbLayer[]>([]);
  const [noCopper, setNoCopper] = createSignal(false);   // the files parse, but no layer is copper yet
  const [checks, setChecks] = createSignal<Check[]>([]);
  const [name, setName] = createSignal("");
  const [nameTyped, setNameTyped] = createSignal(false);   // until the viewer types a name, it follows the first file
  const [reading, setReading] = createSignal(false);
  const [pending, setPending] = createSignal(false);     // an import is scheduled or running
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [fileNotes, setFileNotes] = createSignal<string[]>([]);
  const [fieldErrors, setFieldErrors] = createSignal<Record<string, string>>({});
  const [dragging, setDragging] = createSignal(false);
  const [created, setCreated] = createSignal<string | null>(null);   // the new design's file, while the port hint shows
  const close = () => { if (!busy()) setPcbImportOpen(false); };
  useModal(() => box, close, () => fileInput);

  const id = () => suggestId(name());
  const idError = createMemo(() => {
    if (!name().trim()) return "";
    if (!ID_RE.test(id())) return t("cstImport.id.short");
    if (RESERVED_ID_RE.test(id())) return t("cstImport.id.reserved");
    if (models().some((m) => m.key === id())) return t("cstImport.id.exists");
    return fieldErrors().id ?? "";
  });
  const freeName = (base: string) => {
    const taken = (n: string) => models().some((m) => m.key === suggestId(n));
    let n = base, k = 2;
    while (taken(n) && k < 100) n = `${base} ${k++}`;
    return n;
  };
  const errorsOf = (sev: string) => checks().filter((c) => c.severity === sev);
  /** the design's errors, except the missing port: the importer cannot know the feed, and the dialog says so itself */
  const checkErrors = () => errorsOf("error").filter((c) => c.code !== "no-port");

  // ---- the import: every change of the files, a role or an option imports again (the last one wins)
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let seq = 0;
  onCleanup(() => { clearTimeout(timer); controller?.abort(); });

  const request = () => {
    const built = buildOptions(form(), overrides());
    return { files: entries().map((e) => ({ name: e.name, content_base64: e.content_base64 })), built };
  };

  const run = async () => {
    const { files, built } = request();
    const bad = Object.fromEntries(Object.entries(built.errors).map(([k, v]) => [k, t(v.error, v.params)]));
    setFieldErrors(bad);
    if (!files.length || Object.keys(bad).length) { setPending(false); return; }
    controller?.abort();
    controller = new AbortController();
    const mine = ++seq;
    setReading(true);
    setError("");
    try {
      const res = await api.importPcb({ files, options: built.options }, controller.signal);
      if (mine !== seq) return;
      setReport(res.report);
      setLayers(res.layers);
      setChecks(res.checks ?? []);
      setNoCopper(false);
      const kept = pruneMap(overrides(), res.layers);
      if (Object.keys(kept).length !== Object.keys(overrides()).length) setOverrides(kept);
      // a name (and id) stored in the design: the stem the files share, without their layer suffixes
      if (!nameTyped() || !name().trim()) setName(freeName(designNameFromFiles(entries().map((e) => e.name))));
    } catch (err) {
      if (mine !== seq || (err as Error).name === "AbortError") return;
      const a = err as ApiError;
      const known = Array.isArray(a.data?.layers) ? (a.data.layers as PcbLayer[]) : null;
      setReport(null);
      setChecks([]);
      setLayers(known ?? []);
      setNoCopper(!!known);
      if (known) setOverrides(pruneMap(overrides(), known));
      setError(a.status === 0 ? t("common.serverUnreachable") : a.message);
    } finally {
      if (mine === seq) { setReading(false); setPending(false); }
    }
  };
  const schedule = (delay = DEBOUNCE_MS) => {
    clearTimeout(timer);
    setPending(true);
    timer = setTimeout(() => void run(), delay);
  };

  // ---- files
  const addFiles = async (list: File[]) => {
    if (!list.length || busy()) return;
    const { accepted, problems } = admitFiles(entries(), list.map((f) => ({ name: f.name, size: f.size })));
    setFileNotes(problems.map(problemText));
    const added: Entry[] = [];
    for (const info of accepted) {
      const file = list.find((f) => f.name === info.name)!;
      added.push({ name: file.name, size: file.size, content_base64: toBase64(new Uint8Array(await file.arrayBuffer())) });
    }
    if (!added.length) return;
    setEntries([...entries(), ...added]);
    schedule(0);
  };
  const removeFile = (fileName: string) => {
    const rest = entries().filter((e) => e.name !== fileName);
    setEntries(rest);
    setFileNotes([]);
    if (!rest.length) {
      clearTimeout(timer); controller?.abort(); seq++;
      setReport(null); setLayers([]); setChecks([]); setNoCopper(false); setError(""); setPending(false); setReading(false);
    } else schedule(0);
  };
  const onDrop = (e: DragEvent) => {
    e.stopPropagation();
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDragging(false);
    void addFiles(Array.from(e.dataTransfer?.files ?? []));
  };
  const onDragOver = (e: DragEvent) => {
    e.stopPropagation();   // the app's own drop (open a project, import reference data) is not for this dialog
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    setDragging(true);
  };

  // ---- roles and options
  const chooseRole = (layer: PcbLayer, value: string) => { setOverrides(withRole(overrides(), layer, value)); schedule(); };
  const resetRole = (layer: PcbLayer) => { setOverrides(withoutRole(overrides(), layer)); schedule(); };
  // a "My materials" dielectric picked as the substrate: its values go into the custom fields
  const [mineId, setMineId] = createSignal("");
  void ensureUserMaterials();
  const myDielectrics = () => userMaterials().filter((m) => m.kind === "dielectric");
  const setField = (patch: Partial<PcbForm>) => { setMineId(""); setForm({ ...form(), ...patch }); schedule(400); };
  const chooseSubstrate = (idValue: string) => {
    const mine = idValue.startsWith("u:") ? myDielectrics().find((m) => `u:${m.id}` === idValue) : undefined;
    const lib = SUBSTRATES.find((m) => m.id === idValue);
    setField(mine ? { substrate: "custom", epsR: String(mine.eps_r), tanD: String(mine.tan_d ?? 0) }
      : lib ? { substrate: idValue, epsR: String(lib.eps_r), tanD: String(lib.tan_d) } : { substrate: "custom" });
    if (mine) setMineId(mine.id);
  };

  const create = async (e: Event) => {
    e.preventDefault();
    if (!report() || !name().trim() || idError() || busy() || pending() || Object.keys(fieldErrors()).length) return;
    setBusy(true);
    setError("");
    try {
      const { files, built } = request();
      const res = await createDesign({ id: id(), name: name().trim(), pcb: { files, options: built.options } });
      if (res) {
        // the importer cannot know the feed: without a port, the next step is to add one
        if (res.design.ports.length) setPcbImportOpen(false);
        else setCreated(res.file);
      }
    } catch (err) {
      const a = err as ApiError;
      setFieldErrors(a.fields ?? {});
      setError(a.status === 0 ? t("common.serverUnreachable") : a.message);
    } finally {
      setBusy(false);
    }
  };
  const addPortNow = () => { setPcbImportOpen(false); queueMicrotask(openPortTool); };

  // ---- the report
  const rows = () => mergeNotes(report()?.notes ?? []);
  const refusedRows = () => rows().filter((n) => n.severity === "refused");
  const gaps = () => gapCounts(rows());
  const where = (n: ReportNote) => {
    const runs = lineRuns(n.lines?.length ? n.lines : n.line ? [n.line] : []);
    if (!runs.length) return "";
    if (runs.length === 1 && runs[0][0] === runs[0][1]) return t("cstImport.line", { line: runs[0][0] });
    return t("cstImport.lineRange", { list: runs.slice(0, 3).map(([a, b]) => a === b ? String(a) : `${a}–${b}`).join(", ") + (runs.length > 3 ? ", …" : "") });
  };
  const counts = () => {
    const c = report()?.counts;
    if (!c) return "";
    return [t("cstImport.count.part", { count: c.part }), t("pcbImport.count.polygon", { count: c.polygon })]
      .concat(c.hole ? [t("pcbImport.count.hole", { count: c.hole })] : [], c.via ? [t("pcbImport.count.via", { count: c.via })] : []).join(", ");
  };
  const layerName = (l: PcbLayer) => (l.kind === "dxf" ? l.layer : l.source);
  const content = (l: PcbLayer) => {
    if (l.kind === "drill") return l.holes ? t("pcbImport.count.hole", { count: l.holes }) : t("pcbImport.noGeometry");
    return l.outlines ? t("pcbImport.count.outline", { count: l.outlines }) : t("pcbImport.noGeometry");
  };
  const why = (l: PcbLayer) => {
    const r = reasonKey(l.because);
    return r ? t(r.key, r.params) : l.because;
  };
  const roleLabel = (r: string) => t(r === "" ? "pcbImport.role.unclear" : `pcbImport.role.${r}`);
  /** a row's text: the app's own wording (its controls, not command-line flags) where it has one */
  const noteText = (n: ReportNote) => {
    const k = noteKey(n as ReportNote & { key?: string; params?: Record<string, string> }, hasKey);
    return k ? t(k.key, { ...k.params, units: `${t("pcbImport.advanced")} › ${t("pcbImport.units")}`, origin: `${t("pcbImport.advanced")} › ${t("pcbImport.origin")}`,
      keep: t("pcbImport.origin.keep"), table: t("pcbImport.layers"), outline: t("pcbImport.role.outline"), bottom: t("pcbImport.role.bottom_copper") }) : n.message;
  };
  /** roles the importer guessed from the layer names: the summary names them instead of "everything was imported" */
  const guessed = () => guessedRoles(layers()).map((g) => `${g.layer} → ${roleLabel(g.role)}`).join(", ");
  const numberField = (label: string, field: "thickness" | "epsR" | "tanD" | "f0" | "chordTol" | "margin", unit?: string) => {
    const [lo, hi] = PCB_RANGES[field];   // the arrow keys stay inside the range
    return (
      <label class="field pi-field">
        <span>{label}{unit ? <span class="muted"> ({unit})</span> : null}</span>
        <NumberField value={form()[field]} min={lo} max={hi} step="any"
          aria-invalid={!!fieldErrors()[field]} aria-describedby={fieldErrors()[field] ? `pi-err-${field}` : undefined}
          onInput={(e) => setField({ [field]: e.currentTarget.value } as Partial<PcbForm>)} />
        <Show when={fieldErrors()[field]}><span id={`pi-err-${field}`} class="rp-error nm-hint" role="alert">{fieldErrors()[field]}</span></Show>
      </label>
    );
  };

  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="dialog dialog-sm ci-dialog pi-dialog" role="dialog" aria-modal="true" aria-labelledby="pi-title" aria-describedby="pi-desc" ref={box} tabindex={-1}
        classList={{ "pi-dragging": dragging() }} onDragOver={onDragOver} onDrop={onDrop} onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}>
        <div class="dialog-head">
          <div>
            <h2 id="pi-title">{t("pcbImport.title")}</h2>
            <p id="pi-desc" class="muted">{t("pcbImport.intro")}</p>
          </div>
          <button class="icon-btn" onClick={close} aria-label={t("common.close")}><X size={16} /></button>
        </div>

        <Show when={!created()} fallback={
          <div class="dialog-body nm-body pi-done" role="status">
            <p><b>{t("pcbImport.created", { file: created() })}</b></p>
            <p class="pi-port-hint">{t("pcbImport.portHint")}</p>
            <p class="muted">{t("pcbImport.portHintDetail", { path: `${t("ribbon.tab.sim")} › ${t("ribbon.sim.ports")} › ${t("ribbon.sim.lumped")}` })}</p>
            <div><button class="btn btn-primary" type="button" onClick={addPortNow}><Zap size={14} aria-hidden="true" /> {t("pcbImport.portTool")}</button></div>
          </div>
        }>
        <form class="dialog-body nm-body" id="pi-form" onSubmit={create}>
          <div class="pi-pick" classList={{ "pi-over": dragging() }}>
            <input ref={fileInput} id="pi-file" class="ci-file" type="file" multiple
              onChange={(e) => { const list = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ""; void addFiles(list); }} />
            <label for="pi-file" class="btn btn-ghost" classList={{ "btn-primary": !entries().length }}>
              <FileUp size={14} aria-hidden="true" /> {entries().length ? t("pcbImport.addMore") : t("pcbImport.choose")}
            </label>
            <span class="muted pi-drop-hint">{t("pcbImport.dropHint", { files: PCB_LIMITS.files })}</span>
          </div>
          <Show when={fileNotes().length}>
            <ul class="pi-notes" role="alert"><For each={fileNotes()}>{(n) => <li class="rp-error">{n}</li>}</For></ul>
          </Show>
          <Show when={entries().length}>
            <ul class="pi-files" aria-label={t("pcbImport.files")}>
              <For each={entries()}>{(f) => (
                <li>
                  <span class="mono pi-file-name" title={f.name}>{f.name}</span>
                  <span class="muted">{sizeText(f.size)}</span>
                  <button type="button" class="icon-btn" onClick={() => removeFile(f.name)} aria-label={t("pcbImport.remove", { file: f.name })} disabled={busy()}><X size={14} /></button>
                </li>
              )}</For>
            </ul>
          </Show>
          <Show when={reading()}><p class="muted" role="status">{t("pcbImport.reading")}</p></Show>
          <Show when={error() && !busy()}><p class="rp-error" role="alert">{error()}</p></Show>

          <Show when={layers().length}>
            <section class="pi-section" aria-labelledby="pi-layers-h">
              <h3 id="pi-layers-h">{t("pcbImport.layers")}</h3>
              <Show when={noCopper()}><p class="note">{t("pcbImport.noCopper")}</p></Show>
              <div class="pi-table-wrap">
                <table class="table pi-layers">
                  <thead><tr>
                    <th scope="col">{t("pcbImport.col.layer")}</th>
                    <th scope="col">{t("pcbImport.col.content")}</th>
                    <th scope="col">{t("pcbImport.col.role")}</th>
                  </tr></thead>
                  <tbody>
                    <For each={layers()}>{(l) => (
                      <tr classList={{ "pi-unclear": l.role === null }}>
                        <td>
                          <div class="mono pi-layer-name" title={layerName(l)}>{layerName(l)}</div>
                          <div class="muted pi-layer-src">{l.kind === "dxf" ? l.source : t(`pcbImport.kind.${l.kind}`)}</div>
                        </td>
                        <td>{content(l)}</td>
                        <td>
                          <div class="pi-role">
                            <select class="rp-select" aria-label={t("pcbImport.roleFor", { layer: layerName(l) })} value={roleValue(l)} disabled={busy()}
                              onChange={(e) => chooseRole(l, e.currentTarget.value)}>
                              <For each={roleChoices(l)}>{(r) => <option value={r} selected={roleValue(l) === r}>{roleLabel(r)}</option>}</For>
                            </select>
                            <Show when={isChosen(l)}>
                              <button type="button" class="icon-btn" title={t("pcbImport.resetRole")} aria-label={t("pcbImport.resetRoleFor", { layer: layerName(l) })}
                                onClick={() => resetRole(l)} disabled={busy()}><RotateCcw size={14} /></button>
                            </Show>
                          </div>
                          <div class="pi-why" classList={{ "pi-why-chosen": isChosen(l) }}>{why(l)}</div>
                        </td>
                      </tr>
                    )}</For>
                  </tbody>
                </table>
              </div>
            </section>
          </Show>

          <Show when={entries().length}>
            <section class="pi-section" aria-labelledby="pi-sub-h">
              <h3 id="pi-sub-h">{t("pcbImport.substrate")}</h3>
              <div class="pi-grid">
                <label class="field pi-field pi-wide">
                  <span>{t("pcbImport.material")}</span>
                  <select class="rp-select" value={mineId() ? `u:${mineId()}` : form().substrate} onChange={(e) => chooseSubstrate(e.currentTarget.value)}>
                    <optgroup label={t("materials.group.builtin")}>
                      <For each={SUBSTRATES}>{(m) => <option value={m.id} selected={!mineId() && form().substrate === m.id}>{libraryLabel(m)}</option>}</For>
                    </optgroup>
                    <Show when={myDielectrics().length}>
                      <optgroup label={t("materials.group.mine")}>
                        <For each={myDielectrics()}>{(m) => <option value={`u:${m.id}`} selected={mineId() === m.id}>{m.name}</option>}</For>
                      </optgroup>
                    </Show>
                    <option value="custom" selected={!mineId() && form().substrate === "custom"}>{t("pcbImport.customSubstrate")}</option>
                  </select>
                </label>
                {numberField(t("pcbImport.thickness"), "thickness", "mm")}
                {numberField("εr", "epsR")}
                {numberField("tan δ", "tanD")}
                {numberField(t("pcbImport.f0"), "f0", "GHz")}
              </div>
              <p class="rp-hint">{t("pcbImport.substrateNote")}</p>
              <details class="pi-advanced">
                <summary>{t("pcbImport.advanced")}</summary>
                <div class="pi-grid">
                  <label class="field pi-field">
                    <span>{t("pcbImport.units")}</span>
                    <select class="rp-select" value={form().units} onChange={(e) => setField({ units: e.currentTarget.value as PcbForm["units"] })}>
                      <option value="auto" selected={form().units === "auto"}>{t("pcbImport.units.auto")}</option>
                      <option value="mm" selected={form().units === "mm"}>mm</option>
                      <option value="inch" selected={form().units === "inch"}>{t("pcbImport.units.inch")}</option>
                    </select>
                  </label>
                  {numberField(t("pcbImport.chordTol"), "chordTol", "mm")}
                  {numberField(t("pcbImport.margin"), "margin", "mm")}
                  <label class="field pi-field">
                    <span>{t("pcbImport.origin")}</span>
                    <select class="rp-select" value={form().origin} onChange={(e) => setField({ origin: e.currentTarget.value as PcbForm["origin"] })}>
                      <option value="center" selected={form().origin === "center"}>{t("pcbImport.origin.center")}</option>
                      <option value="keep" selected={form().origin === "keep"}>{t("pcbImport.origin.keep")}</option>
                    </select>
                  </label>
                </div>
                <p class="rp-hint">{t("pcbImport.advancedNote")}</p>
              </details>
            </section>
          </Show>

          <Show when={report()}>{(r) => (
            <section class="ci-report" aria-label={t("pcbImport.report")}>
              <p class="ci-summary" role="status">
                <b>{counts()}</b>.{" "}
                <Show when={refusedRows().length} fallback={<Show when={!guessed()}><span>{t("pcbImport.allImported")}</span></Show>}>
                  <span class="ci-bad">{t("pcbImport.refused", { count: refusedRows().length })}</span> {t("cstImport.listedBelow")}
                </Show>
                <Show when={guessed()}> <span>{t("pcbImport.guessed", { list: guessed() })}</span></Show>
                <Show when={gaps().changed}> {t("pcbImport.warnings", { count: gaps().changed })}</Show>
              </p>
              <Show when={checkErrors().length || errorsOf("warning").length}>
                <p class={checkErrors().length ? "rp-error" : "note"}>
                  {t("cstImport.checks", { list: [checkErrors().length ? t("status.checks.errors", { count: checkErrors().length }) : "", errorsOf("warning").length ? t("status.checks.warnings", { count: errorsOf("warning").length }) : ""].filter(Boolean).join(", ") })}
                  <Show when={checkErrors()[0] ?? errorsOf("warning")[0]}>{(c) => <>: {checkMessage(c())}</>}</Show>
                </p>
              </Show>
              <Show when={rows().length}>
                <ul class="ci-notes">
                  <For each={rows()}>{(n) => (
                    <li class={`ci-note ci-${n.severity}`}>
                      <span class="ci-sev">{t(SEVERITY[n.severity])}</span>
                      <span class="ci-msg">
                        <Show when={n.where}><span class="ci-where">{where(n) ? `${where(n)} · ` : ""}{n.where}: </span></Show>
                        {noteText(n)}
                        <Show when={(n.count ?? 1) > 1}><span class="ci-count"> ×{n.count}</span></Show>
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
              <input autocomplete="off" class="field-text" type="text" maxLength={80} value={name()} aria-invalid={!!idError()} aria-describedby="pi-id-hint"
                onInput={(e) => { setName(e.currentTarget.value); setNameTyped(true); setFieldErrors({}); }} />
              <span id="pi-id-hint" class={idError() ? "rp-error nm-hint" : "rp-hint nm-hint"} aria-live="polite">
                {idError() || (name().trim() ? `${id()}.design.json` : t("cstImport.fileHint"))}
              </span>
            </label>
          </Show>
        </form>
        </Show>
        <div class="dialog-foot">
          <span class="muted">{created() ? t("pcbImport.footDone") : report() ? t("pcbImport.footReady") : t("pcbImport.footEmpty")}</span>
          <div class="dialog-actions">
            <Show when={!created()} fallback={<button class="btn btn-ghost" type="button" onClick={close}>{t("common.close")}</button>}>
              <button class="btn btn-ghost" type="button" onClick={close} disabled={busy()}>{t("common.cancel")}</button>
              <button class="btn btn-primary" type="submit" form="pi-form"
                disabled={!report() || !name().trim() || !!idError() || busy() || pending() || reading() || !!Object.keys(fieldErrors()).length}>
                {busy() ? t("cstImport.creating") : t("cstImport.create")}
              </button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
