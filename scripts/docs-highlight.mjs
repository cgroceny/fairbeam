// Build-time highlighting only: these grammars never enter the browser bundle.
import hljs from "highlight.js/lib/core";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import powershell from "highlight.js/lib/languages/powershell";
import json from "highlight.js/lib/languages/json";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import ini from "highlight.js/lib/languages/ini";
import plaintext from "highlight.js/lib/languages/plaintext";

for (const [name, grammar] of Object.entries({ python, bash, powershell, json, typescript, javascript, ini, plaintext })) {
  hljs.registerLanguage(name, grammar);
}
// Shell fences in the docs contain commands rather than interactive transcripts.
hljs.registerAliases("shell", { languageName: "bash" });

/** Unknown and unlabeled fences stay plain; never guess a language from their contents. */
export function highlightCode(text, language) {
  return language && hljs.getLanguage(language)
    ? hljs.highlight(text, { language, ignoreIllegals: true }).value
    : text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
