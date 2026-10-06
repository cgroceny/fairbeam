// CodeMirror 6 editor for model files. Lazy-loaded (its own chunk) by the Run panel's Code tab.
// Colours come from the design tokens through CSS variables, so light/dark follow the theme.
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { Compartment, EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { type Diagnostic, lintGutter, setDiagnostics } from "@codemirror/lint";
import { theme, highlight } from "./codeTheme";
import { docVersion, draft, file, registerJump, save, setDraft, validation } from "./store";

export default function CodeEditor(props: { ariaLabel: string }) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const readOnly = new Compartment();

  const readOnlyExt = (ro: boolean) => [EditorState.readOnly.of(ro), EditorView.editable.of(!ro)];

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: draft(),
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          lintGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          indentOnInput(),
          indentUnit.of("    "),
          bracketMatching(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          python(),
          syntaxHighlighting(highlight),
          theme,
          readOnly.of(readOnlyExt(!!file()?.readonly)),
          EditorView.contentAttributes.of({ "aria-label": props.ariaLabel }),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (save(), true) },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            ...foldKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDraft(u.state.doc.toString());
          }),
        ],
      }),
    });
    registerJump((line) => {
      if (!view) return;
      const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      view.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
      view.focus();
    });
    const onMenuHistory = (event: Event) => {
      if (!view) return;
      if ((event as CustomEvent<string>).detail === "redo") redo(view);
      else undo(view);
    };
    host.addEventListener("fairbeam:text-history", onMenuHistory);
    onCleanup(() => host.removeEventListener("fairbeam:text-history", onMenuHistory));
  });

  onCleanup(() => {
    registerJump(null);
    view?.destroy();
  });

  // replace the whole document when a file or an old version is loaded
  createEffect(on(docVersion, () => {
    if (!view) return;
    const text = draft();
    if (view.state.doc.toString() !== text) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, { defer: true }));

  createEffect(() => {
    const ro = !!file()?.readonly;
    view?.dispatch({ effects: readOnly.reconfigure(readOnlyExt(ro)) });
  });

  // server validation -> inline error marker at the failing line
  createEffect(() => {
    const v = validation();
    if (!view) return;
    const diags: Diagnostic[] = [];
    const loc = v?.error?.location;
    if (v && !v.valid && loc?.line) {
      const doc = view.state.doc;
      const line = doc.line(Math.max(1, Math.min(loc.line, doc.lines)));
      const from = loc.column ? Math.min(line.to, line.from + Math.max(0, loc.column - 1)) : line.from;
      diags.push({ from, to: Math.max(from + 1, line.to), severity: "error", message: v.error!.message, source: v.error!.stage === "build" ? "build()" : "load" });
    }
    view.dispatch(setDiagnostics(view.state, diags));
  });

  return <div class="code-editor" ref={host} />;
}
