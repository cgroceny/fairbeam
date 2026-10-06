import { onCleanup, onMount } from "solid-js";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { python } from "@codemirror/lang-python";
import { syntaxHighlighting } from "@codemirror/language";
import { theme, highlight } from "./codeTheme";

export default function PythonSourceView(props: { source: string }) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.source,
        extensions: [
          lineNumbers(), python(), syntaxHighlighting(highlight), theme,
          EditorState.readOnly.of(true), EditorView.editable.of(false),
          EditorView.contentAttributes.of({ "aria-label": "Read-only Python source", tabindex: "0" }),
        ],
      }),
    });
  });
  onCleanup(() => view?.destroy());
  return <div class="python-panel-code" ref={host} />;
}
