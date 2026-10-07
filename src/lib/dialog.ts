import { createEffect, onCleanup } from "solid-js";

export const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

type ModalLayer = {
  dialog: HTMLElement;
  close: () => void;
  initial?: () => HTMLElement | null | undefined;
  opener: HTMLElement | null;
  /** how to find the opener again if its node was re-rendered or detached meanwhile */
  openerKey: string | null;
  fallback: HTMLElement | null;
};

const layers: ModalLayer[] = [];
// Keep the exact original attribute value, so an existing inert state survives modal open/close.
const isolated = new Map<HTMLElement, string | null>();
let observer: MutationObserver | undefined;
let redirectingFocus = false;
let recentFallback: HTMLElement | null = null;
let recentFallbackTimer: number | undefined;
// The control that lost focus last, and when: a command whose click briefly drops focus (its
// region re-renders, a save disables it) still counts as the dialog's opener.
let lastBlur: { el: HTMLElement; at: number } | null = null;
const OPENER_GRACE_MS = 1500;
if (typeof document !== "undefined") {
  document.addEventListener("focusout", (event) => {
    if (event.target instanceof HTMLElement && event.target !== document.body) lastBlur = { el: event.target, at: Date.now() };
  }, true);
}

const topLayer = () => layers[layers.length - 1];

function isRendered(el: HTMLElement): boolean {
  if (!el.isConnected || el.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && el.getClientRects().length > 0;
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((el) => el.tabIndex >= 0 && !el.matches(":disabled") && isRendered(el));
}

function canFocus(el: HTMLElement | null | undefined, dialog: HTMLElement): el is HTMLElement {
  return !!el && (el === dialog || dialog.contains(el)) && isRendered(el) && !el.matches(":disabled");
}

/** A selector that finds the same control again after a re-render: its id, its data-action, or its
 * accessible name inside the nearest region with an id (a ribbon tab panel, a dialog, a panel). */
export function openerLocator(el: HTMLElement): string | null {
  const esc = (v: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&"));
  if (el.id) return `#${esc(el.id)}`;
  const tag = el.tagName.toLowerCase();
  const scope = el.parentElement?.closest<HTMLElement>("[id]");
  const within = scope ? `#${esc(scope.id)} ` : "";
  const action = el.getAttribute("data-action");
  if (action) return `${within}${tag}[data-action="${esc(action)}"]`;
  const label = el.getAttribute("aria-label");
  if (label) return `${within}${tag}[aria-label="${esc(label)}"]`;
  return null;
}

function focusElement(el: HTMLElement): void {
  try { el.focus({ preventScroll: true }); }
  catch { el.focus(); }
}

function focusLayer(layer: ModalLayer): void {
  let requested: HTMLElement | null | undefined;
  try { requested = layer.initial?.(); } catch { requested = undefined; }
  const target = canFocus(requested, layer.dialog)
    ? requested
    : layer.initial ? focusableElements(layer.dialog)[0] ?? layer.dialog : layer.dialog;
  focusElement(target);
}

function syncIsolation(): void {
  const top = topLayer();
  const desired = new Set<HTMLElement>();
  const body = document.body;

  if (top?.dialog.isConnected && body) {
    let child: Element = top.dialog;
    let parent = child.parentElement;
    while (parent) {
      for (const sibling of [...parent.children]) {
        if (sibling !== child) desired.add(sibling as HTMLElement);
      }
      if (parent === body) break;
      child = parent;
      parent = parent.parentElement;
    }
  }

  for (const [el, original] of isolated) {
    if (desired.has(el)) continue;
    if (original === null) el.removeAttribute("inert");
    else el.setAttribute("inert", original);
    isolated.delete(el);
  }

  for (const el of desired) {
    if (!isolated.has(el)) isolated.set(el, el.getAttribute("inert"));
    if (!el.hasAttribute("inert")) el.setAttribute("inert", "");
  }
}

function onKeyDown(event: KeyboardEvent): void {
  const top = topLayer();
  if (!top || event.defaultPrevented) return;

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    top.close();
    return;
  }
  if (event.key !== "Tab") return;

  const candidates = focusableElements(top.dialog);
  if (!candidates.length) {
    event.preventDefault();
    focusElement(top.dialog);
    return;
  }

  const active = document.activeElement;
  const index = candidates.findIndex((el) => el === active);
  if (index < 0) {
    event.preventDefault();
    // Focus on something inside the dialog that is not a Tab stop of its own (a scrolling body that
    // Chromium makes keyboard-focusable): continue from there in document order, so Tab still
    // reaches the controls after it (Shortcuts: Close, list, Done, Close).
    if (active instanceof HTMLElement && active !== top.dialog && top.dialog.contains(active)) {
      const next = event.shiftKey
        ? [...candidates].reverse().find((el) => active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)
        : candidates.find((el) => active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      focusElement(next ?? (event.shiftKey ? candidates[candidates.length - 1] : candidates[0]));
    } else {
      focusElement(event.shiftKey ? candidates[candidates.length - 1] : candidates[0]);
    }
  } else if (event.shiftKey && index === 0) {
    event.preventDefault();
    focusElement(candidates[candidates.length - 1]);
  } else if (!event.shiftKey && index === candidates.length - 1) {
    event.preventDefault();
    focusElement(candidates[0]);
  }
}

function onFocusIn(event: FocusEvent): void {
  const top = topLayer();
  if (!top || redirectingFocus || top.dialog.contains(event.target as Node)) return;

  event.stopPropagation();
  redirectingFocus = true;
  focusLayer(top);
  redirectingFocus = false;
}

function startManaging(): void {
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusin", onFocusIn, true);
  observer = new MutationObserver(() => {
    syncIsolation();
    // the focused control inside the top dialog was re-rendered or removed: focus went to the page,
    // so put it back in the dialog (a modal never leaves the keyboard on <body>)
    const top = topLayer();
    const active = document.activeElement;
    if (top?.dialog.isConnected && (!active || active === document.body)) focusLayer(top);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function stopManaging(): void {
  document.removeEventListener("keydown", onKeyDown);
  document.removeEventListener("focusin", onFocusIn, true);
  observer?.disconnect();
  observer = undefined;
}

function addLayer(dialog: HTMLElement, close: () => void, initial?: () => HTMLElement | null | undefined): ModalLayer {
  const active = document.activeElement;
  // the opener: the focused control, or the one whose click dropped focus just before the dialog came
  const recent = lastBlur && Date.now() - lastBlur.at < OPENER_GRACE_MS && !dialog.contains(lastBlur.el) ? lastBlur.el : null;
  const opener = active instanceof HTMLElement && active !== document.body && !dialog.contains(active) ? active : recent;
  const openerKey = opener ? openerLocator(opener) : null;
  const parent = topLayer();
  const fallback = parent?.opener?.isConnected ? parent.opener : parent?.fallback ?? recentFallback;
  if (recentFallbackTimer !== undefined) {
    window.clearTimeout(recentFallbackTimer);
    recentFallbackTimer = undefined;
  }
  recentFallback = null;

  const layer: ModalLayer = { dialog, close, initial, opener, openerKey, fallback };
  if (!layers.length) startManaging();
  layers.push(layer);
  syncIsolation();
  focusLayer(layer);
  // the dialog's first control may render a moment later (data it waits for): focus it then, unless
  // the user has already moved on inside the dialog
  requestAnimationFrame(() => {
    if (topLayer() !== layer || !dialog.isConnected) return;
    const now = document.activeElement;
    if (!now || now === document.body || now === dialog || !dialog.contains(now)) focusLayer(layer);
  });
  return layer;
}

function removeLayer(layer: ModalLayer): void {
  const index = layers.indexOf(layer);
  if (index < 0) return;
  const wasTop = index === layers.length - 1;
  layers.splice(index, 1);
  syncIsolation();
  if (!layers.length) stopManaging();

  if (!wasTop) return;

  // the opener node itself, or the same control found again (its region re-rendered while the dialog
  // was open), then the parent dialog's opener, then the parent dialog
  const again = () => {
    if (!layer.openerKey) return null;
    try { return document.querySelector<HTMLElement>(layer.openerKey); } catch { return null; }
  };
  const destination = [layer.opener, again(), layer.fallback, topLayer()?.dialog]
    .find((target): target is HTMLElement => !!target && isRendered(target) && !target.matches(":disabled"));
  if (destination) focusElement(destination);

  if (!layers.length) {
    recentFallback = layer.opener ?? layer.fallback;
    if (recentFallbackTimer !== undefined) window.clearTimeout(recentFallbackTimer);
    recentFallbackTimer = window.setTimeout(() => {
      recentFallback = null;
      recentFallbackTimer = undefined;
    }, 0);
  }
}

/**
 * Shared modal behavior: focus each time it opens, contain Tab and external focus moves,
 * isolate the background, close only the top dialog on Escape, and restore focus on close.
 */
export function useModal(dialog: () => HTMLElement | undefined, close: () => void, initial?: () => HTMLElement | null | undefined) {
  let layer: ModalLayer | undefined;

  createEffect(() => {
    const element = dialog();
    if (element === layer?.dialog) return;
    if (layer) {
      removeLayer(layer);
      layer = undefined;
    }
    if (element) layer = addLayer(element, close, initial);
  });

  onCleanup(() => {
    if (layer) removeLayer(layer);
    layer = undefined;
  });
}
