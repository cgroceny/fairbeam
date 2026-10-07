// "New parameter": an expression used a name that is not a parameter yet (e.g. "xs"); give it a
// value and it is created, so the field evaluates. A value makes an independent parameter, an
// expression a derived one. Limits are optional and not asked here (the Parameters dock has them).
// Several unknown names are asked one after another (store.paramAsks).
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { X } from "lucide-solid";
import { useModal } from "../../lib/dialog";
import { createParam, draft, type ParamAsk, paramAsks, setParamAsks } from "../store";
import { paramKeyError, paramValues, tryEvaluate } from "../expr";
import { shown as fmt } from "../displayNumber.ts";
import { toExpr } from "../draw";
import type { DesignParam } from "../types";
import { t } from "../../i18n";

/** A sentence with one code-styled name: `id` is a key with a {key} placeholder. */
function WithKey(props: { id: string; name: string; bold?: boolean }) {
  const parts = () => t(props.id, { key: "\u0001" }).split("\u0001");
  return <>{parts()[0]}{props.bold ? <b>{props.name}</b> : <span class="mono">{props.name}</span>}{parts().slice(1).join(props.name)}</>;
}

/** The dialog for the first queued name, if any (rendered once by the designer workspace). */
export function NewParamHost() {
  return (
    <Show when={paramAsks()[0]} keyed>
      {(ask) => <NewParamDialog ask={ask} onDone={() => setParamAsks((q) => q.filter((a) => a !== ask))} />}
    </Show>
  );
}

/** an evaluated value shown as text: the locale's decimal separator */
const derivedValue = (v: number) => fmt(v);

function NewParamDialog(props: { ask: ParamAsk; onDone: () => void }) {
  let box: HTMLDivElement | undefined;
  let valueInput: HTMLInputElement | undefined;
  useModal(() => box, props.onDone, () => valueInput);
  // Esc closes this dialog only, not a dialog under it (the shape dialog): catch it first
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !box?.isConnected) return;
      e.preventDefault();
      e.stopPropagation();
      props.onDone();
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });
  const at = () => props.ask.insertAt ?? draft.params.length;
  const [key, setKey] = createSignal(props.ask.key);
  const [value, setValue] = createSignal("");
  const [label, setLabel] = createSignal("");
  const [unit, setUnit] = createSignal(props.ask.unit ?? "");
  const [description, setDescription] = createSignal("");
  const [tried, setTried] = createSignal(false);

  const keyError = () => {
    const k = key().trim();
    const bad = paramKeyError(k);
    if (bad) return bad;
    if (draft.params.some((q) => q.key === k)) return t("newParam.error.exists");
    return "";
  };
  /** the value evaluated over the parameters above the new one */
  const evaluated = createMemo(() => {
    const text = value().trim();
    if (!text) return { error: t("newParam.error.required") };
    return tryEvaluate(toExpr(text),paramValues(draft.params.slice(0, at())).names);
  });

  const submit = (e: Event) => {
    e.preventDefault();
    setTried(true);
    if (keyError() || evaluated().error) return;
    const k = key().trim();
    const v = toExpr(value());
    const p: DesignParam = typeof v === "number" ? { key: k, default: v } : { key: k, expr: v };
    if (label().trim()) p.label = label().trim();
    if (unit().trim()) p.unit = unit().trim();
    if (description().trim()) p.description = description().trim();
    // rewrite the field first: inserting above it shifts the indices its setter writes to
    if (k !== props.ask.key) props.ask.rename?.(props.ask.key, k);
    createParam(p, props.ask.insertAt);
    props.onDone();
  };

  const later = () => paramAsks().length - 1;
  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onDone()}>
      <div class="dialog dialog-sm np" role="dialog" aria-modal="true" aria-labelledby="np-title" ref={box} tabindex={-1}>
        <div class="dialog-head">
          <div>
            <h2 id="np-title">{t("newParam.title")}</h2>
            <p class="muted"><WithKey id="newParam.intro" name={props.ask.key} /></p>
          </div>
          <button class="icon-btn" onClick={props.onDone} aria-label={t("common.close")} data-noprompt><X size={16} /></button>
        </div>
        <form class="sd-body" id="np-form" onSubmit={submit} novalidate>
          <label class="dz-field">
            <span class="dz-label">{t("newParam.name")}</span>
            <input autocomplete="off" class="rp-input dz-input np-key" type="text" spellcheck={false} value={key()} aria-invalid={!!keyError()}
              onInput={(e) => setKey(e.currentTarget.value)} />
            <span class="dz-value" classList={{ "dz-bad": !!keyError() }}>{keyError() || (key().trim() !== props.ask.key ? t("newParam.willUse", { key: key().trim() }) : "")}</span>
          </label>
          <label class="dz-field">
            <span class="dz-label">{t("newParam.value")}{unit().trim() ? <span class="dz-unit"> {unit().trim()}</span> : null} <span class="dz-unit">{t("newParam.valueHint")}</span></span>
            <input autocomplete="off" ref={valueInput} class="rp-input dz-input mono" type="text" spellcheck={false} value={value()} placeholder={t("newParam.valuePlaceholder")}
              aria-invalid={tried() && !!evaluated().error} onInput={(e) => setValue(e.currentTarget.value)} />
            <span class="dz-value" classList={{ "dz-bad": tried() && !!evaluated().error }}>
              {evaluated().error ? (tried() || value().trim() ? evaluated().error : "") : typeof toExpr(value()) === "number" ? "" : t("newParam.derived", { value: derivedValue(evaluated().value!) })}
            </span>
          </label>
          <div class="dz-pair">
            <label class="dz-field">
              <span class="dz-label">{t("newParam.label")} <span class="dz-unit">{t("newParam.optional")}</span></span>
              <input autocomplete="off" class="rp-input dz-input rp-input-text" type="text" value={label()} placeholder={t("newParam.labelPlaceholder")} onInput={(e) => setLabel(e.currentTarget.value)} />
            </label>
            <label class="dz-field">
              <span class="dz-label">{t("newParam.unit")} <span class="dz-unit">{t("newParam.optional")}</span></span>
              <input autocomplete="off" class="rp-input dz-input" type="text" value={unit()} placeholder="mm, GHz, …" onInput={(e) => setUnit(e.currentTarget.value)} />
            </label>
          </div>
          <label class="dz-field">
            <span class="dz-label">{t("newParam.description")} <span class="dz-unit">{t("newParam.optional")}</span></span>
            <textarea class="rp-input dz-input" rows={2} value={description()} onInput={(e) => setDescription(e.currentTarget.value)} />
          </label>
        </form>
        <div class="dialog-foot">
          <span class="muted">{later() > 0 ? t("newParam.later", { count: later() }) : t("newParam.limitsNote")}</span>
          <div class="dialog-actions">
            <button class="btn btn-ghost" type="button" onClick={props.onDone} data-noprompt>{t("newParam.notNow")}</button>
            <button class="btn btn-primary" type="submit" form="np-form">{t("newParam.create")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Nonblocking offer beneath an ExprField; uses the same creation and evaluation as the dialog. */
export function InlineParam(props: { ask: ParamAsk; onCreated?: () => void }) {
  const [value, setValue] = createSignal("");
  const [tried, setTried] = createSignal(false);
  const result = () => value().trim()
    ? tryEvaluate(toExpr(value()), paramValues(draft.params.slice(0, props.ask.insertAt ?? draft.params.length)).names)
    : { error: t("newParam.error.enterValue") };
  const submit = () => {
    setTried(true);
    if (result().error || draft.params.some((p) => p.key === props.ask.key)) return;
    const v = toExpr(value());
    createParam({ key: props.ask.key, unit: props.ask.unit, ...(typeof v === "number" ? { default: v } : { expr: v }) }, props.ask.insertAt);
    props.onCreated?.();
  };
  return <div class="param-create" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); submit(); } }}>
    <span><WithKey id="newParam.inline" name={props.ask.key} bold /></span>
    {/* wide enough for its whole placeholder in the UI language ("Değer ya da ifade"), never wider than the row */}
    <input autocomplete="off" class="rp-input" aria-label={t("newParam.inlineAria", { key: props.ask.key })} value={value()}
      style={{ "min-width": `min(${t("newParam.inlinePlaceholder").length + 3}ch, 100%)` }}
      aria-invalid={tried() && !!result().error} placeholder={t("newParam.inlinePlaceholder")} onInput={(e) => setValue(e.currentTarget.value)} />
    <span>{props.ask.unit}</span><button type="button" class="btn btn-sm" onClick={submit}>{t("newParam.create")}</button>
    <Show when={tried() && result().error}><span class="dz-bad" role="alert">{result().error}</span></Show>
  </div>;
}
