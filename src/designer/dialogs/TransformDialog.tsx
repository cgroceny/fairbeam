import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { TriangleAlert, X } from "lucide-solid";
import { ExprField, SelectField } from "../DesignPane";
import { designScale, draft, edit, file, names, setSelection } from "../store";
import { evaluate, tryEvaluate } from "../expr";
import { quickBundle } from "../geometry";
import { designChecks, type Check } from "../checks";
import { checkMessage } from "../checkText";
import { applyTransform, displacesOriginal, portsAtShapes, transformPreview, type TransformTarget } from "../transformModel";
import { setPreviewGeometry, setTransformSourceGeometry, setTransformGuide, setTransformRequest, transformRequest } from "../transforms";
import type { Axis, Design, DesignTransform, Expr, Vec3 } from "../types";
import "../../styles/designer-ux.css";
import { latestPickedPoint, pickedPoints } from "../pointTools";
import { startTransformPlacement, stopTransformPlacement } from "../../scene/transformSnap";
import { fmt, t } from "../../i18n";

type Operation = "translate" | "scale" | "rotate" | "mirror";
/** label keys of the operations, in the dialog's order */
const OPERATION_LABEL: Record<Operation, string> = {
  translate: "transform.op.translate",
  scale: "transform.op.scale",
  rotate: "transform.op.rotate",
  mirror: "transform.op.mirror",
};
const initialOperation = (type: DesignTransform["type"]): Operation =>
  type === "move" || type === "translate" ? "translate" : type;
/** how long typing pauses before the outline is rebuilt */
const PREVIEW_DEBOUNCE_MS = 150;
const pickCoordinate = (value: number) => Math.round(value * 1e6) / 1e6;
type PreviewState = "pending" | "ready" | "invalid" | "unavailable";

const copyTarget = (target: TransformTarget): TransformTarget => target.type === "component"
  ? { ...target, indices: [...target.indices] }
  : { ...target };

export function TransformDialogHost() {
  return (
    <Show when={transformRequest()} keyed>
      {(req) => <TransformDialog type={req.type} target={req.target} onClose={() => setTransformRequest(null)} />}
    </Show>
  );
}

/** Ports and lumped resistors are placed by their own start/stop coordinates, not attached to a
 * part: transforms and their copies leave them where they are (the preview omits them too). */
export function feedNote(type: DesignTransform["type"] | "scale", ports: number, resistors: number): string {
  const items = [
    ...(ports ? [t("transform.feed.ports", { count: ports })] : []),
    ...(resistors ? [t("transform.feed.resistors", { count: resistors })] : []),
  ];
  const general = t(`transform.feed.${type}`);
  return items.length
    ? `${general} ${t("transform.feed.reposition", { items: fmt.list(items), count: ports + resistors })}`
    : general;
}

/** A sentence with one bold name: `id` is a key with a {name} placeholder. */
function WithName(props: { id: string; name: string; params?: Record<string, string | number> }) {
  const parts = () => t(props.id, { ...props.params, name: "\u0001" }).split("\u0001");
  return <>{parts()[0]}<b>{props.name}</b>{parts().slice(1).join(props.name)}</>;
}

function TransformDialog(props: { type: DesignTransform["type"]; target: TransformTarget; onClose: () => void }) {
  let box!: HTMLDivElement;
  // This is a modeless tool panel: camera controls remain available beside the inputs.
  onMount(() => {
    box.querySelector<HTMLInputElement>("form input")?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("[aria-modal=true], [role=menu]")) return;
      if (!(event.target instanceof Element) || !event.target.closest(".tf-panel, .viewport")) return;
      event.preventDefault();
      props.onClose();
    };
    document.addEventListener("keydown", escape);
    onCleanup(() => document.removeEventListener("keydown", escape));
  });
  const openedFile = file()?.id;
  // Preview always starts from the design as it was when the dialog opened. This keeps repeated
  // preview requests independent and prevents a later Apply from scaling an already scaled result.
  const baseline = JSON.parse(JSON.stringify(draft)) as Design;
  const baselineSignature = JSON.stringify(baseline);
  const [target] = createSignal<TransformTarget>(copyTarget(props.target));
  const [operation, setOperation] = createSignal<Operation>(initialOperation(props.type));
  const [copy, setCopy] = createSignal(props.type === "translate" || props.type === "mirror");
  const [copies, setCopies] = createSignal<Expr>(1);
  const [step, setStep] = createSignal<Vec3>([designScale(), 0, 0]);
  const [invert, setInvert] = createSignal(false);
  const [pickedTranslation, setPickedTranslation] = createSignal(false);
  const [axis, setAxis] = createSignal<Axis>("z");
  const [center, setCenter] = createSignal<Vec3>([0, 0, 0]);
  const [angle, setAngle] = createSignal<Expr>(90);
  const [factors, setFactors] = createSignal<Vec3>([2, 2, 2]);
  // only a uniform scale is exact for every shape, so one typed factor fills all three by default
  const [uniform, setUniform] = createSignal(true);
  const [origin, setOrigin] = createSignal<Vec3>([0, 0, 0]);
  const [plane, setPlane] = createSignal<Axis>("x");
  const [mirrorPoint, setMirrorPoint] = createSignal<Vec3>([0, 0, 0]);
  const [placing, setPlacing] = createSignal(false);
  const [anchor, setAnchor] = createSignal<[number, number, number] | null>(null);
  const [snapLabel, setSnapLabel] = createSignal("");
  // The outline follows the values as they are typed (debounced); Preview also refreshes it now.
  const [previewState, setPreviewState] = createSignal<PreviewState>("pending");
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let previewRevision = 0;
  let previewSignature = "";
  let initialFrame = false;
  let fitFrame: number | undefined;
  const indices = (): number[] => {
    const current = target();
    return current.type === "component" ? current.indices : [current.i];
  };
  const primaryIndex = () => indices()[0];
  const part = () => draft.parts[primaryIndex()];
  const targetName = () => {
    const current = target();
    return current.type === "component" ? current.name : part()?.label || part()?.name || "";
  };

  const onPlacement = (event: Event) => {
    const detail = (
      event as CustomEvent<{
        kind: "anchor" | "target";
        point: [number, number, number];
        snap?: string | null;
        bypass?: boolean;
        face?: string | null;
        accept?: boolean;
      }>
    ).detail;
    if (detail.kind === "anchor") setAnchor(detail.point);
    else if (detail.kind === "target") {
      const a = anchor();
      if (!a) return;
      setPickedTranslation(false);
      setStep(detail.point.map((value, i) => value - a[i]) as Vec3);
      const snap = detail.snap ? detail.snap : t(detail.bypass ? "transform.snap.bypass" : "transform.snap.off");
      setSnapLabel(` · ${snap} · ${t("transform.snap.on", { face: detail.face ?? t("transform.snap.workPlane") })}`);
      if (detail.accept) {
        setPlacing(false);
        stopTransformPlacement();
      }
    }
  };
  onMount(() => window.addEventListener("fairbeam:transform-placement", onPlacement));
  onCleanup(() => {
    window.removeEventListener("fairbeam:transform-placement", onPlacement);
    clearTimeout(previewTimer);
    cancelAnimationFrame(fitFrame ?? 0);
    stopTransformPlacement();
    setTransformGuide(null);
    setTransformSourceGeometry([]);
    setPreviewGeometry([]);
    if (box.contains(document.activeElement)) queueMicrotask(() => document.querySelector<HTMLElement>(".viewport")?.focus({ preventScroll: true }));
  });

  const transform = (): DesignTransform => {
    const n = copy() && operation() !== "mirror" ? copies() : 0;
    if (operation() === "translate")
      return copy() ? { type: "translate", copies: copies(), step: step() } : { type: "move", offset: step() };
    if (operation() === "scale")
      return { type: "scale", factors: factors(), origin: origin(), ...(copy() ? { copies: copies() } : {}) };
    if (operation() === "rotate") return { type: "rotate", axis: axis(), center: center(), angle: angle(), copies: n };
    return { type: "mirror", plane: plane(), point: mirrorPoint(), keep: copy() };
  };
  const candidate = createMemo(() => transformPreview(baseline, target(), transform()));
  const candidateSignature = () => JSON.stringify(candidate());
  const sourceParts = () => indices().map((i) => baseline.parts[i]);
  const isNewTransformIssue = (path: string) => {
    const match = /^parts\[(\d+)\]\.transforms\[(\d+)\](?:\.|$)/.exec(path);
    if (!match) return false;
    const source = sourceParts()[Number(match[1])];
    return !!source && Number(match[2]) >= (source.transforms?.length ?? 0);
  };
  const problems = createMemo(() =>
    designChecks(candidate()).filter((c) => c.severity === "error" && isNewTransformIssue(c.path)),
  );
  const fieldIssue = (field: string) => problems().find((c) => c.path.endsWith(`.${field}`));
  const buildPreview = (design: Design) => {
    try { return quickBundle(design, names().names, null); }
    catch { return null; }
  };
  // The ports that touch the selected metal before the transform: ports are placed by their own
  // coordinates and do not follow a shape that moves, turns or mirrors, so they would no longer span
  // the feed gap. Warned prominently, with a button that selects each one (transformModel.ts).
  // (the memo of the boolean keeps typing in a field from rebuilding the boxes)
  const displaces = createMemo(() => displacesOriginal(transform()));
  const affectedPorts = createMemo(() => {
    if (!displaces()) return [];
    const selected = target();
    const originals = sourceParts().map((p) => (selected.type === "primitive" ? { ...p, primitives: [p.primitives[selected.j]] } : p));
    const boxes = buildPreview({ ...baseline, parts: originals, ports: [], resistors: [] })?.parts.filter((p) => p.type === "Metal").map((p) => p.bbox) ?? [];
    return boxes.length ? portsAtShapes(baseline, boxes, names().names) : [];
  });
  const updatePreview = (design: Design, signature: string, revision: number) => {
    setTransformGuide(null);
    setPreviewGeometry([]);
    if (problems().length) {
      previewSignature = "";
      setPreviewState("invalid");
      return;
    }
    const result = buildPreview(design);
    if (revision !== previewRevision) return;
    const geometry = result?.parts.flatMap((p) => p.primitives) ?? [];
    if (!result || !geometry.length) {
      previewSignature = "";
      setPreviewState("unavailable");
      return;
    }
    previewSignature = signature;
    setPreviewGeometry(geometry);
    const selected = target();
    const originalParts = sourceParts().map(p => selected.type === "primitive" ? {...p,primitives:[p.primitives[selected.j]]} : p);
    setTransformSourceGeometry(buildPreview({...baseline,parts:originalParts,ports:[],resistors:[]})?.parts.flatMap(p=>p.primitives) ?? []);
    try {
      const point = (operation() === "rotate" ? center() : mirrorPoint()).map(x => evaluate(x,names().names)) as [number,number,number];
      setTransformGuide(operation() === "rotate" || operation() === "mirror" ? {
        kind: operation() === "rotate" ? "axis" : "plane", axis:"xyz".indexOf(operation() === "rotate" ? axis() : plane()), point,
      } : null);
    } catch { setTransformGuide(null); }
    setPreviewState("ready");
    if (!initialFrame) {
      initialFrame = true;
      fitFrame = requestAnimationFrame(() => document.querySelector(".viewport")?.dispatchEvent(new CustomEvent("fairbeam:view", { detail: "fit" })));
    }
  };
  const previewNow = () => {
    clearTimeout(previewTimer);
    const revision = ++previewRevision;
    setPreviewState("pending");
    setPreviewGeometry([]);
    updatePreview(candidate(), candidateSignature(), revision);
  };
  createEffect(() => {
    const design = candidate();
    const signature = JSON.stringify(design);
    const invalid = problems().length > 0;
    clearTimeout(previewTimer);
    const revision = ++previewRevision;
    previewSignature = "";
    setPreviewGeometry([]);
    setPreviewState("pending");
    previewTimer = setTimeout(() => untrack(() => {
      if (invalid) {
        setPreviewState("invalid");
        return;
      }
      updatePreview(design, signature, revision);
    }), PREVIEW_DEBOUNCE_MS);
    onCleanup(() => clearTimeout(previewTimer));
  });
  createEffect(() => {
    // Other tools are accessible in a modeless workspace. Never apply an old snapshot over edits.
    if (file()?.id !== openedFile || JSON.stringify(draft) !== baselineSignature || !part()) props.onClose();
  });

  createEffect(() => {
    if (operation() !== "translate") {
      setPlacing(false);
      stopTransformPlacement();
    }
  });

  const reset = () => {
    setOperation(initialOperation(props.type));
    setCopy(props.type === "translate" || props.type === "mirror");
    setCopies(1);
    setStep([designScale(), 0, 0]);
    setInvert(false);
    setPickedTranslation(false);
    setAxis("z");
    setCenter([0, 0, 0]);
    setAngle(90);
    setFactors([2, 2, 2]);
    setUniform(true);
    setOrigin([0, 0, 0]);
    setPlane("x");
    setMirrorPoint([0, 0, 0]);
    setPlacing(false);
    setAnchor(null);
    setSnapLabel("");
    stopTransformPlacement();
  };
  const usePickedTranslation = () => {
    if (pickedPoints().length < 2) return;
    setPickedTranslation(true);
  };
  const changeOperation = (op: Operation) => {
    setOperation(op);
    setCopy(op === "translate" || op === "mirror");
    setPickedTranslation(false);
  };
  createEffect(() => {
    const points = pickedPoints();
    if (!pickedTranslation() || points.length < 2) return;
    const [a, b] = points.slice(-2);
    setStep(
      b.point.map((v, i) => {
        const delta = (v - a.point[i]) * (invert() ? -1 : 1);
        return pickCoordinate(delta);
      }) as Vec3,
    );
  });
  const useLatestPoint = (setter: (v: Vec3) => void) => {
    const p = latestPickedPoint();
    if (p) setter(p.point.map(pickCoordinate) as Vec3);
  };
  /** the shapes the copies make with the original ("2 copies (3 in total)"), or null while the count is not a whole number >= 0 */
  const copiesTotal = () => {
    const c = tryEvaluate(copies(), names().names).value;
    return c !== undefined && Number.isInteger(c) && c >= 0 && c <= 1000 ? c + 1 : null;
  };
  const detached = () => target().type === "primitive" && part()?.primitives.length > 1;
  const canApply = () => JSON.stringify(draft) === baselineSignature && !problems().length && previewState() === "ready" && previewSignature === candidateSignature();
  const viewRotationPlane = () => {
    const view = { x: "right", y: "front", z: "top" }[operation() === "mirror" ? plane() : axis()];
    const viewport = document.querySelector<HTMLElement>(".viewport");
    viewport?.dispatchEvent(new CustomEvent("fairbeam:view", { detail: view }));
    viewport?.dispatchEvent(new CustomEvent("fairbeam:view", { detail: "fit" }));
    viewport?.focus({ preventScroll: true });
  };
  const commit = () => {
    if (!canApply()) {
      previewNow();
      return;
    }
    let i = primaryIndex();
    edit((d) => {
      i = applyTransform(d, target(), transform());
    });
    setSelection({ type: "part", i });
    props.onClose();
  };
  return (
    <aside class="tf-panel" aria-label={t("transform.title")}>
      <div
        class="dialog dialog-sm tf-dialog"
        role="dialog"
        aria-modal="false"
        aria-labelledby="tf-title"
        ref={box}
        tabindex={-1}
      >
        <div class="dialog-head">
          <div>
            <h2 id="tf-title">{t("transform.title")}</h2>
            <p class="muted">
              <WithName
                id={target().type === "component" ? "transform.intro.component" : target().type === "primitive" ? "transform.intro.selected" : "transform.intro.all"}
                name={targetName()}
              />{" "}
              {t("transform.intro.expr")}
            </p>
          </div>
          <button class="icon-btn" onClick={props.onClose} aria-label={t("common.close")} data-noprompt>
            <X size={16} />
          </button>
        </div>
        <form
          class="sd-body"
          id="tf-form"
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
        >
          <fieldset class="tf-operations">
            <legend class="dz-label">{t("transform.operation")}</legend>
            <div class="tf-operation-list" role="radiogroup" aria-label={t("transform.operationGroup")}>
              <For each={Object.keys(OPERATION_LABEL) as Operation[]}>
                {(op) => (
                  <label class="tf-operation">
                    <input
                      type="radio"
                      name="tf-operation"
                      value={op}
                      checked={operation() === op}
                      onChange={() => changeOperation(op)}
                    />
                    {t(OPERATION_LABEL[op])}
                  </label>
                )}
              </For>
            </div>
          </fieldset>
          <Show when={operation() !== "mirror"}>
            <label class="dz-check">
              <input type="checkbox" checked={copy()} onChange={(e) => setCopy(e.currentTarget.checked)} /> {t("transform.copy")}
            </label>
            <Show when={copy()}>
              <ExprField
                label={t("transform.copies")}
                value={copies()}
                path="__tf.copies"
                issue={fieldIssue("copies")}
                offerParams={false}
                onChange={setCopies}
              />
              <Show when={copiesTotal() !== null}>
                <p class="note">{t("tree.part.copies", { count: copiesTotal()! - 1, total: copiesTotal() })}</p>
              </Show>
            </Show>
          </Show>
          <Show when={operation() === "translate"}>
            <fieldset class="dz-vec">
              <legend class="dz-label">
                {t("transform.step")} <span class="dz-unit">mm</span>
              </legend>
              {/* the step itself comes first: the helpers below it must not push it off the panel */}
              <div class="dz-vec-row">
                <For each={[0, 1, 2]}>
                  {(k) => (
                    <ExprField
                      compact
                      label={"xyz"[k]}
                      value={step()[k]}
                      path={`__tf.step[${k}]`}
                      issue={fieldIssue(`${copy() ? "step" : "offset"}[${k}]`)}
                      offerParams={false}
                      onChange={(v) => {
                        setPickedTranslation(false);
                        setStep((s) => {
                          const next = [...s] as Vec3;
                          next[k] = v;
                          return next;
                        });
                      }}
                    />
                  )}
                </For>
              </div>
              <div class="tf-picks">
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  disabled={pickedPoints().length < 2}
                  onClick={usePickedTranslation}
                >
                  {t("transform.useLastTwo")}
                </button>
                <label class="dz-check">
                  <input type="checkbox" checked={invert()} onChange={(e) => setInvert(e.currentTarget.checked)} />{" "}
                  {t("transform.invert")}
                </label>
              </div>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                aria-pressed={placing()}
                onClick={() => {
                  if (placing()) {
                    setPlacing(false);
                    stopTransformPlacement();
                  } else {
                    setPickedTranslation(false);
                    setAnchor(null);
                    setSnapLabel("");
                    setPlacing(true);
                    startTransformPlacement(part().name);
                  }
                }}
              >
                {placing() ? t("transform.place.stop") : t("transform.place.start")}
              </button>
              <Show when={placing()}>
                <p class="note" role="status">
                  {anchor()
                    ? t("transform.place.target", { snap: snapLabel() })
                    : t("transform.place.anchor", { name: part().label || part().name })}
                </p>
              </Show>
            </fieldset>
            <p class="note">
              {t("transform.translateNote")}
            </p>
          </Show>
          <Show when={operation() === "scale"}>
            <fieldset class="dz-vec">
              <legend class="dz-label">{t("transform.factors")}</legend>
              <div class="dz-vec-row">
                <For each={[0, 1, 2]}>
                  {(k) => (
                    <ExprField
                      compact
                      label={"xyz"[k]}
                      value={factors()[k]}
                      path={`__tf.factors[${k}]`}
                      issue={fieldIssue(`factors[${k}]`) ?? (k === 0 ? fieldIssue("factors") : undefined)}
                      offerParams={false}
                      onChange={(v) =>
                        setFactors((s) => {
                          if (uniform()) return [v, v, v];
                          const n = [...s] as Vec3;
                          n[k] = v;
                          return n;
                        })
                      }
                    />
                  )}
                </For>
              </div>
              <label class="dz-check">
                <input type="checkbox" checked={uniform()} onChange={(e) => {
                  setUniform(e.currentTarget.checked);
                  if (e.currentTarget.checked) setFactors((s) => [s[0], s[0], s[0]]);
                }} /> {t("transform.uniform")}
              </label>
            </fieldset>
            <VecInputs label={t("transform.origin")} values={origin()} setValues={setOrigin} path="origin" issue={fieldIssue} />
            <p class="note" role="status">
              {t("transform.scaleNote")}
            </p>
          </Show>
          <Show when={operation() === "rotate"}>
            <SelectField label={t("transform.rotationAxis")} value={axis()} options={["x", "y", "z"] as Axis[]} onChange={setAxis} />
            <VecInputs
              label={t("transform.centre")}
              values={center()}
              setValues={setCenter}
              path="center"
              issue={fieldIssue}
              pickedAction={() => useLatestPoint(setCenter)}
            />
            <ExprField
              label={t("transform.angle")}
              unit="°"
              value={angle()}
              path="__tf.angle"
              issue={fieldIssue("angle")}
              offerParams={false}
              onChange={setAngle}
            />
            <div class="tf-angle-presets" role="group" aria-label={t("transform.anglePresets")}>
              <For each={[-90, 45, 90, 180]}>{(degrees) =>
                <button type="button" class="btn btn-ghost btn-sm" data-angle-preset={degrees}
                  aria-pressed={String(angle()) === String(degrees)} onClick={() => setAngle(degrees)}>{degrees}°</button>
              }</For>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" onClick={viewRotationPlane}>{t("transform.viewRotationPlane")}</button>
            <p class="note">{t("transform.rotateNote")}</p>
          </Show>
          <Show when={operation() === "mirror"}>
            <SelectField
              label={t("transform.planeNormal")}
              value={plane()}
              options={(["x", "y", "z"] as Axis[]).map(value=>({value,label:t(`transform.mirrorPlane.${value}`)}))}
              onChange={setPlane}
            />
            <VecInputs
              label={t("transform.pointOnPlane")}
              values={mirrorPoint()}
              setValues={setMirrorPoint}
              path="point"
              issue={fieldIssue}
              pickedAction={() => useLatestPoint(setMirrorPoint)}
            />
            <label class="dz-check">
              <input type="checkbox" checked={copy()} onChange={(e) => setCopy(e.currentTarget.checked)} />{" "}
              {t("transform.keepOriginal")}
            </label>
            <button type="button" class="btn btn-ghost btn-sm" onClick={viewRotationPlane}>{t("transform.viewMirrorPlane")}</button>
            <p class="note">{t("transform.mirrorNote")}</p>
          </Show>
          <p class="note">{t("transform.preview.legend")}</p>
          <label class="dz-check tf-disabled" title={t("transform.unite.title")}>
            <input type="checkbox" disabled /> {t("transform.unite.label")}{" "}
            <span>{t("transform.unite.hint")}</span>
          </label>
          <Show when={affectedPorts().length}>
            <div class="tf-ports-warning" role="alert">
              <p class="status-block status-warn">
                <TriangleAlert size={14} aria-hidden="true" />
                <span><strong>{t("transform.ports.title", { count: affectedPorts().length })}</strong>{" "}
                  {t("transform.ports.body", { ports: fmt.list(affectedPorts().map((p) => String(p.number))), count: affectedPorts().length })}</span>
              </p>
              <div class="cluster-sm">
                <For each={affectedPorts().slice(0, 6)}>{(p) => (
                  <button type="button" class="btn btn-ghost btn-sm" onClick={() => setSelection({ type: "port", i: p.index })}>{t("transform.ports.select", { n: p.number })}</button>
                )}</For>
              </div>
            </div>
          </Show>
          <p class="note">
            {feedNote(
              operation() === "translate" && !copy() ? "move" : operation(),
              draft.ports.length,
              draft.resistors.length,
            )}
          </p>
          <Show when={detached()}>
            <p class="note">{t("transform.detachNote")}</p>
          </Show>
          <p class="note" classList={{ "dz-bad": !!problems().length || previewState() === "unavailable" }} role="status" aria-live="polite">
            {problems().length
              ? problems().every((p) => /\.(angle|copies|factors|step|offset|center|origin|point)(\[\d+\])?$/.test(p.path))
                ? t("transform.preview.fixFields") : problems().map(checkMessage)[0]
              : previewState() === "pending"
                ? t("transform.preview.pending")
                : previewState() === "ready"
                  ? t("transform.preview.ready")
                  : t("transform.preview.unavailableValues")}
          </p>
          <div class="tf-inline-actions">
            <button class="btn btn-ghost btn-sm" type="button" onClick={reset}>
              {t("transform.reset")}
            </button>
          </div>
        </form>
        <div class="dialog-foot">
          <span class="muted">{t("transform.footer")}</span>
          <div class="dialog-actions">
            <button class="btn btn-ghost" type="button" onClick={props.onClose} data-noprompt>
              {t("common.cancel")}
            </button>
            <button class="btn btn-ghost" type="button" onClick={previewNow}>
              {t("transform.preview.button")}
            </button>
            <button class="btn btn-primary" type="submit" form="tf-form" disabled={!canApply()}>
              {t("common.apply")}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function VecInputs(props: {
  label: string;
  values: Vec3;
  setValues: (v: Vec3 | ((prev: Vec3) => Vec3)) => Vec3;
  path: string;
  issue?: (field: string) => Check | undefined;
  pickedAction?: () => void;
}) {
  return (
    <fieldset class="dz-vec">
      <legend class="dz-label">
        {props.label} <span class="dz-unit">mm</span>
      </legend>
      <Show when={props.pickedAction && latestPickedPoint()}>
        <button type="button" class="linklike" onClick={props.pickedAction}>
          {t("transform.useLatest")}
        </button>
      </Show>
      <div class="dz-vec-row">
        <For each={[0, 1, 2]}>
          {(k) => (
            <ExprField
              compact
              label={"xyz"[k]}
              value={props.values[k]}
              path={`__tf.${props.path}[${k}]`}
              issue={props.issue?.(`${props.path}[${k}]`)}
              offerParams={false}
              onChange={(v) =>
                props.setValues((s) => {
                  const n = [...s] as Vec3;
                  n[k] = v;
                  return n;
                })
              }
            />
          )}
        </For>
      </div>
    </fieldset>
  );
}
