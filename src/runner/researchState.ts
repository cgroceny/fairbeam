import { createSignal } from "solid-js";

export const [researchOpen, setResearchOpen] = createSignal(false);
export const [researchSelectedId, setResearchSelectedId] = createSignal<string | null>(null);
export function openResearch(id?: string) {
  setResearchSelectedId(id ?? null);
  setResearchOpen(true);
}

const PATH_KEY = "fairbeam.research.paths";
export function researchPath(backend: string): string {
  try { return JSON.parse(localStorage.getItem(PATH_KEY) ?? "{}")[backend] ?? ""; } catch { return ""; }
}
export function rememberResearchPath(backend: string, path: string) {
  try {
    const paths = JSON.parse(localStorage.getItem(PATH_KEY) ?? "{}");
    localStorage.setItem(PATH_KEY, JSON.stringify({ ...paths, [backend]: path }));
  } catch { /* Storage may be disabled; the path still works for this session. */ }
}
