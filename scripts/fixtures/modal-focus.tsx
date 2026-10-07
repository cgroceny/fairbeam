import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { useModal } from "../../src/lib/dialog";

function InnerModal(props: { close: () => void }) {
  let dialog!: HTMLDivElement;
  let first!: HTMLButtonElement;
  const [escapeHandled, setEscapeHandled] = createSignal(false);
  useModal(() => dialog, props.close, () => first);
  return <div class="scrim">
    <div class="dialog" id="modal-fixture-inner" role="dialog" aria-modal="true" aria-labelledby="modal-fixture-inner-title" tabindex={-1} ref={dialog}>
      <h2 id="modal-fixture-inner-title">Nested fixture</h2>
      <button id="modal-fixture-inner-first" ref={first} onClick={props.close}>Close nested dialog</button>
      <button id="modal-fixture-inner-handle-escape" onKeyDown={(event) => {
        if (event.key === "Escape" && !escapeHandled()) { event.preventDefault(); setEscapeHandled(true); }
      }}>Handle Escape once</button>
      <button id="modal-fixture-inner-last">Last nested action</button>
    </div>
  </div>;
}

function OuterModal(props: { close: () => void }) {
  let dialog!: HTMLDivElement;
  let first!: HTMLButtonElement;
  const [innerOpen, setInnerOpen] = createSignal(false);
  useModal(() => dialog, props.close, () => first);
  return <div class="scrim">
    <div class="dialog" id="modal-fixture-outer" role="dialog" aria-modal="true" aria-labelledby="modal-fixture-outer-title" tabindex={-1} ref={dialog}>
      <h2 id="modal-fixture-outer-title">Outer fixture</h2>
      <button id="modal-fixture-outer-first" ref={first}>First outer action</button>
      <button id="modal-fixture-open-inner" onClick={() => setInnerOpen(true)}>Open nested dialog</button>
      <button id="modal-fixture-outer-last">Last outer action</button>
      <Show when={innerOpen()}><InnerModal close={() => setInnerOpen(false)} /></Show>
    </div>
  </div>;
}

/** A dialog whose body scrolls and has no control of its own (Chromium makes such a scroller a
 * keyboard stop): Tab must still reach the button after it. */
function ScrollModal(props: { close: () => void }) {
  let dialog!: HTMLDivElement;
  useModal(() => dialog, props.close);
  return <div class="scrim">
    <div class="dialog" id="modal-fixture-scroll" role="dialog" aria-modal="true" aria-label="Scroll fixture" tabindex={-1} ref={dialog}
      style={{ display: "grid", "grid-template-rows": "auto 80px auto", height: "auto" }}>
      <button id="modal-fixture-scroll-close" onClick={props.close}>Close</button>
      <div id="modal-fixture-scroll-body" style={{ overflow: "auto", "min-height": "0" }}>
        {Array.from({ length: 40 }, (_, i) => <p>Row {i + 1}</p>)}
      </div>
      <button id="modal-fixture-scroll-done" onClick={props.close}>Done</button>
    </div>
  </div>;
}

function PlainModal(props: { id: string; close: () => void }) {
  let dialog!: HTMLDivElement;
  let first!: HTMLButtonElement;
  useModal(() => dialog, props.close, () => first);
  return <div class="scrim">
    <div class="dialog" id={props.id} role="dialog" aria-modal="true" aria-label="Plain fixture" tabindex={-1} ref={dialog} style={{ height: "auto" }}>
      <button id={`${props.id}-first`} ref={first} onClick={props.close}>Close</button>
    </div>
  </div>;
}

/** Mounts a nested-modal fixture into the provided browser-test container. */
export function mountModalFocusFixture(target: HTMLElement): () => void {
  return render(() => {
    const [open, setOpen] = createSignal(false);
    const [scroll, setScroll] = createSignal(false);
    // a command whose region re-renders when it opens its dialog: the opener node is replaced
    const [version, setVersion] = createSignal(0);
    const [rerendered, setRerendered] = createSignal(false);
    // a command that drops focus before its dialog comes (it is disabled while it prepares)
    const [busy, setBusy] = createSignal(false);
    const [prepared, setPrepared] = createSignal(false);
    return <>
      <button id="modal-fixture-launcher" onClick={() => setOpen(true)}>Open modal fixture</button>
      <Show when={open()}><OuterModal close={() => setOpen(false)} /></Show>
      <button id="modal-fixture-scroll-launcher" onClick={() => setScroll(true)}>Open scroll fixture</button>
      <Show when={scroll()}><ScrollModal close={() => setScroll(false)} /></Show>
      <div id="modal-fixture-region">
        <Show when={version() + 1} keyed>{(v) =>
          <button aria-label="Re-rendered opener" data-version={v} onClick={() => { setVersion(version() + 1); setRerendered(true); }}>Open (re-renders)</button>}
        </Show>
      </div>
      <Show when={rerendered()}><PlainModal id="modal-fixture-rerendered" close={() => setRerendered(false)} /></Show>
      <button id="modal-fixture-busy" disabled={busy()} onClick={() => {
        setBusy(true);
        window.setTimeout(() => { setBusy(false); setPrepared(true); }, 60);
      }}>Open after preparing</button>
      <Show when={prepared()}><PlainModal id="modal-fixture-prepared" close={() => setPrepared(false)} /></Show>
    </>;
  }, target);
}
