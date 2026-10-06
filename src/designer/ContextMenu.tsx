import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { openColor } from "./ColorPopover";
import { ChevronLeft, CircleDot, Copy, Eye, EyeOff, Folder, FolderInput, GitMerge, Move, Palette, Pencil, Trash2, X, Zap } from "lucide-solid";
import { useModal } from "../lib/dialog";
import { ExprField, SelectField } from "./DesignPane";
import { closeContext, contextTarget, setRenaming, type ContextTarget } from "./context";
import { componentFolders, designScale, normComponent, draft, duplicateSelected, edit, file, moveToComponent, names, removeSelected, selectAddedFeed, setSelection } from "./store";
import { EdgeTreatmentDialog } from "./EdgeTreatmentDialog";
import { openTransform } from "./transforms";
import { quickBundle } from "./geometry";
import { tryEvaluate } from "./expr";
import { SHORTCUTS } from "./shortcuts";
import { health } from "../runner/store";
import { hiddenParts, setHiddenParts } from "../state";
import type { Axis, DesignPort, Expr, Vec3 } from "./types";
import { BooleanTargets } from "./BooleanTargets";
import { t } from "../i18n";
import type { BooleanOperation } from "./booleanUi";

/** The port dialog's one-line summary, in the port's Start → Stop order (types.ts DesignPort):
 * with a target the other conductor is the start and the picked face (`here`) the stop; a stub
 * starts on the picked face. */
export function portSummary(choice: number | "stub" | "custom", o: {
  here: string; target: string; axis: Axis; ends: [Vec3, Vec3]; stubLength: number; fmt: (v: number) => string;
}): string {
  const [a, b] = o.ends.map((v) => o.fmt(Number(v["xyz".indexOf(o.axis)])));
  if (typeof choice === "number") return t("contextMenu.port.start", { target: o.target, here: o.here, axis: o.axis, a, b });
  if (choice === "stub") return t("contextMenu.port.stub", { here: o.here, axis: o.axis, a, b, length: o.fmt(o.stubLength) });
  return t("contextMenu.port.custom");
}

function PortDialog(props: { target: ContextTarget; close: () => void }) {
  let box!: HTMLDivElement;
  useModal(() => box, props.close);
  const s = props.target.selection, part = draft.parts[s.i];
  const b = quickBundle({ ...draft, ports: [], parts: [{ ...part, primitives: s.type === "primitive" ? [part.primitives[s.j]] : part.primitives }] }, names().names, null);
  const bounds = b?.parts[0]?.bbox;
  const center = bounds ? bounds[0].map((v, k) => (v + bounds[1][k]) / 2) : [0, 0, 0];
  const normal = props.target.normal ?? [0, 0, 1];
  const axis = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
  // picked points carry float noise (7.45e-11 for a face at 0): 0.1 µm is finer than any mesh
  const round = (v: number[]) => v.map((x) => Math.round(x * 1e4) / 1e4 + 0) as Vec3;
  const picked = round(props.target.point ?? center);
  const targets = props.target.targets ?? [];
  const label = (name: string) => { const q = draft.parts.find((x) => x.name === name); return q?.label || name; };
  const here = label(part.name);
  const stubLength = Math.max(designScale() / 10, 0.001);
  // A choice is one of the metals found along the face normal, a short stub out of the face, or
  // "custom" once the user edits the ends. The other metal is the start, the picked face the stop.
  type Choice = number | "stub" | "custom";
  const endsFor = (c: Choice): [Vec3, Vec3] => {
    if (typeof c === "number") {
      const other = round(targets[c].point);
      other.forEach((_, k) => { if (k !== axis) other[k] = picked[k]; });
      return [other, [...picked] as Vec3];
    }
    const stop = [...picked] as Vec3;
    stop[axis] = Number(stop[axis]) + (normal[axis] < 0 ? -1 : 1) * stubLength;
    return [[...picked] as Vec3, stop];
  };
  const [choice, setChoice] = createSignal<Choice>(targets.length ? 0 : "stub");
  const [initial, stop] = endsFor(choice());
  const [port, setPort] = createSignal<DesignPort>({ type: "lumped", number: Math.max(0, ...draft.ports.map((p) => p.number)) + 1,
    R: 50, start: initial, stop, direction: "xyz"[axis] as Axis });
  const choose = (c: Choice) => { setChoice(c); const [a, b] = endsFor(c); setPort({ ...port(), start: a, stop: b, direction: "xyz"[axis] as Axis }); };
  const fmt = (v: number) => String(Number(v.toPrecision(6)));
  const summary = () => portSummary(choice(), {
    here, target: typeof choice() === "number" ? label(targets[choice() as number].part) : "", axis: "xyz"[axis] as Axis,
    ends: endsFor(choice()), stubLength, fmt,
  });
  const ev = (value: Expr | undefined) => tryEvaluate(value, names().names).value;
  const valid = () => {
    const p = port(), values = [...p.start, ...p.stop, p.R].map(ev);
    const k = "xyz".indexOf(p.direction);
    return values.every((v) => v !== undefined && Number.isFinite(v)) && values[6]! > 0 && values[k] !== values[k + 3];
  };
  return <div class="scrim" onClick={(e) => { if (e.target === e.currentTarget) props.close(); }}>
    <div class="dialog dz-port-dialog" ref={box} role="dialog" aria-modal="true" aria-labelledby="context-port-title" aria-describedby="context-port-help" tabindex="-1">
      <div class="dialog-head"><div><h2 id="context-port-title">{props.target.fromBounds ? t("contextMenu.port.titleOn", { part: here }) : t("contextMenu.port.here")}</h2>
        <p id="context-port-help" class="muted">{props.target.fromBounds ? t("contextMenu.port.fromBounds") : t("contextMenu.port.review")} {t("contextMenu.port.lengths")}</p></div>
        <button class="icon-btn" aria-label={t("common.close")} onClick={props.close}><X /></button></div>
      <form id="context-port-form" class="dialog-body stack" onSubmit={(e) => {
        e.preventDefault(); if (!valid()) return;
        edit((d) => { d.ports.push({ ...port(), number: Math.max(0, ...d.ports.map((p) => p.number)) + 1 }); });
        selectAddedFeed({ type: "port", i: draft.ports.length - 1 }); props.close();
      }}>
        <p class="dz-port-summary" role="status">{summary()}</p>
        <fieldset class="dz-port-choices"><legend class="dz-label">{t("contextMenu.port.connectTo")}</legend>
          <For each={targets}>{(t, k) => (
            <label><input type="radio" name="context-port-target" checked={choice() === k()} onChange={() => choose(k())} />
              {" "}{label(t.part)} <span class="muted">({t.side}, {fmt(t.distance)} mm)</span></label>
          )}</For>
          <label><input type="radio" name="context-port-target" checked={choice() === "stub"} onChange={() => choose("stub")} /> {t("contextMenu.port.stubChoice")}</label>
          <Show when={choice() === "custom"}><label><input type="radio" name="context-port-target" checked /> {t("contextMenu.port.customChoice")}</label></Show>
        </fieldset>
        <ExprField label={t("contextMenu.port.impedance")} unit="Ω" path="__contextPort.R" value={port().R} offerParams={false} onChange={(R) => setPort({ ...port(), R })} />
        <For each={["start", "stop"] as const}>{(end) => <fieldset class="dz-vec"><legend>{t(end === "start" ? "contextMenu.port.startEnd" : "contextMenu.port.stopEnd")}</legend>
          <div class="dz-vec-row"><For each={[0, 1, 2]}>{(k) => <ExprField label={"xyz"[k]} path={`__contextPort.${end}[${k}]`}
            offerParams={false} value={port()[end][k]} onChange={(v) => { const vector = [...port()[end]] as Vec3; vector[k] = v; setPort({ ...port(), [end]: vector }); setChoice("custom"); }} />}</For></div>
        </fieldset>}</For>
        <SelectField label={t("contextMenu.port.direction")} value={port().direction} options={["x", "y", "z"] as Axis[]} onChange={(direction) => { setPort({ ...port(), direction }); setChoice("custom"); }} />
        <Show when={!valid()}><p class="note" role="status">{t("contextMenu.port.invalid")}</p></Show>
      </form>
      <div class="dialog-foot"><span class="muted">{t("contextMenu.port.number", { n: port().number })}</span><div class="dialog-actions">
        <button class="btn btn-ghost" data-noprompt onClick={props.close}>{t("common.cancel")}</button>
        <button class="btn btn-primary" type="submit" form="context-port-form" disabled={!valid()}>{t("contextMenu.port.add")}</button>
      </div></div>
    </div>
  </div>;
}

/** The Boolean items' texts: [on a part row, on a shape row] */
const BOOLEAN_ITEM_KEYS: Record<BooleanOperation, [string, string]> = {
  add: ["contextMenu.boolean.add", "contextMenu.boolean.addPart"],
  subtract: ["contextMenu.boolean.subtract", "contextMenu.boolean.subtractPart"],
  intersect: ["contextMenu.boolean.intersect", "contextMenu.boolean.intersectPart"],
  insert: ["contextMenu.boolean.insert", "contextMenu.boolean.insertPart"],
};
const BOOLEAN_SHORTCUTS: Record<BooleanOperation, string> = {
  add: SHORTCUTS.booleanAdd.key, subtract: SHORTCUTS.booleanSubtract.key,
  intersect: SHORTCUTS.booleanIntersect.key, insert: SHORTCUTS.booleanInsert.key,
};

function Menu(props: { target: ContextTarget; port: () => void; edge: (j:number) => void }) {
  let menu!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: props.target.x, y: props.target.y });
  const act = (fn: () => void) => { setSelection(props.target.selection); closeContext(); fn(); };
  // "Move to component" swaps the items for the folders in place: no dialog (dragging the part in
  // the tree does the same)
  const [moving, setMoving] = createSignal(false);
  // "Subtract ›": the other solids listed in place, one pick applies the Boolean
  const [booleanOp, setBooleanOp] = createSignal<BooleanOperation | null>(null);
  const [booleanChoosing, setBooleanChoosing] = createSignal(false);
  const [fresh, setFresh] = createSignal("");
  const current = () => normComponent(draft.parts[props.target.selection.i]?.component);
  const moveTo = (path: string) => act(() => moveToComponent(props.target.selection.i, path));
  const focusFirst = () => queueMicrotask(() => menu.querySelector<HTMLElement>("button:not(:disabled)")?.focus());
  const showFolders = () => { setMoving(true); focusFirst(); };
  // Offer only what makes sense for the item under the cursor: a port needs a picked point on a
  // metal surface (from the 3D view; the tree has no point), and component folders hold parts.
  const s = props.target.selection, part = () => draft.parts[s.i];
  const isPart = () => s.type === "part";
  const deletesPart = () => isPart() || part()?.primitives.length === 1;
  const canPort = () => !!props.target.point && draft.materials.find((m) => m.name === part()?.material)?.kind === "metal";
  // An edit, undo or addition that moves the item under the menu makes its indices stale.
  const where = () => `${part()?.name}/${s.type === "primitive" ? part()?.primitives.length : ""}`, opened = where();
  createEffect(() => { if (where() !== opened) closeContext(false); });
  onMount(() => {
    const r = menu.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(props.target.x, innerWidth - r.width - 8)), y: Math.max(8, Math.min(props.target.y, innerHeight - r.height - 8)) });
    menu.querySelector<HTMLElement>("button")?.focus();
    const away = (e: PointerEvent) => { if (!menu.contains(e.target as Node)) closeContext(false); };
    const viewport = (e: Event) => { if (!menu.contains(e.target as Node)) closeContext(false); };
    // Focus leaving the menu (a click elsewhere, a dialog, script focus) or Escape anywhere closes it:
    // an open menu must never keep swallowing keys such as Ctrl+W.
    const blur = (e: FocusEvent) => { if (!menu.contains(e.relatedTarget as Node | null) && e.relatedTarget) closeContext(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !menu.contains(e.target as Node)) closeContext(false); };
    menu.addEventListener("focusout", blur);
    document.addEventListener("keydown", esc, true);
    document.addEventListener("pointerdown", away);
    window.addEventListener("resize", viewport);
    window.addEventListener("scroll", viewport, true);
    onCleanup(() => { menu.removeEventListener("focusout", blur); document.removeEventListener("keydown", esc, true); document.removeEventListener("pointerdown", away); window.removeEventListener("resize", viewport); window.removeEventListener("scroll", viewport, true); });
  });
  return <div ref={menu} class="menu dz-context-menu" role="menu" aria-label={t("contextMenu.aria")} style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
    onContextMenu={(e) => e.preventDefault()} onKeyDown={(e) => {
      // Keep the menu's own keys from reaching the tree or 3D view; shortcuts pass through.
      if (!(e.ctrlKey || e.metaKey || e.altKey)) e.stopPropagation();
      // arrows step over disabled items (the current folder) and include the new-folder field
      const items = [...menu.querySelectorAll<HTMLElement>("button:not(:disabled), input")], i = items.indexOf(document.activeElement as HTMLElement);
      const inField = document.activeElement instanceof HTMLInputElement;
      if (e.key === "Escape") { e.preventDefault(); closeContext(); }
      else if (e.key === "Tab") closeContext();
      else if (["ArrowDown", "ArrowUp"].includes(e.key) || (!inField && ["Home", "End"].includes(e.key))) {
        e.preventDefault(); items[e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    }}>
    <Show when={!booleanOp()} fallback={<BooleanTargets op={booleanOp()!} a={s.i} itemClass="menu-item" onBack={() => { setBooleanOp(null); focusFirst(); }} onDone={() => { setSelection(props.target.selection); closeContext(); }} />}>
    <Show when={!booleanChoosing()} fallback={<>
      <button class="menu-item" role="menuitem" onClick={() => { setBooleanChoosing(false); focusFirst(); }}><ChevronLeft /> {t("contextMenu.boolean")}</button>
      <For each={["add", "subtract", "intersect", "insert"] as BooleanOperation[]}>{(op) =>
        <button class="menu-item" role="menuitem" aria-keyshortcuts={BOOLEAN_SHORTCUTS[op]}
          onClick={() => { setBooleanOp(op); focusFirst(); }}><GitMerge /> {t(BOOLEAN_ITEM_KEYS[op][isPart() ? 0 : 1])}</button>}</For>
    </>}>
    <Show when={!moving()} fallback={<>
      <button class="menu-item" role="menuitem" onClick={() => { setMoving(false); focusFirst(); }}><ChevronLeft /> {t("contextMenu.moveToComponent")}</button>
      <button class="menu-item" role="menuitem" disabled={current() === ""} onClick={() => moveTo("")}><Folder /> {t("contextMenu.topLevel")}{current() === "" ? t("contextMenu.current") : ""}</button>
      <For each={componentFolders()}>{(c) => (
        <button class="menu-item" role="menuitem" disabled={current() === c} onClick={() => moveTo(c)}
          style={{ "padding-left": `${10 + (c.split("/").length - 1) * 14}px` }}><Folder /> {c.split("/").at(-1)}{current() === c ? t("contextMenu.current") : ""}</button>
      )}</For>
      <input autocomplete="off" class="rp-input dz-input mono dz-menu-new" type="text" spellcheck={false} placeholder={t("contextMenu.newComponentPlaceholder")} aria-label={t("contextMenu.newComponent")}
        value={fresh()} onInput={(e) => setFresh(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && fresh().trim()) { e.preventDefault(); moveTo(fresh()); } }} />
    </>}>
      <button class="menu-item" role="menuitem" title={t("contextMenu.renameTitle", { key: SHORTCUTS.rename.key })} onClick={() => act(() => setRenaming(props.target.selection))}><Pencil /> {t("contextMenu.rename", { key: SHORTCUTS.rename.key })}</button>
      <button class="menu-item" role="menuitem" onClick={() => act(() => setHiddenParts(part()?.name ?? "", !hiddenParts[part()?.name ?? ""]))}>
        {hiddenParts[part()?.name ?? ""] ? <><Eye /> {t("contextMenu.showPart")}</> : <><EyeOff /> {t("contextMenu.hidePart")}</>}</button>
      <div class="dz-menu-separator" role="separator" />
      <button class="menu-item" role="menuitem" title={health()?.desktop ? SHORTCUTS.transform.key : undefined} onClick={() => act(() => openTransform("move", props.target.selection))}><Move /> {t("contextMenu.transform")}</button>
      <button class="menu-item" role="menuitem" onClick={() => { const at = { x: props.target.x, y: props.target.y }; act(() => openColor({ kind: "parts", indices: [s.i], label: part()?.label || part()?.name || "", ...at })); }}><Palette /> {t("contextMenu.color")}</button>
      <Show when={(isPart() ? part()?.primitives.length === 1 : true) && part()?.primitives[s.type === "primitive" ? s.j : 0]?.kind === "box"}><button class="menu-item" role="menuitem" onClick={() => act(() => props.edge(s.type === "primitive" ? s.j : 0))}><CircleDot /> {t("edgeTreatment.title")}</button></Show>
      <div class="dz-menu-separator" role="separator" />
      <button class="menu-item" role="menuitem" disabled={draft.parts.length < 2} title={draft.parts.length < 2 ? t("boolean.needTwo") : undefined} onClick={() => { setBooleanChoosing(true); focusFirst(); }}><GitMerge /> {t("contextMenu.boolean")} ›</button>
      <button class="menu-item" role="menuitem" onClick={showFolders} title={t("contextMenu.moveTitle")}><FolderInput /> {t(isPart() ? "contextMenu.moveToComponent" : "contextMenu.movePart")} ›</button>
      <Show when={canPort()}>
        <div class="dz-menu-separator" role="separator" />
        <button class="menu-item" role="menuitem" onClick={() => act(props.port)}><Zap /> {props.target.fromBounds ? t("contextMenu.addPort") : t("contextMenu.port.here")}</button>
      </Show>
      <div class="dz-menu-separator" role="separator" />
      <button class="menu-item" role="menuitem" title={SHORTCUTS.duplicate.key} onClick={() => act(duplicateSelected)}><Copy /> {t("contextMenu.duplicate", { key: SHORTCUTS.duplicate.key })}</button>
      <button class="menu-item" role="menuitem" title={SHORTCUTS.delete.key} onClick={() => act(removeSelected)}><Trash2 /> {t(deletesPart() ? "contextMenu.deletePart" : "contextMenu.deleteShape", { key: SHORTCUTS.delete.key })}</button>
    </Show>
    </Show>
    </Show>
  </div>;
}

export default function ContextMenu() {
  const [edgeTarget,setEdgeTarget] = createSignal<{i:number;j:number}|null>(null);
  const [portTarget, setPortTarget] = createSignal<ContextTarget | null>(null);
  createEffect(on(() => file()?.id, () => { closeContext(false); setRenaming(null); setPortTarget(null); setEdgeTarget(null); }));
  onCleanup(() => { closeContext(false); setRenaming(null); });
  return <Portal><Show when={contextTarget()} keyed>{(target) => <Menu target={target} port={() => setPortTarget(target)} edge={j=>setEdgeTarget({i:target.selection.i,j})} />}</Show>
    <Show when={edgeTarget()} keyed>{target=><EdgeTreatmentDialog {...target} close={()=>setEdgeTarget(null)}/>}</Show>
    <Show when={portTarget()} keyed>{(target) => <PortDialog target={target} close={() => setPortTarget(null)} />}</Show></Portal>;
}
