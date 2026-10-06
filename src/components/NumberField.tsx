import { createSignal, splitProps, type JSX } from "solid-js";
import { attachNumberInput, NUMBER_PATTERN } from "../lib/numberField";

/** A number entry that behaves the same in every language and WebView (see lib/numberField.ts):
 *  shows a decimal point, accepts "2,45" as 2.45, steps with the arrow keys, and reads "" from
 *  `e.currentTarget.value` while the text is not a number. Takes the props of an <input>
 *  (id, class, min, max, step, value, onInput, onChange, aria-*), but not `type`. */
export default function NumberField(props: Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "type" | "inputmode" | "pattern">) {
  const [own, rest] = splitProps(props, ["ref", "aria-invalid"]);
  const [bad, setBad] = createSignal(false);
  const invalid = () => {
    const a = own["aria-invalid"];
    return bad() || a === true || a === "true" ? true : a;
  };
  return (
    <input
      {...rest}
      type="text"
      inputmode="decimal"
      pattern={NUMBER_PATTERN}
      autocomplete="off"
      autocapitalize="off"
      spellcheck={false}
      aria-invalid={invalid()}
      ref={(el) => {
        attachNumberInput(el, setBad);
        const r = own.ref as unknown;
        if (typeof r === "function") (r as (e: HTMLInputElement) => void)(el);
      }}
    />
  );
}
