// The memory / CPU check of a run (POST /api/preflight) as a note in a run dialog. Shared by the
// Run dialog and the batch dialogs (sweep, mesh convergence, optimizer), which pass the largest
// cell count they expect to simulate.
import { createResource, Show } from "solid-js";
import { CircleAlert } from "lucide-solid";
import { api } from "../runner/api";
import { health, serverState } from "../runner/store";
import { t } from "../i18n";

export function PreflightNote(props: { cells: number | undefined; engine: string }) {
  // asked again when the server's queue changes (a run another client started or ended, #7): the
  // busy part of the answer ("another run is using the CPU") follows it
  const queue = () => { const q = health()?.queue; return q ? `${q.running ?? ""}|${q.queued}|${q.external ?? 0}` : ""; };
  const [pre] = createResource(() => ({ e: props.engine, c: props.cells, ok: serverState() === "online", q: queue() }), (s) => (s.ok && s.c ? api.preflight({ cells: s.c, engine: s.e }).catch(() => null) : null));
  return (
    <Show when={pre() && pre()!.level !== "ok"}>
      <p class="note" classList={{ "dz-bad": pre()!.level === "refuse" }} role={pre()!.level === "refuse" ? "alert" : "status"}>
        <CircleAlert size={14} aria-hidden="true" /> {pre()!.level === "unknown" ? t("run.preflight.unknown") : pre()!.messages.join(" ")}
      </p>
    </Show>
  );
}
