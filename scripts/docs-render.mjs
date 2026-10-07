// The documentation section of the site: renders the Markdown files listed in landing/docs.json
// into site-dist/docs/<slug>.html and docs/tr/<slug>.html, with an overview in each language, inside the page
// frame of landing-src/docs-page.html (the site's header and footer). The Markdown files stay the
// single source; nothing here is written back to them.
//
// Links are rewritten for the site: a link to another published file goes to its page (the
// #fragment is kept; translated headings retain the English IDs, so existing anchors keep working),
// a link into landing/ goes to that site path, and a link to any other file of the repository goes
// to that file on GitHub. Images from landing/media/ use the site's /media/; other images are copied
// next to the pages under docs/img/, except those the manifest lists under hideImages (outdated
// screenshots the site leaves out). A link to a file that does not exist, or to a heading that a
// published page does not have, is a problem: scripts/build-site.mjs fails on it and
// scripts/check-links.mjs reports it.
//
// Used by scripts/build-site.mjs (writes the pages) and scripts/check-links.mjs (checks them).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { Marked } from "marked";
import { externalLinksInHtml } from "./site-links.mjs";
import { highlightCode } from "./docs-highlight.mjs";
import { globToRegExp } from "./lib/tracked-files.mjs";

export const MANIFEST = "landing/docs.json";
export const TEMPLATE = "landing-src/docs-page.html";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|#39|nbsp);/gi, (m, e) => {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " }[e.toLowerCase()];
  if (named) return named;
  return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
const withoutLinkHints = (html) => html.replace(/<span class="visually-hidden" data-i18n="on">[\s\S]*?<\/span>/g, "");
const plainText = (html) => decode(withoutLinkHints(html).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/** The manifest, checked: every page has a source that exists, a unique slug, a title and a description. */
export function loadManifest(root) {
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
  const problems = [];
  const slugs = new Set();
  const sources = new Set();
  for (const key of ["site", "repo", "branch"]) if (typeof manifest[key] !== "string" || !manifest[key]) problems.push(`${MANIFEST}: "${key}" is missing`);
  if (!Array.isArray(manifest.groups) || !manifest.groups.length) problems.push(`${MANIFEST}: no groups`);
  for (const group of manifest.groups ?? []) {
    if (!group.title) problems.push(`${MANIFEST}: a group without a title`);
    if (!Array.isArray(group.pages) || !group.pages.length) problems.push(`${MANIFEST}: group "${group.title}" has no pages`);
    for (const page of group.pages ?? []) {
      const where = `${MANIFEST}: ${page.source ?? page.slug ?? "a page"}`;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(page.slug ?? "") || page.slug === "index") problems.push(`${where}: slug "${page.slug}" must be lower-case words joined by hyphens, and not "index"`);
      else if (slugs.has(page.slug)) problems.push(`${where}: slug "${page.slug}" is used twice`);
      slugs.add(page.slug);
      if (typeof page.source !== "string" || !page.source.endsWith(".md") || !existsSync(join(root, page.source))) problems.push(`${where}: source file not found`);
      else if (sources.has(page.source)) problems.push(`${where}: published twice`);
      sources.add(page.source);
      if (!page.title) problems.push(`${where}: no title`);
      if (!page.description) problems.push(`${where}: no description`);
    }
  }
  for (const h of manifest.hideImages ?? []) {
    if (typeof h?.path !== "string" || !h.reason) problems.push(`${MANIFEST}: every hideImages entry needs a path and a reason`);
  }
  const pages = (manifest.groups ?? []).flatMap((group) => (group.pages ?? []).map((page) => ({ ...page, group: group.title, groupTr: group.titleTr })));
  return { manifest, pages, problems };
}

/** Heading ids as GitHub makes them: lower case, punctuation dropped, spaces to hyphens, "-1", "-2" for repeats. */
export function slugger() {
  const seen = new Set();
  return (text) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    let slug = base;
    for (let n = 1; seen.has(slug); n++) slug = `${base}-${n}`;
    seen.add(slug);
    return slug;
  };
}

/**
 * The paths .vercelignore keeps out of the deploy build (python/, src-tauri/, ...). There a link into
 * them cannot be checked, so it goes to GitHub as it is.
 */
function deployIgnored(root) {
  const file = join(root, ".vercelignore");
  if (!existsSync(file)) return () => false;
  const patterns = readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
    .map((p) => p.replace(/^\//, ""))
    .map((p) => globToRegExp(p.endsWith("/") ? `${p}**` : p.includes("/") ? p : `**/${p}`));
  return (path) => patterns.some((re) => re.test(path));
}

/** Width and height of a PNG or JPEG, so the page reserves the space before the image loads. */
function imageSize(file) {
  const b = readFileSync(file);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

// Raw HTML in the Markdown: these tags are kept, any other tag is shown as text (GitHub drops unknown
// tags, which would lose a placeholder such as "<part>" written outside code), and comments are dropped.
const HTML_TAGS = new Set("a abbr b br code dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p picture pre q s samp small source span strong sub summary sup table tbody td tfoot th thead tr u ul var video".split(" "));
const keepHtml = (text) => text
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/<\/?([a-zA-Z][\w-]*)\b[^>]*>/g, (tag, name) => (HTML_TAGS.has(name.toLowerCase()) ? tag : esc(tag)));

/**
 * Render one Markdown file. `published` maps repository paths to slugs. Returns the title (the first
 * level-1 heading), the body HTML without it, the h2/h3 headings for the contents list, every id,
 * the cross-page anchors to verify, the images to copy and the problems found.
 */
function renderMarkdown(root, source, { published, titles, repo, branch, hidden, ignored, baseSource = source, headingIds, language = "en" }) {
  const text = readFileSync(join(root, source), "utf8");
  const slug = slugger();
  const ids = new Set();
  const headings = [];
  const headingDepths = [];
  const codeBlocks = [];
  const anchors = [];
  const images = [];
  const hiddenUsed = new Set();
  const problems = [];
  let headingIndex = 0;
  let title = null;
  let linkTarget = null;

  const ghUrl = (path, dir, frag) => `${repo}/${dir ? "tree" : "blob"}/${branch}/${path.split("/").map(encodeURIComponent).join("/")}${frag}`;
  const rewrite = (href, isImage) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return href;
    const hash = href.indexOf("#");
    const path = hash < 0 ? href : href.slice(0, hash);
    const frag = hash < 0 ? "" : href.slice(hash);
    if (!path) {
      if (frag.length > 1) anchors.push({ page: null, frag: frag.slice(1), href });
      return href;
    }
    let target;
    try {
      target = posix.normalize(path.startsWith("/") ? path.slice(1) : posix.join(posix.dirname(baseSource), decodeURI(path))).replace(/\/$/, "");
    } catch {
      problems.push(`${source}: malformed link ${href}`);
      return href;
    }
    // a folder the deploy build leaves out (.vercelignore): link to GitHub unchecked; a full
    // checkout (local builds, scripts/check-links.mjs) still checks that the file exists
    if (!isImage && !target.startsWith("..") && !existsSync(join(root, target)) && ignored(target)) return ghUrl(target, path.endsWith("/"), frag);
    if (target.startsWith("..") || !existsSync(join(root, target))) {
      problems.push(`${source}: missing ${href}`);
      return href;
    }
    if (isImage) {
      if (hidden.has(target)) {
        hiddenUsed.add(target);
        return null;
      }
      if (target.startsWith("landing/media/")) return `${language === "tr" ? "../../" : "../"}media/${target.slice("landing/media/".length)}`;
      const to = `img/${target.startsWith("docs/") ? target.slice("docs/".length) : target}`;
      images.push({ from: target, to: `docs/${to}` });
      return language === "tr" ? `../${to}` : to;
    }
    if (published.has(target)) {
      linkTarget = target;
      if (frag.length > 1) anchors.push({ page: published.get(target), frag: frag.slice(1), href });
      return `${published.get(target)}.html${frag}`;
    }
    if (target.startsWith("landing/")) return `${language === "tr" ? "../../" : "../"}${target.slice("landing/".length)}${frag}`;
    return ghUrl(target, statSync(join(root, target)).isDirectory(), frag);
  };

  const marked = new Marked({
    gfm: true,
    walkTokens(token) {
      if (token.type === "link") {
        linkTarget = null;
        token.href = rewrite(token.href, false);
        // a link whose text is the file name of a published page shows that page's title instead
        const only = token.tokens?.length === 1 ? token.tokens[0] : null;
        const label = only && (only.type === "text" || only.type === "codespan") ? only.text : "";
        if (linkTarget && /\.md$/i.test(label) && label.split("/").pop().toLowerCase() === linkTarget.split("/").pop().toLowerCase()) {
          const t = titles.get(linkTarget);
          token.tokens = [{ type: "text", raw: t, text: t }];
        }
        for (const child of token.tokens ?? []) if (child.type === "image") child.inLink = true;
      } else if (token.type === "image") {
        const href = rewrite(token.href, true);
        if (href === null) token.hidden = true;
        else token.href = href;
      }
    },
    renderer: {
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        return externalLinksInHtml(`<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""}>${inner}</a>`, language);
      },
      heading({ tokens, depth }) {
        headingDepths.push(depth);
        const inner = this.parser.parseInline(tokens);
        const id = headingIds?.[headingIndex++] ?? slug(plainText(inner));
        ids.add(id);
        if (depth === 1 && title === null) {
          title = { id, html: inner, text: plainText(inner) };
          return "";
        }
        if (depth === 2 || depth === 3) headings.push({ depth, id, html: withoutLinkHints(inner).replace(/<\/?a\b[^>]*>/g, "") });
        return `<h${depth} id="${id}">${inner}<a class="doc-anchor" href="#${id}" aria-hidden="true" tabindex="-1"></a></h${depth}>\n`;
      },
      html({ text }) {
        return keepHtml(text);
      },
      code({ text, lang }) {
        codeBlocks.push({ text, lang: lang ?? "" });
        const language = (lang ?? "").match(/^\S*/)[0];
        return `<div class="doc-code"><pre><code${language ? ` class="language-${esc(language)}"` : ""}>${highlightCode(text.replace(/\n$/, ""), language)}</code></pre></div>\n`;
      },
      image({ href, title: imageTitle, text: alt, inLink, hidden: leftOut }) {
        if (leftOut) return "";
        let size = "";
        const imageHref = language === "tr" ? href.replace(/^\.\.\//, "") : href;
        const mediaPrefix = language === "tr" ? "../../media/" : "../media/";
        if (imageHref.startsWith("img/") || href.startsWith(mediaPrefix)) {
          const file = imageHref.startsWith("img/") ? images.find((i) => i.to === `docs/${imageHref}`)?.from : `landing/media/${href.slice(mediaPrefix.length)}`;
          const dims = file ? imageSize(join(root, file)) : null;
          // a portrait screenshot (a phone, a narrow panel) is shown at most 360 px wide, as on a phone
          if (dims) size = ` width="${dims.width}" height="${dims.height}"${dims.height > dims.width ? ' class="doc-portrait"' : ""}`;
        }
        const img = `<img src="${esc(href)}" alt="${esc(alt)}"${imageTitle ? ` title="${esc(imageTitle)}"` : ""}${size} loading="lazy" decoding="async">`;
        return inLink ? img : `<a class="doc-image" href="${esc(href)}">${img}</a>`;
      },
    },
  });
  const body = externalLinksInHtml(marked.parse(text), language)
    // wide tables scroll inside their own box instead of widening the page
    .replace(/<table>/g, '<div class="doc-table"><table>').replace(/<\/table>/g, "</table></div>")
    // a paragraph that held only a left-out image
    .replace(/<p>\s*<\/p>\n?/g, "");
  if (!title) problems.push(`${source}: no level-1 heading for the page title`);
  return { title, body, headings, headingDepths, codeBlocks, ids, anchors, images, hiddenUsed, problems };
}

/** The sidebar: the overview, then every group with its pages; the current page is marked. */
function sidebar(groups, current) {
  const groupSlug = slugger();
  const here = current ? groups.flatMap((g) => g.pages).find((p) => p.slug === current) : null;
  const list = groups.map((group) => {
    const id = `docs-group-${groupSlug(group.title)}`;
    const links = group.pages.map((p) => `<li><a href="${p.slug}.html"${p.slug === current ? ' aria-current="page"' : ""} lang="en" data-i18n="off">${esc(p.title)}</a></li>`).join("\n            ");
    return `<div class="docs-nav-group">
          <p class="docs-nav-title" id="${id}">${esc(group.title)}</p>
          <ul aria-labelledby="${id}">
            ${links}
          </ul>
        </div>`;
  }).join("\n        ");
  return `<nav class="docs-nav" aria-label="Documentation">
      <button class="docs-nav-toggle" type="button" aria-expanded="true" aria-controls="docs-nav-list" hidden>
        <svg class="docs-nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
        <span class="docs-nav-label">Documentation</span>
        <span class="docs-nav-here"${here ? ' lang="en" data-i18n="off"' : ""}>${here ? esc(here.title) : "Overview"}</span>
        <svg class="docs-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="docs-nav-list" id="docs-nav-list">
        <a class="docs-nav-home" href="./"${current ? "" : ' aria-current="page"'}>Overview</a>
        ${list}
      </div>
    </nav>`;
}

/** "On this page": the h2 and h3 headings, h3 nested under their h2. */
function contents(headings) {
  const items = [];
  for (const h of headings) {
    if (h.depth === 2 || !items.length) items.push({ h, children: [] });
    else items[items.length - 1].children.push(h);
  }
  const link = (h) => `<a href="#${h.id}">${h.html}</a>`;
  const html = items.map(({ h, children }) => `<li>${link(h)}${children.length ? `<ol>${children.map((c) => `<li>${link(c)}</li>`).join("")}</ol>` : ""}</li>`).join("");
  return `<nav class="doc-toc" aria-labelledby="doc-toc-title">
      <p class="eyebrow doc-toc-label" id="doc-toc-title">On this page</p>
      <button class="doc-toc-toggle" type="button" aria-expanded="true" aria-controls="doc-toc-list" hidden>On this page<svg class="docs-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
      <ol class="doc-toc-list" id="doc-toc-list" lang="en" data-i18n="off">${html}</ol>
    </nav>`;
}

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => {
    if (!(key in values)) throw new Error(`${TEMPLATE}: no value for {{${key}}}`);
    return values[key];
  });
}

/** Mark the footer link to this page as the current page. */
const markFooter = (html, href) => html.replace(/(<footer class="site-footer">[\s\S]*?<\/footer>)/, (footer) => footer.replace(`<a href="${href}">`, `<a href="${href}" aria-current="page">`));

/**
 * Render the whole docs section. Returns { files: [{ path, html }], images: [{ from, to }], problems },
 * paths relative to site-dist/.
 */
export const translationSource = (source) => `docs/tr/${posix.basename(source)}`;

// Read the exact English/Turkish string pairs shared with the browser. The table stays in
// landing/language.js; only literal JSON strings are accepted, never executable expressions.
function siteTranslations(root) {
  const file = join(root, "landing/language.js");
  if (!existsSync(file)) return new Map();
  const pairs = [...readFileSync(file, "utf8").matchAll(/\[\s*("(?:\\.|[^"\\])*")\s*,\s*("(?:\\.|[^"\\])*")\s*\]/g)];
  return new Map(pairs.map(([, en, tr]) => [JSON.parse(en), JSON.parse(tr)]));
}

function translateFrame(html, translations) {
  const translated = (value) => translations.has(decode(value)) ? esc(translations.get(decode(value))) : value;
  return html.replace(/>([^<>]+)</g, (_, value) => {
    const trimmed = value.trim();
    return `>${value.replace(trimmed, () => translated(trimmed))}<`;
  }).replace(/(aria-label|title|content)="([^"]*)"/g, (_, attr, value) => `${attr}="${translated(value)}"`);
}

export function renderDocsSite(root) {
  const english = renderDocsLanguage(root, "en");
  if (english.problems.length) return english;
  const turkish = renderDocsLanguage(root, "tr", english.rendered);
  return { files: [...english.files, ...turkish.files], images: [...new Map([...english.images, ...turkish.images].map((img) => [img.to, img])).values()],
    problems: [...english.problems, ...turkish.problems] };
}

function renderDocsLanguage(root, language, english = []) {
  const { manifest, pages: sourcePages, problems } = loadManifest(root);
  const tr = language === "tr";
  const translations = tr ? siteTranslations(root) : new Map();
  const t = (text) => translations.get(text) ?? text;
  const localize = (html) => tr ? translateFrame(html, translations) : html;
  const prefix = tr ? "docs/tr" : "docs";
  const pages = sourcePages.map((p) => ({ ...p, title: tr ? (p.titleTr ?? t(p.title)) : p.title, description: t(p.description), group: tr ? (p.groupTr ?? t(p.group)) : p.group }));
  if (problems.length) return { files: [], images: [], problems };
  const { site, repo, branch } = manifest;
  let template = readFileSync(join(root, TEMPLATE), "utf8");
  if (tr) template = localize(template).replace(/(["'])\.\.\//g, "$1../../")
    .replace(/(data-site-language="en"[^>]*aria-pressed=")true/, "$1false")
    .replace(/(data-site-language="tr"[^>]*aria-pressed=")false/, "$1true");
  const reserved = new Set([...template.matchAll(/\sid="([^"{}]+)"/g)].map((m) => m[1]));
  for (const id of ["doc-content", "docs-nav-list", "doc-toc-title", "doc-toc-list"]) reserved.add(id);
  const published = new Map(pages.map((p) => [p.source, p.slug]));
  const groups = manifest.groups.map((g) => ({ ...g, originalTitle: g.title, title: tr ? (g.titleTr ?? t(g.title)) : g.title, pages: g.pages.map((p) => pages.find((item) => item.slug === p.slug)) }));
  const hidden = new Set((manifest.hideImages ?? []).map((h) => h.path));

  const ignored = deployIgnored(root);
  const rendered = pages.map((page, index) => {
    const translated = tr && existsSync(join(root, translationSource(page.source)));
    const source = translated ? translationSource(page.source) : page.source;
    const result = renderMarkdown(root, source, { published, titles: new Map(pages.map((p) => [p.source, p.title])), repo, branch, hidden, ignored,
      baseSource: page.source, headingIds: translated ? [...english[index].ids] : undefined, language });
    if (translated && JSON.stringify(result.headingDepths) !== JSON.stringify(english[index].headingDepths)) problems.push(`${source}: heading structure differs from ${page.source}`);
    if (translated && JSON.stringify(result.codeBlocks) !== JSON.stringify(english[index].codeBlocks)) problems.push(`${source}: code examples differ from ${page.source}`);
    return { page, source, translated, ...result };
  });
  // every hideImages entry must still leave out an image, so the list stays as short as it can be
  for (const path of hidden) {
    if (!rendered.some((r) => r.hiddenUsed.has(path))) problems.push(`${MANIFEST}: hideImages lists ${path}, which no published page shows`);
  }
  const bySlug = new Map(rendered.map((r) => [r.page.slug, r]));
  for (const r of rendered) {
    problems.push(...r.problems);
    for (const id of r.ids) {
      if (reserved.has(id) || id.startsWith("docs-group-")) problems.push(`${r.page.source}: heading id "${id}" is also an id of the page frame`);
    }
    for (const a of r.anchors) {
      const target = a.page ? bySlug.get(a.page) : r;
      let frag = a.frag;
      try { frag = decodeURIComponent(frag); } catch { /* checked as written */ }
      if (!target.ids.has(frag)) problems.push(`${r.page.source}: no heading #${a.frag} in ${target.page.source} (link ${a.href})`);
    }
  }

  const files = [];
  const images = new Map();
  rendered.forEach((r, i) => {
    const { page } = r;
    for (const img of r.images) images.set(img.to, img);
    const prev = pages[i - 1];
    const next = pages[i + 1];
    const pager = (p, rel, label) => (p ? `<a class="doc-pager-${rel}" href="${p.slug}.html" rel="${rel}"><span class="doc-pager-dir">${label}</span><span class="doc-pager-title" lang="en" data-i18n="off">${esc(p.title)}</span></a>` : "<span></span>");
    const toc = r.headings.length >= 3 ? localize(contents(r.headings)).replace(/lang="en"/g, `lang="${tr && r.translated ? "tr" : "en"}"`) : "";
    const main = `<div class="shell docs-layout">
    ${localize(sidebar(groups, page.slug)).replace(/lang="en"/g, `lang="${language}"`)}
    <div class="doc-head" id="doc-content" tabindex="-1">
      <div class="doc-meta">
        <p class="eyebrow">${esc(page.group)}</p>
        <a class="doc-edit" href="${repo}/edit/${branch}/${r.source}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4"/></svg>${t("Edit on GitHub")}</a>
      </div>
      <h1 id="${r.title?.id ?? "top"}" lang="${tr && r.translated ? "tr" : "en"}" data-i18n="off">${r.title?.html ?? esc(page.title)}</h1>
    </div>
    ${toc}
    <article class="doc-body" lang="${tr && r.translated ? "tr" : "en"}" data-i18n="off">
    ${tr && !r.translated ? `<p class="doc-translation-note" lang="tr" data-i18n="off">${t("This page is not available in Turkish yet. The English version is shown below.")}</p>` : ""}
${r.body}
    </article>
    <nav class="doc-pager" aria-label="${t("Previous and next page")}">
      ${pager(prev, "prev", t("Previous")).replace(/lang="en"/g, `lang="${language}"`)}
      ${pager(next, "next", t("Next")).replace(/lang="en"/g, `lang="${language}"`)}
    </nav>
  </div>`;
    const html = fill(template, {
      title: esc(`${page.title} · ${t("Fairbeam docs")}`),
      description: esc(page.description),
      url: `${site}/${prefix}/${page.slug}.html`,
      language,
      alternates: alternateLinks(site, `${page.slug}.html`),
      type: "article",
      main,
    });
    files.push({ path: `${prefix}/${page.slug}.html`, html: externalLinksInHtml(markFooter(html, `${page.slug}.html`), language) });
  });

  // the overview: the groups with a line for each page
  const groupSlug = slugger();
  const sections = groups.map((group) => {
    const id = groupSlug(group.originalTitle);
    const cards = group.pages.map((p) => `<li><a class="docs-card" href="${p.slug}.html"><span class="docs-card-title" lang="en" data-i18n="off">${esc(p.title)}</span><span class="docs-card-text">${esc(p.description)}</span></a></li>`).join("\n          ");
    return `<section aria-labelledby="${id}">
        <h2 id="${id}">${esc(group.title)}</h2>
        <ul class="docs-cards">
          ${cards}
        </ul>
      </section>`;
  }).join("\n      ");
  const overview = `<div class="shell docs-layout docs-layout-overview">
    ${sidebar(groups, null)}
    <div class="doc-head" id="doc-content" tabindex="-1">
      <p class="eyebrow">Docs</p>
      <h1>Documentation</h1>
      <p class="lede">Guides and reference for the Fairbeam desktop app, its Python models and the command line.</p>
    </div>
    <div class="docs-overview">
      ${sections}
      <section aria-labelledby="on-this-site">
        <h2 id="on-this-site">On this site</h2>
        <ul class="docs-cards">
          <li><a class="docs-card" href="../features.html"><span class="docs-card-title">Features</span><span class="docs-card-text">Every feature, the example projects, validation against analytical results and solver times.</span></a></li>
          <li><a class="docs-card" href="../roadmap.html"><span class="docs-card-title">Roadmap</span><span class="docs-card-text">What each release added, and the work in development.</span></a></li>
        </ul>
      </section>
    </div>
  </div>`;
  files.unshift({
    path: `${prefix}/index.html`,
    html: markFooter(fill(template, {
      title: t("Documentation · Fairbeam"),
      description: esc(t("Fairbeam documentation: getting started with the desktop app, the designer, simulation, results and exports, Python models and the command line, building from source, and validation.")),
      url: `${site}/${prefix}/`,
      language,
      alternates: alternateLinks(site, ""),
      type: "website",
      main: localize(overview).replace(/lang="en"/g, `lang="${language}"`).replace(/href="\.\.\//g, tr ? 'href="../../' : 'href="../'),
    }), "./"),
  });
  return { files, images: [...images.values()], problems, rendered };
}

function alternateLinks(site, page) {
  return `<link rel="alternate" hreflang="en" href="${site}/docs/${page}">
  <link rel="alternate" hreflang="tr" href="${site}/docs/tr/${page}">
  <link rel="alternate" hreflang="x-default" href="${site}/docs/${page}">`;
}
