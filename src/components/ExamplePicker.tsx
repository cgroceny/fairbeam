// The Examples project picker in the header: a button that shows the open example in full and a
// popover with a search field (role="combobox") over the grouped examples (role="listbox"). It
// replaces a native <select>, which cut the names short and looked different on every OS.
//
// Keys in the search field: type to filter, Up/Down/Home/End move the active row
// (aria-activedescendant; focus stays in the field), Enter opens it, Escape closes and returns
// focus to the button, Tab closes. A click outside, a window blur, resize or page scroll closes it.
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Check, ChevronsUpDown, CopyPlus, FolderOpen, Search } from "lucide-solid";
import { bundle, index, source } from "../state";
import { exampleGroups, filterGroups, flatItems, initialActive, pickerKeyTarget, type PickerGroup } from "../lib/examplePicker";
import { exampleConversionBlocker, exampleEntries, exampleSourceFor, isExample } from "../runner/examples";
import { models, openExampleCopy, serverState } from "../runner/store";
import { openUserProject } from "../runner/openProject";
import { appMode } from "../workspace";
import { t } from "../i18n";

const EDGE = 8;
let uid = 0;

export default function ExamplePicker() {
  const id = `example-picker-${++uid}`;
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  let pop: HTMLDivElement | undefined;
  let search: HTMLInputElement | undefined;
  let list: HTMLDivElement | undefined;

  const examples = createMemo(() => exampleEntries(index()));
  const groups = createMemo<PickerGroup[]>(() => {
    // grouped by category (867 MHz UAV, patch and printed, ...), as on the Start screen; groups
    // without examples are left out
    const out = exampleGroups(examples(), (c) => t(`examples.group.${c}`));
    // a project opened from a file (or a run) is not an example: it is listed so the picker shows it
    const s = source();
    if (s && !examples().some((p) => p.file === s)) {
      out.unshift({ label: t("examples.openedProject"), opened: true, items: [{ file: s, label: s, detail: bundle()?.name ?? "", results: !!bundle()?.results }] });
    }
    return out;
  });

  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(-1);
  /** the file being opened: shown on the button until the load settles, then source() again */
  const [pending, setPending] = createSignal<string | null>(null);
  const [pos, setPos] = createSignal({ top: 0, left: 0, minWidth: 0, maxHeight: 480 });

  const shown = createMemo(() => filterGroups(groups(), query()));
  const items = createMemo(() => flatItems(shown()));
  // the "with results" badge only tells something when some examples have none
  const mixedResults = createMemo(() => { const all = flatItems(groups()); return all.some((i) => i.results) && all.some((i) => !i.results); });
  /** the filtered groups with the flat index of their first row (option ids and the active row count flat) */
  const rows = createMemo(() => {
    let n = 0;
    return shown().map((g) => { const start = n; n += g.items.length; return { ...g, start }; });
  });
  const optionId = (i: number) => `${id}-opt-${i}`;
  const currentFile = () => pending() ?? source();
  const labelFor = (f: string) => (f ? flatItems(groups()).find((i) => i.file === f)?.label ?? f : "");
  const currentLabel = () => labelFor(currentFile());

  // Examples show their full name in the window title (the header may have to ellipsize it); the
  // title names what is open, not a pick that is still loading
  createEffect(() => {
    const label = appMode() === "results" && bundle() ? labelFor(source()) : "";
    document.title = label ? `${label} — Fairbeam` : "Fairbeam";
  });
  onCleanup(() => { document.title = "Fairbeam"; });

  const place = () => {
    const r = trigger.getBoundingClientRect();
    const width = pop?.getBoundingClientRect().width ?? 0;
    const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - EDGE - width));
    const top = r.bottom + 4;
    setPos({ top, left, minWidth: r.width, maxHeight: Math.max(160, window.innerHeight - top - EDGE) });
  };
  const scrollActive = () => {
    const el = list?.querySelector<HTMLElement>(`#${CSS.escape(optionId(active()))}`);
    el?.scrollIntoView({ block: "nearest" });
  };

  const onAway = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!root.contains(t) && !pop?.contains(t)) close(false);
  };
  const onBlur = () => close(false);
  const onViewport = (e: Event) => {
    if (e.type === "scroll" && pop?.contains(e.target as Node)) return; // scrolling the list itself
    close(false);
  };
  const listen = (on: boolean) => {
    const m = on ? "addEventListener" : "removeEventListener";
    document[m]("pointerdown", onAway as EventListener, true);
    window[m]("blur", onBlur);
    window[m]("resize", onViewport);
    window[m]("scroll", onViewport, true);
  };

  function show() {
    if (open()) return;
    setQuery("");
    setActive(initialActive(items(), currentFile()));
    setOpen(true);
    place();
    listen(true);
    // measured once rendered: the popover is as wide as its longest name, kept inside the window
    queueMicrotask(() => { place(); search?.focus(); scrollActive(); });
  }
  function close(focus = true) {
    if (!open()) return;
    setOpen(false);
    listen(false);
    if (focus) trigger.focus();
  }
  onCleanup(() => listen(false));

  const choose = (file: string) => {
    close();
    if (file === source()) return;
    setPending(file);
    // after a failed (or superseded) load the button falls back to what is actually open
    void openUserProject(file).finally(() => { if (pending() === file) setPending(null); });
  };

  const onSearchKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === "Tab") { close(false); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const it = items()[active()];
      if (it) choose(it.file);
      return;
    }
    const next = pickerKeyTarget(e.key, active(), items().length);
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    scrollActive();
  };
  const onInput = (value: string) => {
    setQuery(value);
    setActive(initialActive(items(), value.trim() ? "" : currentFile()));
    if (list) list.scrollTop = 0;
  };
  const onTriggerKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); show(); }
  };

  // Open as new project: an editable Design copy; the reason is on the button when that is impossible
  const copyState = () => {
    const b = bundle();
    if (!b) return null;
    if (!isExample({ file: source() })) return { sourceModel: undefined, reason: t("examples.copy.onlyBundled") };
    const blocker = exampleConversionBlocker(b);
    const sourceModel = exampleSourceFor(models(), b.model.id);
    const reason = blocker ? t("examples.copy.cantOpen", { reason: blocker })
      : serverState() !== "online" ? t("examples.copy.cantOpen", { reason: t("examples.copy.noServer") })
      : !sourceModel ? t("examples.copy.cantOpen", { reason: t("examples.copy.noSource") })
      : null;
    return { sourceModel, reason };
  };

  return (
    <div class="project-picker" ref={root} style={{ display: appMode() === "results" ? undefined : "none" }}>
      <button ref={trigger} type="button" class="example-picker-trigger" aria-haspopup="listbox" aria-expanded={open()}
        aria-controls={open() ? `${id}-list` : undefined} aria-label={currentLabel() ? t("examples.projectLabel", { name: currentLabel() }) : t("examples.projectNone")}
        title={currentLabel() || t("examples.select")} onClick={() => (open() ? close() : show())} onKeyDown={onTriggerKey}>
        <FolderOpen size={14} aria-hidden="true" />
        <span class="example-picker-trigger-label" classList={{ placeholder: !currentLabel() }}>{currentLabel() || t("examples.select")}</span>
        <ChevronsUpDown size={14} aria-hidden="true" class="example-picker-chevron" />
      </button>
      <Show when={copyState()}>{(c) => (
        <button type="button" class="btn btn-ghost example-copy-btn" aria-disabled={c().reason ? "true" : undefined}
          aria-label={t("examples.copy.label")} title={c().reason ?? t("examples.copy.title")}
          onClick={() => { const m = c().sourceModel; if (!c().reason && m) openExampleCopy(m.key, source()); }}>
          <CopyPlus size={14} aria-hidden="true" /> <span class="btn-label">{t("examples.copy.button")}</span>
        </button>
      )}</Show>
      <Show when={open()}>
        <Portal>
          <div ref={pop} class="example-picker-pop" style={{ top: `${pos().top}px`, left: `${pos().left}px`, "min-width": `${Math.max(pos().minWidth, 320)}px`, "max-height": `${pos().maxHeight}px` }}>
            <div class="example-picker-search">
              <Search size={14} aria-hidden="true" />
              <input ref={search} type="text" role="combobox" aria-label={t("examples.filter")} placeholder={t("examples.filter")}
                aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list" autocomplete="off" spellcheck={false}
                aria-activedescendant={active() >= 0 && items()[active()] ? optionId(active()) : undefined}
                value={query()} onInput={(e) => onInput(e.currentTarget.value)} onKeyDown={onSearchKey} />
            </div>
            <div ref={list} id={`${id}-list`} class="example-picker-list" role="listbox" aria-label={t("examples.title")}>
              <For each={rows()}>{(group) => {
                const heading = true;
                return (
                  <div role="group" aria-label={group.label} class="example-picker-group">
                    <Show when={heading}><div class="example-picker-heading" aria-hidden="true">{group.label}</div></Show>
                    <For each={group.items}>{(it, j) => {
                      const i = () => group.start + j();
                      return (
                        <div id={optionId(i())} role="option" class="example-picker-option" classList={{ active: active() === i() }}
                          aria-selected={active() === i()} title={it.file}
                          onPointerMove={() => active() !== i() && setActive(i())}
                          onPointerDown={(e) => e.preventDefault() /* keep focus in the search field */}
                          onClick={() => choose(it.file)}>
                          <span class="example-picker-name">
                            {it.label}
                            <Show when={it.file === currentFile()}><Check size={14} aria-hidden="true" class="example-picker-check" /><span class="visually-hidden"> {t("examples.openMark")}</span></Show>
                          </span>
                          <span class="example-picker-detail">
                            <span>{it.detail}</span>
                            <Show when={it.results && mixedResults()}><span class="example-picker-badge">{t("examples.withResults")}</span></Show>
                          </span>
                        </div>
                      );
                    }}</For>
                  </div>
                );
              }}</For>
              <Show when={!items().length}><p class="example-picker-empty" role="status">{t("examples.noMatch", { query: query().trim() })}</p></Show>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  );
}
