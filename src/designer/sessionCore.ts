// In-memory designer session boundary. No runner, viewport, storage or window adapters are installed here.
import { batch, createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import type { DesignFile } from "../runner/api";
import type { Design, Selection } from "./types";
import type { Check } from "./checks";
import { paramValues } from "./expr";
import { inferLabel, mergesWithPrevious } from "./historyLabels";
import { DesignerAsyncState, newDesignerSessionId } from "./asyncState";

type HistoryEntry = { text: string; label: string; at: number; target: string };
export interface HistoryStep { index: number; label: string; at: number; target: string; current: boolean }
export interface HistoryMark { text: string; undo: string[]; redo: string[]; history: HistoryEntry[]; position: number; file: string | undefined; metadataRevision: number; sessionId: string; documentRevision: number }

export interface DesignerSessionEffects { edited?: () => void; restored?: () => void; disposed?: () => void }
export function createDesignerSession(effects: DesignerSessionEffects = {}) {
  const sessionId = newDesignerSessionId();
  let disposed = false;
  return createRoot(disposeRoot => {
    const [file, setFile] = createSignal<DesignFile | null>(null);
    const [draft, setDraft] = createStore<Design>({} as Design);
    const [selection, setSelection] = createSignal<Selection>({ type: "design" });
    const [loading, setLoading] = createSignal(false);
    const [saving, setSaving] = createSignal(false);
    const [message, setMessageRaw] = createSignal<{ tone: "good" | "warn" | "critical"; text: string } | null>(null);
    // A banner belongs to the moment it was shown: the next edit, undo or redo retires a success or an
    // error banner, and a change of the selection retires a success banner (a warning stays until it is
    // dealt with). "The same moment" is the same task: an action may set its banner before or after its
    // own edit or selection change, and a later user action (another task) retires it.
    let task = 0, ticking = false;
    const currentTask = () => {
      if (!ticking) { ticking = true; queueMicrotask(() => { task++; ticking = false; }); }
      return task;
    };
    let messageTask = -1;
    const setMessage = (next: ReturnType<typeof message>) => { messageTask = next ? currentTask() : -1; setMessageRaw(next); };
    function retireMessage(tones: readonly ("good" | "warn" | "critical")[]) {
      const m = message();
      if (!m || !tones.includes(m.tone) || messageTask === currentTask()) return;
      setMessage(null);
    }
    /** field errors from the last server build, keyed by JSON path ("parts[0].primitives[1].stop[2]") */
    const [serverErrors, setServerErrors] = createSignal<Record<string, string>>({});
    const [conflict, setConflict] = createSignal<string | null>(null);
    /** checks from the server's last preview / validation of the draft (fairbeam.design_checks) */
    const [serverChecks, setServerChecks] = createSignal<Check[]>([]);
    const [undoStack, setUndoStack] = createSignal<string[]>([]);
    const [redoStack, setRedoStack] = createSignal<string[]>([]);
    let history: HistoryEntry[] = [];
    let historyPosition = 0;
    const [historyRevision, setHistoryRevision] = createSignal(0);
    const notifyHistory = () => setHistoryRevision((n) => n + 1);
    let savedMetadataRevision = 0;
    const asyncState = new DesignerAsyncState(sessionId);
    createEffect(on(selection, () => retireMessage(["good"]), { defer: true }));
    const [checksTicket, setChecksTicket] = createSignal<ReturnType<typeof asyncState.ticket> | null>(null);
    const canUndo = () => undoStack().length > 0;
    const canRedo = () => redoStack().length > 0;

    const loaded = () => !!file() && !!draft.schema;
    const snapshot = () => JSON.stringify(unwrap(draft));
    function pythonSourceBase(d: Design): string {
      const copy = JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
      // Renaming or documenting the Design does not change its geometry or invalidate the imported
      // Python source. Keep the origin attached through these metadata edits.
      delete copy.model;
      delete copy.python_source_model;
      delete copy.python_source_hash;
      delete copy.parameter_sweep;
      delete copy.wcs; // the drawing frame is UI state saved with the design, not geometry
      return JSON.stringify(copy);
    }

    /** The draft as JSON, once per change: the dirty flag and the local backup both follow it. */
    const draftText = createMemo(() => (loaded() ? JSON.stringify(draft) : ""));

    const dirty = createMemo(() => {
      const f = file();
      // track the whole draft: any nested edit re-evaluates
      return !!f && loaded() && draftText() !== JSON.stringify(f.design);
    });

    let lastKey = "";
    let lastAt = 0;
    let lastEl: unknown = null;
    type EditObserver = (before: Design, after: Design) => void;
    let postEditObserver: EditObserver | null = null;
    let documentChangeObserver: (() => void) | null = null;
    let observedHistory: { before: string; after: string; undo: string[]; redo: string[]; history: typeof history; position: number } | null = null;
    /** Boolean UI registers here so the store remains independent of Boolean UI. */
    function registerPostEditObserver(observer: EditObserver | null) { if (!disposed) postEditObserver = observer; }
    function registerDocumentChangeObserver(observer: (() => void) | null) { if (!disposed) documentChangeObserver = observer; }
    /** `before`: the design before this edit, so derived geometry can tell a hand edit of its own
     * result (in this edit) from a draft restored by undo, redo or a history jump. */
    type DeriveHook = (d: Design, values: Record<string, number>, before: Design) => void;
    let deriveHook: DeriveHook | null = null;
    /** Geometry derived from other geometry (live Boolean results) is brought up to date inside every
     * edit, so it is part of the same undo step. */
    function registerDeriveHook(hook: DeriveHook | null) { if (!disposed) deriveHook = hook; }
    /** Revert an overlap-triggering edit only while it is still the current draft. */
    function revertObservedEdit(before: Design, after: Design): boolean {
      if (disposed) return false;
      const beforeText = JSON.stringify(before), afterText = JSON.stringify(after);
      if (snapshot() !== afterText || observedHistory?.before !== beforeText || observedHistory.after !== afterText) return false;
      setUndoStack(observedHistory.undo);
      setRedoStack(observedHistory.redo);
      history = observedHistory.history;
      historyPosition = observedHistory.position;
      notifyHistory();
      observedHistory = null;
      restore(JSON.stringify(before));
      return true;
    }

    /** The status a successful save showed ("Saved.", "Saved with 2 warnings …"). */
    let saveNote: ReturnType<typeof message> = null;
    let saveNoteTimer: ReturnType<typeof setTimeout> | undefined;
    let saveNoteDocument: ReturnType<typeof asyncState.ticket> | null = null;
    function showSaveNote(note: NonNullable<ReturnType<typeof message>>) {
      if (disposed) return;
      clearTimeout(saveNoteTimer);
      saveNoteDocument = asyncState.ticket();
      saveNote = note;
      setMessage(note);
      const timer = setTimeout(() => {
        if (saveNote === note && message() === note && saveNoteDocument && asyncState.isDocumentCurrent(saveNoteDocument)) setMessage(null);
        if (saveNote === note) {
          saveNote = null;
          saveNoteDocument = null;
        }
        if (saveNoteTimer === timer) saveNoteTimer = undefined;
      }, 5000);
      saveNoteTimer = timer;
    }
    /** The draft changed after a save or create: retire only that transient success note. */
    function retireSaveNote() {
      clearTimeout(saveNoteTimer);
      saveNoteTimer = undefined;
      if (saveNote && message() === saveNote) setMessage(null);
      saveNote = null;
      saveNoteDocument = null;
    }

    /** Change the draft. Edits to the same field of the same object within 1.5 s, or while one text
     * input keeps the focus (typing), are one undo step. `label` names the step; without it the label is
     * inferred from the change (historyLabels.ts). */
    function historyTarget(key: string): string {
      if (key) return key;
      const s = selection();
      return s.type === "part" || s.type === "primitive" ? `parts[${s.i}]${s.type === "primitive" ? `.primitives[${s.j}]` : ""}` : s.type;
    }

    function historySteps(): HistoryStep[] {
      historyRevision();
      return history.map(({ label, at, target }, index) => ({ index, label, at, target, current: index === historyPosition }));
    }
    /** The label of the step Undo would undo, and of the one Redo would redo ("" when there is none). */
    function undoLabel(): string { historyRevision(); return undoStack().length ? history[historyPosition]?.label ?? "" : ""; }
    function redoLabel(): string { historyRevision(); return redoStack().length ? history[historyPosition + 1]?.label ?? "" : ""; }
    function historyIndex(): number { historyRevision(); return historyPosition; }
    function historyDesign(index: number): Design | null {
      const entry = history[index];
      if (!entry) return null;
      try { return JSON.parse(entry.text) as Design; } catch { return null; }
    }
    function goToHistory(index: number) {
      if (disposed) return;
      if (!Number.isInteger(index) || index < 0 || index >= history.length) return;
      while (historyPosition > index) undo();
      while (historyPosition < index) redo();
    }

    function edit(fn: (d: Design) => void, key = "", label?: string) {
      if (disposed) return;
      const beforeText = snapshot();
      const linkedPythonBase = draft.python_source_model ? pythonSourceBase(unwrap(draft) as Design) : null;
      const undoBefore = undoStack(), redoBefore = redoStack();
      const historyBefore = [...history], positionBefore = historyPosition;
      const now = Date.now();
      // The incumbent editor coalesces typing by the active DOM input. No DOM listener is installed.
      const active = typeof document === "undefined" ? null : document.activeElement;
      const coalesced = mergesWithPrevious({ key: lastKey, at: lastAt, el: lastEl }, key, now, active);
      if (!coalesced) {
        setUndoStack((s) => [...s.slice(-99), snapshot()]);
      }
      lastKey = key;
      lastAt = now;
      lastEl = active;
      setRedoStack([]);
      asyncState.editDraft();
      setDraft(produce((d) => {
        fn(d);
        // Parameter sweeps are designer metadata and do not change what the source script builds.
        // Any other content edit detaches the imported script so reopening Python shows this Design.
        if (linkedPythonBase !== null && pythonSourceBase(d) !== linkedPythonBase) {
          delete d.python_source_model;
          delete d.python_source_hash;
        }
      }));
      if (deriveHook) {
        // the parameter values of this edit (the names memo may not have caught up yet)
        const hook = deriveHook, values = paramValues(draft.params ?? []).names, before = JSON.parse(beforeText) as Design;
        setDraft(produce((d) => hook(d, values, before)));
      }
      const target = historyTarget(key), next = { text: snapshot(), label: label ?? inferLabel(JSON.parse(beforeText) as Design, JSON.parse(snapshot()) as Design, key), at: now, target };
      if (coalesced && historyPosition === history.length - 1) history[historyPosition] = next;
      else {
        history = [...history.slice(0, historyPosition + 1), next];
        if (history.length > 101) history.shift();
        historyPosition = history.length - 1;
      }
      notifyHistory();
      observedHistory = { before: beforeText, after: snapshot(), undo: undoBefore, redo: redoBefore, history: historyBefore, position: positionBefore };
      if (postEditObserver) postEditObserver(JSON.parse(beforeText) as Design, JSON.parse(observedHistory.after) as Design);
      if (disposed) return; // an observer may close its owning session synchronously
      retireSaveNote();
      retireMessage(["good", "critical"]);
      effects.edited?.();
    }

    function restore(text: string) {
      if (disposed) return;
      asyncState.editDraft();
      setDraft(reconcile(JSON.parse(text) as Design));
      retireSaveNote();
      lastKey = "";
      const s = selection();
      // keep the selection only if it still exists
      const d = draft;
      const ok =
        s.type === "design" || s.type === "simulation" ||
        (s.type === "param" && d.params[s.i]) || (s.type === "material" && d.materials[s.i]) ||
        (s.type === "part" && d.parts[s.i]) || (s.type === "primitive" && d.parts[s.i]?.primitives[s.j]) ||
        (s.type === "port" && d.ports[s.i]) || (s.type === "resistor" && d.resistors[s.i]);
      if (!ok) setSelection({ type: "design" });
      retireMessage(["good", "critical"]);
      effects.restored?.();
    }

    /** The design and its edit history at one moment: a dialog whose edits apply live takes one when it
     * opens, and Cancel goes back to it as if nothing had been edited (no extra undo step, the redo
     * stack as it was). */

    function historyMark(): HistoryMark {
      return { text: snapshot(), undo: undoStack(), redo: redoStack(), history: [...history], position: historyPosition, file: file()?.id, metadataRevision: savedMetadataRevision, sessionId, documentRevision: asyncState.ticket().document };
    }
    /** Whether the draft differs from the mark. */
    const changedSince = (mark: HistoryMark) => snapshot() !== mark.text;
    /** Go back to the mark. Refuse another design or metadata superseded by a saved rename. */
    function rollbackTo(mark: HistoryMark): boolean {
      if (disposed || mark.sessionId !== sessionId || mark.documentRevision !== asyncState.ticket().document || file()?.id !== mark.file || mark.metadataRevision !== savedMetadataRevision) return false;
      setUndoStack(mark.undo);
      setRedoStack(mark.redo);
      history = mark.history;
      historyPosition = mark.position;
      notifyHistory();
      if (snapshot() !== mark.text) restore(mark.text);
      return true;
    }

    /** A Home rename changes saved metadata, not the geometry edits Undo/Redo represent. */
    function syncSavedDesignName(id: string, name: string, hash: string, baseHash: string): boolean {
      if (disposed) return false;
      const current = file();
      if (current?.id !== id || dirty() || current.hash !== baseHash) return false;
      // An unchanged saved name must not erase earlier designer-name edits or invalidate marks.
      if (name === draft.model.name && name === current.design.model.name && hash === current.hash) return true;
      const rebase = (text: string) => {
        const design = JSON.parse(text) as Design;
        design.model.name = name;
        return JSON.stringify(design);
      };
      const entries = (list: HistoryEntry[]) => list.map(entry => ({ ...entry, text: rebase(entry.text) }));
      batch(() => {
        setUndoStack(stack => stack.map(rebase));
        setRedoStack(stack => stack.map(rebase));
        history = entries(history);
        if (observedHistory) observedHistory = {
          ...observedHistory, before: rebase(observedHistory.before), after: rebase(observedHistory.after),
          undo: observedHistory.undo.map(rebase), redo: observedHistory.redo.map(rebase), history: entries(observedHistory.history),
        };
        setDraft("model", "name", name);
        setFile({ ...current, hash, design: { ...current.design, model: { ...current.design.model, name } } });
        savedMetadataRevision++;
        lastKey = ""; lastAt = 0; lastEl = null;
        notifyHistory();
      });
      return true;
    }

    function undo() {
      if (disposed) return;
      const s = undoStack();
      if (!s.length) return;
      lastKey = "";
      setRedoStack((r) => [...r, snapshot()]);
      setUndoStack(s.slice(0, -1));
      restore(s[s.length - 1]);
      historyPosition = Math.max(0, historyPosition - 1);
      notifyHistory();
    }

    function redo() {
      if (disposed) return;
      const r = redoStack();
      if (!r.length) return;
      lastKey = "";
      setUndoStack((s) => [...s, snapshot()]);
      setRedoStack(r.slice(0, -1));
      restore(r[r.length - 1]);
      historyPosition = Math.min(history.length - 1, historyPosition + 1);
      notifyHistory();
    }


    function resetHistory(design?: Design) {
      if (disposed) return;
      setUndoStack([]); setRedoStack([]);
      history = design ? [{ text: JSON.stringify(design), label: "Initial state", at: Date.now(), target: "design" }] : [];
      historyPosition = 0; observedHistory = null;
      lastKey = ""; lastAt = 0; lastEl = null;
      notifyHistory();
    }
    function takeFile(next: DesignFile) {
      if (disposed) return;
      documentChangeObserver?.();
      if (disposed) return;
      const previous = file();
      forgetSaveNote();
      asyncState.replaceDocument();
      batch(() => {
        setFile(next);
        // Keep JSON key order independent when replacing a different document.
        if (previous?.id !== next.id) setDraft(reconcile({} as Design));
        setDraft(reconcile(structuredClone(next.design)));
        resetHistory(next.design);
        setServerErrors({}); setServerChecks([]); setChecksTicket(null);
        setConflict(null); setSelection({ type: "design" }); setSaving(false);
      });
    }
    function restoreBackup(design: Design, at: number) {
      if (disposed || !file()) return;
      setUndoStack([JSON.stringify(file()!.design)]);
      setDraft(reconcile(structuredClone(design)));
      history.push({ text: JSON.stringify(design), label: "Restored backup", at, target: "design" });
      historyPosition = 1; notifyHistory();
    }
    function forgetSaveNote() {
      clearTimeout(saveNoteTimer); saveNoteTimer = undefined; saveNote = null; saveNoteDocument = null;
    }
    function dispose() {
      if (disposed) return;
      disposed = true; asyncState.dispose(); forgetSaveNote();
      postEditObserver = null; documentChangeObserver = null; deriveHook = null; observedHistory = null;
      setUndoStack([]); setRedoStack([]); history = []; historyPosition = 0;
      notifyHistory();
      setFile(null); setDraft(reconcile({} as Design)); setSelection({ type: "design" });
      setMessage(null); setServerErrors({}); setServerChecks([]); setChecksTicket(null); setConflict(null); setSaving(false); setLoading(false);
      disposeRoot(); effects.disposed?.();
    }
    const guarded = <T extends (...args: never[]) => unknown>(fn: T): T => ((...args: Parameters<T>) => {
      if (!disposed) return fn(...args);
    }) as T;
    return {
      sessionId, asyncState, dispose, isDisposed: () => disposed,
      file, setFile: guarded(setFile), draft, setDraft: guarded(setDraft), selection, setSelection: guarded(setSelection),
      loading, setLoading: guarded(setLoading), saving, setSaving: guarded(setSaving), message, setMessage: guarded(setMessage),
      serverErrors, setServerErrors: guarded(setServerErrors), conflict, setConflict: guarded(setConflict), serverChecks, setServerChecks: guarded(setServerChecks),
      loaded, snapshot, draftText, dirty, canUndo, canRedo, edit, undo, redo, historySteps, undoLabel, redoLabel, historyIndex, historyDesign, goToHistory,
      historyMark, changedSince, rollbackTo, syncSavedDesignName, revertObservedEdit,
      registerPostEditObserver, registerDocumentChangeObserver, registerDeriveHook,
      notifyDocumentChange: () => { if (!disposed) documentChangeObserver?.(); },
      takeFile, resetHistory, restoreBackup, showSaveNote, retireSaveNote, forgetSaveNote,
      checksTicket, setChecksTicket: guarded(setChecksTicket),
    };
  });
}
