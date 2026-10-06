// Apply in the Python panel: a script becomes the design's content (parts, materials, ports,
// resistors, parameters, mesh, simulation, far field) in one edit. The design's own identity (name,
// id, description) stays. Kept free of the store so a node check can drive it (check-python-apply.mjs).
import type { Design } from "./types";

export interface PythonApplyResponse { design: Design; python: string; normalized: boolean; output?: string }

export type PythonApplyOutcome =
  | { ok: true; python: string; normalized: boolean; output: string }
  | { ok: false; message: string; line?: number; timeout?: boolean; stale?: boolean };

/** Replace everything of `d` except its schema and model with the content of `next` (mutates `d`, for a produce). */
export function replaceDesignContent(d: Design, next: Design): void {
  const target = d as unknown as Record<string, unknown>;
  for (const key of Object.keys(target)) if (key !== "schema" && key !== "model") delete target[key];
  const source = JSON.parse(JSON.stringify(next)) as unknown as Record<string, unknown>;
  for (const key of Object.keys(source)) if (key !== "schema" && key !== "model") target[key] = source[key];
}

export interface PythonApplyDeps {
  /** POST /api/design/from-python; throws an error with `data.line` / `data.timeout` for a script that fails */
  convert: (source: string) => Promise<PythonApplyResponse>;
  /** true while the design the script was written for is still the one open */
  current: () => boolean;
  /** one undo step */
  replace: (next: Design) => void;
}

/** The design is touched only after the server accepted the script, and then by one `replace`. */
export async function applyPythonScript(source: string, deps: PythonApplyDeps): Promise<PythonApplyOutcome> {
  let res: PythonApplyResponse;
  try {
    res = await deps.convert(source);
  } catch (e) {
    const data = ((e as { data?: Record<string, unknown> }).data ?? {}) as { line?: unknown; timeout?: unknown };
    return {
      ok: false, message: e instanceof Error ? e.message : String(e),
      line: typeof data.line === "number" && data.line >= 1 ? data.line : undefined,
      timeout: data.timeout === true,
    };
  }
  if (!deps.current()) return { ok: false, message: "", stale: true };
  deps.replace(res.design);
  return { ok: true, python: res.python, normalized: res.normalized, output: res.output ?? "" };
}
