// The memory / CPU check of a run (POST /api/preflight) as a note in a run dialog. Shared by the
// Run dialog and the batch dialogs (sweep, mesh convergence, optimizer), which pass the largest
// cell count they expect to simulate.
import { createResource, Show, Suspense } from "solid-js";
import { CircleAlert } from "lucide-solid";
import { api, type Preflight } from "../runner/api";
import { health, serverState } from "../runner/store";
import { fmt, t } from "../i18n";

/** "12 MB" / "1.4 GiB" (a small mesh does not read as "0.0 GiB") */
export function memoryText(bytes: number): string {
  return bytes < 2 ** 30 ? `${fmt.int(Math.max(1, Math.round(bytes / 2 ** 20)))} MB` : `${fmt.fixed(bytes / 2 ** 30, 1)} GiB`;
}

/** What an "unknown" answer means, said exactly: no mesh yet, the graphics card's free memory (the
 * server cannot read it), or the computer's free memory. The rest of the answer (another run is
 * using the CPU, …) follows as the server wrote it. */
export function unknownText(pre: Pick<Preflight, "estimate_bytes" | "free_bytes">, cells: number | undefined, engine: string): string {
  if (!cells || pre.estimate_bytes == null) return t("run.preflight.noMesh");
  const need = memoryText(pre.estimate_bytes);
  return engine === "gpu" ? t("run.preflight.gpuUnknown", { need }) : t("run.preflight.freeUnknown", { need });
}

export function PreflightNote(props: { cells: number | undefined; engine: string }) {
  // asked again when the server's queue changes (a run another client started or ended, #7): the
  // busy part of the answer ("another run is using the CPU") follows it
  const queue = () => { const q = health()?.queue; return q ? `${q.running ?? ""}|${q.queued}|${q.external ?? 0}` : ""; };
  const [pre] = createResource(() => ({ e: props.engine, c: props.cells, ok: serverState() === "online", q: queue() }), (s) => (s.ok && s.c ? api.preflight({ cells: s.c, engine: s.e }).catch(() => null) : null));
  // the memory part of an "unknown" answer is said by the app; the server's other remarks follow
  // (each remark after the app's sentence starts as a sentence: the server writes lower-case clauses)
  const text = (p: Preflight) => p.level !== "unknown" ? p.messages.join(" ")
    : [unknownText(p, props.cells, props.engine), ...p.messages.slice(1).map((m) => m.charAt(0).toUpperCase() + m.slice(1))].join(" ");
  // Its own Suspense boundary: while the check is asked, only this note waits. Without it the
  // nearest boundary (the whole ribbon that hosts the Run, Sweep and Optimize dialogs) was swapped
  // for its loading placeholder, which detached the dialog's opener and dropped keyboard focus.
  return (
    <Suspense>
      <Show when={pre() && pre()!.level !== "ok"}>
        <p class="note" classList={{ "dz-bad": pre()!.level === "refuse" }} role={pre()!.level === "refuse" ? "alert" : "status"}>
          <CircleAlert size={14} aria-hidden="true" /> {text(pre()!)}
        </p>
      </Show>
    </Suspense>
  );
}
