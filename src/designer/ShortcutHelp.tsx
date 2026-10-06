import { For, Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { X } from "lucide-solid";
import { useModal } from "../lib/dialog";
import { SHORTCUTS } from "./shortcuts";
import { health } from "../runner/store";
import { t } from "../i18n";

const [open, setOpen] = createSignal(false);
export const showShortcutHelp = () => setOpen(true);

function HelpDialog() {
  let box!: HTMLDivElement;
  const close = () => setOpen(false);
  useModal(() => box, close);
  return <Portal><div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
    <div ref={box} class="dialog shortcut-help-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title" tabindex="-1">
      <div class="dialog-head"><div><h2 id="shortcut-help-title">{t("shortcuts.dialog.title")}</h2><p>{t("shortcuts.dialog.intro")}</p></div>
        <button class="icon-btn" aria-label={t("common.close")} onClick={close}><X size={16} /></button></div>
      <div class="dialog-body"><dl class="shortcut-list"><For each={Object.values(SHORTCUTS).filter((item) => health()?.desktop || (item.id !== "transform" && item.id !== "close"))}>{(item) => <div><dt>{item.label}<small>{item.context}</small></dt><dd><kbd>{item.key}</kbd></dd></div>}</For>
        <div><dt>{t("shortcuts.extra.applyBoolean")}<small>{t("shortcuts.extra.applyBooleanContext")}</small></dt><dd><kbd>Enter</kbd></dd></div>
        <div><dt>{t("shortcuts.extra.orbit")}<small>{t("shortcuts.extra.orbitContext")}</small></dt><dd><kbd>{t("shortcuts.extra.orbitKeys")}</kbd></dd></div>
        <div><dt>{t("shortcuts.extra.drawSolid")}<small>{t("shortcuts.extra.drawSolidContext")}</small></dt><dd><kbd>Enter</kbd></dd></div>
        <div><dt>{t("shortcuts.extra.base")}<small>{t("shortcuts.extra.baseContext")}</small></dt><dd><kbd>Esc</kbd></dd></div>
        <div><dt>{t("shortcuts.extra.select3d")}<small>{t("shortcuts.extra.viewportLocal")}</small></dt><dd><kbd>{t("shortcuts.extra.clickKeys")}</kbd></dd></div>
        <div><dt>{t("shortcuts.extra.cameras")}<small>{t("shortcuts.extra.camerasContext")}</small></dt><dd><kbd>0–6 · 8</kbd></dd></div>
        <div><dt>{t("shortcuts.extra.mainTabs")}<small>{t("shortcuts.extra.mainTabsContext")}</small></dt><dd><kbd>{t("shortcuts.extra.mainTabsKeys")}</kbd></dd></div>
        <div><dt>{t("shortcuts.extra.closeShown")}<small>{t("shortcuts.extra.closeShownContext")}</small></dt><dd><kbd>Delete · ×</kbd></dd></div>
        <div><dt>{t("shortcuts.extra.treeNav")}<small>{t("shortcuts.extra.treeLocal")}</small></dt><dd><kbd>↑ ↓ ← → · Enter · F2</kbd></dd></div>
        <div><dt>{t("shortcuts.extra.treeMulti")}<small>{t("shortcuts.extra.treeLocal")}</small></dt><dd><kbd>{t("shortcuts.extra.treeMultiKeys")}</kbd></dd></div>
      </dl></div>
      <div class="dialog-foot"><div class="dialog-actions"><button class="btn btn-primary" onClick={close}>{t("shortcuts.dialog.done")}</button></div></div>
    </div>
  </div></Portal>;
}
export function ShortcutHelp() { return <Show when={open()}><HelpDialog /></Show>; }
