import { For, Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { X } from "lucide-solid";
import { useModal } from "../lib/dialog";
import { SHORTCUTS } from "./shortcuts";
import { shortcutSheet, type ExtraId } from "./shortcutSheet";
import { health } from "../runner/store";
import { t } from "../i18n";

const [open, setOpen] = createSignal(false);
export const showShortcutHelp = () => setOpen(true);

/** the rows that are not in the shortcut table: gestures and keys local to a tool, a tab or the tree */
function extras(): Record<ExtraId, { label: string; context: string; key: string }> {
  return {
    applyBoolean: { label: t("shortcuts.extra.applyBoolean"), context: t("shortcuts.extra.applyBooleanContext"), key: "Enter" },
    drawSolid: { label: t("shortcuts.extra.drawSolid"), context: t("shortcuts.extra.drawSolidContext"), key: "Enter" },
    base: { label: t("shortcuts.extra.base"), context: t("shortcuts.extra.baseContext"), key: "Esc" },
    cameras: { label: t("shortcuts.extra.cameras"), context: t("shortcuts.extra.camerasContext"), key: "0–6 · 8" },
    mainTabsLocal: { label: t("shortcuts.extra.mainTabs"), context: t("shortcuts.extra.mainTabsContext"), key: t("shortcuts.extra.mainTabsKeys") },
    closeShown: { label: t("shortcuts.extra.closeShown"), context: t("shortcuts.extra.closeShownContext"), key: "Delete · ×" },
    orbit: { label: t("shortcuts.extra.orbit"), context: t("shortcuts.extra.orbitContext"), key: t("shortcuts.extra.orbitKeys") },
    select3d: { label: t("shortcuts.extra.select3d"), context: t("shortcuts.extra.viewportLocal"), key: t("shortcuts.extra.clickKeys") },
    treeNav: { label: t("shortcuts.extra.treeNav"), context: t("shortcuts.extra.treeLocal"), key: "↑ ↓ ← → · Enter · F2" },
    treeMulti: { label: t("shortcuts.extra.treeMulti"), context: t("shortcuts.extra.treeLocal"), key: t("shortcuts.extra.treeMultiKeys") },
  };
}

function HelpDialog() {
  let box!: HTMLDivElement;
  const close = () => setOpen(false);
  useModal(() => box, close);
  // grouped (Edit, View, Panels, Tools, Boolean, Mouse), the common commands first; in the browser the
  // chords it keeps for itself (Ctrl+T, Ctrl+W, Ctrl+Tab) are marked "desktop app only"
  const groups = () => shortcutSheet(SHORTCUTS, extras(), !!health()?.desktop);
  return <Portal><div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
    <div ref={box} class="dialog shortcut-help-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title" tabindex="-1">
      <div class="dialog-head"><div><h2 id="shortcut-help-title">{t("shortcuts.dialog.title")}</h2><p>{t("shortcuts.dialog.intro")}</p></div>
        <button class="icon-btn" aria-label={t("common.close")} onClick={close}><X size={16} /></button></div>
      <div class="dialog-body">
        <For each={groups()}>{(g) => (
          <section class="shortcut-group" aria-labelledby={`shortcut-group-${g.group}`}>
            <h3 class="shortcut-group-title" id={`shortcut-group-${g.group}`}>{t(`shortcuts.group.${g.group}`)}</h3>
            <dl class="shortcut-list">
              <For each={g.rows}>{(row) => (
                <div classList={{ "shortcut-desktop-only": row.desktopOnly }} data-shortcut={row.id}>
                  <dt>{row.label}<small>{row.context}</small></dt>
                  <dd><kbd>{row.key}</kbd>
                    <Show when={row.desktopOnly}><span class="shortcut-note" title={t("shortcuts.desktopOnly.title")}>{t("shortcuts.desktopOnly")}</span></Show>
                  </dd>
                </div>
              )}</For>
            </dl>
          </section>
        )}</For>
      </div>
      <div class="dialog-foot"><div class="dialog-actions"><button class="btn btn-primary" onClick={close}>{t("shortcuts.dialog.done")}</button></div></div>
    </div>
  </div></Portal>;
}
export function ShortcutHelp() { return <Show when={open()}><HelpDialog /></Show>; }
