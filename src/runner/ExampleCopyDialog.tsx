import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { api, ApiError } from "./api";
import { copyExampleFile, copyExampleKey, models, refreshModels, setCopyExampleKey } from "./store";
import { enterDesign } from "../designer/store";
import { setAppMode } from "../workspace";
import { fmt, t } from "../i18n";

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[^a-z]+/, "").slice(0, 41);
export default function ExampleCopyDialog() {
  let dialog!: HTMLDialogElement;
  const [name, setName] = createSignal("");
  const [id, setId] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [preview, setPreview] = createSignal<{ source_cells: number | null; design_cells: number | null; within_tolerance: boolean | null; params_carried?: number; params_total?: number; params_partial?: string[]; expressions?: number } | null>(null);
  const [previewPending, setPreviewPending] = createSignal(false);
  const source = () => models().find((m) => m.key === copyExampleKey());
  createEffect(() => {
    const key = copyExampleKey();
    const project = copyExampleFile() ?? undefined;
    const current = source();
    if (!key || !current) { setPreview(null); setPreviewPending(false); return; }
    const controller = new AbortController();
    let active = true;
    setPreview(null); setError(""); setPreviewPending(true);
    void api.previewExampleConversion({ from: current.key, project }, controller.signal).then((result) => {
      if (active) setPreview(result);
    }).catch((e) => {
      if (!active || (e as Error).name === "AbortError") return;
      const a = e as ApiError;
      setError(a.status === 0 ? t("common.serverUnreachable") : a.message);
    }).finally(() => { if (active) setPreviewPending(false); });
    onCleanup(() => { active = false; controller.abort(); });
  });
  createEffect(() => {
    if (copyExampleKey()) {
      const base = `${source()?.model?.name ?? "Example"} copy`;
      const names = new Set(models().map((m) => m.model?.name?.toLowerCase()));
      let n = base;
      for (let suffix = 2; names.has(n.toLowerCase()); suffix++) n = `${base} ${suffix}`;
      const keys = new Set(models().map((m) => m.key));
      const baseId = slug(n);
      let candidate = baseId;
      for (let suffix = 2; keys.has(candidate); suffix++) {
        const ending = `_${suffix}`;
        candidate = `${baseId.slice(0, 41 - ending.length)}${ending}`;
      }
      setName(n); setId(candidate); setError("");
      if (!dialog.open) dialog.showModal();
    } else if (dialog?.open) dialog.close();
  });
  const uniqueId = () => {
    const base = id();
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(base) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(base)) return "";
    return models().some((m) => m.key === base) ? "" : base;
  };
  const close = () => { if (!busy()) setCopyExampleKey(null); };
  const submit = async (e: Event) => {
    e.preventDefault();
    const m = source();
    if (!m || !uniqueId() || !name().trim() || busy() || previewPending() || !preview()) return;
    setBusy(true); setError("");
    try {
      const result = await api.copyExample({ from: m.key, id: uniqueId(), name: name().trim(), project: copyExampleFile() ?? undefined });
      setCopyExampleKey(null);
      await refreshModels();
      setAppMode("design");
      void enterDesign(result.id);
    } catch (e) {
      const a = e as ApiError;
      setError(a.status === 0 ? t("common.serverUnreachable") : a.message);
    } finally { setBusy(false); }
  };
  return (
    <dialog ref={dialog} class="example-copy-dialog" aria-labelledby="example-copy-title"
      onCancel={(e) => { e.preventDefault(); close(); }}>
      <form class="stack" onSubmit={submit}>
        <h2 id="example-copy-title">{t("exampleCopy.title")}</h2>
        <p class="muted">{t("exampleCopy.intro")}</p>
        <div class="ec-carry" role="group" aria-label={t("exampleCopy.carry.label")}>
          <p><b>{t("exampleCopy.carried")}</b> {t("exampleCopy.carried.body")}</p>
          <p><b>{t("exampleCopy.notCarried")}</b> {t("exampleCopy.notCarried.body")}</p>
        </div>
        <Show when={preview()?.params_carried !== undefined}>
          <p class="muted" role="status">{t("exampleCopy.params", { carried: preview()!.params_carried!, total: preview()!.params_total ?? 0, expressions: preview()!.expressions ?? 0 })}</p>
          <Show when={(preview()!.params_partial ?? []).length > 0}><p class="muted">{t("exampleCopy.partial", { keys: preview()!.params_partial!.join(", ") })}</p></Show>
        </Show>
        <p class="muted">{t("exampleCopy.meshNote")}</p>
        <Show when={previewPending()}><p class="muted" role="status">{t("exampleCopy.checkingMesh")}</p></Show>
        <Show when={preview() && preview()!.source_cells !== null}>
          <div class={preview()!.within_tolerance ? "mesh-preview" : "mesh-preview mesh-preview-warning"} role={preview()!.within_tolerance ? "status" : "alert"}>
            <Show when={!preview()!.within_tolerance}><strong>{t("exampleCopy.meshDiffers")}</strong></Show>
            <p>{t("exampleCopy.cells", { source_cells: fmt.int(preview()!.source_cells!), design_cells: fmt.int(preview()!.design_cells!) })}</p>
          </div>
        </Show>
        <label class="field">
          <span>{t("exampleCopy.name")}</span>
          <input autocomplete="off" class="field-text" value={name()} maxLength={80} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        <label class="field">
          <span>{t("exampleCopy.id")}</span>
          <input autocomplete="off" class="field-text mono" value={id()} maxLength={41} aria-invalid={!uniqueId()}
            onInput={(e) => setId(e.currentTarget.value)} />
        </label>
        <Show when={error()}><p class="rp-error" role="alert">{error()}</p></Show>
        <Show when={!uniqueId()}>
          <p class="rp-error">{t("exampleCopy.idInvalid")}</p>
        </Show>
        <div class="cluster-sm">
          <button class="btn btn-ghost" type="button" disabled={busy()} onClick={close}>{t("common.cancel")}</button>
          <button class="btn btn-primary" disabled={busy() || previewPending() || !preview() || !!error() || !name().trim() || !uniqueId()}>
            {busy() ? t("exampleCopy.copying") : previewPending() ? t("exampleCopy.checking") : t("exampleCopy.create")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
