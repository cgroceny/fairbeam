/**
 * Arrow-key behaviour for a role="radiogroup" of buttons with role="radio": Left/Up and
 * Right/Down select the previous/next option (wrapping), Home/End the first/last, and focus
 * follows the selection. Attach as onKeyDown on the group element.
 */
export function radioGroupKeys(e: KeyboardEvent & { currentTarget: HTMLElement }) {
  const keys = ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)')];
  if (!radios.length) return;
  const i = radios.indexOf(document.activeElement as HTMLElement);
  const n = radios.length;
  const next =
    e.key === "Home" ? 0 : e.key === "End" ? n - 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + n) % n : (i + 1) % n;
  e.preventDefault();
  radios[next].click();
  radios[next].focus();
}

/**
 * Arrow-key focus movement in a grid of buttons (e.g. the S-matrix picker): Left/Right move within
 * a row, Up/Down between rows, skipping disabled buttons; Home/End jump to the first/last enabled
 * button. Attach as onKeyDown on the grid element; `cols` is the number of columns.
 */
export function gridKeys(e: KeyboardEvent & { currentTarget: HTMLElement }, cols: number) {
  const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
  const i = all.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  if (e.key === "Home" || e.key === "End") {
    const enabled = all.filter((b) => !b.disabled);
    enabled[e.key === "Home" ? 0 : enabled.length - 1]?.focus();
    e.preventDefault();
    return;
  }
  const d = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols } as Record<string, number>)[e.key];
  if (!d) return;
  e.preventDefault();
  for (let j = i + d; j >= 0 && j < all.length; j += d) {
    if (Math.abs(d) === 1 && Math.floor(j / cols) !== Math.floor(i / cols)) break; // stay in the row
    if (!all[j].disabled) return all[j].focus();
  }
}
