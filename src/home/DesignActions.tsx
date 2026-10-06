import { createSignal, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { FolderOpen, Pencil, X } from "lucide-solid";
import { api, ApiError, type DesignFile } from "../runner/api";
import { dirty, file, saveBeforeLeaving, syncSavedDesignName } from "../designer/store";
import { refreshModels } from "../runner/store";
import { useModal } from "../lib/dialog";
import { t } from "../i18n";
import "./design-actions.css";

type Entry = { key: string; model?: { name?: string }; error?: string };
type Target = { id: string; name: string; x: number; y: number; broken: boolean };
type Transaction = { id: string; previous: string; hash: string; scope?: string };

export function createDesignActions(entries: () => Entry[]) {
  const [target, setTarget] = createSignal<Target | null>(null);
  const [record, setRecord] = createSignal<DesignFile | null>(null);
  const [note, setNote] = createSignal("");
  const [undo, setUndo] = createSignal<Transaction | null>(null);
  const [working, setWorking] = createSignal(false);
  // an open design with unsaved edits: the rename waits for a decision, never fails silently
  const [saveFirst, setSaveFirst] = createSignal<string | null>(null);
  const close = () => setTarget(null);
  const blocked = (id: string) => file()?.id === id && dirty();
  const explain = (error: unknown) => {
    const a = error as ApiError;
    const kind = a.data?.name_error;
    return a.data?.workspace_error === "scope_mismatch" ? t("store.workspaceChanged")
      : kind === "duplicate" ? t("home.designs.renameDuplicate") : kind === "invalid" ? t("home.designs.renameInvalid")
      : a.status === 409 ? t("home.designs.renameConflict") : a.status === 0 ? t("home.serverUnreachable") : a.message;
  };
  const beginRename = async (id: string) => {
    close(); setNote("");
    if (blocked(id)) { setSaveFirst(id); return; }
    await openRename(id);
  };
  const openRename = async (id: string) => {
    try {
      const next = await api.design(id);
      if (file()?.id === id && (file()!.hash !== next.hash || file()!.backup_scope !== next.backup_scope)) { setNote(t("home.designs.renameConflict")); return; }
      setRecord(next);
    } catch (error) { setNote(explain(error)); }
  };
  const reveal = async (id: string) => {
    close(); setNote("");
    const native = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
    if (!native) { setNote(t("home.designs.revealDesktop")); return; }
    try {
      const location = await api.designLocation(id);
      await native.invoke("reveal_design", { id: location.id, path: location.path });
    } catch (error) { setNote(error instanceof ApiError ? explain(error) : t("home.designs.revealFailed", { error: String(error) })); }
  };
  const undoRename = async () => {
    const transaction = undo(); if (!transaction || working()) return;
    if (blocked(transaction.id)) { setNote(t("home.designs.renameSaveFirst")); return; }
    setWorking(true);
    try {
      const result = await api.renameDesign(transaction.id, transaction.previous, transaction.hash, transaction.scope);
      if (file()?.backup_scope === transaction.scope) syncSavedDesignName(result.id, result.name, result.hash, transaction.hash);
      await refreshModels(); setUndo(null); setNote(t("home.designs.renameUndone"));
    } catch (error) { setNote(explain(error)); }
    finally { setWorking(false); }
  };
  function Menu(props: { value: Target }) {
    let box: HTMLDivElement | undefined;
    useModal(() => box, close, () => box?.querySelector<HTMLButtonElement>("button:not(:disabled)"));
    const act = (action: () => void) => { close(); action(); };
    return <Portal><div class="home-menu-scrim" onPointerDown={(event) => event.target === event.currentTarget && close()}>
      <div class="home-design-menu" role="menu" aria-label={props.value.name} tabindex={-1} ref={box}
        style={{ left: `${Math.max(8, Math.min(props.value.x, window.innerWidth - 260))}px`, top: `${Math.max(8, Math.min(props.value.y, window.innerHeight - 110))}px` }}
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); const buttons = [...box!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
          const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (i + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }}>
        <button role="menuitem" disabled={props.value.broken} onClick={() => act(() => void beginRename(props.value.id))}><Pencil size={15}/>{t("home.designs.rename")}</button>
        <button role="menuitem" onClick={() => act(() => void reveal(props.value.id))}><FolderOpen size={15}/>{t("home.designs.reveal")}</button>
      </div>
    </div></Portal>;
  }
  /** The open design has unsaved edits: say why the rename waits, and offer Save and rename. */
  function SaveFirst(props: { id: string }) {
    let box: HTMLDivElement | undefined, primary: HTMLButtonElement | undefined;
    const [error, setError] = createSignal("");
    const cancel = () => { if (!working()) setSaveFirst(null); };
    useModal(() => box, cancel, () => primary);
    const go = async () => {
      if (working()) return;
      setWorking(true); setError("");
      let saved = false;
      try {
        if (await saveBeforeLeaving()) saved = true; else setError(t("home.designs.renameSaveFailed"));
      } catch (failure) { setError(explain(failure)); }
      finally { setWorking(false); }
      if (!saved) return;
      setSaveFirst(null);
      await new Promise((r) => setTimeout(r, 0)); // this dialog gives the focus back before the rename dialog takes it
      await openRename(props.id);
    };
    return <Portal><div class="scrim"><div ref={box} class="dialog home-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="home-savefirst-title" aria-describedby="home-savefirst-text" tabindex={-1}>
      <div class="dialog-head"><h2 id="home-savefirst-title">{t("home.designs.rename")}</h2><button type="button" class="icon-btn" aria-label={t("common.close")} disabled={working()} onClick={cancel}><X size={18}/></button></div>
      <div class="dialog-body"><p id="home-savefirst-text">{t("home.designs.renameUnsaved")}</p><p class="rp-error" role="status">{error()}</p></div>
      <div class="dialog-foot"><button class="btn" type="button" disabled={working()} onClick={cancel}>{t("common.cancel")}</button><button ref={primary} class="btn btn-primary" type="button" disabled={working()} onClick={() => void go()}>{t("home.designs.saveAndRename")}</button></div>
    </div></div></Portal>;
  }
  function Rename(props: { value: DesignFile }) {
    let box: HTMLFormElement | undefined, input: HTMLInputElement | undefined;
    const [name, setName] = createSignal(props.value.design.model.name), [error, setError] = createSignal("");
    const invalid = () => !name().trim() || name().trim().length > 80 || /[\x00-\x1f]/.test(name()) ? t("home.designs.renameInvalid")
      : entries().some(entry => entry.key !== props.value.id && entry.model?.name?.trim().toLowerCase() === name().trim().toLowerCase()) ? t("home.designs.renameDuplicate") : "";
    const unchanged = () => name().trim() === props.value.design.model.name;
    const cancel = () => { if (!working()) setRecord(null); };
    useModal(() => box, cancel, () => input);
    const save = async (event: SubmitEvent) => {
      event.preventDefault(); if (invalid() || working()) return;
      if (blocked(props.value.id)) { setError(t("home.designs.renameSaveFirst")); return; }
      if (unchanged()) { cancel(); return; }
      setWorking(true); setError("");
      try {
        const result = await api.renameDesign(props.value.id, name().trim(), props.value.hash, props.value.backup_scope);
        if (file()?.backup_scope === props.value.backup_scope) syncSavedDesignName(result.id, result.name, result.hash, props.value.hash);
        setUndo({ id: result.id, previous: result.previous_name, hash: result.hash, scope: props.value.backup_scope });
        await refreshModels(); setRecord(null); setNote(t("home.designs.renamed", { name: result.name }));
      } catch (failure) { setError(explain(failure)); }
      finally { setWorking(false); }
    };
    return <Portal><div class="scrim"><form ref={box} class="dialog home-rename-dialog" role="dialog" aria-modal="true" aria-labelledby="home-rename-title" tabindex={-1} autocomplete="off" onSubmit={save}>
      <div class="dialog-head"><h2 id="home-rename-title">{t("home.designs.rename")}</h2><button type="button" class="icon-btn" aria-label={t("common.close")} disabled={working()} onClick={cancel}><X size={18}/></button></div>
      <div class="dialog-body"><label class="field"><span>{t("home.newProject.name")}</span><input ref={input} disabled={working()} id="home-rename-name" autocomplete="off" class="field-text" value={name()} maxLength={80} aria-invalid={!!(invalid() || error())} aria-describedby="home-rename-hint" onInput={(event) => { setName(event.currentTarget.value); setError(""); }}/></label>
        <p class="note">{t("home.designs.renameNote")}</p><p id="home-rename-hint" class="rp-error" role="status">{invalid() || error()}</p></div>
      <div class="dialog-foot"><button class="btn" type="button" disabled={working()} onClick={cancel}>{t("common.cancel")}</button><button class="btn btn-primary" type="submit" disabled={working() || !!invalid() || unchanged()}>{t("home.designs.renameSave")}</button></div>
    </form></div></Portal>;
  }
  const open = (event: MouseEvent | KeyboardEvent, entry: Entry) => {
    event.preventDefault(); event.stopPropagation();
    const row = event.currentTarget as HTMLElement, rect = row.getBoundingClientRect();
    row.querySelector<HTMLElement>(".home-item")?.focus();
    setTarget({ id: entry.key, name: entry.model?.name ?? entry.key, broken: !!entry.error,
      x: event instanceof MouseEvent && event.clientX ? event.clientX : rect.left + 12,
      y: event instanceof MouseEvent && event.clientY ? event.clientY : rect.bottom });
  };
  /** The visible Rename button of a design row. */
  const rename = (entry: Entry) => { if (!entry.error && !working()) void beginRename(entry.key); };
  return { open, rename, keydown: (event: KeyboardEvent, entry: Entry) => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) open(event, entry); },
    View: () => <><Show when={target()} keyed>{value => <Menu value={value}/>}</Show><Show when={record()} keyed>{value => <Rename value={value}/>}</Show>
      <Show when={saveFirst()} keyed>{id => <SaveFirst id={id}/>}</Show></>,
    /** The outcome line of a rename or reveal, shown under the list of designs (not off-screen below the page). */
    Note: () => <>
      <Show when={note()}><p class="home-design-action-note" role="status">{note()} <Show when={undo()}><button class="btn btn-sm" disabled={working()} onClick={() => void undoRename()}>{t("ribbon.home.undo")}</button></Show></p></Show></> };
}
