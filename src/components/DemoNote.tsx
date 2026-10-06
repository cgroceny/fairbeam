import { createSignal, onCleanup, Show } from "solid-js";
import { ArrowUpRight, Info } from "lucide-solid";
import { INSTALL_URL } from "../env";
import { t } from "../i18n";

/** Demo build only: takes the place of the Run button and says, briefly and honestly, why there
 * is no Run panel. A disclosure popover (button + region), closed by Escape or a click outside. */
export default function DemoNote() {
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  const [open, setOpen] = createSignal(false);

  const onDoc = (e: PointerEvent) => !root.contains(e.target as Node) && close(false);
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(true);
  function close(focus: boolean) {
    setOpen(false);
    document.removeEventListener("pointerdown", onDoc);
    document.removeEventListener("keydown", onKey);
    if (focus) trigger.focus();
  }
  const toggle = () => {
    if (open()) return close(false);
    setOpen(true);
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
  };
  onCleanup(() => close(false));

  return (
    <div class="demo-note" ref={root}>
      <button
        ref={trigger}
        class="btn btn-ghost"
        aria-expanded={open()}
        aria-controls="demo-note-panel"
        onClick={toggle}
        title={t("demo.title")}
        aria-label={t("demo.aria")}
      >
        <Info size={14} aria-hidden="true" /> <span class="btn-label">{t("demo.label")}</span>
      </button>
      <Show when={open()}>
        <div class="demo-note-panel" id="demo-note-panel" role="region" aria-label={t("demo.region")}>
          <p>{t("demo.local")}</p>
          <p class="muted">{t("demo.details")}</p>
          <a class="demo-note-link" href={INSTALL_URL} target="_top">
            {t("demo.download")} <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        </div>
      </Show>
    </div>
  );
}
