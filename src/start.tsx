import { render } from "solid-js/web";
import "./styles/fonts.css";
import "../design-system/tokens.css";
import "./styles/app.css";
import "./styles/runner.css";
import "./styles/drawing.css";
import "./styles/array.css";
import "./styles/import.css";
import "./styles/compare.css";
import "./styles/editor.css";
import "./styles/optimize.css";
import "./styles/designer.css";
import "./styles/render.css";
import App from "./App";
import "./styles/scaling.css";
import { applyTheme, theme } from "./state";
import { health } from "./runner/store";
import { dirty } from "./designer/store";
import { installReloadGuard } from "./lib/reloadGuard";
import { applyAppearance, watchAppearanceTheme } from "./lib/appearance";
import { readGeneralSettings } from "./lib/generalSettings";

applyTheme(theme());
applyAppearance(readGeneralSettings());
watchAppearanceTheme();
installReloadGuard(() => !!health()?.desktop || "__TAURI_INTERNALS__" in window, () => dirty());
// The WebView's own menu (Back, Reload, Inspect) means nothing in the app. Keep it only where it
// helps: text fields (cut/copy/paste) and selected text. Our own menus call preventDefault first.
document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest("input, textarea, [contenteditable=''], [contenteditable='true']")) return;
  if (String(getSelection() ?? "").trim()) return;
  e.preventDefault();
});
// A lazy chunk that is gone (the app files were replaced while it ran, e.g. by an update) cannot be
// imported again: reload once so the page and its chunks match. Not with unsaved edits, and not in
// a loop; the panel's error boundary then offers its own reload.
window.addEventListener("vite:preloadError", (e) => {
  if (dirty()) return;
  try {
    const last = Number(sessionStorage.getItem("fairbeam.chunkReload") ?? 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem("fairbeam.chunkReload", String(Date.now()));
  } catch { return; }
  e.preventDefault();
  location.reload();
});
render(() => <App />, document.getElementById("root")!);
