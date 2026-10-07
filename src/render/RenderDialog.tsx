// "Render image…": pictures of the design from several angles, drawn offscreen with physically based
// materials and saved into the workspace folder renders/<design-id>/.
//
// Lazy-loaded (App.tsx) when the dialog is first opened; the renderer itself (capture.ts) is loaded
// again lazily when Render is pressed.
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { Aperture, Copy, Download, FolderOpen, X } from "lucide-solid";
import { appMode } from "../workspace";
import { bundle } from "../state";
import { draft, file as designFile } from "../designer/store";
import { useModal } from "../lib/dialog";
import NumberField from "../components/NumberField";
import { t } from "../i18n";
import {
  MAX_SIDE, MIN_SIDE, RENDER_ANGLES, RENDER_BACKGROUNDS, RENDER_PORTS, RENDER_QUALITIES, RESOLUTION_PRESETS,
  parseRenderSide, renderFileName, renderFolder, resolutionPreset, supersampling, type RenderAngle,
} from "./options.ts";
import { currentViewState, renderOptions, setRenderBusy, setRenderDialogOpen, setRenderOptions } from "./state.ts";
import { hiddenParts } from "../state";
import { copyImageToClipboard, folderOf, openRendersFolder, saveRenderFile } from "./files.ts";
import { downloadMessage, saveDownload } from "../lib/download";
import type { Design } from "../designer/types";
import { BLENDER_QUALITIES, type BlenderQuality, type BlenderRenderProgress } from "./blender.ts";
import { blenderBusy } from "./blenderStore.ts";
import BlenderRenderPanel from "./BlenderRenderPanel";

// Engine "Blender": the panel (BlenderRenderPanel) starts the render on the server and follows it; the dialog owns the
// options, the quality (Blender's preview / final) and the .blend choice, and lists the finished pictures with the app's.
const [blenderQuality, setBlenderQuality] = createSignal<BlenderQuality>("preview");
const [saveBlend, setSaveBlend] = createSignal(true);

interface Result { id: number; angle: RenderAngle; name: string; url: string; blob?: Blob; path?: string; via: string; size: string }
const [results, setResults] = createSignal<Result[]>([]);
let nextId = 1;
const MAX_KEPT = 24;

export default function RenderDialog() {
  let box: HTMLDivElement | undefined;
  const close = () => { if (!busy()) setRenderDialogOpen(false); };
  const [busy, setBusy] = createSignal(false);
  const [progress, setProgress] = createSignal("");
  const [error, setError] = createSignal("");
  const [note, setNote] = createSignal("");
  const [custom, setCustom] = createSignal(resolutionPreset(renderOptions.width, renderOptions.height) === "custom");
  // the custom size as typed: a value outside MIN_SIDE…MAX_SIDE is shown with the range and blocks the render, never
  // replaced by another size behind the viewer's back
  const [sizeText, setSizeText] = createStore({ width: String(renderOptions.width), height: String(renderOptions.height) });
  const sizeError = (key: "width" | "height") => custom() && "error" in parseRenderSide(sizeText[key]);
  const sizeBlocked = () => sizeError("width") || sizeError("height");
  const sizeMessage = () => t("render.size.range", { min: MIN_SIDE, max: MAX_SIDE });
  let controller: AbortController | undefined;
  useModal(() => box, close);
  onCleanup(() => controller?.abort());

  const designId = () => (appMode() === "design" ? designFile()?.id ?? draft.model.id : bundle()?.model.id) || "design";
  const preset = () => (custom() ? "custom" : resolutionPreset(renderOptions.width, renderOptions.height));
  const factor = () => supersampling(renderOptions);
  const toggleAngle = (angle: RenderAngle) => {
    const on = renderOptions.angles.includes(angle);
    if (on && renderOptions.angles.length === 1) return; // at least one angle
    setRenderOptions({ angles: on ? renderOptions.angles.filter((a) => a !== angle) : [...renderOptions.angles, angle] });
  };
  const locked = () => busy() || blenderBusy();
  createEffect(() => setRenderBusy(locked()));
  onCleanup(() => setRenderBusy(false));
  const isBlender = () => renderOptions.engine === "blender";
  // the design for the Blender look (material names), and the geometry without the parts hidden in the tree
  const designNow = (): Design | null => (appMode() === "design" ? (unwrap(draft) as Design) : null);
  const visibleBundle = createMemo(() => {
    const b = bundle();
    return b && b.parts.some((part) => hiddenParts[part.name]) ? { ...b, parts: b.parts.filter((part) => !hiddenParts[part.name]) } : b;
  });
  const blenderFinished = (result: BlenderRenderProgress) => {
    if (result.status !== "done") return;
    addResults(result.images.map((image) => ({ id: nextId++, angle: image.angle as RenderAngle, name: image.name, url: image.url, path: image.path, via: "workspace",
      size: `${renderOptions.width}×${renderOptions.height} · Blender` })));
    const folder = result.folder || (result.images[0]?.path ? folderOf(result.images[0].path) : renderFolder(designId()));
    setNote(t("render.done", { count: result.images.length, folder }));
  };
  const count = () => renderOptions.angles.length;

  const addResults = (list: Result[]) => {
    setResults((old) => {
      const merged = [...list, ...old];
      for (const dropped of merged.slice(MAX_KEPT)) if (dropped.blob) URL.revokeObjectURL(dropped.url);
      return merged.slice(0, MAX_KEPT);
    });
  };

  const run = async () => {
    const source = bundle();
    if (!source || busy() || sizeBlocked()) return;
    setBusy(true); setError(""); setNote("");
    controller = new AbortController();
    const options = { angles: [...renderOptions.angles], width: renderOptions.width, height: renderOptions.height, background: renderOptions.background,
      ports: renderOptions.ports, solderMask: renderOptions.solderMask, groundShadow: renderOptions.groundShadow, projection: renderOptions.projection,
      engine: renderOptions.engine, quality: renderOptions.quality };
    const stamp = new Date();
    const id = designId();
    try {
      {
        const { captureImages } = await import("./capture");
        const images = await captureImages({ bundle: source, options, view: currentViewState(), hidden: new Set(Object.keys(hiddenParts).filter((name) => hiddenParts[name])), signal: controller.signal,
          onProgress: (done, total, angle) => { if (done < total) setProgress(t("render.progress", { done: done + 1, total, angle: t(`render.angle.${angle}`) })); } });
        const saved: Result[] = [];
        for (const image of images) {
          setProgress(t("render.saving", { angle: t(`render.angle.${image.angle}`) }));
          const file = await saveRenderFile(id, renderFileName(id, image.angle, stamp), image.blob);
          saved.push({ id: nextId++, angle: image.angle, name: file.name, url: URL.createObjectURL(image.blob), blob: image.blob, path: file.path, via: file.via,
            size: `${image.width}×${image.height}${image.factor > 1 ? ` · ${image.factor}×` : ""}` });
        }
        addResults(saved);
        const folder = saved[0]?.path ? folderOf(saved[0].path) : renderFolder(id);
        setNote(t("render.done", { count: saved.length, folder }));
      }
    } catch (e) {
      if ((e as Error)?.name === "AbortError" || (e as Error)?.message === "cancelled") setNote(t("render.cancelled"));
      else { console.error(e); setError(t("render.error.failed", { error: e instanceof Error ? e.message : String(e) })); }
    } finally {
      setBusy(false); setProgress(""); controller = undefined;
    }
  };

  const copy = async (r: Result) => {
    let blob = r.blob;
    if (!blob && r.url) { try { blob = await (await fetch(r.url)).blob(); } catch { blob = undefined; } } // a Blender picture: read back from the renders folder
    setNote(blob && (await copyImageToClipboard(blob)) ? t("render.copy.done", { name: r.name }) : t("render.copy.failed"));
  };
  /** Save a picture with the browser (or the desktop's Save dialog): the PNG of the card, from memory or the server. */
  const download = async (r: Result) => {
    setError("");
    try {
      const blob = r.blob ?? await (await fetch(r.url)).blob();
      setNote(downloadMessage(await saveDownload(r.name, blob, "image/png")));
    } catch (e) { setError(t("render.download.failed", { name: r.name, error: e instanceof Error ? e.message : String(e) })); }
  };
  const openFolder = async () => {
    setError("");
    try {
      const dir = await openRendersFolder(designId());
      setNote(t("render.folder.opened", { folder: dir }));
    } catch (e) { setError(t("render.folder.failed", { error: e instanceof Error ? e.message : String(e) })); }
  };
  const sizeInput = (key: "width" | "height") => (e: Event & { currentTarget: HTMLInputElement }) => {
    setSizeText(key, e.currentTarget.value);
    const r = parseRenderSide(e.currentTarget.value);
    if ("value" in r) setRenderOptions({ [key]: r.value });
  };
  // on leaving the field it shows the size that will be used (a decimal rounded); an invalid entry stays, with its error
  const sizeBlur = (key: "width" | "height") => () => {
    const r = parseRenderSide(sizeText[key]);
    if ("value" in r) setSizeText(key, String(r.value));
  };
  const hasResults = createMemo(() => results().length > 0);

  const seg = <T extends string>(label: string, values: readonly T[], current: () => T, set: (v: T) => void, text: (v: T) => string, dataKey: string, disabled?: (v: T) => boolean) => (
    <div class="field render-field"><span>{label}</span>
      <div class="seg" role="radiogroup" aria-label={label}>
        <For each={values}>{(v) =>
          <button type="button" class="seg-btn" role="radio" aria-checked={current() === v} classList={{ active: current() === v }} disabled={locked() || disabled?.(v)} data-render={`${dataKey}:${v}`}
            onClick={() => set(v)}>{text(v)}</button>}</For>
      </div>
    </div>
  );

  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="dialog render-dialog" role="dialog" aria-modal="true" aria-labelledby="render-title" aria-describedby="render-desc" tabindex={-1} ref={box}>
        <header class="dialog-head">
          <div>
            <h2 id="render-title">{t("render.dialog.title")}</h2>
            <p class="muted" id="render-desc">{t("render.dialog.description")}</p>
          </div>
          <button class="icon-btn" onClick={close} disabled={locked()} aria-label={t("common.close")}><X size={16} aria-hidden="true" /></button>
        </header>
        <div class="dialog-body render-body">
          <div class="export-options render-options">
            <fieldset class="render-angles">
              <legend>{t("render.angles.label")}</legend>
              <For each={RENDER_ANGLES}>{(angle) =>
                <label class="render-angle" classList={{ on: renderOptions.angles.includes(angle) }}>
                  <input type="checkbox" checked={renderOptions.angles.includes(angle)} disabled={locked()} data-render-angle={angle} onChange={() => toggleAngle(angle)} />
                  {t(`render.angle.${angle}`)}
                </label>}</For>
            </fieldset>
            <label class="field render-field"><span>{t("render.size.label")}</span>
              <select value={preset()} disabled={locked()} data-render="size" onChange={(e) => {
                const id = e.currentTarget.value;
                const p = RESOLUTION_PRESETS.find((x) => x.id === id);
                setCustom(!p);
                if (p) setRenderOptions({ width: p.width, height: p.height });
                setSizeText({ width: String(renderOptions.width), height: String(renderOptions.height) });
              }}>
                <For each={RESOLUTION_PRESETS}>{(p) => <option value={p.id}>{p.width}×{p.height}</option>}</For>
                <option value="custom">{t("render.size.custom")}</option>
              </select>
            </label>
            <Show when={custom()}>
              <div class="render-custom">
                <label class="field"><span>{t("render.size.width")}</span>
                  <NumberField value={sizeText.width} min={MIN_SIDE} max={MAX_SIDE} step={1} disabled={locked()} data-render="width" aria-invalid={sizeError("width")}
                    aria-describedby={sizeBlocked() ? "render-size-error" : undefined} onInput={sizeInput("width")} onBlur={sizeBlur("width")} /></label>
                <label class="field"><span>{t("render.size.height")}</span>
                  <NumberField value={sizeText.height} min={MIN_SIDE} max={MAX_SIDE} step={1} disabled={locked()} data-render="height" aria-invalid={sizeError("height")}
                    aria-describedby={sizeBlocked() ? "render-size-error" : undefined} onInput={sizeInput("height")} onBlur={sizeBlur("height")} /></label>
                <Show when={sizeBlocked()}><span id="render-size-error" class="rp-error render-size-error" role="alert">{sizeMessage()}</span></Show>
              </div>
            </Show>
            {seg(t("render.background.label"), RENDER_BACKGROUNDS, () => renderOptions.background, (background) => setRenderOptions({ background }), (v) => t(`render.background.${v}`), "background")}
            {seg(t("render.ports.label"), RENDER_PORTS, () => renderOptions.ports, (ports) => setRenderOptions({ ports }), (v) => t(`render.ports.${v}`), "ports")}
            {seg(t("render.mask.field"), ["none", "green"] as const, () => renderOptions.solderMask, (solderMask) => setRenderOptions({ solderMask }), (v) => t(`render.mask.${v}`), "mask")}
            {seg(t("render.projection.label"), ["perspective", "orthographic"] as const, () => renderOptions.projection, (projection) => setRenderOptions({ projection }), (v) => t(`render.projection.${v}`), "projection")}
            <label class="render-check"><input type="checkbox" checked={renderOptions.groundShadow} disabled={locked()} data-render="shadow" onChange={(e) => setRenderOptions({ groundShadow: e.currentTarget.checked })} /> {t("render.shadow.field")}</label>
            <Show when={!isBlender()} fallback={
              <label class="field render-field"><span>{t("render.quality.label")}</span>
                <select value={blenderQuality()} disabled={locked()} data-render="blender-quality" onChange={(e) => setBlenderQuality(e.currentTarget.value as BlenderQuality)}>
                  <For each={BLENDER_QUALITIES}>{(q) => <option value={q}>{t(`render.blender.quality.${q}`)}</option>}</For>
                </select>
                <span class="rp-hint">{t("render.quality.blenderHint")}</span>
              </label>}>
              <label class="field render-field"><span>{t("render.quality.label")}</span>
                <select value={renderOptions.quality} disabled={locked()} data-render="quality" onChange={(e) => setRenderOptions({ quality: e.currentTarget.value as typeof renderOptions.quality })}>
                  <For each={RENDER_QUALITIES}>{(q) => <option value={q}>{t(`render.quality.${q}`)}</option>}</For>
                </select>
                <span class="rp-hint">{t("render.quality.hint", { w: renderOptions.width, h: renderOptions.height, factor: factor() })}</span>
              </label>
            </Show>
            {seg(t("render.engine.label"), ["app", "blender"] as const, () => renderOptions.engine, (engine) => setRenderOptions({ engine }), (v) => t(`render.engine.${v}`), "engine")}
            <Show when={isBlender()}>
              <label class="render-check"><input type="checkbox" checked={saveBlend()} disabled={locked()} data-render="save-blend" onChange={(e) => setSaveBlend(e.currentTarget.checked)} /> {t("render.blender.saveBlend")}</label>
            </Show>
          </div>
          <div class="render-results" aria-live="polite">
            <Show when={isBlender()}>
              <BlenderRenderPanel design={designNow()} designId={designId()} bundle={visibleBundle() ?? undefined} view={currentViewState()}
                options={renderOptions} quality={blenderQuality()} saveBlend={saveBlend()} onFinished={blenderFinished} blocked={sizeBlocked() ? sizeMessage() : undefined} />
            </Show>
            <Show when={hasResults()} fallback={<p class="muted render-empty">{t("render.results.empty")}</p>}>
              <ul class="render-grid">
                <For each={results()}>{(r) =>
                  <li class="render-card" data-render-result={r.angle}>
                    <div class="render-thumb"><img src={r.url} alt={t("render.results.alt", { angle: t(`render.angle.${r.angle}`), name: r.name })} loading="lazy" decoding="async" /></div>
                    <div class="render-meta">
                      <span class="render-name" title={r.path ?? r.name}>{r.name}</span>
                      <span class="muted">{t(`render.angle.${r.angle}`)} · {r.size}</span>
                      <Show when={r.path}><span class="muted render-path" title={r.path}>{r.path}</span></Show>
                    </div>
                    <div class="render-card-actions">
                      <button class="btn btn-ghost btn-sm" data-action="render-download" onClick={() => void download(r)}><Download size={14} aria-hidden="true" /> {t("render.download.label")}</button>
                      <button class="btn btn-ghost btn-sm" onClick={() => void copy(r)}><Copy size={14} aria-hidden="true" /> {t("render.copy.label")}</button>
                    </div>
                  </li>}</For>
              </ul>
            </Show>
          </div>
        </div>
        <footer class="dialog-foot">
          <span class="muted" role="status">{error() ? "" : progress() || note()}</span>
          <Show when={error()}><span class="rp-error" role="alert">{error()}</span></Show>
          <div class="dialog-actions">
            <button class="btn btn-ghost" onClick={() => void openFolder()} data-action="render-open-folder"><FolderOpen size={14} aria-hidden="true" /> {t("render.folder.open")}</button>
            <Show when={busy()} fallback={<button class="btn btn-ghost" onClick={close}>{t("common.close")}</button>}>
              <button class="btn btn-ghost" onClick={() => controller?.abort()}>{t("common.cancel")}</button>
            </Show>
            <Show when={!isBlender()}>
              <button class="btn btn-primary" disabled={locked() || !bundle() || sizeBlocked()} title={sizeBlocked() ? sizeMessage() : undefined} data-action="render-go" onClick={() => void run()}>
                <Aperture size={14} aria-hidden="true" /> {busy() ? t("render.rendering") : t("render.go", { count: count() })}
              </button>
            </Show>
          </div>
        </footer>
      </div>
    </div>
  );
}
