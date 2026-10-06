import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { X } from "lucide-solid";
import { useModal } from "../lib/dialog";
import { radioGroupKeys } from "../lib/a11y";
import { ApiError } from "../runner/api";
import { models } from "../runner/store";
import { createModel, dialog, newModelKind, file, loadTemplates, setDialog, setPanelTab, templates } from "./store";
import { createDesign } from "../designer/store";
import { t } from "../i18n";

/** A sentence around one code-styled file name: `id` is a key with a {file} placeholder. */
function WithFile(props: { id: string; file: string }) {
  const parts = () => t(props.id, { file: "\u0001" }).split("\u0001");
  return <>{parts()[0]}<span class="mono">{props.file}</span>{parts().slice(1).join(props.file)}</>;
}

const ID_RE = /^[a-z][a-z0-9_]{1,40}$/;
/** Windows device names (python/fairbeam/modelfiles.py RESERVED_ID_RE) */
const RESERVED_ID_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
const suggestId = (name: string) =>
  name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "").slice(0, 41);

/** "New model" (from a template) and "Duplicate" (of the open model) dialog. */
export default function NewModelDialog(props: { onPythonCreated?: (id: string) => void } = {}) {
  let box: HTMLDivElement | undefined;
  let nameInput: HTMLInputElement | undefined;
  const duplicate = () => dialog() === "duplicate";
  const source = () => file();
  const [template, setTemplate] = createSignal("blank");
  /** a Python model file from a template, or a design drawn in the Design tab */
  const [kind, setKind] = createSignal<"python" | "design">(newModelKind());
  const [name, setName] = createSignal(duplicate() && source() ? `${models().find((m) => m.key === source()!.id)?.model?.name ?? source()!.id} copy` : "");
  const [id, setId] = createSignal(duplicate() && source() ? `${source()!.id}_copy`.slice(0, 41) : "");
  const [idTouched, setIdTouched] = createSignal(false);
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [busy, setBusy] = createSignal(false);
  const close = () => setDialog(null);
  useModal(() => box, close, () => nameInput);
  onMount(() => {
    if (!duplicate()) loadTemplates();
  });

  const idError = createMemo(() => {
    const v = id();
    if (!v) return "";
    if (!ID_RE.test(v)) return t("editor.newModel.error.id");
    if (RESERVED_ID_RE.test(v)) return t("editor.newModel.error.reserved");
    if (models().some((m) => m.key === v)) return t("editor.newModel.error.exists");
    return "";
  });
  const current = () => templates().find((x) => x.key === template());
  const lede = (doc?: string) => (doc ?? "").split(/\n\s*\n/)[0].replace(/\s+/g, " ");

  const submit = async (e: Event) => {
    e.preventDefault();
    if (idError() || !id() || busy()) return;
    setBusy(true);
    setErrors({});
    try {
      let pythonCreatedId: string | undefined;
      if (!duplicate() && kind() === "design") {
        // Cancel in "Save changes before creating …?" creates nothing and keeps this dialog open
        if (!(await createDesign({ id: id(), name: name().trim() || undefined }))) return;
        setPanelTab("design");
      } else {
        const created = await createModel({ id: id(), name: name().trim() || undefined, ...(duplicate() ? { from: source()!.id } : { template: template() }) });
        if (!duplicate() && kind() === "python") pythonCreatedId = created.id;
      }
      close();
      if (pythonCreatedId) props.onPythonCreated?.(pythonCreatedId);
    } catch (err) {
      const a = err as ApiError;
      setErrors({ ...a.fields, _: a.status === 0 ? t("common.serverUnreachable") : a.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="dialog dialog-sm" role="dialog" aria-modal="true" aria-labelledby="nm-title" aria-describedby="nm-desc" ref={box} tabindex={-1}>
        <div class="dialog-head">
          <div>
            <h2 id="nm-title">{duplicate() ? t("editor.newModel.duplicateTitle") : t("editor.newModel.title")}</h2>
            <p id="nm-desc" class="muted">
              {duplicate()
                ? <WithFile id="editor.newModel.duplicateDesc" file={source()?.file ?? ""} />
                : kind() === "design"
                  ? <WithFile id="editor.newModel.designDesc" file="<id>.design.json" />
                  : <WithFile id="editor.newModel.pythonDesc" file="python/models/<id>.py" />}
            </p>
          </div>
          <button class="icon-btn" onClick={close} aria-label={t("common.close")}><X size={16} /></button>
        </div>
        <form class="dialog-body nm-body" onSubmit={submit} id="nm-form">
          <div class="stack">
            <label class="field">
              <span>{t("editor.newModel.displayName")}</span>
              <input autocomplete="off" ref={nameInput} class="field-text" type="text" maxLength={80} value={name()} placeholder={t("editor.newModel.namePlaceholder")}
                onInput={(e) => { setName(e.currentTarget.value); if (!idTouched()) setId(suggestId(e.currentTarget.value)); }} />
            </label>
            <label class="field">
              <span>{t("editor.newModel.id")} <span class="muted">{t("editor.newModel.idNote")}</span></span>
              <input autocomplete="off" type="text" maxLength={41} value={id()} aria-invalid={!!(idError() || errors().id)} aria-describedby="nm-id-hint"
                onInput={(e) => { setIdTouched(true); setId(e.currentTarget.value); }} />
              <span id="nm-id-hint" class={idError() || errors().id ? "rp-error nm-hint" : "rp-hint nm-hint"}>
                {idError() || errors().id || (id() ? (kind() === "design" && !duplicate() ? `${id()}.design.json` : `python/models/${id()}.py`) : t("editor.newModel.idHint"))}
              </span>
            </label>
          </div>
          <Show when={!duplicate()}>
            <div class="seg" role="radiogroup" aria-label={t("editor.newModel.kind")} onKeyDown={radioGroupKeys}>
              <button type="button" class="seg-btn" role="radio" aria-checked={kind() === "design"} tabindex={kind() === "design" ? 0 : -1} onClick={() => setKind("design")}>{t("editor.newModel.kind.design")}</button>
              <button type="button" class="seg-btn" role="radio" aria-checked={kind() === "python"} tabindex={kind() === "python" ? 0 : -1} onClick={() => setKind("python")}>{t("editor.newModel.kind.python")}</button>
            </div>
          </Show>
          <Show when={!duplicate() && kind() === "python"}>
            <fieldset class="nm-templates">
              <legend class="section-label">{t("editor.newModel.template")}</legend>
              <div class="nm-list" role="radiogroup" aria-label={t("editor.newModel.template")}>
                <For each={templates()} fallback={<p class="note">{t("editor.newModel.loadingTemplates")}</p>}>
                  {(tpl) => (
                    <label class="nm-option" classList={{ selected: template() === tpl.key }}>
                      <input type="radio" name="nm-template" value={tpl.key} checked={template() === tpl.key} onChange={() => setTemplate(tpl.key)} />
                      <span class="nm-option-text">
                        <span class="nm-option-name">{tpl.model?.name ?? tpl.key}</span>
                        <span class="nm-option-sub">{tpl.model?.description}</span>
                      </span>
                    </label>
                  )}
                </For>
              </div>
              <Show when={current()?.doc}>
                <p class="note nm-doc">{lede(current()!.doc)}</p>
              </Show>
            </fieldset>
          </Show>
        </form>
        <div class="dialog-foot">
          <span class="muted">
            <Show when={errors()._} fallback={<>{duplicate() ? t("editor.newModel.copyNote") : t("editor.newModel.templates", { count: templates().length })}</>}>
              <span class="rs-critical-text">{errors()._}</span>
            </Show>
          </span>
          <div class="dialog-actions">
            <button class="btn btn-ghost" type="button" onClick={close}>{t("common.cancel")}</button>
            <button class="btn btn-primary" type="submit" form="nm-form" disabled={!id() || !!idError() || busy()}>
              {duplicate() ? t("editor.newModel.duplicate") : kind() === "design" ? t("editor.newModel.createDesign") : t("editor.newModel.createModel")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
