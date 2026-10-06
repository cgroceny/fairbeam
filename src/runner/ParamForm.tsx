import { createEffect, For, Show } from "solid-js";
import { CircleAlert, RotateCcw } from "lucide-solid";
import { fieldErrors, isModified, localError, resetValue, setValue, specs, values } from "./store";
import type { ParamSpec } from "./api";
import { t } from "../i18n";
import { paramLabelText } from "../lib/paramLabel";
import NumberField from "../components/NumberField";

function step(s: ParamSpec): string {
  if (s.type === "int") return "1";
  const d = Math.abs(Number(s.default));
  if (!Number.isFinite(d) || d === 0) return "any";
  // about 1 % of the default, rounded down to a power of ten (58 mm -> 0.1, 3.5 GHz -> 0.01)
  return String(10 ** Math.floor(Math.log10(d / 100)));
}

function Field(props: { spec: ParamSpec; swept: boolean }) {
  const s = () => props.spec;
  let input: HTMLInputElement | undefined;
  // Write the state into the number input only when it differs from what the input reports. A
  // plain value binding would clear partially typed text ("5." reads as "" in some browsers).
  createEffect(() => {
    const v = values[s().key] ?? "";
    if (input && input.value !== v) input.value = v;
  });
  const id = () => `param-${s().key}`;
  const error = () => (props.swept ? null : fieldErrors[s().key] ?? localError(s(), values[s().key]));
  const range = () => {
    const lo = s().minimum;
    const hi = s().maximum;
    if (lo === null && hi === null) return "";
    if (lo !== null && hi !== null) return `${lo}–${hi}`;
    return lo !== null ? `≥ ${lo}` : `≤ ${hi}`;
  };
  return (
    <div class="rp-field" classList={{ modified: isModified(s()) && !props.swept, invalid: !!error(), swept: props.swept }}>
      <label class="rp-label" for={id()} title={s().description || undefined}>
        <span class="rp-dot" aria-hidden="true" />
        <span class="rp-label-text">{paramLabelText(s().label)}</span>
        <Show when={isModified(s()) && !props.swept}>
          <span class="visually-hidden"> {t("paramForm.modified")}</span>
        </Show>
      </label>
      <div class="rp-control">
        <Show
          when={s().type === "int" || s().type === "float"}
          fallback={
            <Show
              when={s().type === "bool"}
              fallback={
                <input autocomplete="off" id={id()} class="rp-input rp-input-text" type="text" value={values[s().key] ?? ""} aria-invalid={!!error()}
                  aria-describedby={error() ? `${id()}-err` : undefined}
                  onInput={(e) => setValue(s().key, e.currentTarget.value)} />
              }
            >
              <input id={id()} type="checkbox" checked={values[s().key] === "true"} onChange={(e) => setValue(s().key, String(e.currentTarget.checked))} />
            </Show>
          }
        >
          <NumberField
            ref={input}
            id={id()}
            class="rp-input"
            min={s().minimum ?? undefined}
            max={s().maximum ?? undefined}
            step={step(s())}
            disabled={props.swept}
            aria-invalid={!!error()}
            aria-describedby={error() ? `${id()}-err` : `${id()}-hint`}
            onInput={(e) => setValue(s().key, e.currentTarget.value)}
          />
          <span class="rp-unit">{s().unit}</span>
        </Show>
        <button
          type="button"
          class="icon-btn icon-btn-sm rp-reset"
          classList={{ hidden: !isModified(s()) || props.swept }}
          disabled={!isModified(s()) || props.swept}
          onClick={() => resetValue(s())}
          title={t("paramForm.resetTitle", { value: `${s().default}${s().unit ? " " + s().unit : ""}` })}
          aria-label={t("paramForm.resetLabel", { label: paramLabelText(s().label), value: String(s().default) })}
        >
          <RotateCcw size={14} />
        </button>
      </div>
      <Show
        when={error()}
        fallback={
          <p class="rp-hint" id={`${id()}-hint`}>
            <span class="mono">{s().key}</span>
            <Show when={props.swept}> · {t("paramForm.swept")}</Show>
            <Show when={!props.swept && range()}> · <span class="mono">{range()}</span></Show>
            <Show when={!props.swept && isModified(s())}> · {t("paramForm.default")} <span class="mono">{String(s().default)}</span></Show>
          </p>
        }
      >
        <p class="rp-error" id={`${id()}-err`} role="alert">
          <CircleAlert size={12} aria-hidden="true" /> {error()}
        </p>
      </Show>
    </div>
  );
}

export default function ParamForm(props: { swept?: string[] }) {
  return (
    <div class="stack">
      <For each={specs()}>{(s) => <Field spec={s} swept={(props.swept ?? []).includes(s.key)} />}</For>
    </div>
  );
}
