import { createSignal, Show } from "solid-js";
import { useModal } from "../lib/dialog";
import { designIdError, suggestDesignId } from "../lib/designId";
import { models } from "../runner/store";
import { createDesign, dirty, saveBeforeLeaving } from "./store";
import { t } from "../i18n";

interface Props {
  source: { id: string; name: string };
  close: () => void;
}

export default function SaveAsDialog(props: Props) {
  let box: HTMLDivElement | undefined;
  let nameInput: HTMLInputElement | undefined;
  const [name, setName] = createSignal(`${props.source.name} copy`);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const close = () => { if (!busy()) props.close(); };
  const id = () => suggestDesignId(name());
  const idError = () => !name().trim() ? "" : designIdError(id(), models().map((m) => m.key));
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
              {idError() || (name().trim() ? `${id()}.design.json` : t("saveAs.enterName"))}
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
