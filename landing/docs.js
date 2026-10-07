// Documentation pages (docs/): on narrow screens the sidebar and the "On this page" list fold away
// behind a button; code blocks get a Copy button; a wide table or code block that scrolls sideways
// can be reached with the Tab key. The breakpoints match docs.css. The contents list follows the
// scroll through script.js. Without JS everything is simply shown.
(() => {
  document.documentElement.classList.add("js-docs");

  /** A button that shows and hides a panel while `query` matches; outside it the panel is always shown. */
  function foldable(button, panel, query, closeOnLink) {
    if (!button || !panel) return;
    const narrow = window.matchMedia(query);
    const set = (open) => {
      button.setAttribute("aria-expanded", String(open));
      panel.hidden = !open;
    };
    const sync = () => {
      button.hidden = !narrow.matches;
      set(!narrow.matches);
    };
    button.addEventListener("click", () => set(button.getAttribute("aria-expanded") !== "true"));
    // a section link folds the list away, so the section is what the reader sees
    if (closeOnLink) {
      panel.addEventListener("click", (event) => {
        const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
        if (link && narrow.matches) set(false);
      });
    }
    if (narrow.addEventListener) narrow.addEventListener("change", sync);
    else narrow.addListener?.(sync);
    sync();
  }
  foldable(document.querySelector(".docs-nav-toggle"), document.getElementById("docs-nav-list"), "(max-width: 960px)", false);
  foldable(document.querySelector(".doc-toc-toggle"), document.getElementById("doc-toc-list"), "(max-width: 1200px)", true);

  // Copy buttons (the clipboard needs a secure context: https or localhost)
  if (navigator.clipboard && window.isSecureContext) {
    for (const block of document.querySelectorAll(".doc-code")) {
      const code = block.querySelector("code");
      if (!code) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "doc-copy";
      button.dataset.i18n = "on"; // the page text is English only; this label follows the site language
      button.setAttribute("aria-live", "polite");
      button.textContent = "Copy";
      let timer = 0;
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(code.textContent ?? "");
        } catch {
          return;
        }
        button.textContent = "Copied";
        button.dataset.copied = "";
        clearTimeout(timer);
        timer = setTimeout(() => {
          button.textContent = "Copy";
          delete button.dataset.copied;
        }, 1600);
      });
      block.append(button);
    }
  }

  // Boxes that scroll sideways are keyboard-reachable (and only those, so short tables add no Tab stop)
  const scrollers = [...document.querySelectorAll(".doc-table, .doc-code pre")];
  const mark = () => {
    for (const el of scrollers) {
      if (el.scrollWidth > el.clientWidth + 1) el.tabIndex = 0;
      else el.removeAttribute("tabindex");
    }
  };
  let queued = false;
  window.addEventListener("resize", () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; mark(); });
  });
  mark();
})();
