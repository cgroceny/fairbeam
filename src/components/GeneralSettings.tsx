import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import { CircleAlert, CircleCheck, LoaderCircle, Settings, X } from "lucide-solid";
import { applyTheme } from "../state";
import { useModal } from "../lib/dialog";
import { errorText } from "../lib/errorText";
import { readGeneralSettings, writeGeneralSettings, type GeneralSettings } from "../lib/generalSettings";
import { applyAppearance, APPEARANCE_DEFAULTS } from "../lib/appearance";
import { APPEARANCE_OPTIONS, CUSTOM_COLORS } from "../lib/appearanceOptions";
import { resetDesignerLayout } from "../designer/layoutState";
import { resetRibbonLayout } from "../designer/DesignWorkspace";
import { setEngine, health } from "../runner/store";
import { setConfirmShapes } from "../designer/draw";
import AccountSettings from "./AccountSettings";
import { setLanguage, t, type LanguageChoice, setDecimalChoice } from "../i18n";
import UsageStatsSettings from "./UsageStatsSettings";
import "../styles/general-settings.css";
import NumberField from "./NumberField";

type Native = { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> };
type UpdateFeedback = { tone: "good" | "warn" | "critical"; text: string };
type DesktopSettings = {
  check_updates_on_start: boolean;
  workspace?: string;
  current_workspace?: string | null;
  next_workspace?: string;
  workspace_pending?: boolean;
  prefer_gpu?: boolean;
  gpu_build?: string | null;
  external_is_gpu?: boolean;
  external_python?: string | null;
  gpu_runtime?: string;
  gpu_runtime_ready?: boolean;
  gpu_choice_ready?: boolean;
  gpu_choice_source?: string | null;
  gpu_choice_path?: string | null;
  gpu_runtime_installing?: boolean;
  gpu_supported?: boolean;
  gpu_support_reason?: string | null;
  gpu_adapter?: string | null;
  gpu_driver?: string | null;
  gpu_runtime_enabled?: boolean;
};
const native = () => (window as unknown as { __TAURI_INTERNALS__?: Native }).__TAURI_INTERNALS__;
export default function GeneralSettingsDialog(props: { open: boolean; close: () => void }) {
  let box!: HTMLDivElement;
  const desktop = () => !!native();
  const [value, setValue] = createSignal<GeneralSettings>(readGeneralSettings());
  const [tab, setTab] = createSignal<"general" | "appearance">("general");
  const [message, setMessage] = createSignal("");
  const [messageTone, setMessageTone] = createSignal<"good" | "critical">("critical");
  const showError = (text: string) => { setMessageTone("critical"); setMessage(text); };
  const showSuccess = (text: string) => { setMessageTone("good"); setMessage(text); };
  const [currentWorkspace, setCurrentWorkspace] = createSignal<string | null>(null);
  const [nextWorkspace, setNextWorkspace] = createSignal("");
  const [workspacePending, setWorkspacePending] = createSignal(false);
  const [updates, setUpdates] = createSignal(false);
  // the openEMS build the desktop app starts with: the GPU build has both engines (GPU.md)
  const [gpuBuild, setGpuBuild] = createSignal<string | null>(null);
  const [externalPython, setExternalPython] = createSignal<string | null>(null);
  // the Python chosen in the setup screen is itself a GPU build
  const [externalIsGpu, setExternalIsGpu] = createSignal(false);
  const [gpuChanged, setGpuChanged] = createSignal(false);
  const [gpuRuntime, setGpuRuntime] = createSignal("");
  const [gpuChoiceReady, setGpuChoiceReady] = createSignal(false);
  const [gpuChoiceSource, setGpuChoiceSource] = createSignal<string | null>(null);
  const [gpuChoicePath, setGpuChoicePath] = createSignal<string | null>(null);
  const [gpuRuntimeEnabled, setGpuRuntimeEnabled] = createSignal(false);
  const [gpuSupported, setGpuSupported] = createSignal(false);
  const [gpuSupportReason, setGpuSupportReason] = createSignal<string | null>(null);
  const [gpuAdapter, setGpuAdapter] = createSignal<string | null>(null);
  const [gpuDriver, setGpuDriver] = createSignal<string | null>(null);
  const [gpuInstalling, setGpuInstalling] = createSignal(false);
  const [workspaceBusy, setWorkspaceBusy] = createSignal(false);
  const [checkingUpdates, setCheckingUpdates] = createSignal(false);
  const [updateStatus, setUpdateStatus] = createSignal<UpdateFeedback | null>(null);
  const [busy, setBusy] = createSignal(false);
  // Blender (rendering through the user's Blender): the executable path and what the server finds there
  const [blenderInfo, setBlenderInfo] = createSignal<import("../render/blender").BlenderInfo | null>(null);
  const [blenderBusy, setBlenderBusy] = createSignal(false);
  const checkBlender = async (path: string, adopt = false) => {
    setBlenderBusy(true);
    try {
      const { detectBlender } = await import("../render/blender");
      const info = await detectBlender(path);
      setBlenderInfo(info);
      if (adopt && info.found && info.path) save({ blenderPath: info.path });
    } catch { setBlenderInfo(null); }
    finally { setBlenderBusy(false); }
  };
  const browseBlender = async () => {
    try {
      const picked = await native()!.invoke<string | null>("pick_blender_executable");
      if (picked) { save({ blenderPath: picked }); await checkBlender(picked); }
    } catch (e) { showError(t("settings.blender.browseFailed", { error: errorText(e) })); }
  };
  onMount(() => { document.documentElement.dataset.unitDisplay = value().units; });
  useModal(() => props.open ? box : undefined, props.close);
  const save = (patch: Partial<GeneralSettings>) => {
    const next = { ...value(), ...patch };
    try {
      writeGeneralSettings(next); setValue(next); setMessage("");
      if (patch.theme) applyTheme(patch.theme);
      applyAppearance(next);
      if (patch.engine) setEngine(patch.engine === "gpu" && !health()?.engines?.includes("gpu") ? "cpu" : patch.engine);
      if (patch.confirmShapes !== undefined) setConfirmShapes(patch.confirmShapes);
      if (patch.units) document.documentElement.dataset.unitDisplay = patch.units;
      if (patch.language) setLanguage(patch.language);
      if (patch.decimals) setDecimalChoice(patch.decimals);
    } catch (e) { showError(t("settings.error.save", { error: errorText(e) })); }
  };
  const loadDesktop = async () => {
    if (!native()) return;
    try {
      const data = await native()!.invoke<DesktopSettings>("get_general_settings");
      setUpdates(data.check_updates_on_start);
      setCurrentWorkspace(data.current_workspace ?? null);
      setNextWorkspace(data.next_workspace ?? data.workspace ?? "");
      setWorkspacePending(!!data.workspace_pending);
      setGpuBuild(data.gpu_build ?? null); setExternalIsGpu(!!data.external_is_gpu); setExternalPython(data.external_python ?? null);
      setGpuRuntime(data.gpu_runtime ?? "");
      setGpuChoiceReady(!!data.gpu_choice_ready); setGpuChoiceSource(data.gpu_choice_source ?? null); setGpuChoicePath(data.gpu_choice_path ?? null);
      setGpuRuntimeEnabled(!!data.gpu_runtime_enabled); setGpuSupported(!!data.gpu_supported);
      setGpuSupportReason(data.gpu_support_reason ?? null); setGpuAdapter(data.gpu_adapter ?? null); setGpuDriver(data.gpu_driver ?? null);
      setGpuInstalling(!!data.gpu_runtime_installing);
    }
    catch (e) { showError(t("settings.error.loadDesktop", { error: errorText(e) })); }
  };
  const checkUpdates = async (v: boolean) => {
    setBusy(true); setMessage("");
    try { await native()!.invoke("set_update_check_on_start", { value: v }); setUpdates(v); }
    catch (e) { showError(t("settings.error.saveUpdates", { error: errorText(e) })); }
    finally { setBusy(false); }
  };
  const checkUpdatesNow = async () => {
    setCheckingUpdates(true); setUpdateStatus(null);
    try {
      const result = await native()!.invoke<{ status: string; version?: string }>("check_updates_now");
      const messageKeys: Record<string, string> = {
        up_to_date: "settings.updateCheck.upToDate",
        update_available: "settings.updateCheck.available",
        unavailable: "settings.updateCheck.unavailable",
        preview_blocked: "settings.updateCheck.previewBlocked",
        in_progress: "settings.updateCheck.inProgress",
        disabled: "settings.updateCheck.disabled",
      };
      const messageKey = messageKeys[result.status] ?? "settings.updateCheck.unavailable";
      const tone = result.status === "up_to_date" || result.status === "update_available" ? "good" :
        ["in_progress", "unavailable", "preview_blocked", "disabled"].includes(result.status) ? "warn" : "critical";
      setUpdateStatus({ tone, text: t(messageKey, { version: result.version ?? "" }) });
    } catch (e) { setUpdateStatus({ tone: "critical", text: t("settings.error.manualUpdates", { error: errorText(e) }) }); }
    finally { setCheckingUpdates(false); }
  };
  const chooseManagedGpu = async (v: boolean) => {
    setBusy(true); setMessage("");
    try {
      await native()!.invoke("set_gpu_runtime_enabled", { value: v });
      setGpuRuntimeEnabled(v); setGpuChanged(true); showSuccess(t("settings.nextStart"));
    } catch (e) {
      const code = errorText(e);
      const known: Record<string, string> = {
        gpu_runtime_not_ready: "settings.gpuManaged.selectedUnavailable",
        gpu_runtime_unsupported: "settings.gpuManaged.reason.gpu_runtime_unsupported",
        nvidia_smi_missing: "settings.gpuManaged.reason.nvidia_smi_missing",
        nvidia_gpu_missing: "settings.gpuManaged.reason.nvidia_gpu_missing",
        nvidia_driver_too_old: "settings.gpuManaged.reason.nvidia_driver_too_old",
        nvidia_compute_unsupported: "settings.gpuManaged.reason.nvidia_compute_unsupported",
        nvidia_compute_capability_unknown: "settings.gpuManaged.reason.nvidia_compute_capability_unknown",
        nvidia_probe_failed: "settings.gpuManaged.reason.nvidia_probe_failed",
      };
      showError(known[code] ? t(known[code]) : t("settings.error.gpuPreference"));
    }
    finally { setBusy(false); }
  };
  const installGpuRuntime = async () => {
    setGpuInstalling(true); setBusy(true); setMessage("");
    try {
      await native()!.invoke("install_gpu_runtime");
      await loadDesktop();
      showSuccess(t("settings.gpuManaged.ready"));
    } catch (e) {
      const code = errorText(e);
      const known: Record<string, string> = {
        runtime_installing: "settings.gpuManaged.cpuInstallBusy",
        gpu_runtime_installing: "settings.gpuManaged.installBusy",
        gpu_runtime_in_use_until_exit: "settings.gpuManaged.activeUntilExit",
        nvidia_smi_missing: "settings.gpuManaged.reason.nvidia_smi_missing",
        nvidia_gpu_missing: "settings.gpuManaged.reason.nvidia_gpu_missing",
        nvidia_driver_too_old: "settings.gpuManaged.reason.nvidia_driver_too_old",
        nvidia_probe_failed: "settings.gpuManaged.reason.nvidia_probe_failed",
      };
      showError(known[code] ? t(known[code]) : t("settings.error.gpuInstall"));
    }
    finally { setBusy(false); setGpuInstalling(false); }
  };
  const chooseWorkspace = async () => {
    setWorkspaceBusy(true); setMessage("");
    try {
      const path = await native()!.invoke<string | null>("pick_workspace_folder");
      if (!path) return;
      const saved = await native()!.invoke<string>("set_workspace_folder", { path });
      setNextWorkspace(saved);
      await loadDesktop();
      showSuccess(t("settings.workspaceChoiceSaved"));
    } catch (e) {
      const code = errorText(e);
      const known: Record<string, string> = {
        workspace_not_folder: "settings.error.workspaceNotFolder",
        workspace_protected_path: "settings.error.workspaceProtected",
        workspace_not_writable: "settings.error.workspaceNotWritable",
        workspace_picker_failed: "settings.error.workspacePicker",
      };
      const key = known[code];
      showError(key ? t(key) : t("settings.error.workspaceSave", { error: code }));
    } finally { setWorkspaceBusy(false); }
  };
  const gpuReason = () => {
    const code = gpuSupportReason();
    return code ? t(`settings.gpuManaged.reason.${code}`) : t("settings.gpuManaged.unsupported");
  };
  createEffect(() => { if (props.open) { setValue(readGeneralSettings()); setUpdateStatus(null); void loadDesktop(); void checkBlender(readGeneralSettings().blenderPath); } });
  return <Show when={props.open}><div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && props.close()}>
    <div class="dialog dialog-sm gs-dialog" role="dialog" aria-modal="true" aria-labelledby="gs-title" ref={box} tabindex={-1}>
      <div class="dialog-head"><div><h2 id="gs-title"><Settings size={17} /> {t("settings.title")}</h2><p class="muted">{t("settings.subtitle")}</p></div><button class="icon-btn" onClick={props.close} aria-label={t("common.close")}><X size={16}/></button></div>
      <div class="gs-tabs" role="tablist" aria-label={t("settings.title")}>
        <For each={["general", "appearance"] as const}>{name => <button type="button" id={`gs-tab-${name}`} role="tab" aria-selected={tab() === name} aria-controls={`gs-panel-${name}`} tabindex={tab() === name ? 0 : -1} class="btn btn-ghost" onClick={() => setTab(name)} onKeyDown={e => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
          e.preventDefault(); const next = e.key === "Home" ? "general" : e.key === "End" ? "appearance" : tab() === "general" ? "appearance" : "general";
          setTab(next); document.getElementById(`gs-tab-${next}`)?.focus();
        }}>{t(`settings.tab.${name}`)}</button>}</For>
      </div>
      <div class="gs-body">
        <Show when={tab() === "appearance"}>
          <div class="gs-panel" id="gs-panel-appearance" role="tabpanel" aria-labelledby="gs-tab-appearance" tabindex={0}>
        <label class="dz-field"><span class="dz-label">{t("settings.theme")}</span><select class="rp-select dz-input" value={value().theme} onChange={e => save({ theme: e.currentTarget.value as GeneralSettings["theme"] })}><option value="system">{t("settings.theme.system")}</option><option value="light">{t("settings.theme.light")}</option><option value="dark">{t("settings.theme.dark")}</option></select></label>
            <label class="dz-field"><span class="dz-label">{t("settings.appearance.uiFont")}</span><select class="rp-select dz-input" value={value().uiFont} onChange={e => save({ uiFont: e.currentTarget.value as GeneralSettings["uiFont"] })}><option value="plex">{t("settings.appearance.plexSans")}</option><option value="system">{t("settings.appearance.systemFont")}</option><option value="arial">Arial / Helvetica</option></select></label>
            <label class="dz-field"><span class="dz-label">{t("settings.appearance.monoFont")}</span><select class="rp-select dz-input" value={value().monoFont} onChange={e => save({ monoFont: e.currentTarget.value as GeneralSettings["monoFont"] })}><option value="plex">{t("settings.appearance.plexMono")}</option><option value="system">{t("settings.appearance.systemMono")}</option><option value="consolas">Consolas</option></select><span class="note">{t("settings.appearance.fontNote")}</span></label>

            <For each={(["colorPreset", "accent", "chartPalette", "chartWeight", "viewportPalette"] as const)}>{key => <div class="gs-appearance-choice">
              <label class="dz-field"><span class="dz-label">{t(`settings.appearance.${key}`)}</span><select data-appearance={key} class="rp-select dz-input" value={value()[key]} onChange={e => save({ [key]: key === "chartWeight" ? Number(e.currentTarget.value) : e.currentTarget.value } as Partial<GeneralSettings>)}><For each={APPEARANCE_OPTIONS[key] as readonly (string | number)[]}>{option => <option value={option}>{t(`settings.appearance.option.${option}`)}</option>}</For></select></label>
              <button type="button" class="btn btn-ghost btn-sm" disabled={value()[key] === APPEARANCE_DEFAULTS[key]} aria-label={t("settings.appearance.resetOne", { label: t(`settings.appearance.${key}`) })} onClick={() => save({ [key]: APPEARANCE_DEFAULTS[key] })}>{t("settings.appearance.resetShort")}</button>
            </div>}</For>
            <p class="note">{t("settings.appearance.colorNote")}</p>
            <details class="gs-custom-colors"><summary>{t("settings.appearance.customColors")}</summary><div class="stack">
              <For each={CUSTOM_COLORS}>{key=><div class="gs-appearance-choice"><label class="gs-check"><input type="checkbox" data-custom-enabled={key} checked={!!value()[key]} onChange={e=>save({[key]:e.currentTarget.checked ? (key==="customAccent"?"#245a91":key==="traceColor"?"#2166ac":key==="viewportColor"?"#e8e6e1":"#bdb9b1") : ""})}/>{t(`settings.appearance.${key}`)}</label><input type="color" data-custom-color={key} aria-label={t(`settings.appearance.${key}`)} disabled={!value()[key]} value={value()[key]||"#245a91"} onInput={e=>save({[key]:e.currentTarget.value})}/></div>}</For>
              <p class="note">{t("settings.appearance.customNote")}</p>
            </div></details>
            <div class="gs-style-preview" aria-label={t("settings.appearance.stylePreview")}>
              <svg viewBox="0 0 160 64" aria-hidden="true"><path class="c-line" stroke="var(--al-series-1)" d="M8 48 L35 35 L65 43 L100 16 L152 24"/><path class="c-line" stroke="var(--al-series-2)" stroke-dasharray="5 3" d="M8 24 L35 40 L65 16 L100 43 L152 35"/></svg>
              <div class="gs-grid-preview" aria-hidden="true" />
            </div>
            <div class="gs-font-preview"><span>{t("settings.appearance.preview")}</span><span class="mono">2.450 GHz · −12.34 dB · 50.00 Ω</span></div>
            <button class="btn btn-ghost" onClick={() => save(APPEARANCE_DEFAULTS)}>{t("settings.appearance.reset")}</button>
          </div>
        </Show>
        <Show when={tab() === "general"}><div class="gs-panel" id="gs-panel-general" role="tabpanel" aria-labelledby="gs-tab-general" tabindex={0}>
        <label class="dz-field"><span class="dz-label">{t("settings.language")}</span><select class="rp-select dz-input" value={value().language} onChange={e => save({ language: e.currentTarget.value as LanguageChoice })}><option value="system">{t("settings.language.system")}</option><option value="en" lang="en">English</option><option value="tr" lang="tr">Türkçe</option></select></label>
        <label class="dz-field"><span class="dz-label">{t("settings.decimals")}</span><select class="rp-select dz-input" value={value().decimals} onChange={e => save({ decimals: e.currentTarget.value as GeneralSettings["decimals"] })}><option value="language">{t("settings.decimals.language")}</option><option value="point">{t("settings.decimals.point")}</option><option value="comma">{t("settings.decimals.comma")}</option></select><span class="note">{t("settings.decimals.note")}</span></label>
        <label class="dz-field"><span class="dz-label">{t("settings.engine")}</span><select class="rp-select dz-input" value={value().engine} onChange={e => save({ engine: e.currentTarget.value as GeneralSettings["engine"] })}><option value="cpu">CPU</option><option value="gpu">{t("settings.engine.gpu")}</option></select></label>
        <div class="dz-field"><span class="dz-label">{t("settings.threads")} <span class="dz-unit">1–{health()?.cpu_count ?? t("settings.threads.available")}</span></span><label class="gs-check"><input type="checkbox" checked={value().threads === 0} onChange={e => save({ threads: e.currentTarget.checked ? 0 : (health()?.default_threads ?? 4) })}/> {t("settings.threads.auto")}</label><Show when={value().threads !== 0}><NumberField class="rp-input dz-input" min="1" max={health()?.cpu_count} step="1" value={value().threads} onChange={e => { const n = Number(e.currentTarget.value); if (Number.isInteger(n) && n > 0 && n <= (health()?.cpu_count ?? 1024)) save({ threads: n }); }} /></Show><span class="note">{t("settings.threads.note", { n: health()?.default_threads ?? 1, cores: health()?.physical_cores ?? health()?.cpu_count ?? 1 })}</span></div>
        <label class="dz-field"><span class="dz-label">{t("settings.mesh")}</span><select class="rp-select dz-input" value={value().meshMode} onChange={e => save({ meshMode: e.currentTarget.value as GeneralSettings["meshMode"] })}><option value="legacy">{t("settings.mesh.legacy")}</option><option value="auto">{t("settings.mesh.auto")}</option></select></label>
        <label class="gs-check"><input type="checkbox" checked={value().confirmShapes} onChange={e => save({ confirmShapes: e.currentTarget.checked })}/> {t("settings.confirmShapes")}</label>
        <label class="dz-field"><span class="dz-label">{t("settings.units")}</span><select class="rp-select dz-input" value={value().units} onChange={e => save({ units: e.currentTarget.value as GeneralSettings["units"] })}><option value="standard">{t("settings.units.standard")}</option><option value="compact">{t("settings.units.compact")}</option></select></label>
        <div class="dz-field gs-blender">
          <label class="dz-label" for="gs-blender-path">{t("settings.blender.label")}</label>
          <div class="gs-blender-row">
            <input id="gs-blender-path" class="rp-input dz-input mono" type="text" autocomplete="off" spellcheck={false} value={value().blenderPath} placeholder={t("settings.blender.placeholder")}
              onChange={e => { const path = e.currentTarget.value.trim(); save({ blenderPath: path }); void checkBlender(path); }} />
            <Show when={desktop()}><button class="btn btn-ghost btn-sm" disabled={blenderBusy()} onClick={() => void browseBlender()}>{t("settings.blender.browse")}</button></Show>
            <button class="btn btn-ghost btn-sm" disabled={blenderBusy()} onClick={() => void checkBlender("", true)}>{t("settings.blender.detect")}</button>
          </div>
          <Show when={blenderInfo()}>{info =>
            <span class="note" classList={{ "gs-blender-bad": !info().ok }} role="status">
              {info().ok ? t("settings.blender.found", { version: info().label ?? info().version ?? "", path: info().path ?? "" })
                : info().found ? t("settings.blender.tooOld", { version: info().version ?? "" }) : t("settings.blender.notFound")}
              <Show when={info().ok && info().configured_error}> {t("settings.blender.configuredBad")}</Show>
              <Show when={!info().ok}> <a href={info().download_url} target="_blank" rel="noopener noreferrer" onClick={e => { if (health()?.desktop) { e.preventDefault(); void import("../render/blender").then(m => m.openBlenderDownload()); } }}>{t("settings.blender.download")}</a></Show>
            </span>}</Show>
          <span class="note">{t("settings.blender.note")}</span>
        </div>
        <button class="btn btn-ghost" onClick={() => { resetDesignerLayout(); resetRibbonLayout(); showSuccess(t("settings.layoutReset")); }}>{t("settings.resetLayout")}</button>
        <Show when={desktop()}>
          <hr />
          <div class="gs-update-row">
            <label class="gs-check"><input type="checkbox" checked={updates()} disabled={busy()} onChange={e => void checkUpdates(e.currentTarget.checked)} /> {t("settings.checkUpdates")}</label>
            <button class="btn btn-ghost btn-sm" disabled={checkingUpdates()} onClick={() => void checkUpdatesNow()}>{checkingUpdates() ? t("settings.checkUpdatesNow.busy") : t("settings.checkUpdatesNow")}</button>
          </div>
          <Show when={checkingUpdates() || updateStatus()}>
            <p role="status" class="status-block gs-update-status" classList={{
              "status-good": !checkingUpdates() && updateStatus()?.tone === "good",
              "status-warn": !checkingUpdates() && updateStatus()?.tone === "warn",
              "status-critical": !checkingUpdates() && updateStatus()?.tone === "critical",
            }}>
              <Show when={checkingUpdates()} fallback={<Show when={updateStatus()?.tone === "good"} fallback={<CircleAlert aria-hidden="true" />}><CircleCheck aria-hidden="true" /></Show>}><LoaderCircle aria-hidden="true" /></Show>
              <span>{checkingUpdates() ? t("settings.checkUpdatesNow.busy") : updateStatus()?.text}</span>
            </p>
          </Show>
          <Show when={externalIsGpu()}>
            <p class="gs-check">{t("settings.gpuBuild.label")} <span class="mono">{gpuBuild() ?? externalPython()}</span></p>
            <p class="note">{t("settings.gpuBuild.externalIsGpu", { python: externalPython() ?? "" })}</p>
          </Show>
          <Show when={!externalIsGpu() && gpuChoiceReady()}>
            <div class="gs-gpu-runtime">
              <div><span class="dz-label">{gpuChoiceSource() === "managed" ? t("settings.gpuManaged.ready") : t("settings.gpuBuild.label")}</span><span class="mono">{gpuChoicePath() ?? gpuRuntime()}</span></div>
              <label class="gs-check"><input type="checkbox" checked={gpuRuntimeEnabled()} disabled={busy()} onChange={e => void chooseManagedGpu(e.currentTarget.checked)} /> {t("settings.gpuManaged.enabled")}</label>
              <p class="note">{gpuChoiceSource() === "managed" ? t("settings.gpuManaged.note") : t("settings.gpuManaged.externalNote")}{gpuChanged() ? ` ${t("settings.nextStart")}` : ""}</p>
            </div>
          </Show>
          <Show when={!externalIsGpu() && !gpuChoiceReady() && gpuSupported()}>
            <div class="gs-gpu-runtime">
              <div><span class="dz-label">{t("settings.gpuManaged.supported")}</span>
                <Show when={gpuAdapter()}><span class="note">{t("settings.gpuManaged.adapter", { adapter: gpuAdapter() })}</span></Show>
                <Show when={gpuDriver()}><span class="note">{t("settings.gpuManaged.driver", { driver: gpuDriver() })}</span></Show>
              </div>
              <p class="note">{t("settings.gpuManaged.note")}</p>
              <button class="btn btn-ghost btn-sm" disabled={busy() || gpuInstalling()} onClick={() => void installGpuRuntime()}>{gpuInstalling() ? t("settings.gpuManaged.preparing") : t("settings.gpuManaged.install")}</button>
            </div>
          </Show>
          <Show when={!externalIsGpu() && !gpuChoiceReady() && !gpuSupported() && gpuSupportReason()}>
            <p class="note">{gpuReason()}</p>
          </Show>
          <Show when={!externalIsGpu() && gpuRuntimeEnabled() && !gpuChoiceReady()}>
            <p class="note">{t("settings.gpuManaged.selectedUnavailable")}</p>
          </Show>
          <div class="gs-workspace">
            <div class="gs-workspace-row">
              <div><span class="dz-label">{t("settings.currentWorkspace")}</span><span class="mono">{currentWorkspace() || t("settings.currentWorkspaceUnavailable")}</span></div>
              <button class="btn btn-ghost btn-sm" disabled={!currentWorkspace()} onClick={async () => { try { await native()!.invoke("open_workspace"); } catch (e) { showError(t("settings.error.openWorkspace", { error: errorText(e) })); } }}>{t("settings.openFolder")}</button>
            </div>
            <div class="gs-workspace-row">
              <div><span class="dz-label">{t("settings.workspaceNextStart")}</span><span class="mono">{nextWorkspace() || t("common.loading")}</span></div>
              <button class="btn btn-ghost btn-sm" disabled={workspaceBusy() || busy()} onClick={() => void chooseWorkspace()}>{t("settings.changeWorkspace")}</button>
            </div>
            <p class="note">{t("settings.workspaceChoiceNote")}</p>
            <Show when={workspacePending()}><p class="note">{t("settings.nextStart")}</p></Show>
          </div>
        </Show>
        <AccountSettings closeSettings={props.close} />
        <Show when={desktop()}><UsageStatsSettings /></Show>
        </div></Show>
        <Show when={message()}><p role={messageTone() === "good" ? "status" : "alert"} class="status-block" classList={{ "status-good": messageTone() === "good", "status-critical": messageTone() === "critical" }}>{message()}</p></Show>
      </div>
    </div>
  </div></Show>;
}
