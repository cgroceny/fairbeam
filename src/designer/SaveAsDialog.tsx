import { createSignal, Show } from "solid-js";
import { useModal } from "../lib/dialog";
import { designFileHint, designIdError, freeDesignId } from "../lib/designId";
import { models } from "../runner/store";
import { appMode } from "../workspace";
import { createDesign, dirty, file, saveBeforeLeaving } from "./store";
import { t } from "../i18n";

/** Save As… is open (App.tsx hosts the dialog). Opened from the desktop File menu, the Home ribbon's
 * Project group, the header's ⋯ menu and Shift+Ctrl+S (⇧⌘S) in the designer. */
export const [saveAsOpen, setSaveAsOpen] = createSignal(false);
/** Save As needs a design open on the Design screen. */
export const canSaveAs = () => appMode() === "design" && !!file();
export const openSaveAs = () => { if (canSaveAs()) setSaveAsOpen(true); };

interface Props {
  source: { id: string; name: string };
  close: () => void;
}

/** "<name> copy", or "<name> copy 2", "… 3" when a design or model already has that file name. */
function copyName(name: string, keys: readonly string[]): string {
  const base = `${name} copy`;
  let n = base;
  for (let k = 2; k < 100 && keys.includes(freeDesignId(n, keys).id); k++) n = `${base} ${k}`;
  return n;
}

export default function SaveAsDialog(props: Props) {
  let box: HTMLDivElement | undefined;
  let nameInput: HTMLInputElement | undefined;
  const keys = () => models().map((m) => m.key);
  const [name, setName] = createSignal(copyName(props.source.name, keys()));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const close = () => { if (!busy()) props.close(); };
  // a bundled example's id gets a suffix (freeDesignId), shown under the field
  const id = () => freeDesignId(name(), keys()).id;
  const idError = () => !name().trim() ? "" : designIdError(id(), keys());
  useModal(() => box, close, () => nameInput);

  const submit = async (event: Event) => {
    event.preventDefault();
    if (!name().trim() || idError() || busy()) return;
    setBusy(true);
    setError("");
    try {
      if (dirty() && !(await saveBeforeLeaving())) {
        setError(t("saveAs.error.saveFirst"));
        return;
      }
      const result = await createDesign({ id: id(), name: name().trim(), from: props.source.id });
      if (!result) {
        setError(t("saveAs.error.create"));
        return;
      }
      props.close();
    } catch (err) {
      setError(t("saveAs.error.failed", { error: String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="dialog dialog-sm" role="dialog" aria-modal="true" aria-labelledby="save-as-title" aria-describedby="save-as-desc" ref={box} tabindex={-1}>
        <div class="dialog-head">
          <div>
            <h2 id="save-as-title">{t("saveAs.title")}</h2>
            <p id="save-as-desc" class="muted">{t("saveAs.description")}</p>
          </div>
        </div>
        <form class="dialog-body nm-body" onSubmit={submit}>
          <label class="field">
            <span>{t("saveAs.name")}</span>
            <input autocomplete="off" ref={nameInput} class="field-text" type="text" maxLength={80} value={name()} aria-invalid={!!idError()}
              aria-describedby="save-as-hint" onInput={(e) => { setName(e.currentTarget.value); setError(""); }} />
            <span id="save-as-hint" class={idError() ? "rp-error nm-hint" : "rp-hint nm-hint"} aria-live="polite">
              {idError() || (name().trim() ? designFileHint(name(), keys()) : t("saveAs.enterName"))}
            </span>
          </label>
          <Show when={error()}><p class="rp-error" role="alert">{error()}</p></Show>
          <div class="dialog-foot">
            <span class="muted">{busy() ? t("saveAs.saving") : ""}</span>
            <div class="dialog-actions">
              <button class="btn btn-ghost" type="button" disabled={busy()} onClick={close}>{t("common.cancel")}</button>
              <button class="btn btn-primary" type="submit" disabled={!name().trim() || !!idError() || busy()}>{busy() ? t("saveAs.saving") : t("common.save")}</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
