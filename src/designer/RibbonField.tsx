// A draft expression shown alongside the inspector. IDs are local to this control, while
// validation still uses the shared design path (the inspector may show that same field).
import { createSignal, createUniqueId, Show } from "solid-js";
import { tryEvaluate } from "./expr";
import { shown as fmt } from "./displayNumber.ts";
import { issues, names } from "./store";
import { checkMessage } from "./checkText";
import type { Expr } from "./types";

export default function RibbonField(props: { label: string; unit?: string; value: Expr; path: string; onChange: (value: Expr) => void }) {
  const id = `ribbon-${createUniqueId()}`;
  const [text, setText] = createSignal<string | null>(null);
  const evaluated = () => tryEvaluate(props.value, names().names);
  const issue = () => issues()[props.path];
  const bad = () => issue()?.severity === "error" || !!evaluated().error;
  const detail = () => issue()?.message ?? (evaluated().error && checkMessage({ code: "expr", message: evaluated().error! })) ?? (typeof props.value === "number" ? "" : `= ${fmt(evaluated().value!)}`);
  return (
    <label class="dz-field" for={id}>
      <span class="dz-label">{props.label} <span class="dz-unit">{props.unit}</span></span>
      <input autocomplete="off" id={id} class="rp-input dz-input mono" type="text" spellcheck={false}
        value={text() ?? String(props.value)} aria-invalid={bad()} aria-describedby={detail() ? `${id}-detail` : undefined}
        onInput={(e) => {
          const value = e.currentTarget.value;
          setText(value);
          const trimmed = value.trim();
          props.onChange(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed) ? Number(trimmed) : trimmed);
        }} onBlur={() => setText(null)} />
      <Show when={detail()}><span id={`${id}-detail`} class="dz-value" classList={{ "dz-bad": bad(), "dz-warn": issue()?.severity === "warning" }}>{detail()}</span></Show>
    </label>
  );
}
