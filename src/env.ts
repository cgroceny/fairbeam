/** Build-time flags. `npm run build:demo` sets VITE_FAIRBEAM_DEMO=1 (see .env.demo). */

/** Read-only public demo: no local run server, bundled example projects only. */
export const DEMO = import.meta.env.VITE_FAIRBEAM_DEMO === "1";

/** Where the demo sends people who want to run simulations themselves. */
export const INSTALL_URL: string = import.meta.env.VITE_FAIRBEAM_INSTALL_URL || "/#download";

/** URL of a file in public/, respecting the build's base path (/ in dev, /app/ in the demo). */
export const publicUrl = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;

/**
 * URL of a project bundle under public/projects. Bundle paths may contain folders
 * (studies/<name>/<member>.json): each segment is encoded, the slashes are kept.
 */
export const projectUrl = (file: string) =>
  publicUrl(`projects/${file.split("/").filter((s) => s && s !== "." && s !== "..").map(encodeURIComponent).join("/")}`);
