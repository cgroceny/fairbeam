// The "Material library" dialog (ribbon, Model group): nominal values of common antenna materials
// with their source (src/designer/materials.ts). "Add" copies an entry's values into the design as
// a new material, so the design file stays self-contained; edit the copy in Properties.
import { For, onMount, Show } from "solid-js";
import { X } from "lucide-solid";
import { useModal } from "../lib/dialog";
import { MATERIAL_LIBRARY, type LibraryMaterial } from "./materials";
import { addLibraryMaterial, addUserMaterial, draft } from "./store";
import type { UserMaterial } from "./userMaterials";
import { ensureUserMaterials, userMaterials } from "./userMaterialsStore";
import { fmt, hasKey, t } from "../i18n";

// The library's texts in the UI language, by entry id (materials.ts keeps the English data that
// python/tests/fixtures/material_library.json pins; the material names written into designs stay).
const byId = (key: string, fallback: string) => (hasKey(key) ? t(key) : fallback);
export const libraryLabel = (m: LibraryMaterial) => byId(`materials.lib.${m.id}.label`, m.label);
export const libraryNote = (m: LibraryMaterial) => byId(`materials.lib.${m.id}.note`, m.note);
export const conductorLabel = (p: { id: string; label: string }) => byId(`materials.conductor.${p.id}`, p.label);
export const materialKindLabel = (kind: string) => byId(`materials.kind.${kind}`, kind);

const loss = (m: LibraryMaterial) =>
  m.kind === "metal" ? "" : `${fmt.num(m.tan_d ?? 0, 6)}${m.tan_d_freq !== null && m.tan_d_freq !== undefined ? ` @ ${fmt.num(m.tan_d_freq, 3)} GHz` : ""}`;

const userLoss = (m: UserMaterial) =>
  m.kind === "metal" ? (m.thickness !== undefined ? `${fmt.num(m.thickness, 4)} mm` : "") : `${fmt.num(m.tan_d ?? 0, 6)}${m.tan_d_freq !== undefined ? ` @ ${fmt.num(m.tan_d_freq, 3)} GHz` : ""}`;

export function MaterialLibraryDialog(props: { onClose: () => void; onManage?: () => void }) {
  let box: HTMLDivElement | undefined;
  useModal(() => box, props.onClose);
  onMount(() => { void ensureUserMaterials(); });
  /** design materials copied from an entry (by name), for the "in the design" hint */
  const inDesign = (id: string) => (draft.materials ?? []).filter((m) => m.library === id).map((m) => m.name);
  const add = (m: LibraryMaterial) => {
    addLibraryMaterial(m);
    props.onClose();
  };
  const addMine = (m: UserMaterial) => {
    addUserMaterial(m);
    props.onClose();
  };
  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="dialog dialog-sm dm-lib" role="dialog" aria-modal="true" aria-labelledby="ml-title" ref={box} tabindex={-1}>
        <div class="dialog-head">
          <div>
            <h2 id="ml-title">{t("materials.title")}</h2>
            <p class="muted">{t("materials.subtitle")}</p>
          </div>
          <button class="icon-btn" onClick={props.onClose} aria-label={t("common.close")}><X size={16} /></button>
        </div>
        <div class="dialog-body">
          <table class="table dm-lib-table">
            <thead>
              <tr><th scope="col">{t("materials.col.material")}</th><th scope="col">εr</th><th scope="col">tan δ</th><th scope="col"><span class="visually-hidden">{t("common.add")}</span></th></tr>
            </thead>
            <tbody>
              <tr class="dm-lib-group"><th scope="rowgroup" colspan="4">{t("materials.group.builtin")}</th></tr>
              <For each={MATERIAL_LIBRARY}>{(m) => (
                <tr>
                  <td>
                    <div class="dm-lib-name">{libraryLabel(m)} <span class="muted">{materialKindLabel(m.kind)}</span></div>
                    <div class="dm-lib-note">{libraryNote(m)}</div>
                    <Show when={inDesign(m.id).length}>
                      <div class="dm-lib-note">{t("materials.inDesign")} <span class="mono">{inDesign(m.id).join(", ")}</span>.</div>
                    </Show>
                  </td>
                  <td class="mono">{m.kind === "metal" ? "PEC" : `${fmt.num(m.eps_r ?? 1, 3)}${"mu_r" in m && m.mu_r !== undefined ? ` · μr ${fmt.num(m.mu_r as number, 3)}` : ""}`}</td>
                  <td class="mono">{loss(m)}</td>
                  <td><button class="btn btn-sm" onClick={() => add(m)} aria-label={t("materials.addEntry", { label: libraryLabel(m) })}>{t("common.add")}</button></td>
                </tr>
              )}</For>
              <tr class="dm-lib-group"><th scope="rowgroup" colspan="4">{t("materials.group.mine")}</th></tr>
              <Show when={!userMaterials().length}>
                <tr><td colspan="4" class="dm-lib-note">{t("materials.mine.empty")}</td></tr>
              </Show>
              <For each={userMaterials()}>{(m) => (
                <tr>
                  <td>
                    <div class="dm-lib-name">{m.name} <span class="muted">{materialKindLabel(m.kind)}</span></div>
                  </td>
                  <td class="mono">{m.kind === "metal" ? (m.conductivity !== undefined ? fmt.num(m.conductivity, 4) + " S/m" : "PEC") : `${fmt.num(m.eps_r ?? 1, 3)}${"mu_r" in m && m.mu_r !== undefined ? ` · μr ${fmt.num(m.mu_r as number, 3)}` : ""}`}</td>
                  <td class="mono">{userLoss(m)}</td>
                  <td><button class="btn btn-sm" onClick={() => addMine(m)} aria-label={t("materials.addEntry", { label: m.name })}>{t("common.add")}</button></td>
                </tr>
              )}</For>
            </tbody>
          </table>
        </div>
        <div class="dialog-foot">
          <span class="muted">{t("materials.lossNote")}</span>
          <div class="dialog-actions">
            <Show when={props.onManage}>
              <button class="btn" type="button" onClick={() => props.onManage?.()}>{t("materials.manageMine")}</button>
            </Show>
            <button class="btn btn-ghost" type="button" onClick={props.onClose}>{t("common.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
