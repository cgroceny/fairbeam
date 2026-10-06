import { createMemo, createSignal, For, Show, onCleanup } from "solid-js";
import { X } from "lucide-solid";
import { unwrap } from "solid-js/store";
import { equivalentChipLoad } from "../lib/chipLoad";
import { paramValues, tryEvaluate } from "./expr";
import { useModal } from "../lib/dialog";
import { t } from "../i18n";
import { createFeed, draft, feedCreation, setFeedCreation } from "./store";
import { checkMessage } from "./checkText";
import { designChecks } from "./checks";
import type { Axis, DesignPort, DesignResistor, Vec3 } from "./types";

export default function FeedCreationDialog() {
  onCleanup(() => setFeedCreation(null));
  return <Show when={feedCreation()} keyed>{(kind) => <FeedForm kind={kind} />}</Show>;
}
function FeedForm(props: { kind: "lumped" | "waveguide" | "element" }) {
  let box: HTMLFormElement | undefined;
  const close = () => setFeedCreation(null);
  useModal(() => box, close, () => box?.querySelector("select"));
  const [type, setType] = createSignal(props.kind);
  const [start, setStart] = createSignal<Vec3>(props.kind === "waveguide" ? [-11.43, -5.08, 0] : [0, 0, 0]);
  const [stop, setStop] = createSignal<Vec3>(props.kind === "waveguide" ? [11.43, 5.08, 1] : [0, 0, 1]);
  const [direction, setDirection] = createSignal<Axis>("z");
  const [R, setR] = createSignal("50"), [L, setL] = createSignal(""), [C, setC] = createSignal("");
  const [topology, setTopology] = createSignal<"series" | "parallel">("parallel");
  const [mode, setMode] = createSignal("TE10"), [a, setA] = createSignal("22.86"), [b, setB] = createSignal("10.16");
  const [reference, setReference] = createSignal(false);
  const [referenceReal, setReferenceReal] = createSignal("20"), [referenceImag, setReferenceImag] = createSignal("-150");
  const [excite, setExcite] = createSignal(true);
  const names = paramValues(draft.params).names;
  const fMin = tryEvaluate(draft.simulation.f_min, names).value;
  const fMax = tryEvaluate(draft.simulation.f_max, names).value;
  const center = fMin !== undefined && fMax !== undefined ? fMin / 2 + fMax / 2 : NaN;
  const [chipReal, setChipReal] = createSignal("20"), [chipImag, setChipImag] = createSignal("-150");
  const [chipFrequency, setChipFrequency] = createSignal(Number.isFinite(center) && center > 0 ? String(center) : "");
  const chipEquivalent = createMemo(() => [chipReal(), chipImag(), chipFrequency()].every((v) => !!v.trim())
    ? equivalentChipLoad(Number(chipReal()), Number(chipImag()), Number(chipFrequency()) * 1e9) : null);
  const fillChipLoad = () => {
    const load = chipEquivalent();
    if (!load) return;
    setR(String(load.R)); setL(load.L === undefined ? "" : String(load.L)); setC(load.C === undefined ? "" : String(load.C));
    setTopology("parallel");
  };
  const value = createMemo<DesignPort | DesignResistor>(() => {
    const spatial = { start: start(), stop: stop(), direction: direction() };
    const taken = new Set(draft.resistors.map((element) => element.name));
    let number = 1;
    while (taken.has(`LE${number}`)) number++;
    if (type() === "element") return { ...spatial, name: `LE${number}`, topology: topology(),
      ...(R().trim() ? { R: R() } : {}), ...(L().trim() ? { L: L() } : {}), ...(C().trim() ? { C: C() } : {}) };
    return { ...spatial, type: type() as "lumped" | "waveguide", number: Math.max(0, ...draft.ports.map((p) => p.number)) + 1,
      excite: excite(), ...(type() === "waveguide" ? { mode: mode(), a: a(), b: b() } : { R: R(), ...(reference() ? { reference_impedance: { real: referenceReal(), imag: referenceImag() } } : {}) }) };
  });
  const errors = createMemo(() => {
    const d = structuredClone(unwrap(draft));
    const path = type() === "element" ? `resistors[${d.resistors.length}]` : `ports[${d.ports.length}]`;
    if (type() === "element") d.resistors.push(value() as DesignResistor); else d.ports.push(value() as DesignPort);
    return designChecks(d).filter((c) => c.severity === "error" && c.path.startsWith(path));
  });
  const field = (label: string, value: () => string, set: (v: string) => void, unit = "", id = "") => <label class="dz-field"><span class="dz-label">{label} {unit}</span><input autocomplete="off" placeholder={unit == "H" ? "1e-9 (1 nH)" : unit == "F" ? "1e-12 (1 pF)" : undefined} id={id || undefined} class="rp-input dz-input mono" value={value()} onInput={(e) => set(e.currentTarget.value)} /></label>;
  const vector = (label: string, value: () => Vec3, set: (v: Vec3) => void, path: string) => <fieldset><legend>{label} (mm)</legend><div class="dz-pair"><For each={[0, 1, 2]}>{(k) => field("xyz"[k].toUpperCase(), () => String(value()[k]), (v) => { const next = [...value()] as Vec3; next[k] = v; set(next); }, "", `feed-${path}-${k}`)}</For></div></fieldset>;
  return <div class="scrim"><form autocomplete="off" class="dialog dz-feed-dialog" role="dialog" aria-modal="true" aria-labelledby="feed-title" ref={box} tabindex={-1} onSubmit={(e) => { e.preventDefault(); if (!errors().length) createFeed(value()); }}>
    <div class="dialog-head"><h2 id="feed-title">{t("feed.create")}</h2><button type="button" class="icon-btn" aria-label={t("common.close")} onClick={close}><X size={18} /></button></div>
    <div class="dialog-body dz-form">
      <label class="dz-field"><span class="dz-label">{t("props.port.type")}</span><select class="rp-input" value={type()} onChange={(e) => setType(e.currentTarget.value as typeof props.kind)}><option value="lumped">{t("props.port.lumped")}</option><option value="waveguide">{t("props.port.waveguide")}</option><option value="element">{t("feed.element")}</option></select></label>
      <p class="note">{t("feed.coordinates")}</p>
      {vector(t("props.start"), start, setStart, "start")}{vector(t("props.stop"), stop, setStop, "stop")}
      <label class="dz-field"><span class="dz-label">{t("props.direction")}</span><select class="rp-input" value={direction()} onChange={(e) => setDirection(e.currentTarget.value as Axis)}><For each={["x", "y", "z"]}>{(axis) => <option>{axis}</option>}</For></select></label>
      <Show when={type() !== "waveguide"}>{field(t("props.resistor.resistance"), R, setR, "Ω")}</Show>
      <Show when={type() === "lumped"}><label class="dz-check"><input autocomplete="off" type="checkbox" checked={reference()} onChange={(e) => setReference(e.currentTarget.checked)} />{t("feed.complexReference")}</label><Show when={reference()}>{field("Re Zref", referenceReal, setReferenceReal, "Ω")}{field("Im Zref", referenceImag, setReferenceImag, "Ω")}<p class="note">{t("feed.referenceNote")}</p></Show></Show>
      <Show when={type() === "element"}>{field(t("feed.inductance"), L, setL, "H")}{field(t("feed.capacitance"), C, setC, "F")}
        <label class="dz-field"><span class="dz-label">{t("feed.topology")}</span><select class="rp-input" value={topology()} onChange={(e) => setTopology(e.currentTarget.value as "series" | "parallel")}><option value="parallel">{t("feed.parallel")}</option><option value="series">{t("feed.series")}</option></select></label><p class="note">{t("feed.rlcNote")}</p><Show when={topology() === "series" && (!!L().trim() || !!C().trim())}><p class="note" role="note">{t("feed.seriesLimitation")}</p></Show></Show>
      <Show when={type() === "element"}>
        <details class="dz-inspector-advanced dz-chip-helper">
          <summary tabindex={0}>{t("feed.chipHelper")}</summary>
          <div class="dz-form" onKeyDown={(event) => {
            if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
              event.preventDefault();
              event.stopPropagation();
              fillChipLoad();
            }
          }}>
            <p class="note">{t("feed.chipNote")}</p>
            {field(t("feed.chipReal"), chipReal, setChipReal, "Ω", "feed-chip-real")}
            {field(t("feed.chipImag"), chipImag, setChipImag, "Ω", "feed-chip-imag")}
            {field(t("feed.chipFrequency"), chipFrequency, setChipFrequency, "GHz", "feed-chip-frequency")}
            <Show when={!chipEquivalent()}><p class="dz-bad" role="alert">{t("feed.chipInvalid")}</p></Show>
            <button class="btn" type="button" disabled={!chipEquivalent()} onClick={fillChipLoad}>{t("feed.chipFill")}</button>
          </div>
        </details>
      </Show>
      <Show when={type() === "waveguide"}>{field(t("feed.mode"), mode, setMode)}{field("a", a, setA, "mm")}{field("b", b, setB, "mm")}<p class="note">{t("props.port.noteWaveguide")}</p><p class="note">{t("feed.floquetNote")}</p></Show>
      <Show when={type() !== "element"}><label class="dz-check"><input autocomplete="off" type="checkbox" checked={excite()} onChange={(e) => setExcite(e.currentTarget.checked)} />{t("props.port.excited")}</label></Show>
      <Show when={errors().length}><div class="dz-bad" role="alert"><p>{t("feed.invalid")}</p><For each={errors()}>{(error) => <p>{checkMessage(error)}</p>}</For></div></Show>
    </div><div class="dialog-foot"><button class="btn" type="button" onClick={close}>{t("common.cancel")}</button><button class="btn btn-primary" type="submit" disabled={!!errors().length}>{t("feed.create")}</button></div>
  </form></div>;
}
