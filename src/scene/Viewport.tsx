import { lumpedLabel } from "../lumped.ts";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { Aperture, Crosshair, Gem } from "lucide-solid";
import { activeExportSurface, exportNotice, geometryAvailable, registerSurfaceExports } from "../components/exportContext";
import { CAMERA_VIEWS, VIEW_DIRECTIONS, cameraShortcut, isViewCommand, nearestAxis, type ViewName, type ViewCommand } from "./cameraViews";
import { CameraViewIcon } from "./CameraViewIcon";
import { bundle, centerView, farfieldIndex, setFarfieldIndex, hiddenParts, hoverPart, layers, meshPlane, selectedPart, selectedShape, setHoverPart, setViewCursor, solidFade, theme } from "../state";
import { keepCamera } from "../state";
import { previewGeometry } from "../designer/transforms";
import { cssVar } from "../lib/cssvar";
import { downloadFailedMessage, saveDownloadUrl } from "../lib/download";
import { downloadToast } from "../lib/toast";
import { dims, GHz, num } from "../lib/format";
import { fmt, t } from "../i18n";
import type { Bundle, Part } from "../types";
import {
  boxLines, buildParts, lumpedObject, meshPlaneLines, type PartObject, portObject, type SceneColors, sceneRadius, waveguidePortObject, SceneGeometryCache, updatePortGlyphs,
} from "./geometry";
import type { PortGlyph } from "./portGlyphs";
import { patternMesh } from "./pattern";
import FarfieldCard from "../components/FarfieldCard";
import { quantityGrid, quantityMax } from "../lib/farfieldQuantity";
import { patternQuantity } from "../lib/patternQuantityStore";
import { showPattern3dEntry } from "../designer/runResults";
import { arrayActive, arraySet, arrayWeights, farfieldOverride } from "../lib/arrayStore";
import { currentLayer, fieldExcitation, shownFieldFrequency, hasCurrentPhase, updateCurrentPhase } from "./fields";
import { fieldPlaneLayer, updateFieldPlanePhase } from "./fieldPlanes";
import { currentFieldPlaneView } from "./FieldPlaneControls";
import "./fieldPlaneClock";
import FieldPlaneScale from "./FieldPlaneScale";
import { fieldPlaneMap, fieldPlaneMode, fieldPlanePart, fieldPlanePhase, fieldPlaneScale } from "../state";
import { attachTransformOverlay } from "./transformOverlay";
import { attachBooleanOverlay } from "./booleanOverlay";
import { booleanPreviewGeometry } from "../designer/booleanPreview";
import { booleanKeysActive } from "../designer/booleanUi";
import { faceBoundary } from "./faceHighlight";
import { attachDrawOverlay } from "./drawOverlay";
import { clearOwnedDebugReference, frameTask, portMarkerRadius, watchPixelRatio } from "./viewportLifecycle";
import { renderPixelRatio } from "./renderBudget";
import { localCpuRunActive } from "../runner/designRun";
import { attachVertexOverlay } from "./vertexOverlay";
import { vertexTarget } from "../designer/vertexEdit";
import { extrudeFacePicking, facePicking, localFrame as drawFrame, plane as drawPlane, shapeRequest, tool as drawTool, wcsIsGlobal, worldToWcs } from "../designer/draw";
import { frameBasis } from "../designer/localFrame";
import { appMode } from "../workspace";
import { draft as designDraft, selection, selectionBounds } from "../designer/store";
import { boundsPortTarget, contextTarget, openContext, type ContextTarget } from "../designer/context";
import { pickedShape } from "../designer/contextGeometry";
import { measure as measurePoints } from "../designer/measure.ts";
import { pointPickMode, pickedPoints, hoveredPickedPoint, isFacePickMode, type PickedPoint, type PointPickMode } from "../designer/pointTools";
import { resolveFaceCandidate } from "../designer/faceAlign";
import { setMessage } from "../designer/store";
import { resolvePointCandidate } from "../designer/pointGeometry";
import { transformPlacement } from "./transformSnap";
import { registerViewProvider, renderedView, renderOptions, setRenderDialogOpen, setRenderedView, setRenderOptions } from "../render/state";
import type { RenderedHandle } from "../render/rendered";

const VIEW_DIRS = Object.fromEntries(CAMERA_VIEWS.map(({ id }) => [id, new THREE.Vector3(...VIEW_DIRECTIONS[id]).normalize()])) as Record<ViewName, THREE.Vector3>;

/** most mesh lines drawn on the mesh plane (both in-plane axes together) */
const MESH_PLANE_MAX = 3000;
/** the view names announced by the number keys: i18n keys */
const VIEW_LABEL = Object.fromEntries(CAMERA_VIEWS.map(({ id, title }) => [id, title])) as Record<ViewName, string>;

function colors(): SceneColors {
  return {
    metal: cssVar("--al-3d-metal"),
    dielectric: cssVar("--al-3d-dielectric"),
    port: cssVar("--al-3d-port"),
    edge: cssVar("--al-3d-edge"),
    cut: cssVar("--al-3d-cutout"),
    domain: cssVar("--al-3d-domain"),
    nf2ff: cssVar("--al-3d-nf2ff"),
    ground: cssVar("--al-3d-ground"),
    grid: cssVar("--al-viewport-grid"),
    gridMajor: cssVar("--al-viewport-grid-major"),
  };
}

/** field colour map (Turbo) for the directivity surface and the surface current */
function fieldStops(): THREE.Color[] {
  return [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => new THREE.Color(cssVar(`--al-field-${i}`)));
}

function niceLength(x: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}

/** The nearest hit, but a metal face wins over a dielectric face at the same depth: a patch or
 *  trace drawn on a substrate's top face is coplanar with it, and the ray would otherwise pick
 *  whichever mesh it tested first. */
function pickHit(hits: THREE.Intersection[]): THREE.Intersection | undefined {
  const first = hits[0];
  if (!first) return;
  const tie = first.distance * 1e-4 + 1e-9;
  return hits.find((h) => h.distance - first.distance <= tie && h.object.userData.metal) ?? first;
}

export default function Viewport() {
  let host!: HTMLDivElement;
  const [view, setView] = createSignal<ViewName | null>("iso");
  const [scaleBar, setScaleBar] = createSignal<{ px: number; label: string } | null>(null);
  const [cursor, setCursorLocal] = createSignal<{ x: number; y: number; z: number } | null>(null);
  // also published (state.ts viewCursor) for the designer's status bar
  const setCursor = (c: { x: number; y: number; z: number } | null) => { setCursorLocal(c); setViewCursor(c); };
  const [tip, setTip] = createSignal<{ x: number; y: number; name: string } | null>(null);
  const [themeTick, setThemeTick] = createSignal(0);
  /** bumped on every rebuild of the part meshes (the highlight effects follow it) */
  const [partsTick, setPartsTick] = createSignal(0);
  // keyboard: part picked with Tab (highlighted like hover) and the aria-live announcement
  const [kbPart, setKbPart] = createSignal<number>(-1);
  const [announce, setAnnounce] = createSignal("");
  const [phaseDeg, setPhaseDeg] = createSignal(0);
  const [phasePlaying, setPhasePlaying] = createSignal(false);
  let applyCurrentPhase: ((phase: number) => void) | undefined;
  /** set when the mesh plane shows only every k-th line (very fine meshes) */
  const [meshNote, setMeshNote] = createSignal<string | null>(null);
  let announcedText = "";
  let announceTask: ReturnType<typeof frameTask> | undefined;
  const say = (text: string) => {
    // re-announce identical text (e.g. pressing Fit twice): clear, then set on the next frame
    setAnnounce("");
    announcedText = text;
    announceTask?.request();
  };

  const ff = () => {
    // a steered array pattern (src/lib/arrayStore.ts) replaces the stored far field when active
    const o = farfieldOverride();
    if (o) return o;
    const b = bundle();
    const list = b?.results?.farfield ?? [];
    return list.length ? list[Math.min(farfieldIndex(), list.length - 1)] : null;
  };

  onMount(() => {
    announceTask = frameTask(() => setAnnounce(announcedText));
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.domElement.className = "vp-canvas";
    host.prepend(renderer.domElement);

    // Three r186 keeps one module-wide DFG_LUT texture. Each renderer registers a dispose
    // listener on it; renderer.dispose() does not remove that listener, so the shared texture
    // otherwise keeps every retired renderer and WebGL context alive across workspace switches.
    const lutListeners: Array<{ texture: THREE.Texture; listener: (...args: unknown[]) => void }> = [];
    const textureEvents = THREE.Texture.prototype as unknown as {
      addEventListener(type: string, listener: (...args: unknown[]) => void): void;
      removeEventListener(type: string, listener: (...args: unknown[]) => void): void;
    };
    function trackLutListener<T>(run: () => T): T {
      if (lutListeners.length) return run();
      const original = textureEvents.addEventListener;
      textureEvents.addEventListener = function (this: THREE.Texture, type, listener) {
        if (type === "dispose" && this.name === "DFG_LUT") lutListeners.push({ texture: this, listener });
        original.call(this, type, listener);
      };
      try { return run(); }
      finally { textureEvents.addEventListener = original; }
    }

    const labels = new CSS2DRenderer();
    labels.domElement.className = "vp-labels";
    host.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 1e6);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.screenSpacePanning = true;
    // the wheel zooms towards the pointer, left drag orbits, middle and right drag pan
    controls.zoomToCursor = true;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };

    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const envRT = trackLutListener(() => pmrem.fromScene(room, 0.04));
    room.dispose();
    const env = envRT.texture;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(0.6, -0.8, 1.2);
    scene.add(sun);

    const debugViewport = { camera, controls, scene, renderer };
    if (import.meta.env.DEV) (window as unknown as { __fairbeam: unknown }).__fairbeam = debugViewport;

    function renderScene(target: THREE.Scene, view: THREE.Camera) {
      trackLutListener(() => renderer.render(target, view));
    }

    const partsRoot = new THREE.Group();
    const overlayRoot = new THREE.Group();
    const patternRoot = new THREE.Group();
    const currentRoot = new THREE.Group();
    let currentGroup: THREE.Group | null = null;
    const fieldPlaneRoot = new THREE.Group();
    scene.add(partsRoot, overlayRoot, patternRoot, currentRoot, fieldPlaneRoot);
    const pointMarkers = new THREE.Group();
    scene.add(pointMarkers);
    createEffect(on([pickedPoints, hoveredPickedPoint, pointPickMode, theme, themeTick], ([picked, preview, pickMode]) => {
      for (const child of [...pointMarkers.children]) {
        pointMarkers.remove(child);
        if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        } else if (child instanceof CSS2DObject) child.element.remove();
      }
      const add = (point: { point: [number, number, number]; label: string }, color: string) => {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.8, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
        dot.position.set(...point.point);
        dot.renderOrder = 20;
        pointMarkers.add(dot);
        const element = document.createElement("div");
        element.className = "vp-point-marker";
        element.textContent = point.label;
        const tag = new CSS2DObject(element);
        tag.position.set(...point.point);
        tag.renderOrder = 21;
        pointMarkers.add(tag);
      };
      const face = (tris: [number, number, number][], opacity: number) => {
        const color = cssVar("--al-critical");
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(tris.flat()), 3));
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, side: THREE.DoubleSide }));
        mesh.renderOrder = 19;
        const boundary = new THREE.BufferGeometry();
        boundary.setAttribute("position", new THREE.BufferAttribute(new Float32Array(faceBoundary(tris).flat()), 3));
        const outline = new THREE.LineSegments(boundary, new THREE.LineBasicMaterial({ color, depthTest: false }));
        outline.renderOrder = 20;
        pointMarkers.add(mesh, outline);
      };
      picked.forEach(point => {
        if (point.face) face(point.face.tris, 0.35);
        add(point, cssVar("--al-focus"));
      });
      if (pickMode === "measure" && picked.length >= 2) {
        // the measured segment with its length at the middle
        const [a, b] = picked;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([...a.point, ...b.point]), 3));
        const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: cssVar("--al-focus"), depthTest: false }));
        line.renderOrder = 20;
        const element = document.createElement("div");
        element.className = "vp-point-marker";
        element.textContent = `${fmt.fixed(measurePoints(a.point, b.point).distance, 3)} mm`;
        const tag = new CSS2DObject(element);
        tag.position.set(...a.point.map((v, i) => (v + b.point[i]) / 2) as [number, number, number]);
        pointMarkers.add(line, tag);
      }
      if (preview) {
        if (preview.face) face(preview.face.tris, 0.3);
        add(preview, cssVar("--al-focus"));
      }
      requestRender();
    }));

    // axis gizmo, rendered into a corner with its own camera
    const gizmo = new THREE.Scene();
    const gizmoCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
    gizmoCam.up.set(0, 0, 1);
    const axisColors = ["#c8553d", "#4b9b4b", "#3f7fd1"];
    // x, y, z for the global WCS; u, v, w along the local WCS' axes while one is active
    const gizmoAxes = new THREE.Group();
    gizmo.add(gizmoAxes);
    function buildGizmo() {
      for (const child of [...gizmoAxes.children]) {
        gizmoAxes.remove(child);
        child.traverse((o) => { const m = (o as THREE.Sprite).material as THREE.SpriteMaterial | undefined; m?.map?.dispose?.(); m?.dispose?.(); });
      }
      const local = !wcsIsGlobal() && appMode() === "design";
      const basis = local ? frameBasis(drawPlane().normal, drawFrame()) : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      (local ? ["u", "v", "w"] : ["X", "Y", "Z"]).forEach((lbl, i) => {
        const dir = new THREE.Vector3(...(basis[i] as [number, number, number]));
        gizmoAxes.add(new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, axisColors[i], 0.28, 0.16));
        const cv = document.createElement("canvas");
        cv.width = cv.height = 64;
        const ctx = cv.getContext("2d")!;
        ctx.fillStyle = axisColors[i];
        ctx.font = "600 40px IBM Plex Mono, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(lbl, 32, 34);
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false }));
        sp.position.copy(dir.clone().multiplyScalar(1.35));
        sp.scale.setScalar(0.5);
        gizmoAxes.add(sp);
      });
    }
    createEffect(() => { wcsIsGlobal(); drawPlane(); drawFrame(); appMode(); buildGizmo(); requestRender(); });

    // the Rendered view: attached on first use, so its code (three.js materials, the studio, the
    // port models) is never part of the designer's startup
    let rendered: RenderedHandle | null = null;
    let renderedDisposed = false;
    let parts: PartObject[] = [];
    let groundGrid: THREE.GridHelper | null = null;
    let groundGridOpacity = 0.9;
    function updateGroundGrid() {
      if (!groundGrid) return;
      const below = Math.max(0, -camera.position.clone().sub(controls.target).normalize().z);
      const fade = THREE.MathUtils.lerp(1, 0.12, THREE.MathUtils.smoothstep(below, 0.05, 0.75));
      const materials = Array.isArray(groundGrid.material) ? groundGrid.material : [groundGrid.material];
      for (const material of materials) material.opacity = groundGridOpacity * fade;
    }
    const geometryCache = new SceneGeometryCache();
    let finishGeometryRebuild = false;
    let size = { w: 1, h: 1 };
    let fitted: Bundle | null = null;
    /** port label elements and their plain text, so the array feed can be written into them */
    const portLabels = new Map<number, { el: HTMLElement; base: string }>();
    /** port and element glyphs with their CSS2D labels, kept next to the glyph as it rescales */
    let glyphLabels: { glyph: PortGlyph; label: CSS2DObject }[] = [];
    const renderTask = frameTask(render);
    const requestRender = renderTask.request;
    const onControlsChange = () => {
      const direction = camera.position.clone().sub(controls.target).normalize();
      setView(CAMERA_VIEWS.find(({ id }) => direction.dot(VIEW_DIRS[id]) > 1 - 1e-8)?.id ?? null);
      updateGroundGrid(); requestRender();
    };
    controls.addEventListener("change", onControlsChange);

    function render() {
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, size.w, size.h);
      // ports are drawn in screen pixels: rescale them for this view (a few meshes, no geometry rebuild)
      updatePortGlyphs(overlayRoot, camera, size.h);
      for (const { glyph, label: lab } of glyphLabels) lab.position.copy(glyph.userData.labelAnchor);
      // the rendered view (src/render/rendered.ts, loaded on first use) keeps its own lights and labels off
      rendered?.beforeRender(camera);
      renderScene(scene, camera);
      if (!rendered?.active) labels.render(scene, camera);
      // gizmo
      const g = 84;
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.setScissorTest(true);
      renderer.setScissor(8, 8, g, g);
      renderer.setViewport(8, 8, g, g);
      const d = camera.position.clone().sub(controls.target).normalize().multiplyScalar(4);
      gizmoCam.position.copy(d);
      gizmoCam.lookAt(0, 0, 0);
      renderScene(gizmo, gizmoCam);
      renderer.setScissorTest(false);
      renderer.autoClear = true;
      flushGraveyard();
      updateScaleBar();
    }

    function updateScaleBar() {
      const dist = camera.position.distanceTo(controls.target);
      const worldPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / size.h;
      const len = niceLength(worldPerPx * 110);
      const px = Math.round((len / worldPerPx) * 2) / 2;
      const prev = scaleBar();
      // only when it changes: this runs every frame while orbiting
      const text = `${fmt.num(len, 6)} mm`;
      if (!prev || prev.px !== px || prev.label !== text) setScaleBar({ px, label: text });
    }

    function resize() {
      const r = host.getBoundingClientRect();
      size = { w: Math.max(1, Math.floor(r.width)), h: Math.max(1, Math.floor(r.height)) };
      // Preserve fractional DPR; the cap keeps the existing Retina GPU budget, and a local CPU run
      // gets the machine's cores: one pixel per CSS pixel while it runs (renderBudget.ts).
      const pixelRatio = renderPixelRatio(window.devicePixelRatio || 1, localCpuRunActive());
      if (renderer.getPixelRatio() !== pixelRatio) renderer.setPixelRatio(pixelRatio);
      renderer.setSize(size.w, size.h, false);
      labels.setSize(size.w, size.h);
      camera.aspect = size.w / size.h;
      camera.updateProjectionMatrix();
      requestRender();
    }
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    const stopPixelRatio = watchPixelRatio(resize);
    createEffect(on(localCpuRunActive, () => resize(), { defer: true }));

    // Keep the phase clock completely idle unless the map is visible and explicitly playing.
    let hostVisible = false;
    const io = new IntersectionObserver(([entry]) => {
      hostVisible = !!entry?.isIntersecting && entry.intersectionRatio > 0;
      if (!hostVisible) setPhasePlaying(false);
    });
    io.observe(host);
    let phaseTimer: ReturnType<typeof setInterval> | undefined;
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stopPhaseTimer = () => { clearInterval(phaseTimer); phaseTimer = undefined; };
    const onMotionChange = () => { if (motionQuery.matches || document.hidden) setPhasePlaying(false); };
    motionQuery.addEventListener("change", onMotionChange);
    document.addEventListener("visibilitychange", onMotionChange);
    createEffect(() => {
      const b = bundle();
      const f = ff()?.f ?? null;
      const active = phasePlaying() && centerView() !== "drawing" && layers.current && !!b && hasCurrentPhase(b, f) && hostVisible && !document.hidden && !motionQuery.matches;
      stopPhaseTimer();
      if (active) phaseTimer = setInterval(() => {
        setPhaseDeg((phase) => {
          const next = (phase + 15) % 360;
          applyCurrentPhase?.(next);
          return next;
        });
      }, 40);
      if (!active && phasePlaying()) setPhasePlaying(false);
      onCleanup(stopPhaseTimer);
    });

    function orientView(v: ViewName) {
      const dist = camera.position.distanceTo(controls.target);
      camera.position.copy(controls.target).addScaledVector(VIEW_DIRS[v], dist);
      controls.update();
      setView(v);
      requestRender();
    }
    // the size and centre of the scene the camera was last fitted to: a later edit that changes them
    // a lot (a first sheet in an empty design, a disjoint Add, a parameter ten times larger) fits the
    // view again; a small edit never moves a view the user has zoomed or panned
    let framed: { center: THREE.Vector3; radius: number } | null = null;
    // an explicit addition has just framed itself: the rebuild that follows only notes the new scene
    let framedByAddition = false;
    function refitWhenSceneChanged(b: Bundle) {
      const now = sceneRadius(b);
      if (!framed || framedByAddition) { framed = { center: now.center, radius: now.radius }; framedByAddition = false; return; }
      const ratio = now.radius / framed.radius;
      const moved = now.center.distanceTo(framed.center) / Math.max(framed.radius, now.radius);
      if (ratio > 3 || ratio < 1 / 3 || moved > 1.5) { fitCurrentView(); say(t("viewport.say.refitted")); }
    }
    function fitCurrentView() {
      const b = bundle();
      if (!b) return;
      let { center, radius, box } = sceneRadius(b);
      framed = { center: center.clone(), radius };
      const preview = previewGeometry();
      if (preview.length) {
        const bounds = box.clone();
        for (const p of preview) for (const corner of p.bbox) bounds.expandByPoint(new THREE.Vector3(...corner));
        center = bounds.getCenter(new THREE.Vector3());
        radius = bounds.getSize(new THREE.Vector3()).length() / 2;
      }
      const direction = camera.position.clone().sub(controls.target).normalize();
      if (!direction.lengthSq()) direction.copy(VIEW_DIRS.iso);
      const fov = THREE.MathUtils.degToRad(camera.fov);
      const aspectFix = Math.max(1, 1 / camera.aspect);
      const dist = (radius / Math.sin(fov / 2)) * 1.08 * aspectFix;
      camera.position.copy(center).addScaledVector(direction, dist);
      camera.near = dist / 500;
      camera.far = dist * 200;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
      requestRender();
    }
    function frameView(v: ViewName) { orientView(v); fitCurrentView(); }
    function applyView(command: ViewCommand) {
      if (!bundle()) return;
      if (command === "fit") { fitCurrentView(); say(t("viewport.say.fitted")); return; }
      const v = command === "nearest" ? nearestAxis(camera.position.clone().sub(controls.target)) : command;
      orientView(v);
      say(t("viewport.say.view", { view: t(VIEW_LABEL[v]) }));
    }
    const onViewEvent = (e: Event) => {
      const v: unknown = (e as CustomEvent).detail;
      if (isViewCommand(v)) applyView(v);
    };
    host.addEventListener("fairbeam:view", onViewEvent);

    // An explicit addition gets one immediate fit, before its quick preview's next frame. Keep
    // the user's viewing direction; there is no delayed animation, restore, or server refit to
    // compete with subsequent orbit/pan/zoom input (including trackpad gestures in WKWebView).
    const onFrameAdded = (e: Event) => {
      const { bounds, label, reason } = (e as CustomEvent<{ bounds: Part["bbox"]; label: string; reason?: "check" }>).detail;
      if (!bounds.flat().every(Number.isFinite)) return;
      const box = new THREE.Box3(new THREE.Vector3(...bounds[0]), new THREE.Vector3(...bounds[1]));
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.01);
      const direction = camera.position.clone().sub(controls.target).normalize();
      if (!direction.lengthSq()) direction.copy(VIEW_DIRS.iso);
      const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2) * 1.08 * Math.max(1, 1 / camera.aspect);
      camera.position.copy(center).addScaledVector(direction, dist);
      camera.near = dist / 500;
      camera.far = dist * 200;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();
      framedByAddition = true;
      say(reason === "check" ? t("viewport.say.showingChecked", { label }) : t("viewport.say.added", { label }));
      requestRender();
    };
    window.addEventListener("fairbeam:frame-added", onFrameAdded);

    // Ports and resistors are overlays, so the solid-part emissive highlight cannot mark them.
    // Keep this selection marker reactive without moving the camera on edits or preview updates.
    createEffect(() => {
      const s = selection();
      themeTick(); theme(); bundle();
      if (appMode() !== "design" || (s.type !== "port" && s.type !== "resistor")) return;
      const bounds = selectionBounds(s);
      if (!bounds) return;
      const box = new THREE.Box3(new THREE.Vector3(...bounds[0]), new THREE.Vector3(...bounds[1]));
      box.expandByScalar(Math.max(box.getSize(new THREE.Vector3()).length() * 0.04, 0.02));
      const marker = new THREE.Box3Helper(box, new THREE.Color(cssVar("--al-focus")));
      const material = marker.material as THREE.LineBasicMaterial;
      material.depthTest = false;
      marker.renderOrder = 100;
      marker.name = "checked-item-selection";
      scene.add(marker);
      requestRender();
      onCleanup(() => { scene.remove(marker); marker.geometry.dispose(); material.dispose(); requestRender(); });
    });

    // Frees GPU memory of everything under g: geometries, materials and the textures they own
    // (maps of the surface-current planes, sprite textures). The shared environment map (env) is
    // left alone: it lives as long as the viewport. CSS2D label elements are removed from the DOM.
    const TEXTURE_SLOTS = ["map", "alphaMap", "aoMap", "bumpMap", "emissiveMap", "lightMap", "metalnessMap", "normalMap", "roughnessMap", "specularMap"] as const;
    function disposeMaterial(mat: THREE.Material) {
      const m = mat as unknown as Record<string, unknown>;
      for (const k of TEXTURE_SLOTS) {
        const t = m[k];
        if (t instanceof THREE.Texture && t !== env) t.dispose();
      }
      mat.dispose();
    }
    function disposeNow(o: THREE.Object3D) {
      o.traverse((x) => {
        const m = x as THREE.Mesh;
        if (m.geometry && !geometryCache.owns(m.geometry)) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach(disposeMaterial);
        else if (mat) disposeMaterial(mat);
      });
    }
    // Retired objects are freed after the next frame: a replacement material then already holds
    // the same shader program, so disposing the old one does not destroy and recompile it.
    const graveyard: THREE.Object3D[] = [];
    function retire(o: THREE.Object3D) {
      o.traverse((x) => { if (x instanceof CSS2DObject) x.element.remove(); });
      o.removeFromParent();
      graveyard.push(o);
    }
    function flushGraveyard() {
      for (const o of graveyard.splice(0)) disposeNow(o);
      if (finishGeometryRebuild) {
        finishGeometryRebuild = false;
        geometryCache.endRebuild();
      }
    }
    function disposeGroup(g: THREE.Object3D) {
      for (const c of [...g.children]) retire(c);
    }

    function label(text: string, cls = "vp-label") {
      const el = document.createElement("div");
      el.className = cls;
      el.textContent = text;
      return new CSS2DObject(el);
    }

    // ---- full rebuild: bundle or theme change
    createEffect(on([bundle, themeTick, theme], () => {
      const b = bundle();
      disposeGroup(partsRoot);
      disposeGroup(overlayRoot);
      geometryCache.beginRebuild();
      finishGeometryRebuild = true;
      parts = [];
      // the hover/selection highlight below runs again on the new parts (effect order is not
      // guaranteed: on the same bundle change it may already have run on the retired ones)
      setPartsTick((n) => n + 1);
      portLabels.clear();
      glyphLabels = [];
      if (!b) return requestRender();
      const c = colors();
      // (effect order is not guaranteed: while the rendered view is on it keeps the studio background)
      if (!rendered?.active) scene.background = new THREE.Color(cssVar("--al-viewport"));
      parts = buildParts(b, c, env, layers.dielectricXray, geometryCache);
      parts.forEach((p) => partsRoot.add(p.group));

      const { radius, center } = sceneRadius(b);
      const portR = portMarkerRadius(radius, b.mesh.x);
      for (const p of b.ports) {
        const wg = p.type === "waveguide";
        const g = wg ? waveguidePortObject(p.start, p.stop, p.direction, c.port, portR) : portObject(p.start, p.stop, c.port, portR, p.direction);
        g.name = `port-${p.number}`;
        // a grouped port's additional feeds: glyphs of their own, rescaled and highlighted with the port's
        const members = (p.group?.members ?? []).map((m) => portObject(m.start, m.stop, c.port, portR, m.direction));
        if (members.length) {
          const own = g.userData;
          g.add(...members);
          g.userData = {
            ...own,
            update: (wpp) => { own.update(wpp); for (const m of members) m.userData.update(wpp); },
            setHighlight: (on, hl) => { own.setHighlight(on, hl); for (const m of members) m.userData.setHighlight(on, hl); },
          };
        }
        const text = wg ? t("viewport.portWaveguide", { n: p.number, mode: p.mode ?? "TE10" }) : `P${p.number} · ${fmt.num(p.R, 6)} Ω`;
        const l = label(text, "vp-label vp-label-port");
        portLabels.set(p.number, { el: l.element, base: text });
        l.position.copy(g.userData.labelAnchor);
        g.add(l);
        glyphLabels.push({ glyph: g, label: l });
        overlayRoot.add(g);
      }

      for (const e of b.lumped_elements ?? []) {
        const body = lumpedObject(e.start, e.stop, cssVar("--al-3d-lumped"), portR * 1.2, cssVar("--al-3d-lumped-accent"), e.direction);
        body.name = `lumped-${e.name}`;
        const l = label(lumpedLabel(e), "vp-label");
        body.add(l);
        l.position.copy(body.userData.labelAnchor);
        glyphLabels.push({ glyph: body, label: l });
        overlayRoot.add(body);
      }

      const domain = boxLines(b.domain.min, b.domain.max, new THREE.LineBasicMaterial({ color: c.domain, transparent: true, opacity: 0.7 }));
      domain.name = "domain";
      overlayRoot.add(domain);
      if (b.nf2ff_box) {
        const nf = boxLines(b.nf2ff_box.min, b.nf2ff_box.max,
          new THREE.LineDashedMaterial({ color: c.nf2ff, dashSize: radius * 0.06, gapSize: radius * 0.04 }));
        nf.name = "nf2ff";
        overlayRoot.add(nf);
      }

      // ground: the PEC half-space boundary. The reference grid is a separate visibility layer.
      const ground = new THREE.Group();
      ground.name = "ground";
      const gz = b.half_space ? b.half_space.position : 0;
      const ext = b.half_space
        ? Math.max(b.domain.max[0] - b.domain.min[0], b.domain.max[1] - b.domain.min[1])
        : radius * 6;
      if (b.half_space) {
        const plane = new THREE.Mesh(
          new THREE.PlaneGeometry(b.domain.max[0] - b.domain.min[0], b.domain.max[1] - b.domain.min[1]),
          new THREE.MeshStandardMaterial({ color: c.ground, metalness: 0.6, roughness: 0.5, envMap: env, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
        );
        plane.position.set((b.domain.min[0] + b.domain.max[0]) / 2, (b.domain.min[1] + b.domain.max[1]) / 2, gz - 1e-3 * radius);
        ground.add(plane);
      }
      const step = niceLength(ext / 24);
      const divisions = Math.max(2, Math.round(ext / step));
      const grid = new THREE.GridHelper(divisions * step, divisions, c.gridMajor, c.grid);
      grid.name = "guide-grid";
      grid.rotation.x = Math.PI / 2;
      grid.position.set(center.x, center.y, gz);
      (grid.material as THREE.Material).transparent = true;
      groundGrid = grid;
      groundGridOpacity = b.half_space ? 0.5 : 0.9;
      updateGroundGrid();
      (grid.material as THREE.Material).depthWrite = false;
      overlayRoot.add(ground);
      overlayRoot.add(grid);

      if (fitted !== b) {
        fitted = b;
        if (!keepCamera()) frameView("iso");
        else untrack(() => { if (appMode() === "design") refitWhenSceneChanged(b); }); // untracked: the refit reads signals (the preview, the mode) that must not rebuild the scene
      }
      applyVisibility();
      buildMeshPlane();
      buildPattern();
      buildCurrent();
      requestRender();
    }));


    // X-ray changes only the existing dielectric materials; geometry, labels and camera stay put.
    // The selected port glyph gets the stronger look (bigger, opaque x-ray, focus colour). Created after
    // the rebuild effect and on the same dependencies, so it runs on the freshly built glyphs.
    createEffect(() => {
      const s = selection();
      themeTick(); theme(); bundle();
      if (appMode() !== "design" || s.type !== "port") return;
      const number = designDraft.ports?.[s.i]?.number;
      const glyph = number === undefined ? undefined : overlayRoot.getObjectByName(`port-${number}`) as PortGlyph | undefined;
      if (!glyph?.userData.setHighlight) return;
      glyph.userData.setHighlight(true, cssVar("--al-focus"));
      requestRender();
      onCleanup(() => { glyph.userData.setHighlight(false); requestRender(); });
    });

    createEffect(on(() => layers.dielectricXray, () => {
      for (const p of parts) {
        if (p.kind === "metal") continue;
        for (const m of p.meshes) {
          if (!(m.material instanceof THREE.MeshStandardMaterial)) continue;
          const mat = m.material;
          mat.userData.base = {
            transparent: true,
            opacity: layers.dielectricXray ? 0.38 : 0.9,
            depthWrite: !layers.dielectricXray,
          };
        }
      }
      applySolidFade();
    }, { defer: true }));

    function applyVisibility() {
      for (const p of parts) {
        // a Boolean being set up draws its operands in their own colours instead
        p.group.visible = !hiddenParts[p.part.name] && !booleanPreviewGeometry()?.hide.includes(p.part.name);
        p.edges.forEach((e) => (e.visible = layers.edges));
      }
      const byName = (n: string) => overlayRoot.getObjectByName(n);
      const d = byName("domain");
      if (d) d.visible = layers.domain;
      const nf = byName("nf2ff");
      if (nf) nf.visible = layers.nf2ff;
      const g = byName("ground");
      if (g) g.visible = layers.ground;
      const guideGrid = byName("guide-grid");
      if (guideGrid) guideGrid.visible = layers.guideGrid;
      requestRender();
    }
    createEffect(on([() => ({ ...hiddenParts }), () => layers.edges, () => layers.domain, () => layers.nf2ff, () => layers.ground, () => layers.guideGrid, () => booleanPreviewGeometry()?.hide.join("\n")], applyVisibility));

    function buildMeshPlane() {
      const old = overlayRoot.getObjectByName("meshplane");
      if (old) retire(old);
      const b = bundle();
      if (!b || !layers.mesh) return setMeshNote(null), requestRender();
      const axis = ({ x: 0, y: 1, z: 2 } as const)[meshPlane.axis];
      const lines = [b.mesh.x, b.mesh.y, b.mesh.z][axis];
      const pos = lines[Math.min(meshPlane.index, lines.length - 1)];
      // Very fine meshes: above MESH_PLANE_MAX lines in the plane, draw every k-th line (first and
      // last kept) and say so; the full grid would be an unreadable solid tone and slow to draw.
      const u = ([b.mesh.x, b.mesh.y, b.mesh.z] as number[][])[(axis + 1) % 3];
      const v = ([b.mesh.x, b.mesh.y, b.mesh.z] as number[][])[(axis + 2) % 3];
      const total = u.length + v.length;
      const k = Math.ceil(total / MESH_PLANE_MAX);
      const thin = (arr: number[]) => (k > 1 ? arr.filter((_, i) => i % k === 0 || i === arr.length - 1) : arr);
      const shown = k > 1 ? { ...b, mesh: { ...b.mesh, x: thin(b.mesh.x), y: thin(b.mesh.y), z: thin(b.mesh.z) } } : b;
      setMeshNote(k > 1 ? t("viewport.meshThinned", { k, total }) : null);
      const obj = meshPlaneLines(shown, axis, pos, cssVar("--al-text"), 0.35);
      obj.name = "meshplane";
      obj.renderOrder = 5;
      overlayRoot.add(obj);
      requestRender();
    }
    createEffect(on([() => layers.mesh, () => meshPlane.axis, () => meshPlane.index], buildMeshPlane));

    function buildPattern() {
      disposeGroup(patternRoot);
      const b = bundle();
      const f = ff();
      if (!b || !f || !layers.pattern) return requestRender();
      const { radius } = sceneRadius(b);
      const c0 = b.nf2ff_center ?? [0, 0, 0];
      // far-field magnitude does not depend on the phase centre; in half space anchor it on the ground
      const ctr = new THREE.Vector3(c0[0], c0[1], b.half_space ? b.half_space.position : c0[2]);
      // the chosen quantity (gain, realized gain, a circular part; directivity when the entry lacks it)
      const q = farfieldOverride() ? "directivity" : patternQuantity();
      patternRoot.add(patternMesh(f, ctr, radius * 1.15, fieldStops(), !!b.half_space, { values: quantityGrid(b, f, q), max: quantityMax(b, f, q) }));
      requestRender();
    }
    createEffect(on([() => layers.pattern, farfieldIndex, farfieldOverride, patternQuantity], buildPattern, { defer: true }));

    // array feed on the port labels while the array pattern is shown: "P2 · 0 dB ∠ −90°"
    function writePortFeeds() {
      const feed = arrayActive() && arraySet() ? arrayWeights() : null;
      for (const [n, { el, base }] of portLabels) {
        const w = feed?.get(n);
        el.textContent = w ? `P${n} · ${num(w.ampDb, 1)} dB ∠ ${num(w.phaseDeg, 0)}°`.replace(/-/g, "\u2212") : base;
      }
      requestRender();
    }
    createEffect(on([arrayWeights, arrayActive, arraySet, bundle, themeTick, theme], writePortFeeds));

    function buildCurrent() {
      disposeGroup(currentRoot); // also disposes the plane textures (material.map)
      currentGroup = null;
      applyCurrentPhase = undefined;
      const b = bundle();
      if (!b?.fields || !layers.current) return requestRender();
      const f = ff()?.f ?? null;
      currentGroup = currentLayer(b, f, fieldStops(), sceneRadius(b).radius);
      currentRoot.add(currentGroup);
      if (hasCurrentPhase(b, f)) {
        applyCurrentPhase = (phase) => { if (currentGroup) { updateCurrentPhase(currentGroup, phase); requestRender(); } };
        updateCurrentPhase(currentGroup, phaseDeg());
      }
      requestRender();
    }
    createEffect(on([() => layers.current, farfieldIndex], buildCurrent, { defer: true }));

    // the E/H field-plane map (bundle field_planes) chosen in the designer's result tree
    let fieldPlaneGroup: THREE.Group | null = null;
    function buildFieldPlane() {
      disposeGroup(fieldPlaneRoot);
      const i = fieldPlaneMap();
      const m = i === null ? undefined : bundle()?.field_planes?.[i];
      fieldPlaneGroup = null;
      if (m) {
        fieldPlaneGroup = fieldPlaneLayer(m, currentFieldPlaneView(), fieldStops());
        fieldPlaneRoot.add(fieldPlaneGroup);
      }
      requestRender();
    }
    // not deferred: a 3D view mounted while a map is focused draws it at once
    createEffect(on([fieldPlaneMap, fieldPlaneScale, fieldPlaneMode, fieldPlanePart, bundle], buildFieldPlane));
    // Animate: the texture is redrawn in place at each instant, only while this view is on screen
    createEffect(on(fieldPlanePhase, (deg) => {
      if (hostVisible && fieldPlaneGroup && updateFieldPlanePhase(fieldPlaneGroup, deg)) requestRender();
    }, { defer: true }));

    // ---- theme (explicit toggle or OS change)
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => setThemeTick((t) => t + 1);
    mq.addEventListener("change", onScheme);
    window.addEventListener("fairbeam:appearance", onScheme);

    // ---- hover picking and ground readout
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let pending: PointerEvent | null = null;
    const onMove = (e: PointerEvent) => {
      pending = e;
      pickTask.request();
    };
    function pick() {
      const e = pending;
      pending = null;
      const b = bundle();
      if (!e || !b) return;
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const meshes = parts.filter((p) => p.group.visible).flatMap((p) => p.meshes);
      const hit = pickHit(ray.intersectObjects(meshes, false));
      // while drawing, the draw overlay shows its own readout: no part tooltip or hover highlight
      const name = drawTool() || facePicking() || transformPlacement() || vertexTarget() || isFacePickMode(pointPickMode()) ? null : (hit?.object.userData.part as string | undefined) ?? null;
      setHoverPart(name);
      setTip(name ? { x: e.clientX - r.left, y: e.clientY - r.top, name } : null);
      const gz = b.half_space ? b.half_space.position : 0;
      const p = new THREE.Vector3();
      const ok = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -gz), p);
      setCursor(hit ? { x: hit.point.x, y: hit.point.y, z: hit.point.z } : ok ? { x: p.x, y: p.y, z: gz } : null);
      onPointMove(e);
    }
    const pickTask = frameTask(pick);
    const onLeave = () => {
      pending = null;
      setTip(null);
      setCursor(null);
      setHoverPart(null);
      window.dispatchEvent(new CustomEvent("fairbeam:point-hover", { detail: null }));
    };
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerleave", onLeave);
    // a click (no drag) names the part under the pointer; the designer selects it
    let downAt: { x: number; y: number } | null = null;
    // Right drag pans, so a right click only opens the part menu when the pointer stayed put. The
    // browser fires "contextmenu" on the press on macOS but on the release on Windows: a menu
    // requested while the button is still down waits for the release.
    let rightAt: { x: number; y: number } | null = null;
    let rightMoved: boolean | null = null;
    let pendingMenu: (() => void) | null = null;
    const onDown = (e: PointerEvent) => {
      const altOrbit = e.button === 0 && e.altKey;
      const nonModalDialog = !!shapeRequest() || !!document.querySelector('.dm-face-extrude');
      // Pick modes (face, vertex, extrude face, WCS-to-face, measure, placement) are click-driven: they
      // accept a press and release within 4 px, so left drag still orbits, and right/middle drag pans.
      // Only drawing owns the left button.
      const toolActive = !nonModalDialog && !!drawTool();
      controls.mouseButtons = { LEFT: altOrbit || !toolActive ? THREE.MOUSE.ROTATE : null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
      downAt = e.button === 0 && !e.ctrlKey && !e.altKey ? { x: e.clientX, y: e.clientY } : null;
      if (e.button === 2 || (e.button === 0 && e.ctrlKey)) {
        rightAt = { x: e.clientX, y: e.clientY };
        rightMoved = null;
        pendingMenu = null;
      }
    };
    const onRightUp = (e: PointerEvent) => {
      if (!rightAt) return;
      rightMoved = Math.hypot(e.clientX - rightAt.x, e.clientY - rightAt.y) > 4;
      rightAt = null;
      const open = pendingMenu;
      pendingMenu = null;
      if (open && !rightMoved) open();
    };
    const onUp = (e: PointerEvent) => {
      onRightUp(e);
      controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
      if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
      downAt = null;
      if (transformPlacement()) return;
      if (facePicking() || extrudeFacePicking()) return; // the draw overlay takes these face clicks
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = pickHit(ray.intersectObjects(parts.filter((p) => p.group.visible).flatMap((p) => p.meshes), false));
      const pointMode = pointPickMode();
      if (pointMode) {
        if (hit?.face) {
          const record = candidate(hit, pointMode, pointMode === "face-source" ? "Move" : pointMode === "face-target" ? "Target" : String.fromCharCode(65 + (pointMode === "measure" ? pickedPoints().length % 2 : pickedPoints().length)), true);
          if (record) window.dispatchEvent(new CustomEvent("fairbeam:point-pick", { detail: record }));
        }
        return;
      }
      if (vertexTarget()) return; // editing points: a click beside the handles keeps the selection
      window.dispatchEvent(new CustomEvent("fairbeam:pick", { detail: (hit?.object.userData.part as string | undefined) ?? null }));
    };
    const onPointMove = (event: PointerEvent) => {
      const mode = pointPickMode();
      if (transformPlacement()) {
        window.dispatchEvent(new CustomEvent("fairbeam:point-hover", { detail: null }));
        return;
      }
      if (!mode) return;
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = pickHit(ray.intersectObjects(parts.filter(part => part.group.visible).flatMap(part => part.meshes), false));
      window.dispatchEvent(new CustomEvent("fairbeam:point-hover", { detail: hit?.face ? candidate(hit, mode, "Preview", false) : null }));
    };
    /** A point candidate, or for face alignment the planar face under the hit (a click on a curved
     * or slanted face explains why it cannot be used). */
    function candidate(hit: THREE.Intersection, mode: PointPickMode, label: string, click: boolean): PickedPoint | null {
      if (!isFacePickMode(mode)) return resolvePointCandidate(hit, mode, label);
      const face = resolveFaceCandidate(hit, ray.ray.direction);
      renderer.domElement.style.cursor = typeof face === "string" ? "not-allowed" : "crosshair";
      renderer.domElement.title = typeof face === "string" ? t("viewport.face.unsupported") : "";
      if (face === "curved" || face === "slanted" || !face) {
        if (click && face) setMessage({ tone: "warn", text: face === "curved" ? t("viewport.face.curved") : t("viewport.face.slanted") });
        return null;
      }
      return { point: face.centre, kind: "face centre", label, face };
    }
    createEffect(on(pointPickMode, (mode) => {
      if (!isFacePickMode(mode)) {
        renderer.domElement.title = "";
        if (!drawTool() && !facePicking() && !extrudeFacePicking()) renderer.domElement.style.cursor = "";
      }
    }));
    renderer.domElement.addEventListener("pointerdown", onDown, true);
    renderer.domElement.addEventListener("pointerup", onUp, true);
    const onContext = (e: MouseEvent) => {
      if (appMode() !== "design") return;
      // OrbitControls suppresses every native menu. Intercept before that listener.
      // Empty space and draw tools get no menu at all, not the browser's.
      e.stopImmediatePropagation();
      e.preventDefault();
      if (drawTool() || facePicking() || transformPlacement()) return;
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const hit = pickHit(ray.intersectObjects(parts.filter((p) => p.group.visible).flatMap((p) => p.meshes), false));
      const i = designDraft.parts.findIndex((p) => p.name === hit?.object.userData.part);
      if (!hit || i < 0) return;
      const j = pickedShape(i, ray);
      const normal = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld);
      // A port picked on a metal face feeds against another metal along the face normal, usually
      // the next one behind it (a patch against its ground plane). Offer the nearest few on both
      // sides, one per part; the port dialog lets the user choose.
      const targets: NonNullable<ContextTarget["targets"]> = [];
      if (normal && hit.object.userData.metal) {
        const others = parts.filter((p) => p.group.visible).flatMap((p) => p.meshes)
          .filter((m) => m.userData.metal && m.userData.part !== hit.object.userData.part);
        for (const [side, dir] of [["behind", normal.clone().negate()], ["in front", normal.clone()]] as const) {
          const through = new THREE.Raycaster(hit.point.clone().addScaledVector(dir, 1e-9), dir);
          const seen = new Set<string>();
          for (const h of through.intersectObjects(others, false)) {
            const part = h.object.userData.part as string;
            if (h.distance <= 1e-9 || seen.has(part)) continue;
            seen.add(part);
            targets.push({ part, point: h.point.toArray(), side, distance: h.distance });
            if (seen.size === 3) break;
          }
        }
      }
      const open = () => openContext({ selection: j === undefined ? { type: "part", i } : { type: "primitive", i, j },
        x: e.clientX, y: e.clientY, trigger: host, point: hit.point.toArray(), normal: normal?.toArray(), targets });
      if (rightAt) pendingMenu = open; // macOS: still pressed, decide on the release
      else if (!rightMoved) open(); // Windows (after the release), or a menu key
      rightMoved = null;
    };
    const onContextKey = (e: KeyboardEvent) => {
      if (appMode() !== "design" || e.target !== host || !(e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) return;
      const name = bundle()?.parts[kbPart()]?.name ?? selectedPart();
      const i = designDraft.parts.findIndex((p) => p.name === name);
      if (i < 0) return;
      const r = host.getBoundingClientRect();
      if (openContext({ selection: { type: "part", i }, x: r.left + r.width / 2, y: r.top + r.height / 2, trigger: host, ...boundsPortTarget(i) })) {
        e.preventDefault(); e.stopImmediatePropagation();
      }
    };
    renderer.domElement.addEventListener("contextmenu", onContext, true);
    host.addEventListener("keydown", onContextKey, true);
    // the designer's draw tools (work-plane grid, rubber band, snapping)
    const detachTransform = attachTransformOverlay(scene, requestRender);
    const detachBoolean = attachBooleanOverlay(scene, requestRender);
    const detachDraw = attachDrawOverlay({ host, canvas: renderer.domElement, scene, camera, requestRender, bundle });
    const detachVertex = attachVertexOverlay({ host, canvas: renderer.domElement, scene, camera, requestRender, bundle });

    // ---- keyboard: orbit, pan, zoom, views, fit, and Tab through the parts
    const ORBIT = THREE.MathUtils.degToRad(7.5);
    const Z = new THREE.Vector3(0, 0, 1);
    function orbit(dAz: number, dPol: number) {
      const off = camera.position.clone().sub(controls.target);
      off.applyAxisAngle(Z, dAz);
      if (dPol) {
        const axis = new THREE.Vector3().crossVectors(off, Z).normalize();
        const next = off.clone().applyAxisAngle(axis, dPol);
        const pol = next.angleTo(Z);
        if (axis.lengthSq() > 0 && pol > 0.02 && pol < Math.PI - 0.02) off.copy(next);
      }
      camera.position.copy(controls.target).add(off);
      camera.lookAt(controls.target);
      controls.update();
    }
    function pan(dx: number, dy: number) {
      const dist = camera.position.distanceTo(controls.target);
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0).multiplyScalar(dx * dist * 0.06);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1).multiplyScalar(dy * dist * 0.06);
      camera.position.add(right).add(up);
      controls.target.add(right).add(up);
      controls.update();
    }
    function zoom(factor: number) {
      const off = camera.position.clone().sub(controls.target).multiplyScalar(factor);
      camera.position.copy(controls.target).add(off);
      controls.update();
    }
    const onMenuZoom = (event: Event) => {
      const direction = (event as CustomEvent<"in" | "out">).detail;
      if (!bundle() || (direction !== "in" && direction !== "out")) return;
      zoom(direction === "in" ? 0.85 : 1 / 0.85);
      say(direction === "in" ? t("viewport.say.zoomedIn") : t("viewport.say.zoomedOut"));
      requestRender();
    };
    host.addEventListener("fairbeam:zoom", onMenuZoom);
    function describePart(i: number): string {
      const b = bundle();
      const p = b?.parts[i];
      if (!b || !p) return "";
      const kind = p.type === "Material" ? t("viewport.part.dielectric", { eps: p.material ? fmt.num(p.material.eps_r, 4) : "?" }) : "PEC";
      const hidden = hiddenParts[p.name] ? t("viewport.part.hidden") : "";
      return t("viewport.part.describe", { name: p.label ?? p.name, kind, dims: dims(p.bbox), hidden, n: i + 1, total: b.parts.length });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.target !== host || e.metaKey || e.ctrlKey || e.altKey || drawTool()) return;
      const b = bundle();
      if (!b) return;
      const k = e.key;
      // Number keys bubble to the guarded camera handler below (including Num Lock off).
      if (cameraShortcut(e)) return;
      if (k === "f" || k === "F" || k === " ") applyView("fit");
      // with two parts to combine, + and - are the Boolean keys (designer/shortcuts.ts); = and _ still zoom
      else if ((k === "+" || k === "-") && booleanKeysActive()) return;
      else if (k === "+" || k === "=") zoom(0.85), say(t("viewport.say.zoomedIn"));
      else if (k === "-" || k === "_") zoom(1 / 0.85), say(t("viewport.say.zoomedOut"));
      else if (k.startsWith("Arrow")) {
        const dx = k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : 0;
        const dy = k === "ArrowUp" ? 1 : k === "ArrowDown" ? -1 : 0;
        if (e.shiftKey) pan(-dx, -dy);
        else orbit(-dx * ORBIT, -dy * ORBIT);
      } else if (k === "Tab") {
        // Tab / Shift+Tab step through the parts; past the last (or before the first) part the
        // key is not handled, so focus leaves the viewport as usual
        const n = b.parts.length;
        const next = kbPart() + (e.shiftKey ? -1 : 1);
        if (next < 0 || next >= n) {
          setKbPart(-1);
          setHoverPart(null);
          return;
        }
        setKbPart(next);
        setHoverPart(b.parts[next].name);
        say(describePart(next));
      } else if (k === "Escape" && kbPart() >= 0) {
        setKbPart(-1);
        setHoverPart(null);
        say(t("viewport.say.noPart"));
      } else return;
      e.preventDefault();
      requestRender();
    };
    const onBlur = () => {
      if (kbPart() >= 0) {
        setKbPart(-1);
        setHoverPart(null);
      }
    };
    host.addEventListener("keydown", onKey);
    const onCameraKey = (e: KeyboardEvent) => {
      const command = cameraShortcut(e);
      const target = e.target instanceof Element ? e.target : null;
      if (!command || e.defaultPrevented || !bundle() || drawTool() || !host.getClientRects().length) return;
      if (target?.closest("input, textarea, select, [contenteditable], .cm-editor, .dialog, .scrim, .rb-pop, [role=menu]")) return;
      if (document.querySelector("[aria-modal=true], dialog[open], .rb-pop, [role=menu]")) return;
      e.preventDefault();
      applyView(command);
    };
    document.addEventListener("keydown", onCameraKey);
    host.addEventListener("blur", onBlur);
    createEffect(on(bundle, () => setKbPart(-1), { defer: true }));

    // highlight the hovered part (emissive lift, no colour change) and, stronger, the part
    // selected in the designer: a red tint and a red outline drawn over everything, so a part inside
    // or behind others (a ground plane under the substrate, a pin in a connector) still shows
    const selectionColour = () => cssVar("--al-critical") || cssVar("--al-focus");
    let selectionOutlines: (THREE.LineSegments | THREE.Mesh)[] = [];
    const clearSelectionOutlines = () => {
      for (const l of selectionOutlines) {
        l.removeFromParent();
        // the x-ray fill shares the part's geometry: only the outline's own geometry is freed
        if (l instanceof THREE.LineSegments) l.geometry.dispose();
        (l.material as THREE.Material).dispose();
      }
      selectionOutlines = [];
    };
    onCleanup(clearSelectionOutlines);
    // a shape selected in the tree (selectedShape): only the pieces that came from it (the bundle's
    // `source` index) get the full highlight; the rest of its part a faint one. Bundles without
    // `source` (server previews, results) fall back to the whole part.
    const isPicked = (p: (typeof parts)[number], m: THREE.Mesh, sel: string | null, shape: number | null) => {
      if (p.part.name !== sel) return false;
      if (shape === null) return true;
      const has = p.meshes.some((q) => (q.userData.primitive as { source?: number } | undefined)?.source !== undefined);
      return !has || (m.userData.primitive as { source?: number } | undefined)?.source === shape;
    };
    createEffect(on([hoverPart, selectedPart, selectedShape, partsTick, themeTick, theme], ([name, sel, shape]) => {
      const lift = cssVar("--al-copper-300");
      const pick = selectionColour();
      for (const p of parts) {
        for (const m of p.meshes) {
          const mat = m.material as THREE.MeshStandardMaterial;
          const s = isPicked(p, m, sel, shape), inPart = p.part.name === sel, h = p.part.name === name;
          mat.emissive?.set(s || inPart ? pick : h ? lift : "#000000");
          mat.emissiveIntensity = s ? 0.55 : inPart ? 0.15 : h ? 0.25 : 0;
        }
      }
      requestRender();
    }));
    // the overlays follow the selection only (not the hover): their edge geometry is built once per
    // selection, not on every pointer move across the parts
    createEffect(on([selectedPart, selectedShape, partsTick, themeTick, theme], ([sel, shape]) => {
      const pick = selectionColour();
      clearSelectionOutlines();
      for (const p of parts) {
        if (p.part.name !== sel) continue;
        for (const m of p.meshes) {
          if (!isPicked(p, m, sel, shape)) {
            // the part's other shapes: a faint outline only, so the picked one stands out
            const faint = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 25),
              new THREE.LineBasicMaterial({ color: pick, depthTest: false, depthWrite: false, transparent: true, opacity: 0.3 }));
            faint.renderOrder = 997;
            faint.name = "selection-outline";
            faint.raycast = () => {};
            m.add(faint);
            selectionOutlines.push(faint);
            continue;
          }
          const line = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 25),
            new THREE.LineBasicMaterial({ color: pick, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 }));
          line.renderOrder = 999;
          line.name = "selection-outline";
          // x-ray: a faint red fill over everything, so a hidden part reads as a shape, not just a line
          const xray = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({
            color: pick, transparent: true, opacity: 0.34, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
          xray.renderOrder = 998;
          xray.name = "selection-xray";
          // picking hits the part itself, never its overlays
          xray.raycast = () => {};
          line.raycast = () => {};
          m.add(xray, line);
          selectionOutlines.push(xray, line);
        }
      }
      requestRender();
    }));

    // designer mesh view: fade every solid so the mesh plane shows through (materials keep their
    // own settings in userData.base and get them back when the fade ends)
    // parts that enclose the selection (its centre lies strictly inside them: a substrate around a
    // via, a solid drawn inside another) are faded while it is selected, so it is not hidden;
    // parts that only touch it (a patch on its substrate) keep their look
    let enclosing = new Set<string>();
    createEffect(on([selectedPart, selectedShape, partsTick], ([sel, shape]) => {
      const box = new THREE.Box3();
      for (const p of parts) for (const m of p.meshes) if (isPicked(p, m, sel, shape)) box.expandByObject(m);
      const next = new Set<string>();
      if (!box.isEmpty()) {
        const c = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const tol = 1e-6 * Math.max(1, size.length());
        for (const p of parts) {
          if (p.part.name === sel) continue;
          const pb = new THREE.Box3();
          for (const m of p.meshes) pb.expandByObject(m);
          if (!pb.isEmpty() && [0, 1, 2].every((k) => c.getComponent(k) > pb.min.getComponent(k) + tol && c.getComponent(k) < pb.max.getComponent(k) - tol)) next.add(p.part.name);
        }
      }
      enclosing = next;
      applySolidFade();
    }));
    function applySolidFade() {
      const fade = solidFade();
      for (const p of parts) {
        const ghost = !fade && enclosing.has(p.part.name);
        for (const m of p.meshes) {
          const mat = m.material as THREE.Material;
          const base = (mat.userData.base ??= { transparent: mat.transparent, opacity: mat.opacity, depthWrite: mat.depthWrite });
          const next = fade
            ? { transparent: true, opacity: Math.min(base.opacity, p.kind === "metal" ? 0.5 : 0.22), depthWrite: false }
            : ghost ? { transparent: true, opacity: Math.min(base.opacity, 0.18), depthWrite: false }
            : base;
          if (mat.transparent !== next.transparent) mat.needsUpdate = true;
          Object.assign(mat, next);
        }
      }
      requestRender();
    }
    createEffect(on([solidFade, bundle, themeTick, theme], applySolidFade));

    // ---- rendered view (physically based materials, studio light, ground shadow, ports)
    async function syncRendered() {
      if (!renderedView()) { rendered?.hide(); return; }
      if (!rendered) {
        const { attachRendered } = await import("../render/rendered");
        if (renderedDisposed) return;
        rendered ??= attachRendered({ renderer, scene, env, labels: labels.domElement, modellingBackground: () => new THREE.Color(cssVar("--al-viewport")), requestRender });
      }
      if (!renderedView()) { rendered.hide(); return; }
      rendered.show(bundle(), { ...renderOptions }, new Set(Object.keys(hiddenParts).filter((name) => hiddenParts[name])));
    }
    // after the rebuild effect above: on a bundle or theme change it has just reset the background
    createEffect(() => {
      renderedView(); bundle(); themeTick(); theme();
      for (const key of ["ports", "solderMask", "groundShadow", "background"] as const) renderOptions[key];
      Object.values(hiddenParts); // a part hidden or shown in the tree redraws the picture
      untrack(() => { void syncRendered().catch((e) => { console.error(e); setRenderedView(false); exportNotice(t("render.error.view", { error: String(e) })); }); });
    });
    const unregisterView = registerViewProvider(() => ({ position: camera.position.toArray(), target: controls.target.toArray(), up: [0, 0, 1], fov: camera.fov }));
    onCleanup(() => { unregisterView(); renderedDisposed = true; rendered?.dispose(); rendered = null; });

    // ---- screenshot
    const renderNow = renderTask.runNow;
    const onShot = async () => {
      if (activeExportSurface() !== "viewport" || !geometryAvailable() || !bundle()?.parts.some(p=>p.primitives.length) || !host.getClientRects().length || host.closest("[inert],[hidden]")) { exportNotice(t("contextExport.noView")); return; }
      renderNow();
      const name = `${(bundle()?.name ?? "fairbeam").replace(/[^a-z0-9._-]+/gi, "_")}.png`;
      // the browser or WebView may save, ask, block or cancel without telling the page: say
      // "requested", not "saved" (src/lib/download.ts). One toast reports it (lib/toast.ts).
      try {
        downloadToast(await saveDownloadUrl(name, renderer.domElement.toDataURL("image/png")));
      } catch (e) {
        console.error(e);
        exportNotice(downloadFailedMessage(name, e), { tone: "error" });
      }
    };
    const unregisterExport = registerSurfaceExports("viewport", {ready:()=>geometryAvailable() && !!bundle()?.parts.some(p=>p.primitives.length),screenshot:onShot,actions:()=>[]});
    // PNG of the current view for the export package: detail.resolve(dataUrl)
    const onCapture = (e: Event) => {
      if (activeExportSurface() !== "viewport" || !geometryAvailable()) { (e as CustomEvent<{resolve:(url:string|null)=>void}>).detail?.resolve(null); return; }
      renderNow();
      (e as CustomEvent<{ resolve: (url: string | null) => void }>).detail?.resolve(renderer.domElement.toDataURL("image/png"));
    };
    window.addEventListener("fairbeam:capture", onCapture);

    onCleanup(() => {
      if (import.meta.env.DEV) clearOwnedDebugReference(window as unknown as { __fairbeam?: unknown }, debugViewport);
      renderTask.dispose();
      pickTask.dispose();
      announceTask?.dispose();
      announceTask = undefined;
      pending = null;
      ro.disconnect();
      io.disconnect();
      stopPhaseTimer();
      motionQuery.removeEventListener("change", onMotionChange);
      document.removeEventListener("visibilitychange", onMotionChange);
      stopPixelRatio();
      mq.removeEventListener("change", onScheme);
      window.removeEventListener("fairbeam:appearance", onScheme);
      unregisterExport();
      window.removeEventListener("fairbeam:capture", onCapture);
      host.removeEventListener("fairbeam:view", onViewEvent);
      host.removeEventListener("fairbeam:zoom", onMenuZoom);
      window.removeEventListener("fairbeam:frame-added", onFrameAdded);
      host.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", onCameraKey);
      host.removeEventListener("blur", onBlur);
      renderer.domElement.removeEventListener("pointermove", onMove);
      detachVertex();
      detachDraw();
      detachTransform();
      detachBoolean();
      renderer.domElement.removeEventListener("pointerdown", onDown, true);
      renderer.domElement.removeEventListener("pointerup", onUp, true);
      renderer.domElement.removeEventListener("contextmenu", onContext, true);
      host.removeEventListener("keydown", onContextKey, true);
      renderer.domElement.removeEventListener("pointerleave", onLeave);
      controls.removeEventListener("change", onControlsChange);
      controls.dispose();
      disposeGroup(scene);
      disposeGroup(gizmo);
      flushGraveyard(); // arrow helpers and the X/Y/Z sprite textures
      geometryCache.dispose();
      envRT.dispose();
      pmrem.dispose();
      labels.domElement.remove();
      renderer.dispose();
      for (const { texture, listener } of lutListeners) textureEvents.removeEventListener.call(texture, "dispose", listener);
      lutListeners.length = 0;
      // release the WebGL context now: remounting (Reload panel) must not pile up contexts
      renderer.forceContextLoss();
      renderer.domElement.remove();
    });
  });

  const go = (v: ViewCommand) => host.dispatchEvent(new CustomEvent("fairbeam:view", { detail: v }));
  const tipPart = () => {
    const at = tip();
    const b = bundle();
    return at && b ? b.parts.find((p) => p.name === at.name) : undefined;
  };

  return (
    <div
      class="viewport"
      classList={{ "vp-rendered-light": renderedView() && renderOptions.background !== "dark" }}
      ref={host}
      tabindex={0}
      role="application"
      aria-roledescription={t("viewport.roledescription")}
      aria-label={bundle()?.name ? t("viewport.ariaNamed", { name: bundle()!.name }) : t("viewport.aria")}
      aria-describedby="vp-keys"
      aria-haspopup={appMode() === "design" ? "menu" : undefined}
      aria-expanded={appMode() === "design" ? contextTarget()?.trigger === host : undefined}
    >
      <p id="vp-keys" class="visually-hidden">
        {t("viewport.keys")}
        <Show when={appMode() === "design"}> {t("viewport.keysDesign")}</Show>
      </p>
      <div class="visually-hidden" aria-live="polite" aria-atomic="true">{announce()}</div>
      <div class="vp-hud vp-hud-tl" role="toolbar" aria-label={t("viewport.cameraViews")}>
        <div class="seg">
          <For each={CAMERA_VIEWS}>
            {(v) => (
              <button class="seg-btn" classList={{ active: view() === v.id }} aria-pressed={view() === v.id} onClick={() => go(v.id)} title={`${t(v.title)} (${v.shortcut})`}>
                <CameraViewIcon view={v.id} size={16} /> {t(v.label)}
              </button>
            )}
          </For>
        </div>
        <button class="icon-btn" onClick={() => go("fit")} data-action="fit" title={t("viewport.fit")} aria-label={t("viewport.fit")}>
          <Crosshair size={16} aria-hidden="true" />
        </button>
        <button class="seg-btn vp-rendered-toggle" classList={{ active: renderedView() }} aria-pressed={renderedView()} data-action="rendered"
          disabled={!bundle()?.parts.length} title={t("render.toggle.title")} onClick={() => setRenderedView(!renderedView())}>
          <Gem size={16} aria-hidden="true" /> {t("render.toggle.label")}
        </button>
        <Show when={renderedView()}>
          <div class="vp-render-bar" role="toolbar" aria-label={t("render.bar.aria")}>
            <div class="seg" role="group" aria-label={t("render.ports.label")}>
              <For each={["connector", "marker", "hidden"] as const}>{(mode) =>
                <button class="seg-btn" classList={{ active: renderOptions.ports === mode }} aria-pressed={renderOptions.ports === mode} data-render-ports={mode}
                  title={t(`render.ports.${mode}.title`)} onClick={() => setRenderOptions({ ports: mode })}>{t(`render.ports.${mode}`)}</button>}</For>
            </div>
            <div class="seg" role="group" aria-label={t("render.options.aria")}>
              <button class="seg-btn" classList={{ active: renderOptions.groundShadow }} aria-pressed={renderOptions.groundShadow} data-render-shadow
                title={t("render.shadow.title")} onClick={() => setRenderOptions({ groundShadow: !renderOptions.groundShadow })}>{t("render.shadow.label")}</button>
              <button class="seg-btn" classList={{ active: renderOptions.solderMask === "green" }} aria-pressed={renderOptions.solderMask === "green"} data-render-mask
                title={t("render.mask.title")} onClick={() => setRenderOptions({ solderMask: renderOptions.solderMask === "green" ? "none" : "green" })}>{t("render.mask.label")}</button>
              <button class="seg-btn" classList={{ active: renderOptions.background === "dark" }} aria-pressed={renderOptions.background === "dark"} data-render-dark
                title={t("render.dark.title")} onClick={() => setRenderOptions({ background: renderOptions.background === "dark" ? "studio" : "dark" })}>{t("render.dark.label")}</button>
            </div>
            <button class="btn btn-sm" data-action="render-image" onClick={() => setRenderDialogOpen(true)} title={t("render.image.title")}>
              <Aperture size={14} aria-hidden="true" /> {t("render.image.label")}
            </button>
          </div>
        </Show>
      </div>

      {/* colour scales stack in one column (side by side on small viewports), so they never overlap */}
      <div class="vp-hud vp-hud-tr vp-scales">
        <Show when={layers.pattern && bundle() && ff()}>
          {(f) => (
            <FarfieldCard bundle={bundle()!} ff={f()} entries={bundle()!.results?.farfield ?? []}
              active={Math.min(farfieldIndex(), (bundle()!.results?.farfield.length ?? 1) - 1)}
              onSelect={(i) => (appMode() === "design" ? showPattern3dEntry(i) : setFarfieldIndex(i))} arrayPattern={!!farfieldOverride()} />
          )}
        </Show>

        <FieldPlaneScale />

        <Show when={layers.current && bundle()?.fields && shownFieldFrequency(bundle()!, ff()?.f ?? null)}>
          {(fs) => (
            <div class="colorbar" role="group" aria-label={t("viewport.current.aria", { excitation: fieldExcitation(bundle()!).text })}>
              <div class="colorbar-title">{t("model.layer.current")} · {GHz(fs(), 3)}</div>
              {/* the one excitation the maps were recorded with (#90); unknown for older bundles without it */}
              <div class="colorbar-port" classList={{ "colorbar-port-unknown": fieldExcitation(bundle()!).port == null }}>{fieldExcitation(bundle()!).text}</div>
              <Show when={hasCurrentPhase(bundle()!, ff()?.f ?? null)} fallback={<div class="colorbar-note">{t("viewport.current.noPhase")}</div>}>
                <div class="current-phase-controls">
                  <div class="current-phase-actions">
                    <button class="btn btn-ghost btn-sm" aria-pressed={phasePlaying()} onClick={() => setPhasePlaying((playing) => !playing)}>
                      {phasePlaying() ? t("viewport.current.pause") : t("viewport.current.play")}
                    </button>
                    <span class="current-phase-value">{phaseDeg()}°</span>
                  </div>
                  <label class="visually-hidden" for="current-phase-slider">{t("viewport.current.phaseLabel")}</label>
                  <input id="current-phase-slider" type="range" min="0" max="360" step="1" value={phaseDeg()}
                    aria-valuetext={t("array.degrees", { n: phaseDeg() })}
                    onInput={(event) => { const value = Number(event.currentTarget.value); setPhaseDeg(value); applyCurrentPhase?.(value); }} />
                </div>
              </Show>
              <div class="colorbar-body">
                <div class="colorbar-ramp" aria-hidden="true" />
                <div class="colorbar-ticks">
                  <For each={[1, 0.75, 0.5, 0.25, 0]}>{(v) => <span>{num(v, 2)}</span>}</For>
                </div>
              </div>
              <div class="colorbar-unit">{hasCurrentPhase(bundle()!, ff()?.f ?? null)
                ? t("viewport.current.unitPhase")
                : t("viewport.current.unit")}</div>
            </div>
          )}
        </Show>
      </div>

      <div class="vp-hud vp-hud-br">
        <Show when={meshNote()}>{(n) => <span class="readout" role="note">{n()}</span>}</Show>
        <Show when={cursor()}>
          {(c) => {
            // u, v, w of the local WCS while one is active, else x, y, z
            const local = () => (!wcsIsGlobal() && appMode() === "design" ? worldToWcs([c().x, c().y, c().z]) : null);
            return (
              <span class="readout">
                <Show when={local()} fallback={<>x {num(c().x, 2)} · y {num(c().y, 2)} · z {num(c().z, 2)} mm</>}>
                  {(l) => <>u {num(l()[0], 2)} · v {num(l()[1], 2)} · w {num(l()[2], 2)} mm</>}
                </Show>
              </span>
            );
          }}
        </Show>
        <Show when={scaleBar()}>
          {(s) => (
            <span class="scalebar" style={{ width: `${s().px}px` }}>
              <span>{s().label}</span>
            </span>
          )}
        </Show>
      </div>

      <Show when={tip() && tipPart()}>
        <div
          class="vp-tip"
          classList={{ "flip-x": tip()!.x > host.clientWidth - 220, "flip-y": tip()!.y > host.clientHeight - 120 }}
          style={{
            left: `${tip()!.x + (tip()!.x > host.clientWidth - 220 ? -14 : 14)}px`,
            top: `${tip()!.y + (tip()!.y > host.clientHeight - 120 ? -14 : 14)}px`,
          }}
        >
          <div class="vp-tip-name">{tipPart()!.label ?? tipPart()!.name}</div>
          <div class="vp-tip-row">{tipPart()!.type === "Material" ? t("viewport.tip.dielectric", { eps: tipPart()!.material ? fmt.num(tipPart()!.material!.eps_r, 4) : "?" }) : "PEC"}</div>
          <div class="vp-tip-row mono">{dims(tipPart()!.bbox)}</div>
          <Show when={tipPart()!.primitives.length > 1}>
            <div class="vp-tip-row">{t("viewport.tip.primitives", { count: tipPart()!.primitives.length })}</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
