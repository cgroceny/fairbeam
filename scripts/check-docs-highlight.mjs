#!/usr/bin/env node
// Exercise the actual Markdown renderer, including escaping and copyable code text.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDocsSite } from "./docs-render.mjs";

const cases = [
  ["python", 'def model():\n    return "<part>&" # example'],
  ["py", "return 1"],
  ["bash", 'echo "$HOME" # example'],
  ["sh", 'echo "$HOME" # example'],
  ["shell", 'echo "$HOME" # example'],
  ["powershell", '$value = "<part>&" # example'],
  ["pwsh", '$value = "example"'],
  ["json", '{"part": "<part>&", "count": 1}'],
  ["typescript", 'const count: number = 1;'],
  ["ts", 'const count: number = 1;'],
  ["javascript", 'const name = "example";'],
  ["js", 'const name = "example";'],
  ["toml", '[model]\nname = "example"'],
  ["ini", '[model]\nname = "example"'],
  ["python title=example", "return 1"],
  ["text", '<script>alert("x")</script>&'],
  ["plaintext", '<part>& "value"'],
  ["txt", '<part>& "value"'],
  ["unknown-fence", 'const value = "<script>&";'],
  ["", 'const value = "<script>&";'],
];
const root = mkdtempSync(join(tmpdir(), "fairbeam-docs-highlight-"));
try {
  mkdirSync(join(root, "landing"));
  mkdirSync(join(root, "landing-src"));
  writeFileSync(join(root, "landing/docs.json"), JSON.stringify({
    site: "https://example.org", repo: "https://example.org/repo", branch: "main",
    groups: [{ title: "Reference", pages: [{ source: "sample.md", slug: "sample", title: "Sample", description: "Sample" }] }],
  }));
  writeFileSync(join(root, "landing-src/docs-page.html"), readFileSync(new URL("../landing-src/docs-page.html", import.meta.url)));
  writeFileSync(join(root, "sample.md"), '# Sample\n\nInline `return "<part>&"` stays plain.\n\n' +
    cases.map(([lang, code]) => `\`\`\`${lang}\n${code}\n\`\`\`\n`).join("\n"));
  const result = renderDocsSite(root);
  assert.deepEqual(result.problems, []);
  const html = result.files.find((f) => f.path === "docs/sample.html").html;
  const blocks = [...html.matchAll(/<div class="doc-code"><pre><code[^>]*>([\s\S]*?)<\/code><\/pre><\/div>/g)];
  assert.equal(blocks.length, cases.length);
  blocks.forEach(([ , content], i) => {
    const [lang, source] = cases[i];
    const text = content.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#x27|#39);/g,
      (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" })[entity]);
    assert.equal(text, source, `${lang}: code.textContent must preserve the source for Copy`);
    assert.equal(content.includes('class="hljs-'), i < 15, `${lang}: explicit highlighting or plain fallback`);
    assert.ok(!content.includes("<script>"), `${lang}: escape markup`);
  });
  assert.ok(html.includes('<code>return &quot;&lt;part&gt;&amp;&quot;</code>'), "inline code stays unchanged");
  assert.ok(!/<script[^>]+(?:highlight|hljs)/i.test(html), "no client highlighter");
  console.log(`check-docs-highlight: ${cases.length} fences, escaping, copyable text and inline code OK`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
