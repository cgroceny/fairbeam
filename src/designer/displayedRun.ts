import { createSignal } from "solid-js";
import type { Bundle } from "../types";

// openBundle validates into a new object. Keep its exact source relationship, never infer it
// from a model id or frequency shared by different runs. Null invalidates the viewport adapter.
export const [displayedRun, setDisplayedRun] = createSignal<{ source: Bundle; view: Bundle } | null>(null);
