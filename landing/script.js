// Fairbeam landing: theme toggle (shared with the app through the same localStorage key), the
// scroll-pinned chapters and the on-demand demo iframe. No framework, no tracking.
(() => {
  const KEY = "fairbeam.theme";
  const order = { system: "light", light: "dark", dark: "system" };
  const label = { system: "Theme: system", light: "Theme: light", dark: "Theme: dark" };
  const root = document.documentElement;
  const button = document.getElementById("theme-toggle");

  const read = () => {
    try {
      const v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : "system";
    } catch {
      return "system";
    }
  };
  let theme = read();
  const apply = (t) => {
    theme = t;
    if (t === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", t);
    if (button) {
      button.dataset.themeState = t;
      button.setAttribute("aria-label", label[t]);
      button.title = `${label[t]} (click to change)`;
    }
  };
  apply(theme);
  button?.addEventListener("click", () => {
    const next = order[theme];
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* private mode: this page only */
    }
    apply(next);
  });

  // Keep this page in step with a theme selected in another site or app tab.
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) apply(read());
  });

  // The live demo is loaded only when asked for: it pulls in three.js and the example projects.
  const load = document.getElementById("load-demo");
  load?.addEventListener("click", () => {
    const host = load.parentElement;
    const frame = document.createElement("iframe");
    frame.src = host.dataset.src;
    frame.title = "Fairbeam demo viewer";
    frame.loading = "eager";
    host.replaceChildren(frame);
    frame.focus();
  });

  // ---------------------------------------------------------------- pinned chapters
  // Each .chapter is several screens tall with a sticky .chapter-pin inside. The scroll position
  // through it picks the step (li.on, data-step) and sets --f, the progress within that step, for
  // CSS. The 3D chapters' stage reads the same scroll itself (story/story.js).
  const chapters = [...document.querySelectorAll(".chapter")].map((el) => ({
    el,
    n: Number(el.dataset.steps) || 1,
    steps: [...el.querySelectorAll(".chapter-steps > li")],
    counters: [...el.querySelectorAll("[data-count]")],
    zoom: el.querySelector(".screen-zoom"),
    hl: el.querySelector(".screen-hl"),
    title: el.querySelector("[data-title-target]"),
    step: -1,
  }));
  const header = document.querySelector(".site-header");

  /** the app screenshot: zoom so the step's region (x, y, w, h in % of the image) fills the view */
  function frameRegion(c, li) {
    if (!c.zoom) return;
    const r = (li?.dataset.hl || "").split(",").map(Number);
    if (r.length !== 4 || r.some(Number.isNaN)) {
      c.zoom.style.transform = "";
      c.hl?.classList.remove("on");
      return;
    }
    const [x, y, w, h] = r;
    const s = Math.max(1, Math.min(2.2, 0.92 * Math.min(100 / w, 100 / h)));
    const clamp = (v, lo) => Math.min(0, Math.max(lo, v));
    const tx = clamp(50 - (x + w / 2) * s, 100 - 100 * s);
    const ty = clamp(50 - (y + h / 2) * s, 100 - 100 * s);
    c.zoom.style.transform = `translate(${tx}%, ${ty}%) scale(${s})`;
    if (c.hl) {
      Object.assign(c.hl.style, { left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` });
      c.hl.classList.add("on");
    }
  }

  function updateChapters() {
    const hh = header ? header.offsetHeight : 56;
    const vh = window.innerHeight;
    for (const c of chapters) {
      const r = c.el.getBoundingClientRect();
      if (r.bottom < -vh || r.top > 2 * vh) continue;
      const total = r.height - (vh - hh);
      const pr = total > 0 ? Math.min(0.99999, Math.max(0, (hh - r.top) / total)) : 0;
      const x = pr * c.n;
      const step = Math.floor(x);
      const f = x - step;
      if (step !== c.step) {
        c.step = step;
        c.el.dataset.step = String(step);
        c.steps.forEach((li, i) => li.classList.toggle("on", i === step));
        frameRegion(c, c.steps[step]);
        if (c.title && c.steps[step]?.dataset.title) c.title.textContent = c.steps[step].dataset.title;
      }
      c.el.style.setProperty("--f", f.toFixed(3));
      for (const el of c.counters) {
        if (Number(el.closest("[data-panel]")?.dataset.panel) !== step) continue;
        el.textContent = `${(Math.min(1, f / 0.85) * Number(el.dataset.count)).toFixed(1)}${el.dataset.unit || ""}`;
      }
    }
  }
  if (chapters.length) {
    root.classList.add("js-chapters");
    let queued = false;
    const queue = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; updateChapters(); });
    };
    window.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("resize", queue);
    updateChapters();
  }

  // ---------------------------------------------------------------- roadmap board
  // The board is static HTML (rendered from roadmap.json at build time). This adds the phone tabs
  // and the entrance motion; without JS the three columns simply stack.
  const board = document.getElementById("roadmap-board");
  if (board) {
    const tablist = board.querySelector("[role=tablist]");
    const tabs = [...board.querySelectorAll("[role=tab]")];
    const panels = tabs.map((t) => document.getElementById(t.getAttribute("aria-controls")));
    const phone = window.matchMedia("(max-width: 720px)");
    let current = 0;

    const select = (i, focus) => {
      current = i;
      tabs.forEach((t, k) => {
        t.setAttribute("aria-selected", String(k === i));
        t.tabIndex = k === i ? 0 : -1;
      });
      panels.forEach((p, k) => { p.hidden = phone.matches && k !== i; });
      if (focus) tabs[i].focus();
    };
    // tab semantics only while the tabs are shown; on wider screens the panels are plain sections
    const layout = () => {
      // A focused card must remain visible when a wide board becomes a phone tab.
      const focusedPanel = panels.findIndex((panel) => panel.contains(document.activeElement));
      if (phone.matches && focusedPanel >= 0) current = focusedPanel;
      const focusedTab = tabs.includes(document.activeElement);
      board.classList.toggle("rm-tabbed", phone.matches);
      panels.forEach((p, k) => {
        if (phone.matches) {
          p.setAttribute("role", "tabpanel");
          p.setAttribute("aria-labelledby", tabs[k].id);
        } else {
          p.removeAttribute("role");
          p.setAttribute("aria-labelledby", `rm-h-${p.dataset.state}`);
        }
      });
      select(current, false);
      // The tabs disappear on wider screens; retain a visible keyboard destination.
      if (!phone.matches && focusedTab) {
        panels[current].tabIndex = -1;
        panels[current].focus({ preventScroll: true });
      }
    };
    tablist.hidden = false;
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => select(i, false));
      t.addEventListener("keydown", (e) => {
        const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        select((to + tabs.length) % tabs.length, true);
      });
    });
    phone.addEventListener("change", layout);
    layout();

    // cards fade and rise as they enter the viewport, a few at a time; none of it with reduced motion
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches && "IntersectionObserver" in window) {
      board.classList.add("rm-motion");
      const seen = new IntersectionObserver((entries) => {
        // stagger in reading order: row by row, then left to right
        const shown = entries.filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top || a.boundingClientRect.left - b.boundingClientRect.left)
          .map((e) => e.target);
        shown.forEach((card, k) => {
          card.style.setProperty("--rm-delay", `${Math.min(k, 8) * 55}ms`);
          card.classList.add("is-in");
          seen.unobserve(card);
        });
      }, { rootMargin: "0px 0px -6% 0px", threshold: 0.1 });
      board.querySelectorAll(".rm-card").forEach((card) => seen.observe(card));
    }
  }

  // ---------------------------------------------------------------- guide: the contents list follows the scroll
  // The link of the section being read (the last heading that has reached the top of the page) gets
  // aria-current="location"; at the very bottom the last section counts, however short it is.
  const toc = document.querySelector(".guide-toc");
  if (toc) {
    const items = [...toc.querySelectorAll('a[href^="#"]')]
      .map((a) => ({ a, el: document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1))) }))
      .filter((it) => it.el);
    let active = null;
    let queued = false;
    const update = () => {
      queued = false;
      // a heading counts as reached once it is at (or above) where a click on its link puts it:
      // the page's scroll-padding-top plus the heading's own scroll-margin-top, and a little
      const pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
      let cur = null;
      for (const it of items) {
        const line = pad + (parseFloat(getComputedStyle(it.el).scrollMarginTop) || 0) + 8;
        if (it.el.getBoundingClientRect().top <= line) cur = it;
      }
      if (items.length && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) cur = items[items.length - 1];
      if ((cur?.a ?? null) === active) return;
      active?.removeAttribute("aria-current");
      cur?.a.setAttribute("aria-current", "location");
      active = cur?.a ?? null;
    };
    const queue = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(update);
    };
    window.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("resize", queue);
    update();
  }

})();
