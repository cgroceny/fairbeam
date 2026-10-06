import { For, Show, createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { X } from "lucide-solid";
import type { PickedFace } from "./faceAlign";
import { draft, edit, file, names, selectAddedGeometry } from "./store";
import { lastShapeMaterial, pickShapeMaterial, rememberShapeMaterial } from "./shapeMaterial";
import { tryEvaluate } from "./expr";
import { unique } from "./draw";
import { extrudeFace } from "./faceExtrude";
import { quickBundle } from "./geometry";
import { setPreviewGeometry } from "./transforms";
import { t } from "../i18n";
import { isReservedName } from "../lib/legacy";

export default function FaceExtrudeDialog() {
  const [face, setFace] = createSignal<PickedFace | null>(null);
  const [thickness, setThickness] = createSignal("0.035"), [name, setName] = createSignal("extrusion"), [material, setMaterial] = createSignal(""), [component, setComponent] = createSignal("");
  const [error, setError] = createSignal("");
  let opener: HTMLElement | null = null;
  let thicknessInput: HTMLInputElement | undefined;
  const close = () => { setFace(null); window.dispatchEvent(new CustomEvent("fairbeam:extrude-face-close")); opener?.focus(); };
  onMount(() => {
    const pick = (e: Event) => {
      const f = (e as CustomEvent<PickedFace>).detail;
      opener = document.activeElement as HTMLElement | null;
      setFace(f); setThickness(String(draft.params.find(p => /copper.*thick|thick.*copper|^(t_cu|cu_thickness|copper_thickness)$/i.test(p.key))?.key ?? "0.035"));
      setName(unique("extrusion", draft.parts.map(p => p.name)));
      // the metal used last, else an existing metal (e.g. copper), so repeated extrusions do not add copper2, copper3, …
      setMaterial(pickShapeMaterial(draft.materials, lastShapeMaterial(file()?.id), ""));
      setComponent(draft.parts.find(p => p.name === f.part)?.component ?? ""); setError("");
      thicknessInput?.focus();
    };
    window.addEventListener("fairbeam:extrude-face-pick", pick);
    const onKey = (e: KeyboardEvent) => {
      if (face() && e.key === "Escape") { e.preventDefault(); close(); }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("fairbeam:extrude-face-pick", pick);
      window.removeEventListener("keydown", onKey);
    });
  });
  // Live preview, the Transform dialog's pattern: the dashed outline of the new solid follows the
  // thickness, rebuilt once typing pauses (150 ms); it never touches the design until OK.
  const [previewNote, setPreviewNote] = createSignal("");
  createEffect(() => {
    const f = face(), thick = thickness();
    if (!f) { setPreviewGeometry([]); setPreviewNote(""); return; }
    const timer = setTimeout(() => untrack(() => {
      const evaluated = tryEvaluate(thick, names().names);
      const source = draft.parts.find(p => p.name === f.part);
      try {
        if (!source || evaluated.error || evaluated.value === undefined || !Number.isFinite(evaluated.value)) throw new Error("thickness");
        const material = draft.materials[0]?.name ?? "";
        const part = extrudeFace(f, source, thick.trim(), evaluated.value, "__extrusion", material, "");
        const built = quickBundle({ ...draft, ports: [], resistors: [], parts: [{ ...part, material }] }, names().names, null);
        setPreviewGeometry(built?.parts[0]?.primitives ?? []);
        setPreviewNote(built ? t("faceExtrude.preview.updated") : t("faceExtrude.preview.unavailable"));
      } catch { setPreviewGeometry([]); setPreviewNote(t("faceExtrude.preview.unavailable")); }
    }), 150);
    onCleanup(() => clearTimeout(timer));
  });
  onCleanup(() => setPreviewGeometry([]));
  const submit = () => {
    const f = face(); if (!f) return;
    const evaluated = tryEvaluate(thickness(), names().names);
    if (evaluated.error || evaluated.value === undefined || !Number.isFinite(evaluated.value)) { setError(evaluated.error || t("faceExtrude.error.thickness")); return; }
    const partName = name().trim();
    if (!partName || isReservedName(partName) || draft.parts.some(p => p.name === partName)) { setError(t("faceExtrude.error.name")); return; }
    const source = draft.parts.find(p => p.name === f.part);
    if (!source) { setError(t("faceExtrude.error.sourceGone")); return; }
    try {
      const newMetal = !material();
      const materialName = newMetal ? unique("copper", draft.materials.map(m => m.name)) : material();
      const result = extrudeFace(f, source, thickness().trim(), evaluated.value, partName, materialName, component().trim());
      const index = draft.parts.length;
      edit(d => { if (newMetal) d.materials.push({ name: materialName, kind: "metal" }); d.parts.push(result); }, "", t("faceExtrude.title"));
      rememberShapeMaterial(file()?.id, materialName);
      selectAddedGeometry({ type: "part", i: index }); close();
    } catch (e) { setError((e as Error).message); }
  };
  /** "Face of <part>" around the bold part name */
  const faceOf = () => t("faceExtrude.faceOf", { part: "\u0001" }).split("\u0001");
  return <Show when={face()}>{f => <div class="dm-face-extrude" role="dialog" aria-label={t("faceExtrude.title")}>
    <header>
      <strong>{t("faceExtrude.title")}</strong>
      <button class="icon-btn" onClick={close} aria-label={t("common.close")}><X size={16} /></button>
    </header>
    <p>{faceOf()[0]}<b>{f().part}</b>{faceOf()[1]} · {t("faceExtrude.axis")} {"xyz"[f().axis]} {f().sign > 0 ? "+" : "−"}</p>
    <label>{t("faceExtrude.thickness")}<input autocomplete="off" ref={thicknessInput} class="rp-input" value={thickness()} onInput={e => setThickness(e.currentTarget.value)} /></label>
    <label>{t("faceExtrude.material")}
      <select class="rp-select" value={material()} onChange={e => setMaterial(e.currentTarget.value)}>
        <option value="">{t("faceExtrude.newMetal")}</option>
        <For each={draft.materials}>{m => <option value={m.name}>{m.name}</option>}</For>
      </select>
    </label>
    <label>{t("faceExtrude.name")}<input autocomplete="off" class="rp-input" value={name()} onInput={e => setName(e.currentTarget.value)} /></label>
    <label>{t("faceExtrude.component")}<input autocomplete="off" class="rp-input" value={component()} onInput={e => setComponent(e.currentTarget.value)} /></label>
    <Show when={previewNote() && !error()}><p class="note" role="status">{previewNote()}</p></Show>
    <Show when={error()}><p class="dm-face-error" role="alert">{error()}</p></Show>
    <footer>
      <button class="btn btn-ghost btn-sm" onClick={close}>{t("common.cancel")}</button>
      <button class="btn btn-primary btn-sm" onClick={submit}>{t("common.ok")}</button>
    </footer>
  </div>}</Show>;
}
