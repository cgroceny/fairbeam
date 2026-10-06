// CST: WCS > Transform WCS. One dialog moves the work coordinate system along its own u, v, w and
// turns it about them (quarter turns: the geometry stays axis aligned). Values take expressions; the
// resulting origin and axes are shown before OK. Cancel changes nothing.
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { X } from "lucide-solid";
import type { Axis, Expr } from "../types";
import { ExprField } from "../DesignPane";
import { names } from "../store";
import { evaluate } from "../expr";
import { setWcs, setWcsDialog, setWcsOrigin, wcs, wcsDialog } from "../draw";
import { frameBasis, transformedWcs } from "../localFrame";
import { latestPickedPoint } from "../pointTools";
import { shown as fmt } from "../displayNumber.ts";
import { t } from "../../i18n";
import "../../styles/designer-ux.css";

const AXES: Axis[] = ["x", "y", "z"];
const UVW = ["u", "v", "w"] as const;
const dirName = (v: number[]) => { const k = v.findIndex((x) => x !== 0); return `${v[k] < 0 ? "−" : "+"}${AXES[k]}`; };

/** The dialog while it is open (rendered once by the designer workspace). */
export function WcsDialogHost() {
  return <Show when={wcsDialog()}><WcsDialog onClose={() => setWcsDialog(false)} /></Show>;
}

function WcsDialog(props: { onClose: () => void }) {
  let box: HTMLDivElement | undefined;
  onMount(() => {
    const opener = document.activeElement as HTMLElement | null;
    box?.querySelector<HTMLInputElement>("input")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); props.onClose(); } };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected && !box?.contains(active)) return;
        const target = opener && opener !== document.body && opener.isConnected && opener.getClientRects().length ? opener : document.querySelector<HTMLElement>(".viewport");
        target?.focus({ preventScroll: true });
      });
    });
  });
  const [move, setMove] = createSignal<[Expr, Expr, Expr]>([0, 0, 0]);
  const [turn, setTurn] = createSignal<[Expr, Expr, Expr]>([0, 0, 0]);
  const result = createMemo(() => transformedWcs(wcs(), move(), turn(), names().names));
  const unchanged = () => {
    const r = result();
    return !("error" in r) && JSON.stringify(r.wcs) === JSON.stringify({ ...wcs(), origin: [...wcs().origin] }) && move().every((m) => String(m) === "0" || m === 0);
  };
  const preview = () => {
    const r = result();
    if ("error" in r) return null;
    try {
      const o = r.wcs.origin.map((x) => evaluate(x, names().names));
      const [u, v, w] = frameBasis(r.wcs.normal, r.wcs);
      return t("wcs.dialog.preview", { origin: o.map((x) => fmt(x)).join(", "), u: dirName(u), v: dirName(v), w: dirName(w) });
    } catch { return null; }
  };
  const submit = (e: Event) => {
    e.preventDefault();
    const r = result();
    if ("error" in r) return;
    setWcs(r.wcs, t("history.wcsTransform"));
    props.onClose();
  };
  const set3 = (get: () => [Expr, Expr, Expr], put: (v: [Expr, Expr, Expr]) => void, k: number, v: Expr) => { const next = [...get()] as [Expr, Expr, Expr]; next[k] = v === "" ? 0 : v; put(next); };
  return (
    <div class="scrim sd-scrim" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="dialog dialog-sm sd" role="dialog" aria-labelledby="wcs-title" ref={box} tabindex={-1}>
        <div class="dialog-head">
          <div>
            <h2 id="wcs-title">{t("wcs.dialog.title")}</h2>
            <p class="muted">{t("wcs.dialog.intro")}</p>
          </div>
          <button class="icon-btn" onClick={props.onClose} aria-label={t("common.close")} data-noprompt><X size={16} /></button>
        </div>
        <form class="sd-body" id="wcs-form" onSubmit={submit} novalidate>
          <fieldset class="dz-vec">
            <legend class="dz-label">{t("wcs.dialog.move")} <span class="dz-unit">mm</span></legend>
            <div class="wcs-axes">
              <For each={UVW}>{(a, k) => (
                <ExprField compact label={a} value={move()[k()]} path={`__wcs.move[${k()}]`} offerParams={false}
                  onChange={(v) => set3(move, setMove, k(), v)} />
              )}</For>
            </div>
          </fieldset>
          <fieldset class="dz-vec">
            <legend class="dz-label">{t("wcs.dialog.rotate")} <span class="dz-unit">°</span></legend>
            <div class="wcs-axes">
              <For each={UVW}>{(a, k) => (
                <ExprField compact label={t("wcs.dialog.about", { axis: a })} value={turn()[k()]} path={`__wcs.rotate[${k()}]`} offerParams={false}
                  onChange={(v) => set3(turn, setTurn, k(), v)} />
              )}</For>
            </div>
          </fieldset>
          <p class="note">{t("wcs.dialog.note")}</p>
          <Show when={latestPickedPoint()}>{(picked) => (
            <button type="button" class="linklike" onClick={() => { setWcsOrigin(picked().point); props.onClose(); }}>
              {t("wcs.dialog.usePicked", { label: picked().label })}
            </button>
          )}</Show>
          <Show when={"error" in result() ? (result() as { error: string }).error : null}>{(code) => <p class="note dz-bad" role="alert">{t(`wcs.error.${code()}`)}</p>}</Show>
          <Show when={preview()}>{(text) => <p class="note" role="status">{text()}</p>}</Show>
        </form>
        <div class="dialog-foot">
          <span class="muted" />
          <div class="dialog-actions">
            <button class="btn btn-ghost" type="button" onClick={props.onClose} data-noprompt>{t("common.cancel")}</button>
            <button class="btn btn-primary" type="submit" form="wcs-form" disabled={"error" in result() || unchanged()}>{t("common.ok")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
