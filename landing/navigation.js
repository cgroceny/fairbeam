// Site navigation: the mobile section menu and the scroll padding under the sticky header.
(() => {
  const menuButton = document.querySelector("[data-mobile-nav-toggle]");
  const sectionNav = document.getElementById("site-nav");
  if (menuButton && sectionNav) {
    const compact = window.matchMedia("(max-width: 800px)");
    document.documentElement.classList.add("js-site-nav");

    const setMenuOpen = (open, restoreFocus = false) => {
      const expanded = compact.matches && open;
      menuButton.setAttribute("aria-expanded", String(expanded));
      menuButton.setAttribute("aria-label", expanded ? "Close section navigation" : "Open section navigation");
      menuButton.title = expanded ? "Close section navigation" : "Open section navigation";
      sectionNav.hidden = compact.matches && !expanded;
      if (restoreFocus) menuButton.focus();
    };

    const syncViewport = () => {
      const navHadFocus = sectionNav.contains(document.activeElement);
      const buttonHadFocus = document.activeElement === menuButton;
      setMenuOpen(false);
      if (compact.matches && navHadFocus) menuButton.focus();
      else if (!compact.matches && buttonHadFocus) sectionNav.querySelector("a[href]")?.focus();
    };

    setMenuOpen(false);
    menuButton.addEventListener("click", () => setMenuOpen(menuButton.getAttribute("aria-expanded") !== "true"));
    sectionNav.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest("a[href^='#']");
      if (!compact.matches || !link) return;
      let destination = null;
      try { destination = document.getElementById(decodeURIComponent(link.hash.slice(1))); } catch { /* ignore malformed fragments */ }
      if (destination) {
        if (!destination.hasAttribute("tabindex")) destination.tabIndex = -1;
        requestAnimationFrame(() => destination.focus({ preventScroll: true }));
      }
      setMenuOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || menuButton.getAttribute("aria-expanded") !== "true") return;
      event.preventDefault();
      setMenuOpen(false, true);
    });
    document.addEventListener("pointerdown", (event) => {
      if (!compact.matches || menuButton.getAttribute("aria-expanded") !== "true") return;
      const target = event.target instanceof Node ? event.target : null;
      if (target && !sectionNav.contains(target) && !menuButton.contains(target)) {
        const restoreFocus = sectionNav.contains(document.activeElement);
        setMenuOpen(false);
        if (restoreFocus) requestAnimationFrame(() => {
          const active = document.activeElement;
          const outsideFocusable = active instanceof HTMLElement && active !== menuButton && !sectionNav.contains(active) &&
            active.matches("a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1']), [contenteditable='true']");
          if (!outsideFocusable) menuButton.focus();
        });
      }
    }, true);
    if (compact.addEventListener) compact.addEventListener("change", syncViewport);
    else compact.addListener?.(syncViewport);
  }

  // The sticky header's height is the page's scroll-padding-top, so fragment links land below it.
  const header = document.querySelector(".site-header");
  if (header && typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      document.documentElement.style.scrollPaddingTop = `${Math.ceil(header.getBoundingClientRect().height) + 16}px`;
    }).observe(header);
  }
})();
