// Ephemeral choices for one result. No viewer, Designer, document or browser globals.
import { batch, createComputed, createMemo, createSignal, on, type Accessor } from "solid-js";
import type { Bundle } from "../types";
import { defaultSmallAntennaOptions, smallAntennaAnalysis, type SmallAntennaOptions } from "./smallAntenna.ts";
import { snapshotSmallAntenna } from "./smallAntennaResult.ts";

const emptyOptions = (): SmallAntennaOptions => ({ resonanceId: null, vswr: 2, selectedPartIndices: [], enclosure: "finite" });
const owned = (value: SmallAntennaOptions): SmallAntennaOptions => Object.freeze({ ...value, selectedPartIndices: Object.freeze([...value.selectedPartIndices]) });

export function createSmallAntennaSession(readSource: Accessor<Bundle | null>,
  config: { identity?: Accessor<string>; comparing?: Accessor<boolean> } = {}) {
  // A focus/tab object can change while resolving to the same actual result.
  const [disposed, setDisposed] = createSignal(false);
  const source = createMemo(() => disposed() ? null : readSource());
  const identity = createMemo(() => config.identity?.() ?? "");
  const [selection, setSelection] = createSignal(owned(emptyOptions()));
  const [vswrText, setVswrText] = createSignal("2"), [badInput, setBadInput] = createSignal(false);
  const [custom, setCustom] = createSignal(false), [revision, setRevision] = createSignal(0);
  const changed = () => setRevision(value => value + 1);
  const reset = () => batch(() => {
    const b = source();
    setSelection(owned(b ? defaultSmallAntennaOptions(b) : emptyOptions()));
    setVswrText("2"); setBadInput(false); setCustom(false); changed();
  });
  createComputed(on([source, identity], reset));
  const invalidVswr = createMemo(() => badInput() || !vswrText().trim() || !Number.isFinite(Number(vswrText())) || Number(vswrText()) <= 1);
  const options = createMemo(() => owned({ ...selection(), vswr: invalidVswr() ? NaN : Number(vswrText()) }));
  const analysis = createMemo(() => { const b = source(); return b ? smallAntennaAnalysis(b, options()) : null; });
  const editable = () => !!source() && !disposed() && !config.comparing?.();
  const update = (partial: Partial<SmallAntennaOptions>) => {
    if (!editable()) return;
    batch(() => { setSelection(value => owned({ ...value, ...partial })); setCustom(true); changed(); });
  };
  const selectResonance = (id: string | null) => {
    if (id !== null && !analysis()?.candidates.some(candidate => candidate.id === id)) return;
    update({ resonanceId: id });
  };
  const setVswr = (text: string, invalid = false) => {
    if (!editable()) return;
    batch(() => { setVswrText(text); setBadInput(invalid); setCustom(true); changed(); });
  };
  const selectPart = (index: number, selected: boolean) => {
    if (!Number.isInteger(index) || !source()?.parts[index] || source()!.parts[index].void) return;
    const indices = new Set(selection().selectedPartIndices);
    if (selected) indices.add(index); else indices.delete(index);
    update({ selectedPartIndices: [...indices].sort((a, b) => a - b) });
  };
  const selectAllParts = () => { const b = source(); if (b) update({ selectedPartIndices: defaultSmallAntennaOptions(b).selectedPartIndices }); };
  const setEnclosure = (enclosure: SmallAntennaOptions["enclosure"]) => {
    if (enclosure === "finite" || enclosure === "pec-image") update({ enclosure });
  };
  const snapshot = (bundle: Bundle, file = "") => bundle === source() && analysis()
    ? snapshotSmallAntenna(bundle, file, custom() ? options() : undefined, analysis()!)
    : snapshotSmallAntenna(bundle, file);
  return { source, identity, options, analysis, editable, vswrText, invalidVswr, revision, custom,
    selectResonance, setVswr, selectPart, selectAllParts, setEnclosure, snapshot, reset,
    dispose: () => { setDisposed(true); } };
}
export type SmallAntennaSession = ReturnType<typeof createSmallAntennaSession>;
