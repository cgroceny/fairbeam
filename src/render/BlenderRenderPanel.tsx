// "Render with Blender" panel: start, follow, cancel and look at a Blender render of a design, inside the app.
// Self-contained and lazy-loadable (nothing of it is in the startup bundle):
//
//   const Panel = lazy(() => import("../render/BlenderRenderPanel"));
//   <Panel design={design} options={options} bundle={liveBundle} />
//
// The render runs on the run server in the background (Blender with -b; no window, no add-on); the panel only follows
// it, so the designer stays usable, closing the dialog does not stop the render, and the panel shows the running or
// last render again when it is opened (blenderStore.ts). Every image appears as soon as Blender has written it.
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { CircleAlert, CircleCheck, Download, ExternalLink, FolderOpen, LoaderCircle, Maximize2, Play, Square, X } from "lucide-solid";
import type { Bundle } from "../types";
import type { Design } from "../designer/types";
import { renderFolderId, type RenderOptions } from "./options.ts";
import type { ViewState } from "./frame.ts";
import { t } from "../i18n";
import { useModal } from "../lib/dialog";
import { readGeneralSettings } from "../lib/generalSettings";
import { downloadMessage, saveDownloadUrl } from "../lib/download";
import {
  detectBlender, openBlendInBlender, openBlenderDownload, openRenderFolder, blenderFileUrl,
  type BlenderImage, type BlenderInfo, type BlenderQuality, type BlenderRenderProgress,
} from "./blender.ts";
import { blenderBusy, blenderFailure, blenderProgress, cancelBlenderRender, startBlenderRender } from "./blenderStore.ts";
import "../styles/blender-render.css";

export interface BlenderRenderPanelProps {
  /** the design to render (its model id names the renders/<id>/ folder); null for a bundle opened without a design */
  design: Design | null;
  /** the render options of the Render image dialog (the engine is Blender whatever `options.engine` says) */
  options: RenderOptions;
  /** the design id the pictures are filed under (renders/<id>/): the dialog's, so both engines share the folder */
  designId?: string;
  /** the viewer's live camera, read when the render starts: the "current" angle */
  view?: ViewState | null;
  /** preview (the default, Cycles 32 samples) or final (256 samples) */
  quality?: BlenderQuality;
  /** the design's geometry; when omitted the server builds it (POST /api/preview) from `design` */
  bundle?: Bundle;
  /** start at once when the panel opens (the host's own Render button already asked for it) */
  autoStart?: boolean;
  /** also keep the scene as a .blend next to the images (default true) */
  saveBlend?: boolean;
  /** "auto" (a GPU when Cycles finds one), "cpu" or "gpu" */
  device?: "auto" | "cpu" | "gpu";
  /** called once when a render this panel started has finished (status done, failed or cancelled) */
  onFinished?: (result: BlenderRenderProgress) => void;
  /** why a render cannot start now (an invalid size in the dialog): the Start button is disabled with this reason */
  blocked?: string;
}

const STAGES: Record<string, string> = {
  starting: "render.blender.stage.starting", import: "render.blender.stage.import", materials: "render.blender.stage.materials",
  ports: "render.blender.stage.ports", rendering: "render.blender.stage.rendering", denoising: "render.blender.stage.denoising",
  done: "render.blender.stage.done",
};

function Lightbox(props: { image: BlenderImage; close: () => void; checker: boolean }) {
  let box!: HTMLDivElement;
  useModal(() => box, props.close);
  return <div class="scrim blr-lightbox" onClick={e => e.target === e.currentTarget && props.close()}>
    <div class="blr-lightbox-box" role="dialog" aria-modal="true" aria-label={props.image.name} tabindex={-1} ref={box}>
      <button class="icon-btn blr-lightbox-close" onClick={props.close} aria-label={t("common.close")}><X size={16} aria-hidden="true" /></button>
      <div class="blr-lightbox-img" classList={{ "blr-checker": props.checker }}><img src={props.image.url} alt={props.image.name} /></div>
      <p class="mono blr-lightbox-name">{props.image.name}</p>
    </div>
  </div>;
}

export default function BlenderRenderPanel(props: BlenderRenderPanelProps) {
  const [info, setInfo] = createSignal<BlenderInfo | null>(null);
  const [detecting, setDetecting] = createSignal(true);
  const [selected, setSelected] = createSignal(0);
  const [zoom, setZoom] = createSignal<BlenderImage | null>(null);
  const [note, setNote] = createSignal<{ text: string; warn: boolean } | null>(null);
  const configuredPath = () => readGeneralSettings().blenderPath.trim();
  let alive = true;
  let reported: string | null = null;
  let startedHere = false;
  onCleanup(() => { alive = false; });

  const detect = async () => {
    setDetecting(true);
    try { const r = await detectBlender(configuredPath()); if (alive) setInfo(r); }
    catch { if (alive) setInfo(null); }
    finally { if (alive) setDetecting(false); }
  };
  const start = async () => {
    setNote(null);
    setSelected(0);
    startedHere = true;
    await startBlenderRender({ ...props.options, engine: "blender" }, props.design, {
      bundle: props.bundle, designId: props.designId, view: props.view, quality: props.quality, saveBlend: props.saveBlend ?? true, device: props.device, blenderPath: configuredPath() || undefined,
    });
  };
  onMount(async () => {
    await detect();
    if (props.autoStart && info()?.ok && !blenderBusy() && !blenderProgress()) void start();
  });

  // the newest image is shown as it arrives
  createEffect(() => { const n = blenderProgress()?.images.length ?? 0; if (n) setSelected(n - 1); });
  createEffect(() => {
    const x = blenderProgress();
    // only a render this panel started is reported (a finished one found again on open is not announced twice)
    if (startedHere && x && ["done", "failed", "cancelled"].includes(x.status) && reported !== x.id) {
      reported = x.id;
      props.onFinished?.(x);
    }
  });

  // transparent PNGs sit on a checkerboard so the alpha is visible
  const transparent = () => String(props.options.background) === "transparent";
  // the render in the store is the last one of any design: another design's pictures are not shown here
  const p = () => { const x = blenderProgress(); return x && (!props.designId || x.design === renderFolderId(props.designId)) ? x : null; };
  const running = () => blenderBusy();
  const images = () => p()?.images ?? [];
  const shown = () => images()[Math.min(selected(), Math.max(0, images().length - 1))];
  const pct = () => Math.round((p()?.progress ?? 0) * 100);
  const design = () => p()?.design ?? "";
  const stageText = () => {
    const x = p();
    if (!x) return t("render.blender.stage.starting");
    if (x.status === "queued") return t("render.blender.queued");
    if (x.angleIndex > 0 && (x.stage === "rendering" || x.stage === "denoising")) {
      const base = t("render.blender.angle", { i: x.angleIndex, n: x.angleCount, name: x.angle });
      return x.stage === "denoising" ? `${base} · ${t("render.blender.stage.denoising")}`
        : x.samples > 0 ? `${base} · ${t("render.blender.samples", { s: x.sample, n: x.samples })}` : base;
    }
    return t(STAGES[x.stage] ?? "render.blender.stage.starting");
  };
  const deviceText = () => {
    const d = p()?.device ?? "";
    if (!d) return "";
    return d === "cpu" ? "CPU" : `GPU (${d.split(":")[0].toUpperCase()})`;
  };
  const failed = (message: string) => setNote({ text: message, warn: true });
  const guard = (fn: () => Promise<unknown>) => { setNote(null); void fn().catch(e => failed(e instanceof Error ? e.message : String(e))); };
  // every click answers with a status line: the download's outcome, the folder opened, or the error
  const saveAs = (img: BlenderImage) => guard(async () => {
    const r = await saveDownloadUrl(img.name, img.url);
    if (r.status === "failed") failed(t("render.blender.saveFailed", { name: img.name }));
    else setNote({ text: downloadMessage(r), warn: r.status === "cancelled" });
  });
  const openFolder = () => guard(async () => {
    const r = await openRenderFolder(design());
    setNote({ text: t("render.folder.opened", { folder: r?.dir || p()?.folder || design() }), warn: false });
  });

  return <section class="blr" aria-label={t("render.blender.title")}>
    <Show when={!detecting() && info() && !info()!.ok}>
      <div class="status-block status-warn blr-missing" role="alert">
        <CircleAlert size={14} aria-hidden="true" />
        <div>
          <p>{info()!.found ? t("render.blender.tooOld", { version: info()!.version ?? "" }) : t("render.blender.notFound")}</p>
          <p class="muted">{t("render.blender.notFoundHint")}</p>
          <button class="btn btn-ghost btn-sm" onClick={() => guard(() => openBlenderDownload())}><ExternalLink size={13} aria-hidden="true" /> {t("render.blender.getBlender")}</button>
        </div>
      </div>
    </Show>
    <Show when={info()?.ok}>
      <p class="blr-found muted"><CircleCheck size={13} aria-hidden="true" /> {t("render.blender.using", { version: info()!.label ?? info()!.version ?? "" })} <span class="mono" title={info()!.path ?? ""}>{info()!.path}</span></p>
    </Show>

    <div class="blr-controls">
      <Show when={!running()} fallback={<button class="btn btn-ghost" onClick={() => void cancelBlenderRender()}><Square size={13} aria-hidden="true" /> {t("render.blender.cancel")}</button>}>
        <button class="btn btn-primary" disabled={detecting() || !info()?.ok || !!props.blocked} title={props.blocked} onClick={() => void start()}><Play size={13} aria-hidden="true" /> {p() ? t("render.blender.again") : t("render.blender.start")}</button>
      </Show>
      <Show when={detecting()}><span class="muted"><LoaderCircle size={13} class="spin" aria-hidden="true" /> {t("render.blender.detecting")}</span></Show>
    </div>

    <Show when={running() || p()}>
      <div class="blr-progress" role="status" aria-live="polite">
        <div class="blr-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={p()?.status === "done" ? 100 : pct()}><span style={{ width: `${p()?.status === "done" ? 100 : pct()}%` }} /></div>
        <p class="blr-stage">
          <Show when={running()}><LoaderCircle size={13} class="spin" aria-hidden="true" /></Show>
          <Show when={p()?.status === "done"}><CircleCheck size={13} aria-hidden="true" /></Show>
          <Show when={p()?.status === "failed" || p()?.status === "cancelled"}><CircleAlert size={13} aria-hidden="true" /></Show>
          <span>
            {p()?.status === "done" ? t("render.blender.finished", { n: images().length, s: Math.round(p()!.elapsedS) })
              : p()?.status === "cancelled" ? t("render.blender.cancelled")
              : p()?.status === "failed" ? t("render.blender.failed")
              : stageText()}
          </span>
          <Show when={running() && pct() > 0}><span class="muted mono">{pct()}%</span></Show>
          <Show when={deviceText()}><span class="muted">{deviceText()}</span></Show>
          <Show when={running() && p()}><span class="muted mono">{Math.round(p()!.elapsedS)} s</span></Show>
        </p>
      </div>
    </Show>
    <Show when={blenderFailure() || (p()?.status === "failed" && p()?.error)}>
      <p class="status-block status-critical" role="alert"><CircleAlert size={14} aria-hidden="true" /> <span>{blenderFailure() ?? p()?.error}</span></p>
    </Show>

    <Show when={images().length}>
      <div class="blr-gallery">
        <figure class="blr-main">
          <button class="blr-main-btn" classList={{ "blr-checker": transparent() }} onClick={() => setZoom(shown()!)} title={t("render.blender.enlarge")} aria-label={t("render.blender.enlargeName", { name: shown()?.name ?? "" })}>
            <img src={shown()?.url} alt={shown()?.name} />
            <span class="blr-zoom-hint" aria-hidden="true"><Maximize2 size={14} /></span>
          </button>
          <figcaption class="mono">{shown()?.name} <span class="muted">· {shown()?.seconds.toFixed(1)} s</span></figcaption>
        </figure>
        <Show when={images().length > 1}>
          <ul class="blr-thumbs" aria-label={t("render.blender.images")}>
            <For each={images()}>{(img, i) =>
              <li><button class="blr-thumb" classList={{ "blr-checker": transparent(), "is-on": i() === selected() }} aria-pressed={i() === selected()} onClick={() => setSelected(i())} title={img.name}>
                <img src={img.url} alt={img.angle} loading="lazy" /><span>{img.angle}</span>
              </button></li>}
            </For>
          </ul>
        </Show>
      </div>
      <div class="blr-actions">
        <button class="btn btn-ghost btn-sm" onClick={() => saveAs(shown()!)}><Download size={13} aria-hidden="true" /> {t("render.blender.saveAs")}</button>
        <button class="btn btn-ghost btn-sm" onClick={openFolder}><FolderOpen size={13} aria-hidden="true" /> {t("render.blender.openFolder")}</button>
        <Show when={p()?.blend}>
          <button class="btn btn-ghost btn-sm" onClick={() => guard(() => openBlendInBlender(design(), p()!.blend!, configuredPath()))} title={blenderFileUrl(design(), p()!.blend!)}>
            <ExternalLink size={13} aria-hidden="true" /> {t("render.blender.openBlend")}
          </button>
        </Show>
      </div>
      <p class="muted mono blr-folder" title={p()?.folder}>{p()?.folder}</p>
    </Show>
    <Show when={note()}><p class="status-block" classList={{ "status-warn": note()!.warn }} role="status">{note()!.text}</p></Show>
    <Show when={zoom()}>{img => <Lightbox image={img()} checker={transparent()} close={() => setZoom(null)} />}</Show>
  </section>;
}
