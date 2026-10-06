import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--al-surface)", color: "var(--al-text)", fontSize: "var(--al-text-sm)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--al-font-mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--al-focus)", padding: "var(--al-space-2) 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--al-focus)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--al-selection)",
  },
  ".cm-activeLine": { backgroundColor: "var(--al-code-active-line)" },
  ".cm-gutters": { backgroundColor: "var(--al-surface-2)", color: "var(--al-text-3)", border: "none", borderRight: "1px solid var(--al-border)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--al-surface-3)", color: "var(--al-text)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 var(--al-space-2) 0 var(--al-space-3)", minWidth: "32px" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--al-surface-3)", border: "none", color: "var(--al-text-2)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "var(--al-accent-soft)", outline: "1px solid var(--al-accent-line)" },
  ".cm-selectionMatch": { backgroundColor: "var(--al-code-match)" },
  ".cm-searchMatch": { backgroundColor: "var(--al-code-match)", outline: "1px solid var(--al-accent-line)" },
  ".cm-panels": { backgroundColor: "var(--al-surface-2)", color: "var(--al-text)", borderColor: "var(--al-border)" },
  ".cm-panels input, .cm-panels button": { fontFamily: "var(--al-font-sans)", fontSize: "var(--al-text-sm)" },
  ".cm-textfield": { backgroundColor: "var(--al-surface)", border: "1px solid var(--al-border-strong)", borderRadius: "var(--al-radius-sm)", color: "var(--al-text)" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--al-surface)", border: "1px solid var(--al-border)", borderRadius: "var(--al-radius-sm)", color: "var(--al-text)" },
  ".cm-tooltip": { backgroundColor: "var(--al-surface)", border: "1px solid var(--al-border)", borderRadius: "var(--al-radius)", boxShadow: "var(--al-shadow-pop)" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--al-critical)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--al-critical)", textUnderlineOffset: "3px" },
  ".cm-lint-marker-error": { content: "none" },
});

export const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--al-code-keyword)" },
  { tag: [t.bool, t.null, t.self], color: "var(--al-code-keyword)" },
  { tag: [t.number], color: "var(--al-code-number)" },
  { tag: [t.string, t.special(t.string)], color: "var(--al-code-string)" },
  { tag: [t.comment, t.lineComment, t.docString], color: "var(--al-code-comment)", fontStyle: "italic" },
  { tag: [t.function(t.definition(t.variableName)), t.definition(t.className)], color: "var(--al-text)", fontWeight: "600" },
  { tag: [t.propertyName, t.attributeName], color: "var(--al-code-property)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--al-text-2)" },
  { tag: t.invalid, color: "var(--al-critical)" },
]);

