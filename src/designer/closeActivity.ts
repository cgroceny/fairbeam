import { createSignal } from "solid-js";
import type { CloseActivityJob } from "../runner/api";

type Answer = "clear" | "pending" | "cancel";
type Phase = "initial" | "final";
type Request = {
  id: number; checked: Set<Phase>; checking: boolean; canceled: boolean;
  approved: Set<string>; unknownApproved: boolean; activity: CloseActivityJob[] | null;
};
let query: (() => Promise<CloseActivityJob[]>) | null = null;
let request: Request | null = null;
export type ActivityCounts = { simulations: number; renders: number };
export const [closeActivity, setCloseActivity] = createSignal<{ id: number; counts: ActivityCounts | null } | null>(null);
const activityKey = (job: CloseActivityJob) => JSON.stringify([job.kind, job.id]);

/** The mounted desktop close host supplies a fresh, server-wide list, never scoped history. */
export function registerCloseActivity(read: () => Promise<CloseActivityJob[]>) {
  query = read;
  return () => {
    if (query !== read) return;
    query = null;
    request = null;
    setCloseActivity(null);
  };
}

/** Check once before unsaved-work questions and once immediately before authorizing exit.
 * Work started during Save/Don't save still needs consent; finished work needs no second question. */
export function checkCloseActivity(id: number, phase: Phase): Answer {
  if (!query) return "clear";
  if (!request || request.id !== id) {
    request = { id, checked: new Set(), checking: false, canceled: false,
      approved: new Set(), unknownApproved: false, activity: [] };
    setCloseActivity(null);
  }
  const current = request;
  if (current.canceled) return "cancel";
  if (current.checking || closeActivity()) return "pending";
  if (current.checked.has(phase)) return "clear";
  current.checking = true;
  void query().then(jobs => {
    if (request !== current) return;
    current.activity = jobs;
    if (jobs.some(job => !current.approved.has(activityKey(job)))) setCloseActivity({ id, counts: {
      simulations: jobs.filter(job => job.kind === "simulation").length,
      renders: jobs.filter(job => job.kind === "render").length,
    } });
  }, () => {
    if (request !== current) return;
    current.activity = null;
    // A failed status request is not evidence that no simulations or renders are running.
    if (!current.unknownApproved) setCloseActivity({ id, counts: null });
  }).finally(() => {
    current.checking = false;
    current.checked.add(phase);
  });
  return "pending";
}

export function decideCloseActivity(proceed: boolean) {
  if (!request || closeActivity()?.id !== request.id) return;
  if (!proceed) request.canceled = true;
  else if (request.activity === null) request.unknownApproved = true;
  else for (const job of request.activity) request.approved.add(activityKey(job));
  // Work may have arrived while either activity question was open, including the
  // final one. Re-read before exit; approved identities will not ask twice.
  if (proceed) request.checked.delete("final");
  setCloseActivity(null);
}

/** A replacement dialog can cancel exit while the status request is still in flight. */
export function cancelCloseActivity(id: number) {
  if (request?.id !== id) return;
  request = null;
  setCloseActivity(null);
}

/** A later edit or save question invalidates only the final status check, not run consent. */
export function requireFinalActivityCheck(id: number) {
  if (request?.id === id) request.checked.delete("final");
}
