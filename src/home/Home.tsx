// Start screen: a new project (blank, or from a template), your designs, your Python models and
// the examples (opened in Examples mode, #51). Designing needs the local run server; the examples
// open without it. A design's own runs are not listed here: they open under the design.
// The footer links to the public issue tracker (FeedbackLink).
import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import { Box, CircuitBoard, CopyPlus, FilePlus2, FileCode, FileUp, FolderOpen, LoaderCircle, MessageSquare, PenTool, Pencil, Play, Plus, Search, Star, Trash2 } from "lucide-solid";
import { ApiError } from "../runner/api";
import { models, openRunPanel, openExampleCopy, probeServer, refreshModels, serverState } from "../runner/store";
import { confirmReplaceDraft, createDesign, deleteDesign, dirty, enterDesign, file } from "../designer/store";
import { openUserProject } from "../runner/openProject";
import { index } from "../state";
import { labelOf, projectLabels } from "../lib/projectLabels";
import { exampleEntries, exampleSourceFor } from "../runner/examples";
import { setAppMode } from "../workspace";
import { dialog, file as editorFile, setDialog, setNewModelKind, setPanelTab } from "../editor/store";
import NewModelDialog from "../editor/NewModelDialog";
import { pythonHint, runPythonModel, setPythonHint } from "../runner/startPython";
import { DEMO } from "../env";
import FeedbackLink from "../components/FeedbackLink";
import { setCstImportOpen } from "../lib/cstImport";
import { setPcbImportOpen } from "../lib/pcbImport";
import { designFileHint, designIdError, freeDesignId } from "../lib/designId";
import { TEMPLATE_GROUPS, type TemplateKey } from "../designer/templates";
import { openPythonModelAsDesign } from "../designer/pythonModel";
import { t } from "../i18n";
import { createDesignActions } from "./DesignActions";
import { hasUndatedProjects, visibleProjects, type ProjectSort } from "./projectList";

const focusAfterRender = (id: string) => requestAnimationFrame(() => {
  document.getElementById(id)?.focus();
});

// a translated sentence with a marked-up part: the text around {command} / {name} stays plain
const withCommand = (text: string, command: string) => {
  const [before, after = ""] = text.split("{command}");
  return <>{before}<span class="mono">{command}</span>{after}</>;
};
const withName = (text: string, name: string) => {
  const [before, after = ""] = text.split("{name}");
  return <>{before}<b>{name}</b>{after}</>;
};

function storedFavorites(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem("fairbeam.home.favoriteDesigns") ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : []);
  } catch { return new Set(); }
}
function storedSort(): ProjectSort {
  try { return localStorage.getItem("fairbeam.home.designSort") === "name" ? "name" : "modified"; }
  catch { return "modified"; }
}
function storedFavoritesOnly(): boolean {
  try { return localStorage.getItem("fairbeam.home.favoritesOnly") === "true"; }
  catch { return false; }
}
function persistHome(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage may be unavailable */ }
}

export default function Home() {
  const examples = createMemo(() => exampleEntries(index()));
  const labels = createMemo(() => projectLabels(examples()));
  const [name, setName] = createSignal("");
  const [template, setTemplate] = createSignal<TemplateKey>("empty");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [designQuery, setDesignQuery] = createSignal("");
  const [designSort, setDesignSort] = createSignal<ProjectSort>(storedSort());
  const [favoriteKeys, setFavoriteKeys] = createSignal<Set<string>>(storedFavorites());
  const [favoritesOnly, setFavoritesOnly] = createSignal(storedFavoritesOnly());
  const online = () => serverState() === "online";
  // The name field starts filled in from the chosen starter ("Half-wave dipole", or "… 2" when a
  // design has that name), and follows the starter until the user types a name of their own. The
  // name is in the interface language; the file name is its ASCII form, with a suffix when that is
  // a bundled example's id (freeDesignId: "Patch antenna" is saved as patch_antenna_2).
  const [autoName, setAutoName] = createSignal("");
  const modelKeys = () => models().map((m) => m.key);
  const starterName = (key: TemplateKey) => {
    const tpl = TEMPLATE_GROUPS.flatMap((g) => g.templates).find((x) => x.key === key);
    const base = tpl ? t(tpl.name) : "";
    let n = base, k = 2;
    while (base && models().some((m) => m.key === freeDesignId(n, modelKeys()).id) && k < 100) n = `${base} ${k++}`;
    return n;
  };
  createEffect(on([template, online], () => {
    if (!online() || (name().trim() && name() !== autoName())) return;
    const n = starterName(template());
    setAutoName(n);
    setName(n);
  }));
  const id = () => freeDesignId(name(), modelKeys()).id;
  const idError = () => (!name().trim() ? "" : designIdError(id(), modelKeys()));
  // designs that do not load stay listed (greyed, with the reason) rather than vanishing: a file
  // made by a newer Fairbeam, or a hand edit, would otherwise look lost. A failed entry has no kind.
  // The bundled example designs (read-only) are not the user's: they are only the sources of
  // "Open as new design…" for their examples.
  const designs = createMemo(() => models().filter((m) => !m.readonly && (m.error ? m.file?.endsWith(".design.json") : m.kind === "design")));
  const designActions = createDesignActions(designs);
  const shownDesigns = createMemo(() => visibleProjects(designs(), designQuery(), designSort(), favoritesOnly(), favoriteKeys()));
  const showUnknownModifiedNote = () => designSort() === "modified" && hasUndatedProjects(designs());
  const toggleFavorite = (key: string) => {
    const next = new Set(favoriteKeys());
    if (next.has(key)) next.delete(key); else next.add(key);
    setFavoriteKeys(next);
    persistHome("fairbeam.home.favoriteDesigns", JSON.stringify([...next]));
  };
  const loadError = (e: string) => {
    const msg = e.split("\n")[0].replace(/^DesignError:\s*/, "").slice(0, 160);
    return /not valid JSON/i.test(msg)
      ? t("home.designs.damaged", { error: msg })
      : t("home.designs.loadError", { error: msg });
  };
  // deleting a design: the row asks first; the server moves the file into its history folder
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal(false);
  const [delNote, setDelNote] = createSignal<{ tone: "good" | "bad"; text: string } | null>(null);
  const remove = async (key: string, fileName: string) => {
    setDeleting(true);
    setDelNote(null);
    try {
      await deleteDesign(key);
      setDelNote({ tone: "good", text: t("home.designs.deleted", { file: fileName }) });
    } catch (err) {
      const a = err as ApiError;
      setDelNote({ tone: "bad", text: a.status === 0 ? t("home.serverUnreachable") : a.message });
    } finally {
      setDeleting(false);
      setConfirming(null);
      focusAfterRender("home-delete-note");
    }
  };
  const pythonModels = createMemo(() => models().filter((m) => m.kind !== "design" && !m.error && !m.readonly));

  onMount(() => {
    if (!DEMO && online()) refreshModels();
  });

  const create = async (e: Event) => {
    e.preventDefault();
    if (!name().trim() || idError() || busy()) return;
    // an unsaved open design is saved or given up first; Cancel creates nothing
    if (!(await confirmReplaceDraft("create", name().trim()))) return;
    setBusy(true);
    setError("");
    try {
      await createDesign({ id: id(), name: name().trim(), template: template() });
    } catch (err) {
      const a = err as ApiError;
      setError(a.status === 0 ? t("home.serverUnreachable") : a.message);
      focusAfterRender("home-create-error");
    } finally {
      setBusy(false);
    }
  };

  const runModel = runPythonModel;
  // A new Python model starts in the code editor. Once saved, convert it to a Design and open the
  // Design Python panel so the source remains editable alongside its geometry.
  const [creatingModel, setCreatingModel] = createSignal<string | undefined>(undefined);
  const [pythonDesignBusy, setPythonDesignBusy] = createSignal(false);
  const newPythonModel = () => {
    if (pythonDesignBusy()) return;
    setCreatingModel(editorFile()?.id ?? "");
    setPythonConversionError(null);
    setPythonHint(false);
    setNewModelKind("python");
    setDialog("new");
  };
  const [pythonConversionError, setPythonConversionError] = createSignal<{ id: string; message: string } | null>(null);
  const openPythonAsDesign = async (sourceId: string) => {
    if (pythonDesignBusy()) return;
    setPythonConversionError(null);
    setPythonDesignBusy(true);
    try {
      await openPythonModelAsDesign(sourceId);
    } catch (err) {
      const a = err as ApiError;
      await refreshModels();
      setPythonConversionError({ id: sourceId, message: a.status === 0 ? t("home.serverUnreachable") : a.message });
    } finally {
      setPythonDesignBusy(false);
    }
  };
  const openPythonCode = async () => {
    const key = pythonConversionError()?.id;
    if (!key) return;
    setPythonConversionError(null);
    setAppMode("results");
    setPanelTab("code");
    await openRunPanel(key);
    setPanelTab("code");
  };
  createEffect(on(dialog, (d) => {
    const before = creatingModel();
    if (d !== null || before === undefined) return;
    setCreatingModel(undefined);
    setNewModelKind("design");
    const f = editorFile();
    if (f && f.id !== before && !f.readonly) {
      if (models().some((m) => m.key === f.id && m.kind !== "design")) void openPythonAsDesign(f.id);
      else { setAppMode("results"); void openRunPanel(f.id); }
    }
  }));

  return (
    <main class="home">
      <div class="home-inner">
        <header class="home-head">
          <h1>{t("home.title")}</h1>
          <p class="muted">{t("home.subtitle")}</p>
        </header>
        <Show when={!DEMO}><p class="home-quickstart">{t("home.quickStart")}</p></Show>

        <Show when={!DEMO} fallback={<p class="note">{t("home.demoNote")}</p>}>
          <Show when={online()} fallback={
            <section class="home-card home-offline">
              <Show when={serverState() === "checking" || serverState() === "unknown"} fallback={
                <>
                  <h2>{t("home.offline.title")}</h2>
                  <p>{withCommand(t("home.offline.body"), "fairbeam serve")}</p>
                  <button class="btn btn-ghost btn-sm" onClick={() => probeServer()}>{t("home.offline.checkAgain")}</button>
                </>
              }>
                <p class="muted"><LoaderCircle size={14} class="rs-spin" aria-hidden="true" /> {t("home.offline.looking")}</p>
              </Show>
            </section>
          }>
            <div class="home-grid">
              <section class="home-card">
                <h2><FilePlus2 size={16} aria-hidden="true" /> {t("home.newProject.title")}</h2>
                <form class="stack" onSubmit={create}>
                  <label class="field">
                    <span>{t("home.newProject.name")}</span>
                    <input autocomplete="off" class="field-text" type="text" maxLength={80} value={name()} placeholder={t("home.newProject.placeholder")} aria-invalid={!!idError()}
                      aria-describedby={error() ? "home-name-hint home-create-error" : "home-name-hint"}
                      onInput={(e) => { setName(e.currentTarget.value); setError(""); }} />
                    <span id="home-name-hint" class={idError() ? "rp-error nm-hint" : "rp-hint nm-hint"} aria-live="polite">{idError() || (name().trim() ? designFileHint(name(), modelKeys()) : t("home.newProject.fileHint"))}</span>
                  </label>
                  <div class="home-templates" role="radiogroup" aria-label={t("home.newProject.startFrom")}>
                    <For each={TEMPLATE_GROUPS}>{(g, i) => (
                      <div class="home-tpl-group" role={g.label ? "group" : undefined} aria-labelledby={g.label ? `home-tpl-group-${i()}` : undefined}>
                        <Show when={g.label}><span id={`home-tpl-group-${i()}`} class="home-tpl-label">{t(g.label)}</span></Show>
                        <div class="nm-list home-tpl-list">
                          <For each={g.templates}>{(tpl) => (
                            <label class="nm-option" classList={{ selected: template() === tpl.key }}>
                              <input type="radio" name="home-template" value={tpl.key} checked={template() === tpl.key} onChange={() => setTemplate(tpl.key)} />
                              <span class="nm-option-text">
                                <span class="nm-option-name">{t(tpl.name)}</span>
                                <span class="nm-option-sub">{t(tpl.sub)}</span>
                              </span>
                            </label>
                          )}</For>
                        </div>
                      </div>
                    )}</For>
                  </div>
                  <Show when={error()}><p id="home-create-error" class="rp-error" role="alert" tabIndex={-1}>{error()}</p></Show>
                  <button class="btn btn-primary" type="submit" disabled={!name().trim() || !!idError() || busy()}
                    title={!name().trim() ? t("home.newProject.needName") : idError() || undefined}>
                    <PenTool size={14} aria-hidden="true" /> {busy() ? t("home.newProject.creating") : t("home.newProject.create")}
                  </button>
                </form>
                <div class="home-import">
                  <button class="btn btn-ghost" type="button" onClick={() => setCstImportOpen(true)}
                    title={t("home.importCst.title")}>
                    <FileUp size={14} aria-hidden="true" /> {t("home.importCst.button")}
                  </button>
                  <span class="muted">{t("home.importCst.note")}</span>
                </div>
                <div class="home-import home-import-next">
                  <button class="btn btn-ghost" type="button" onClick={() => setPcbImportOpen(true)}
                    title={t("home.importPcb.title")}>
                    <CircuitBoard size={14} aria-hidden="true" /> {t("home.importPcb.button")}
                  </button>
                  <span class="muted">{t("home.importPcb.note")}</span>
                </div>
              </section>

              <section class="home-card">
                <h2><Box size={16} aria-hidden="true" /> {t("home.designs.title")}</h2>
                <Show when={designs().length}>
                  <div class="home-design-tools">
                    <label class="home-design-search">
                      <Search size={14} aria-hidden="true" />
                      <input autocomplete="off" type="search" aria-label={t("home.designs.search")} placeholder={t("home.designs.searchPlaceholder")}
                        value={designQuery()} onInput={(e) => setDesignQuery(e.currentTarget.value)} />
                    </label>
                    <label class="home-design-sort">
                      <span>{t("home.designs.sort")}</span>
                      <select aria-label={t("home.designs.sort")} value={designSort()} onChange={(e) => {
                        const next = e.currentTarget.value === "name" ? "name" : "modified";
                        setDesignSort(next);
                        persistHome("fairbeam.home.designSort", next);
                      }}>
                        <option value="modified">{t("home.designs.sort.modified")}</option>
                        <option value="name">{t("home.designs.sort.name")}</option>
                      </select>
                    </label>
                    <button class="chip-btn home-favorites-only" type="button" aria-pressed={favoritesOnly()} classList={{ active: favoritesOnly() }}
                      onClick={() => { const next = !favoritesOnly(); setFavoritesOnly(next); persistHome("fairbeam.home.favoritesOnly", String(next)); }}>
                      <Star size={13} aria-hidden="true" /> {t("home.designs.favoritesOnly")}
                    </button>
                  </div>
                </Show>
                <Show when={showUnknownModifiedNote()}><p class="home-modified-note muted" role="note">{t("home.designs.unknownModified")}</p></Show>
                <Show when={designs().length} fallback={<p class="muted">{t("home.designs.empty")}</p>}>
                  <Show when={shownDesigns().length} fallback={<p class="muted" role="status">{favoritesOnly() && !designQuery().trim() ? t("home.designs.noFavorites") : t("home.designs.noMatches")}</p>}>
                    <ul class="home-list" id="home-design-list">
                    <For each={shownDesigns()}>{(m) => (
                      <li data-home-design={m.key} onContextMenu={(event) => designActions.open(event, m)} onKeyDown={(event) => designActions.keydown(event, m)}>
                        <Show when={confirming() === m.key} fallback={
                          <div class="home-row">
                            <Show when={!m.error} fallback={
                              <div class="home-item home-item-bad" title={m.error} aria-disabled="true">
                                <span class="home-item-name">{m.key}</span>
                                <span class="home-item-sub">{loadError(m.error!)}</span>
                              </div>
                            }>
                              <button class="home-item" onClick={() => enterDesign(m.key)}>
                                <span class="home-item-name">{m.model?.name ?? m.key}</span>
                                <span class="home-item-sub mono">{m.file}</span>
                              </button>
                            </Show>
                            <button class="icon-btn icon-btn-sm home-favorite" data-home-favorite={m.key} aria-pressed={favoriteKeys().has(m.key)}
                              aria-label={t(favoriteKeys().has(m.key) ? "home.designs.unfavorite" : "home.designs.favorite", { name: m.model?.name ?? m.key })}
                              title={t(favoriteKeys().has(m.key) ? "home.designs.unfavorite" : "home.designs.favorite", { name: m.model?.name ?? m.key })}
                              onClick={() => toggleFavorite(m.key)}>
                              <Star size={14} fill={favoriteKeys().has(m.key) ? "currentColor" : "none"} aria-hidden="true" />
                            </button>
                            <button class="icon-btn icon-btn-sm home-rename" data-home-rename={m.key}
                              aria-label={t("home.designs.renameAria", { name: m.model?.name ?? m.key })} title={t("home.designs.renameTitle")}
                              onClick={() => designActions.rename(m)}><Pencil size={14} aria-hidden="true" /></button>
                            <button id={`home-delete-${m.key}`} class="icon-btn home-del" onClick={() => { setDelNote(null); setConfirming(m.key); focusAfterRender(`home-keep-${m.key}`); }}
                              aria-label={t("home.designs.deleteAria", { name: m.model?.name ?? m.key })} title={t("home.designs.deleteTitle")}><Trash2 size={14} /></button>
                          </div>
                        }>
                          <div class="home-confirm" role="group" aria-label={t("home.designs.confirm", { name: m.model?.name ?? m.key })}
                            onKeyDown={(e) => { if (e.key === "Escape" && !deleting()) { e.preventDefault(); setConfirming(null); focusAfterRender(`home-delete-${m.key}`); } }}>
                            <span>{withName(t("home.designs.confirm"), m.model?.name ?? m.key)}{file()?.id === m.key && dirty() ? ` ${t("home.designs.unsavedLost")}` : ""} <span class="muted">{t("home.designs.movesToHistory")}</span></span>
                            <div class="cluster-sm">
                              <button class="btn btn-sm home-del-btn" disabled={deleting()} aria-label={t("home.designs.deleteAria", { name: m.model?.name ?? m.key })}
                                onClick={() => remove(m.key, m.file)}>{deleting() ? t("home.designs.deleting") : t("common.delete")}</button>
                              <button id={`home-keep-${m.key}`} class="btn btn-ghost btn-sm" disabled={deleting()}
                                aria-label={t("home.designs.keepAria", { name: m.model?.name ?? m.key })}
                                onClick={() => { setConfirming(null); focusAfterRender(`home-delete-${m.key}`); }}>{t("home.designs.keep")}</button>
                            </div>
                          </div>
                        </Show>
                      </li>
                    )}</For>
                    </ul>
                  </Show>
                </Show>
                <designActions.Note />
                <Show when={delNote()}><p id="home-delete-note" class={delNote()!.tone === "bad" ? "rp-error" : "note home-del-note"}
                  role={delNote()!.tone === "bad" ? "alert" : "status"} tabIndex={-1}>{delNote()!.text}</p></Show>
                <h2 class="home-h2b"><FileCode size={16} aria-hidden="true" /> {t("home.python.title")}</h2>
                <Show when={!pythonModels().length} fallback={<Show when={pythonHint()}>
                  <p id="home-python-hint" tabIndex={-1} class="note home-python-hint" role="status">{t("home.python.choose")}</p>
                </Show>}>
                  <p id="home-python-hint" tabIndex={-1} class={pythonHint() ? "note home-python-hint" : "muted"} role={pythonHint() ? "status" : undefined}>{t("home.python.none")}</p>
                </Show>
                <ul class="home-list">
                  <For each={pythonModels()}>{(m) => (
                    <li><div class="home-row">
                      <button class="home-item" data-run-python-model={m.key} disabled={pythonDesignBusy()} onClick={() => runModel(m.key)} title={t("home.python.openTitle")}>
                        <span class="home-item-name">{m.model?.name ?? m.key}</span>
                        <span class="home-item-sub mono"><Play size={11} aria-hidden="true" /> {m.file}</span>
                      </button>
                      <button class="btn btn-ghost btn-sm home-copy home-python-design" data-python-model={m.key} disabled={!online() || pythonDesignBusy()}
                        onClick={() => void openPythonAsDesign(m.key)} title={t("home.python.openDesignTitle")}>
                        <PenTool size={14} aria-hidden="true" /><span>{t("home.python.openDesign")}</span>
                      </button>
                    </div></li>
                  )}</For>
                </ul>
                <Show when={pythonConversionError()}>
                  <div class="stack-sm" role="alert">
                    <p class="rp-error">{t("home.python.designFailed", { error: pythonConversionError()!.message })}</p>
                    <button class="btn btn-ghost btn-sm" onClick={() => void openPythonCode()}>{t("home.python.openCode")}</button>
                  </div>
                </Show>
                <Show when={pythonDesignBusy()}><p class="note" role="status">{t("home.python.openingDesign")}</p></Show>
                <button class="btn btn-ghost btn-sm" disabled={pythonDesignBusy()} onClick={newPythonModel} title={t("home.python.newTitle")}><Plus size={13} aria-hidden="true" /> {t("home.python.new")}</button>
              </section>
            </div>
          </Show>
        </Show>

        <section class="home-card home-examples">
          <h2><FolderOpen size={16} aria-hidden="true" /> {t("home.examples.title")}</h2>
          <ul class="home-list home-list-cols">
            <For each={examples()}>{(p) => {
              const sourceModel = () => exampleSourceFor(models(), p.model);
              return <li>
                <div class="home-row">
                  <button class="home-item" onClick={() => openUserProject(p.file)} title={p.file}>
                    <span class="home-item-name" title={labelOf(labels(), p)}>{labelOf(labels(), p)}</span>
                    <span class="home-item-sub">{p.simulated === false ? t("home.examples.geometryOnly") : t("home.examples.withResults")}</span>
                  </button>
                  <button class="btn btn-ghost btn-sm home-copy" disabled={!online() || !sourceModel()} aria-label={t("home.examples.openAsNew")}
                    title={!sourceModel() ? t("home.examples.noSource") : t("home.examples.copyTitle")}
                    onClick={() => { if (sourceModel()) openExampleCopy(sourceModel()!.key, p.file); }}>
                    <CopyPlus size={14} aria-hidden="true" /> <span>{t("home.examples.openAsNew")}</span>
                  </button>
                </div>
              </li>;
            }}</For>
          </ul>
        </section>

        <footer class="home-foot">
          <MessageSquare size={14} aria-hidden="true" />
          <span>{t("home.feedback.label")}</span>
          <FeedbackLink kind="bug" class="home-foot-link" title={t("home.feedback.bugTitle")}>{t("home.feedback.bug")}</FeedbackLink>
          <span aria-hidden="true">·</span>
          <FeedbackLink kind="feature" class="home-foot-link" title={t("home.feedback.featureTitle")}>{t("home.feedback.feature")}</FeedbackLink>
        </footer>
      </div>
      <designActions.View />
      <Show when={dialog() && creatingModel() !== undefined}><NewModelDialog /></Show>
    </main>
  );
}
