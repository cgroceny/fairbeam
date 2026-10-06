// The "My materials" dialog: rename, edit, delete, import and export the user's own material
// library (userMaterials.ts). Adding an entry to a design is in the Material library dialog; saving
// one from a design is in the tree's context menu and Properties.
import { createSignal, For, Show, onMount } from "solid-js";
import { Download, Trash2, Upload, X } from "lucide-solid";
import { useModal } from "../lib/dialog";
import { requestDownload } from "../lib/download";
import { t } from "../i18n";
import { cleanUserMaterial, type UserMaterial } from "./userMaterials";
import { commitUserMaterials, importUserMaterialsText, refreshUserMaterials, userMaterials, userMaterialsJson, userMaterialsWarnings, userMaterialsWhere } from "./userMaterialsStore";
import { materialKindLabel } from "./MaterialLibrary";

type NumKey = "mu_r" | "eps_r" | "tan_d" | "tan_d_freq" | "conductivity" | "thickness";

export function UserMaterialsDialog(props: { onClose: () => void }) {
  let box: HTMLDivElement | undefined;
  let chooser: HTMLInputElement | undefined;
  useModal(() => box, props.onClose);
  const [error, setError] = createSignal("");
  const [note, setNote] = createSignal("");
  onMount(() => { void refreshUserMaterials(); });

  /** Apply a change to one entry; an invalid value (or a name in use) is refused and the field reverts. */
  const change = (m: UserMaterial, patch: Partial<UserMaterial>, revert: () => void) => {
    const next = { ...m, ...patch };
    for (const k of Object.keys(next) as (keyof UserMaterial)[]) if (next[k] === undefined) delete next[k];
    const res = cleanUserMaterial(next);
    if ("why" in res) { setError(`${m.name}: ${res.why}`); revert(); return; }
    if (userMaterials().some((q) => q.id !== m.id && q.name === res.entry.name)) { setError(t("props.error.usedTwice")); revert(); return; }
    setError("");
    void commitUserMaterials(userMaterials().map((q) => (q.id === m.id ? res.entry : q)));
  };
  const setNum = (m: UserMaterial, key: NumKey, el: HTMLInputElement) => {
    const text = el.value.trim();
    const was = m[key];
    const revert = () => { el.value = was === undefined ? "" : String(was); };
    if (!text) {
      if (key === "eps_r") { setError(`${m.name}: εr`); revert(); return; }
      change(m, { [key]: key === "tan_d" ? 0 : undefined }, revert);
      return;
    }
    const v = Number(text);
    if (!Number.isFinite(v)) { setError(`${m.name}: ${text}`); revert(); return; }
    change(m, { [key]: v }, revert);
  };
  const numField = (m: UserMaterial, key: NumKey, label: string, placeholder = "") => (
    <input autocomplete="off" class="rp-input dz-input mono" type="text" inputmode="decimal" aria-label={`${m.name}: ${label}`} placeholder={placeholder}
      value={m[key] === undefined ? "" : String(m[key])} onChange={(e) => setNum(m, key, e.currentTarget)} />
  );
  const remove = (m: UserMaterial) => { setError(""); void commitUserMaterials(userMaterials().filter((q) => q.id !== m.id)); };

  const doExport = () => {
    requestDownload("my-materials.json", userMaterialsJson(), "application/json");
  };
  const doImport = async (file: File | undefined) => {
    if (!file) return;
    const r = await importUserMaterialsText(await file.text());
    setNote(t("userMaterials.imported", { count: r.added }));
    if (chooser) chooser.value = "";
  };

  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="dialog dm-lib" role="dialog" aria-modal="true" aria-labelledby="um-title" ref={box} tabindex={-1}>
        <div class="dialog-head">
          <div>
            <h2 id="um-title">{t("userMaterials.title")}</h2>
            <p class="muted">{t("userMaterials.subtitle")}</p>
          </div>
          <button class="icon-btn" onClick={props.onClose} aria-label={t("common.close")}><X size={16} /></button>
        </div>
        <div class="dialog-body">
          <Show when={userMaterials().length} fallback={<p class="muted">{t("userMaterials.empty")}</p>}>
            <table class="table dm-lib-table">
              <thead>
                <tr>
                  <th scope="col">{t("userMaterials.col.name")}</th><th scope="col">εr / σ (S/m)</th><th scope="col">tan δ / {t("props.material.thickness")} (mm)</th>
                  <th scope="col">{t("userMaterials.col.freq")}</th><th scope="col"><span class="visually-hidden">{t("common.delete")}</span></th>
                </tr>
              </thead>
              <tbody>
                <For each={userMaterials()}>{(m) => (
                  <tr>
                    <td>
                      <input autocomplete="off" class="rp-input dz-input" type="text" aria-label={t("userMaterials.rename", { name: m.name })} value={m.name}
                        onChange={(e) => change(m, { name: e.currentTarget.value }, () => { e.currentTarget.value = m.name; })} />
                      <div class="dm-lib-note">{materialKindLabel(m.kind)}</div>
                    </td>
                    <Show when={m.kind === "dielectric"} fallback={<>
                      <td>{numField(m, "conductivity", t("props.material.conductivity"), "PEC")}</td>
                      <td>{m.conductivity !== undefined ? numField(m, "thickness", t("props.material.thickness"), "0.035") : null}</td>
                      <td />
                    </>}>
                      <td>{numField(m, "eps_r", "εr")}{numField(m, "mu_r", "μr", "μr = 1")}</td>
                      <td>{numField(m, "tan_d", "tan δ")}</td>
                      <td>{numField(m, "tan_d_freq", t("props.material.tanDFreq"), "GHz")}</td>
                    </Show>
                    <td><button class="icon-btn" onClick={() => remove(m)} aria-label={t("userMaterials.delete", { name: m.name })} title={t("common.delete")}><Trash2 size={15} /></button></td>
                  </tr>
                )}</For>
              </tbody>
            </table>
          </Show>
          <Show when={error()}><p class="dz-value dz-bad" role="alert">{error()}</p></Show>
          <Show when={note()}><p class="muted" role="status">{note()}</p></Show>
          <Show when={userMaterialsWarnings().length}>
            <div class="note" role="status">
              <b>{t("userMaterials.skipped", { count: userMaterialsWarnings().length })}</b>
              <ul><For each={userMaterialsWarnings().slice(0, 8)}>{(w) => <li>{w}</li>}</For></ul>
            </div>
          </Show>
        </div>
        <div class="dialog-foot">
          <span class="muted">{t(userMaterialsWhere() === "server" ? "userMaterials.whereServer" : "userMaterials.whereBrowser")}</span>
          <div class="dialog-actions">
            <input ref={chooser} type="file" accept=".json,application/json" class="visually-hidden" tabindex={-1} aria-hidden="true"
              onChange={(e) => { void doImport(e.currentTarget.files?.[0]); }} />
            <button class="btn" type="button" onClick={() => chooser?.click()}><Upload size={14} /> {t("userMaterials.import")}</button>
            <button class="btn" type="button" disabled={!userMaterials().length} onClick={doExport}><Download size={14} /> {t("userMaterials.export")}</button>
            <button class="btn btn-ghost" type="button" onClick={props.onClose}>{t("common.close")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
