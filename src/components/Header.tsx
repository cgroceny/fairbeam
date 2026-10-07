import { source } from "../state";
import { isExample } from "../runner/examples";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Camera, CircleCheck, Ellipsis, Info, MessageSquare, Monitor, Moon, Package, SaveAll, Settings, Sun, TriangleAlert, Upload, UserRound } from "lucide-solid";
import { applyTheme, bundle, setPackageOpen, theme, type Theme } from "../state";
import { compact } from "../lib/format";
import { openExamples } from "../runner/designRun";
import RunToggle from "../runner/RunToggle";
import { openUserProject } from "../runner/openProject";
import DemoNote from "./DemoNote";
import ExamplePicker from "./ExamplePicker";
import FeedbackLink from "./FeedbackLink";
import { DEMO } from "../env";
import { appMode, setAppMode } from "../workspace";
import { radioGroupKeys } from "../lib/a11y";
import { dirty as designDirty, draft as designDraft, file as designFile } from "../designer/store";
import GeneralSettingsDialog from "./GeneralSettings";
import { canSaveAs, openSaveAs } from "../designer/SaveAsDialog";
import { SHORTCUTS } from "../designer/shortcuts";
import ContextExportMenu from "./ContextExportMenu";
import { captureActiveSurface, screenshotAvailable, screenshotReason } from "../components/exportContext";
import AboutDialog from "./AboutDialog";
import Lockup from "./Lockup";
import AccountChip from "./AccountChip";
import { accountUiEnabled } from "../lib/account";
import { accountStatus, setAccountDialogOpen } from "./AccountState";
import { fmt, t, decimalComma } from "../i18n";

/** the compact cell count (1.90 M) with the locale's decimal separator */
const compactText = (v: number | null | undefined) => {
  const s = compact(v);
  return decimalComma() ? s.replace(".", ",") : s;
};
const dbText = (v: number | null | undefined) => (v === undefined || v === null ? "" : fmt.num(v, 3));

export default function Header() {
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [aboutOpen, setAboutOpen] = createSignal(false);
  const openSettings = () => setSettingsOpen(true), openAbout = () => setAboutOpen(true);
  onMount(() => { window.addEventListener("fairbeam:open-settings", openSettings); window.addEventListener("fairbeam:open-about", openAbout); });
  onCleanup(() => { window.removeEventListener("fairbeam:open-settings", openSettings); window.removeEventListener("fairbeam:open-about", openAbout); });
  let fileInput!: HTMLInputElement;
  const nextTheme: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
  const themeLabel: Record<Theme, string> = { system: "header.theme.system", light: "header.theme.light", dark: "header.theme.dark" };
  const [moreOpen, setMoreOpen] = createSignal(false);
  const [morePosition, setMorePosition] = createSignal({ top: 0, left: 0 });
  let moreRoot!: HTMLDivElement;
  let moreTrigger!: HTMLButtonElement;
  let moreMenu: HTMLDivElement | undefined;
  const placeMore = () => {
    if (!moreMenu) return;
    const r = moreTrigger.getBoundingClientRect(), m = moreMenu.getBoundingClientRect(), edge = 8;
    const below = r.bottom + 4;
    const top = below + m.height > window.innerHeight - edge && r.top - 4 - m.height >= edge
      ? r.top - 4 - m.height
      : Math.max(edge, Math.min(below, window.innerHeight - edge - m.height));
    setMorePosition({ top, left: Math.max(edge, Math.min(r.right - m.width, window.innerWidth - edge - m.width)) });
  };
  const onMoreAway = (e: PointerEvent) => { if (!moreRoot.contains(e.target as Node)) closeMore(false); };
  const onMoreBlur = () => closeMore(false);
  const onMoreViewport = (e: Event) => {
    if (e.type === "scroll" && moreMenu?.contains(e.target as Node)) return;
    closeMore(false);
  };
  const listenMore = (on: boolean) => {
    const method = on ? "addEventListener" : "removeEventListener";
    document[method]("pointerdown", onMoreAway as EventListener, true);
    window[method]("blur", onMoreBlur);
    window[method]("resize", onMoreViewport);
    window[method]("scroll", onMoreViewport, true);
  };
  function closeMore(focus = true) {
    if (!moreOpen()) return;
    setMoreOpen(false);
    listenMore(false);
    if (focus) moreTrigger?.focus();
  }
  const openMore = (last = false) => {
    if (moreOpen()) return;
    setMoreOpen(true);
    listenMore(true);
    queueMicrotask(() => {
      placeMore();
      const items = moreMenu?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled):not([aria-disabled='true'])");
      (last ? items?.[items.length - 1] : items?.[0])?.focus();
    });
  };
  const onMoreKeyDown = (e: KeyboardEvent) => {
    const items = [...(moreMenu?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled):not([aria-disabled='true'])") ?? [])];
    const active = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); closeMore(true); }
    else if (e.key === "Tab") {
      const candidates = [...document.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")]
        .filter((el) => !moreMenu?.contains(el) && el.getClientRects().length > 0);
      const at = candidates.indexOf(moreTrigger);
      e.preventDefault();
      closeMore(false);
      candidates[at + (e.shiftKey ? -1 : 1)]?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const offset = e.key === "ArrowDown" ? 1 : -1;
      items[(active + offset + items.length) % items.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1]?.focus();
    }
  };
  const runMoreAction = (action: () => void) => { closeMore(true); action(); };
  onCleanup(() => listenMore(false));
  // The Screen radio group is one Tab stop (arrows move within it): the current screen, or Start
  // when Design is current but disabled (no design open).
  const userResults = () => appMode() === "results" && !!bundle()?.results && !isExample({ file: source() ?? "" });
  const tabStop = () => (appMode() === "design" && !designFile() ? "home" : appMode());

  return (
    <header class="app-header">
      <div class="brand">
        <Lockup />
      </div>

      <Show when={!DEMO}>
        <div class="seg seg-sm mode-switch" role="radiogroup" aria-label={t("header.screen")} onKeyDown={radioGroupKeys}>
          <button class="seg-btn" role="radio" aria-checked={appMode() === "home"} tabindex={tabStop() === "home" ? 0 : -1} onClick={() => setAppMode("home")}>{t("header.screen.start")}</button>
          <button class="seg-btn" role="radio" aria-checked={appMode() === "design"} tabindex={tabStop() === "design" ? 0 : -1} disabled={!designFile()} title={designFile() ? t("header.screen.designTitle") : t("header.screen.designDisabled")}
            onClick={() => setAppMode("design")}>{t("header.screen.design")}</button>
          <button class="seg-btn" role="radio" aria-checked={appMode() === "results"} tabindex={tabStop() === "results" ? 0 : -1} onClick={() => { if (!userResults()) void openExamples(); }}
            title={t(userResults() ? "header.screen.resultsTitle" : "header.screen.examplesTitle")}>{t(userResults() ? "header.screen.results" : "header.screen.examples")}</button>
        </div>
      </Show>

      <Show when={appMode() === "design" && designFile()}>
        <div class="design-title" title={designFile()!.file}>
          <span class="design-title-name">{designDraft.model?.name}</span>
          <Show when={designDirty()}><span class="code-dot" aria-label={t("header.unsaved")} /></Show>
          <span class="mono muted">{designFile()!.file}</span>
        </div>
      </Show>

      <ExamplePicker />

      <Show when={appMode() === "results" && bundle()}>
        {(b) => (
          <div class="header-meta">
            <span class="mono meta-id" title={t("header.modelTitle", { id: b().model.id })}>{b().model.id}</span>
            <span class="sep" />
            <span class="mono meta-cells">{t("header.cells", { cells: compactText(b().mesh.total_cells) })}</span>
            <Show when={b().run}>
              {(r) => (
                <>
                  <span class="sep" />
                  <Show
                    when={r().converged}
                    fallback={
                      <span class="status status-warn" title={t("header.status.notConvergedTitle")}>
                        <TriangleAlert size={13} aria-hidden="true" /> <span class="status-label">{t("header.status.notConverged")}</span>
                      </span>
                    }
                  >
                    <span class="status status-good" title={r().final_energy_db !== undefined && r().final_energy_db !== null ? t("header.status.energyFell", { value: dbText(r().final_energy_db) }) : t("header.status.energyBelow", { value: dbText(r().final_energy_bound_db) })}>
                      <CircleCheck size={13} aria-hidden="true" /> <span class="status-label">{t("header.status.converged")}</span>
                    </span>
                  </Show>
                </>
              )}
            </Show>
          </div>
        )}
      </Show>

      <div class="header-actions">
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) void openUserProject(f);
            e.currentTarget.value = "";
          }}
        />
        <Show when={!DEMO && appMode() !== "results"}><RunToggle /></Show>
        <Show when={DEMO}><DemoNote /></Show>
        <div class="header-secondary">
          <button class="icon-btn hide-xs" disabled={!screenshotAvailable()} onClick={() => void captureActiveSurface()} title={screenshotAvailable()?t("header.screenshot.title"):screenshotReason()} aria-label={t("header.screenshot.aria")}>
            <Camera size={16} aria-hidden="true" />
          </button>
          <FeedbackLink kind="choose" class="icon-btn hide-xs" label={t("header.feedback.label")} title={t("header.feedback.title")}>
            <MessageSquare size={16} aria-hidden="true" />
          </FeedbackLink>
          <button class="icon-btn" onClick={() => applyTheme(nextTheme[theme()])} title={t("header.theme.title", { theme: t(themeLabel[theme()]) })} aria-label={t(themeLabel[theme()])}>
            <Show when={theme() === "system"} fallback={theme() === "light" ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}>
              <Monitor size={16} aria-hidden="true" />
            </Show>
          </button>
          <AccountChip />
          <button class="icon-btn" onClick={openSettings} title={t("header.settings")} aria-label={t("header.settings")}><Settings size={16} aria-hidden="true" /></button>
          <button class="icon-btn" onClick={openAbout} title={t("header.about")} aria-label={t("header.about")}><Info size={16} aria-hidden="true" /></button>
          <button class="btn btn-ghost" hidden={appMode() === "home"} disabled={!bundle()} onClick={() => setPackageOpen(true)} title={t("header.package.title")} aria-label={t("header.package.label")}>
            <Package size={14} aria-hidden="true" /> <span class="btn-label collapse-xl">{t("header.package.label")}</span>
          </button>
        </div>
        <ContextExportMenu />
        <div class="header-more" ref={moreRoot}>
          <button ref={moreTrigger} type="button" class="icon-btn header-more-trigger" aria-haspopup="menu" aria-expanded={moreOpen()}
            aria-controls="header-more-menu" aria-label={t("header.more.aria")} title={t("header.more.title")}
            onClick={() => moreOpen() ? closeMore(false) : openMore()}
            onKeyDown={(e) => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); openMore(e.key === "ArrowUp"); } }}>
            <Ellipsis size={16} aria-hidden="true" />
          </button>
          <Show when={moreOpen()}>
            <div id="header-more-menu" class="menu header-more-menu" role="menu" aria-label={t("header.more.menu")}
              ref={moreMenu} style={{ top: `${morePosition().top}px`, left: `${morePosition().left}px` }} onKeyDown={onMoreKeyDown}>
              <button class="menu-item" type="button" role="menuitem" aria-label={t("header.open.aria")} title={t("header.open.title")} onClick={() => runMoreAction(() => fileInput.click())}>
                <Upload size={14} aria-hidden="true" /> {t("header.open.label")}
              </button>
              <Show when={!DEMO}>
                <button class="menu-item" type="button" role="menuitem" disabled={!canSaveAs()}
                  title={canSaveAs() ? t("header.saveAs.title", { key: SHORTCUTS.saveAs.key }) : t("header.saveAs.disabled")} onClick={() => runMoreAction(openSaveAs)}>
                  <SaveAll size={14} aria-hidden="true" /> {t("header.saveAs.label")}
                </button>
              </Show>
              <span class="menu-sep" role="none" />
              <button class="menu-item" type="button" role="menuitem" disabled={!screenshotAvailable()} title={screenshotAvailable()?t("header.screenshot.title"):screenshotReason()} onClick={() => runMoreAction(() => { void captureActiveSurface(); })}>
                <Camera size={14} aria-hidden="true" /> {t("header.screenshot.aria")}
              </button>
              <FeedbackLink kind="choose" class="menu-item" role="menuitem" onClick={() => closeMore(false)} label={t("header.feedback.label")} title={t("header.feedback.title")}>
                <MessageSquare size={14} aria-hidden="true" /> {t("header.feedback.label")}
              </FeedbackLink>
              <span class="menu-sep" role="none" />
              <button class="menu-item" type="button" role="menuitem" onClick={() => runMoreAction(() => applyTheme(nextTheme[theme()]))}>
                <Show when={theme() === "system"} fallback={theme() === "light" ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}><Monitor size={14} aria-hidden="true" /></Show>
                {t("header.more.theme", { theme: t(themeLabel[theme()]) })}
              </button>
              <Show when={accountUiEnabled() && accountStatus()}>
                <button class="menu-item" type="button" role="menuitem" onClick={() => runMoreAction(() => setAccountDialogOpen(true))}>
                  <UserRound size={14} aria-hidden="true" /> {t("header.more.account")}
                </button>
              </Show>
              <button class="menu-item" type="button" role="menuitem" onClick={() => runMoreAction(openSettings)}><Settings size={14} aria-hidden="true" /> {t("header.settings")}</button>
              <button class="menu-item" type="button" role="menuitem" onClick={() => runMoreAction(openAbout)}><Info size={14} aria-hidden="true" /> {t("header.about")}</button>
              <Show when={appMode() !== "home"}>
                <span class="menu-sep" role="none" />
                <button class="menu-item" type="button" role="menuitem" disabled={!bundle()} onClick={() => runMoreAction(() => setPackageOpen(true))}>
                  <Package size={14} aria-hidden="true" /> {t("header.package.label")}
                </button>
              </Show>
            </div>
          </Show>
        </div>
      </div>
      <GeneralSettingsDialog open={settingsOpen()} close={() => setSettingsOpen(false)} />
      <AboutDialog open={aboutOpen()} close={() => setAboutOpen(false)} />
    </header>
  );
}
