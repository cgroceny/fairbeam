// External website destinations keep the current page available to the reader.
export function isExternalSiteLink(href) {
  if (!/^(?:https?:)?\/\//i.test(href)) return false;
  const url = new URL(href, "https://fairbeam.org");
  return !["fairbeam.org", "www.fairbeam.org"].includes(url.hostname);
}

export const newTabHint = (language = "en") => `<span class="visually-hidden" data-i18n="on"> (${language === "tr" ? "yeni sekmede açılır" : "opens in a new tab"})</span>`;

// Also handles raw HTML links in Markdown, keeping other relationship tokens intact.
export function externalLinksInHtml(html, language = "en") {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (link, attributes, text) => {
    const href = attributes.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1];
    if (!href || !isExternalSiteLink(href)) return link;
    const rel = attributes.match(/\brel\s*=\s*["']([^"']*)["']/i)?.[1]?.split(/\s+/) ?? [];
    const tokens = [...new Set([...rel, "noopener", "noreferrer"])].filter(Boolean);
    attributes = attributes.replace(/\s+(?:target|rel)\s*=\s*["'][^"']*["']/gi, "");
    const hint = text.includes('class="visually-hidden" data-i18n="on"') ? "" : newTabHint(language);
    return `<a${attributes} target="_blank" rel="${tokens.join(" ")}">${text}${hint}</a>`;
  });
}
