// "Color…" from a right-click menu (a solid, a component folder, a material): a small popover with
// the color input and a Default reset. It sets the color through setColors, so a folder's solids
// change as one undo step, exactly like Properties › Color.
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { draft, file, setColors } from "./store";
import { resolveColor, themeColor, validColor } from "./colors";
import { t } from "../i18n";

export type ColorRequest = { kind: "parts" | "materials"; indices: number[]; x: number; y: number; label: string };
export const [colorRequest, setColorRequest] = createSignal<ColorRequest | null>(null);
export const openColor = (request: ColorRequest) => setColorRequest(request);

/** The color the first item is drawn with now (its own, its material's, else the theme's). */
function currentColor(req: ColorRequest): string {
  const item = draft[req.kind][req.indices[0]];
  if (!item) return themeColor(false);
  if (req.kind === "materials") return validColor(item.color) ?? themeColor((item as { kind?: string }).kind === "metal");
  const material = draft.materials.find((m) => m.name === (item as { material?: string }).material);
  return resolveColor(item, material, themeColor(material?.kind === "metal"));
}
const hasOwnColor = (req: ColorRequest) => req.indices.some((i) => !!validColor(draft[req.kind][i]?.color));

function Popover(props: { req: ColorRequest }) {
  let box!: HTMLDivElement;
  let input!: HTMLInputElement;
  const close = () => setColorRequest(null);
  const [pos, setPos] = createSignal({ x: props.req.x, y: props.req.y });
  const open = () => props.req;
  // an undo, or a change of design, can remove what the popover edits
  createEffect(() => { if (!open().indices.length || open().indices.some((i) => !draft[open().kind][i])) close(); });
  onMount(() => {
    const r = box.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(props.req.x, innerWidth - r.width - 8)), y: Math.max(8, Math.min(props.req.y, innerHeight - r.height - 8)) });
    input.focus();
    const away = (e: PointerEvent) => { if (!box.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    onCleanup(() => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", esc, true); });
  });
  return (
    <div ref={box} class="menu dz-color-popover" role="dialog" aria-label={t("colorPopover.title", { name: open().label })}
      style={{ left: `${pos().x}px`, top: `${pos().y}px` }} onContextMenu={(e) => e.preventDefault()}>
      <span class="dz-label">{t("colorPopover.title", { name: open().label })}</span>
      <div class="cluster-sm">
        <input ref={input} type="color" class="dz-color-input" aria-label={t("props.color")} value={currentColor(open())}
          onInput={(e) => setColors(open().kind, open().indices, e.currentTarget.value)} />
        <Show when={open().indices.length > 1}><span class="note">{t("colorPopover.count", { count: open().indices.length })}</span></Show>
        <button class="btn btn-ghost btn-sm" disabled={!hasOwnColor(open())} onClick={() => setColors(open().kind, open().indices, undefined)}>{t("props.color.reset")}</button>
        <button class="btn btn-ghost btn-sm" onClick={close}>{t("common.close")}</button>
      </div>
    </div>
  );
}

export default function ColorPopoverHost() {
  createEffect(() => { void file()?.id; setColorRequest(null); });
  onCleanup(() => setColorRequest(null));
  return <Portal><Show when={colorRequest()} keyed>{(req) => <Popover req={req} />}</Show></Portal>;
}
