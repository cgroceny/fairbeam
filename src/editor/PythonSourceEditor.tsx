// The Python panel's Edit mode: the script in a CodeMirror editor (line numbers, Tab indent, Python
// highlighting). Lazy-loaded with the read-only view's chunk. `text` is the model of the editor: a
// change made from outside (the regenerated script after Apply) replaces the document.
import { createEffect, on, onCleanup, onMount } from "solid-js";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { type Diagnostic, lintGutter, setDiagnostics } from "@codemirror/lint";
import { theme, highlight } from "./codeTheme";

export interface ScriptError { line: number; message: string }

export default function PythonSourceEditor(props: {
  text: string;
  ariaLabel: string;
  error: ScriptError | null;
  onChange: (text: string) => void;
  onApply: () => void;
}) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  const mark = (error: ScriptError | null) => {
    if (!view) return;
    const diagnostics: Diagnostic[] = [];
    if (error) {
      const line = view.state.doc.line(Math.max(1, Math.min(error.line, view.state.doc.lines)));
      diagnostics.push({ from: line.from, to: Math.max(line.to, Math.min(line.from + 1, view.state.doc.length)), severity: "error", message: error.message });
      view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    }
    view.dispatch(setDiagnostics(view.state, diagnostics));
  };
  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.text,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), lintGutter(), history(), drawSelection(), indentOnInput(),
          indentUnit.of("    "), bracketMatching(), highlightActiveLine(), python(), syntaxHighlighting(highlight), theme,
          EditorView.contentAttributes.of({ "aria-label": props.ariaLabel }),
          keymap.of([
            { key: "Mod-Enter", preventDefault: true, run: () => (props.onApply(), true) },
            indentWithTab, ...defaultKeymap, ...historyKeymap,
          ]),
          EditorView.updateListener.of((u) => { if (u.docChanged) props.onChange(u.state.doc.toString()); }),
        ],
      }),
    });
    (host as HTMLDivElement & { cmView?: EditorView }).cmView = view; // for the scenario checks
    mark(props.error);
  });
  createEffect(on(() => props.text, (text) => {
    if (view && text !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, { defer: true }));
  createEffect(on(() => props.error, (error) => mark(error), { defer: true }));
  onCleanup(() => view?.destroy());
  return <div class="python-panel-code python-panel-editor" ref={host} />;
}
