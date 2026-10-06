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

/** Mounts a nested-modal fixture into the provided browser-test container. */
export function mountModalFocusFixture(target: HTMLElement): () => void {
  return render(() => {
    const [open, setOpen] = createSignal(false);
    return <>
      <button id="modal-fixture-launcher" onClick={() => setOpen(true)}>Open modal fixture</button>
      <Show when={open()}><OuterModal close={() => setOpen(false)} /></Show>
    </>;
  }, target);
}
