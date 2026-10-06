// "Subtract ›" (and Add, Intersect, Insert): the other solids listed right in the menu, so a
// Boolean is one pick instead of arming it, picking B in the tree and pressing Apply. Shared by the
// right-click menu and the ribbon's Boolean menu.
import { ChevronLeft, CircleDot } from "lucide-solid";
import { For, onCleanup, Show } from "solid-js";
import { booleanTargets, BOOLEAN_LABELS, BOOLEAN_SYMBOLS, runBoolean, type BooleanOperation } from "./booleanUi";
import { draft } from "./store";
import { setHoverPart } from "../state";
import { t } from "../i18n";

export function BooleanTargets(props: { op: BooleanOperation; a: number; itemClass: string; onBack: () => void; onDone: () => void }) {
  const others = () => booleanTargets(props.a);
  onCleanup(() => setHoverPart(null));
  const pick = (b: number) => { const { op, a } = props; props.onDone(); runBoolean(op, a, b); };
  return <>
    <button class={props.itemClass} type="button" role="menuitem" onClick={props.onBack}><ChevronLeft size={14} aria-hidden="true" /> {BOOLEAN_LABELS[props.op]} {BOOLEAN_SYMBOLS[props.op]} …</button>
    <Show when={others().length} fallback={<p class="note bool-targets-none" role="status">{t("boolean.needTwo")}</p>}>
      <For each={others()}>{(o) =>
        <button class={props.itemClass} type="button" role="menuitem" data-boolean-target={draft.parts[o.i]?.name}
          title={t("boolean.targetTitle", { op: BOOLEAN_LABELS[props.op], a: draft.parts[props.a]?.label || draft.parts[props.a]?.name, b: o.title })}
          onPointerEnter={() => setHoverPart(draft.parts[o.i]?.name ?? null)} onPointerLeave={() => setHoverPart(null)}
          onClick={() => { setHoverPart(null); pick(o.i); }}><CircleDot size={14} aria-hidden="true" /> {o.title}</button>
      }</For>
    </Show>
  </>;
}
