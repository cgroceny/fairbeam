// Fairbeam landing: one 3D stage behind the hero, "How it works" and the array chapter. Scrolling
// drives it: the finished patch antenna in the hero, taken apart and rebuilt step by step, then
// tiled into the 4 × 1 array whose beam is steered from its embedded element patterns.
//
// Everything shown is real simulation data, reduced by scripts/build-site.mjs:
//   media/patch-story.json  public/projects/patch-antenna.json: boxes, mesh lines, |J| map, far field, |S11|
//   media/array-story.json  public/projects/patch-array-4x1.json: boxes, ports, S at f0, element patterns
// Bundled with three.js (tree-shaken) into site-dist/story/story.js by scripts/build-site.mjs.
// The step text of each chapter is switched by landing/script.js; this file only reads the scroll.

import {
  AmbientLight, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, CylinderGeometry,
  DirectionalLight, DoubleSide, EdgesGeometry, Float32BufferAttribute, Group, HemisphereLight, LineBasicMaterial,
  LineSegments, Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Scene,
  SRGBColorSpace, Vector3, WebGLRenderer,
} from "three";
import { arrayModel } from "./array-math.js";

const root = document.documentElement;
const journey = document.getElementById("journey");
const canvas = document.getElementById("stage-canvas");
const heroEl = document.getElementById("top");
const howEl = document.getElementById("how");
const arrEl = document.getElementById("array");

function fallback(why) {
  if (why) console.warn("story:", why);
  root.classList.add("no-story");
}

if (journey && canvas && heroEl && howEl && arrEl) start().catch((e) => fallback(e));

// ------------------------------------------------------------------ helpers
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const ease = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
const lerp = (a, b, t) => a + (b - a) * t;
/** local progress of p inside [a, b] */
const seg = (p, a, b) => clamp01((p - a) / (b - a));
const css = (name, fallbackColor) => getComputedStyle(root).getPropertyValue(name).trim() || fallbackColor;
const headerH = () => document.querySelector(".site-header")?.offsetHeight || 56;

/** 0..1 through a pinned chapter: 0 when it reaches the header, 1 when its end leaves the screen */
function pinProgress(el) {
  const h = headerH(), r = el.getBoundingClientRect();
  const total = r.height - (window.innerHeight - h);
  return total > 0 ? clamp01((h - r.top) / total) : 0;
}

// Turbo, trimmed like the app's field map (--al-field-*), low -> high
const FIELD = ["#493dab", "#3789f9", "#25cdd0", "#48f789", "#96fa50", "#e5d730", "#ff9520", "#e54813", "#a01101"].map((c) => new Color(c));
function field(t, out = new Color()) {
  const x = clamp01(t) * (FIELD.length - 1);
  const i = Math.min(FIELD.length - 2, Math.floor(x));
  return out.copy(FIELD[i]).lerp(FIELD[i + 1], x - i);
}

async function start() {
  let renderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch (e) {
    return fallback(e);
  }
  const [data, adata] = await Promise.all(["media/patch-story.json", "media/array-story.json"].map((u) => fetch(u).then((r) => r.json())));
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  root.classList.add("has-story");

  const scene = new Scene();
  const camera = new PerspectiveCamera(32, 1, 0.1, 300);
  const U = 0.1; // scene units per mm
  scene.add(new AmbientLight(0xffffff, 0.55));
  scene.add(new HemisphereLight(0xffffff, 0x404040, 0.6));
  const sun = new DirectionalLight(0xffffff, 1.6);
  sun.position.set(6, -8, 12);
  scene.add(sun);

  const box = (b) => {
    const lo = b.start.map((v, i) => Math.min(v, b.stop[i]) * U), hi = b.start.map((v, i) => Math.max(v, b.stop[i]) * U);
    return { lo, hi, size: hi.map((v, i) => Math.max(v - lo[i], 0.004)), c: hi.map((v, i) => (v + lo[i]) / 2) };
  };
  const metal = new Color(css("--al-3d-metal", "#c98552"));
  const diel = new Color(css("--al-3d-dielectric", "#4f7a5f"));
  const accent = new Color(css("--al-accent-text", "#dda172"));
  const metalMat = () => new MeshStandardMaterial({ color: metal, metalness: 0.75, roughness: 0.32, side: DoubleSide });
  const dielMat = () => new MeshStandardMaterial({ color: diel, metalness: 0, roughness: 0.7, transparent: true, opacity: 0.88 });
  const portMat = () => new MeshStandardMaterial({ color: 0xd4462f, emissive: 0xd4462f, emissiveIntensity: 0.4 });

  // drafting floor: in the scene, so it keeps its spacing when the antenna group zooms out
  const fl = [];
  for (let i = -24; i <= 24; i++) fl.push(i, -24, 0, i, 24, 0, -24, i, 0, 24, i, 0);
  const floor = new LineSegments(new BufferGeometry().setAttribute("position", new Float32BufferAttribute(fl.map((v) => v * 0.6), 3)),
    new LineBasicMaterial({ color: new Color(css("--al-text", "#888")), transparent: true, opacity: 0.08 }));
  floor.position.z = -0.01;
  scene.add(floor);

  // world: z up (as in openEMS); the antenna sits at the origin
  const world = new Group();
  scene.add(world);

  // ================================================================== the single patch
  const parts = {};
  for (const p of data.parts) {
    const b = box(p);
    const m = new Mesh(new BoxGeometry(...b.size), p.type !== "Material" ? metalMat() : dielMat());
    m.position.set(...b.c);
    m.userData = { base: b };
    world.add(m);
    parts[p.name] = m;
  }
  // the model as a blueprint: the parts drawn as outlines and pulled apart
  const blue = new Group();
  const blueMat = new LineBasicMaterial({ color: accent, transparent: true, opacity: 0 });
  data.parts.forEach((p, i) => {
    const b = box(p);
    const e = new LineSegments(new EdgesGeometry(new BoxGeometry(...b.size)), blueMat);
    e.position.set(...b.c);
    e.userData = { z: b.c[2], lift: i * 0.9 };
    blue.add(e);
  });
  world.add(blue);

  const b0 = box(data.port);
  const port = new Mesh(new CylinderGeometry(0.035, 0.035, Math.max(b0.size[2], 0.05), 16), portMat());
  port.rotation.x = Math.PI / 2;
  port.position.set(...b0.c);
  world.add(port);
  const patchBox = parts.patch.userData.base;
  const zTop = patchBox.hi[2];

  // FDTD mesh lines in the patch plane (x and y lines near the structure)
  const lines = [];
  const R = 4.2;
  const xs = data.mesh.x.map((v) => v * U).filter((v) => Math.abs(v) <= R);
  const ys = data.mesh.y.map((v) => v * U).filter((v) => Math.abs(v) <= R);
  for (const x of xs) lines.push(x, -R, 0, x, R, 0);
  for (const y of ys) lines.push(-R, y, 0, R, y, 0);
  const meshGeo = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(lines, 3));
  const meshLines = new LineSegments(meshGeo, new LineBasicMaterial({ color: accent, transparent: true, opacity: 0.55 }));
  meshLines.position.z = zTop + 0.004;
  world.add(meshLines);
  const meshCount = lines.length / 3;

  // surface current on the patch: |J| / max as the field map, on a plane just above the copper
  const J = data.current;
  const tc = document.createElement("canvas");
  tc.width = J.nu;
  tc.height = J.nv;
  const ctx = tc.getContext("2d");
  const img = ctx.createImageData(J.nu, J.nv);
  const col = new Color();
  for (let v = 0; v < J.nv; v++) {
    for (let u = 0; u < J.nu; u++) {
      const val = J.values[v * J.nu + u];
      const k = ((J.nv - 1 - v) * J.nu + u) * 4; // canvas rows run top-down
      if (val < 0) { img.data[k + 3] = 0; continue; }
      field(val / 1000, col);
      img.data[k] = col.r * 255; img.data[k + 1] = col.g * 255; img.data[k + 2] = col.b * 255; img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const jtex = new CanvasTexture(tc);
  jtex.colorSpace = SRGBColorSpace;
  const cur = new Mesh(new PlaneGeometry((J.u_range[1] - J.u_range[0]) * U, (J.v_range[1] - J.v_range[0]) * U),
    new MeshBasicMaterial({ map: jtex, transparent: true, opacity: 0, depthWrite: false }));
  cur.position.set(((J.u_range[0] + J.u_range[1]) / 2) * U, ((J.v_range[0] + J.v_range[1]) / 2) * U, zTop + 0.006);
  world.add(cur);

  // far-field directivity surface: radius and colour by dB over the top 30 dB
  function patternMesh(nt, np, opacity) {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(nt * (np + 1) * 3), 3));
    g.setAttribute("color", new BufferAttribute(new Float32Array(nt * (np + 1) * 3), 3));
    const idx = [];
    for (let i = 0; i < nt - 1; i++) for (let j = 0; j < np; j++) {
      const a = i * (np + 1) + j, b = a + np + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    g.setIndex(idx);
    const m = new Mesh(g, new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0, transparent: true, opacity, side: DoubleSide, depthWrite: false }));
    m.renderOrder = 3;
    return m;
  }
  /** fill a pattern mesh from a dB grid (row-major [θ][φ]) */
  function shapePattern(mesh, theta, phi, dbAt, top, size) {
    const nt = theta.length, np = phi.length;
    const pos = mesh.geometry.attributes.position.array, cols = mesh.geometry.attributes.color.array;
    for (let i = 0; i < nt; i++) {
      const th = (theta[i] * Math.PI) / 180;
      for (let j = 0; j <= np; j++) {
        const ph = (phi[j % np] * Math.PI) / 180;
        const t = clamp01((dbAt(i, j % np) - (top - 30)) / 30);
        const r = size * t, k = (i * (np + 1) + j) * 3;
        pos[k] = r * Math.sin(th) * Math.cos(ph); pos[k + 1] = r * Math.sin(th) * Math.sin(ph); pos[k + 2] = r * Math.cos(th);
        field(t, col);
        cols[k] = col.r; cols[k + 1] = col.g; cols[k + 2] = col.b;
      }
    }
    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.geometry.attributes.color.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    mesh.geometry.computeBoundingSphere();
  }
  const F = data.farfield;
  const pattern = patternMesh(F.theta.length, F.phi.length, 0.9);
  shapePattern(pattern, F.theta, F.phi, (i, j) => F.d[i][j], F.dmax, 3.4);
  pattern.position.z = zTop;
  world.add(pattern);
  {
    // a faint wire grid on the pattern so its shape reads
    const pos = pattern.geometry.attributes.position.array, nt = F.theta.length, np = F.phi.length;
    const at = (i, j) => { const k = (i * (np + 1) + j) * 3; return [pos[k], pos[k + 1], pos[k + 2]]; };
    const wl = [];
    for (let i = 0; i < nt; i += 5) for (let j = 0; j < np; j++) wl.push(...at(i, j), ...at(i, j + 1));
    for (let j = 0; j < np; j += 6) for (let i = 0; i < nt - 1; i++) wl.push(...at(i, j), ...at(i + 1, j));
    const wire = new LineSegments(new BufferGeometry().setAttribute("position", new Float32BufferAttribute(wl, 3)),
      new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.14, depthWrite: false }));
    wire.scale.setScalar(1.002);
    pattern.add(wire);
  }

  // ================================================================== the 4 × 1 array
  const AM = arrayModel(adata);
  const SA = 0.42; // world scale in the array chapter
  const TOP = 12; // dB mapping of the array patterns: the top 30 dB below 12 dBi, for every weighting
  const arr = new Group();
  arr.visible = false;
  world.add(arr);
  const sGnd = parts.gnd.userData.base, sPatch = patchBox;
  const board = [], patches = [];
  for (const p of adata.parts) {
    const b = box(p);
    const m = new Mesh(new BoxGeometry(...b.size), p.type !== "Material" ? metalMat() : dielMat());
    m.position.set(...b.c);
    m.userData = { base: b };
    arr.add(m);
    (p.name === "patches" ? patches : board).push(m);
  }
  patches.sort((a, b) => a.userData.base.c[1] - b.userData.base.c[1]);
  const aPorts = adata.ports.map((p, n) => {
    const m = new Mesh(new CylinderGeometry(0.035, 0.035, Math.max(zTop, 0.05), 16), portMat());
    m.rotation.x = Math.PI / 2;
    const c = p.position.map((v) => v * U);
    m.userData = { c, dy: c[1] - patches[n].userData.base.c[1] };
    arr.add(m);
    return m;
  });
  const apat = patternMesh(AM.nt, AM.np, 0.88);
  const apatAt = adata.phase_center.map((v) => v * U);
  apat.position.set(...apatAt);
  arr.add(apat);
  const ASIZE = 2.7 / SA;
  const dbUniform = AM.pattern(AM.steering(0)).d.slice();
  const p1 = AM.pattern([[1, 0], [0, 0], [0, 0], [0, 0]]);
  const dbP1 = p1.d.slice();
  const dbMix = new Float32Array(dbUniform.length);
  let shownKey = "";
  function showArrayPattern(key, grid) {
    if (key === shownKey) return;
    shownKey = key;
    shapePattern(apat, adata.theta, adata.phi, (i, j) => grid[i * AM.np + j], TOP, ASIZE);
  }

  // ------------------------------------------------------------------ 2D overlays: |S11|, files, array readout
  const svg = document.getElementById("story-s11");
  const S11 = data.s11;
  const X = (f) => 34 + ((f - S11.f[0]) / (S11.f[S11.f.length - 1] - S11.f[0])) * 270;
  const Y = (db) => 14 + (Math.min(0, Math.max(-40, db)) / -40) * 126;
  const pts = S11.f.map((f, i) => `${X(f).toFixed(1)},${Y(S11.db[i]).toFixed(1)}`);
  let k0 = 0;
  S11.db.forEach((d, i) => { if (d < S11.db[k0]) k0 = i; });
  const ticks = [0, -10, -20, -30, -40].map((d) => `<line class="gr" x1="34" x2="304" y1="${Y(d)}" y2="${Y(d)}"/><text x="28" y="${Y(d) + 3}" text-anchor="end">${d}</text>`).join("");
  const fticks = [1, 1.5, 2, 2.5, 3].map((f) => `<text x="${X(f * 1e9)}" y="156" text-anchor="middle">${f}</text>`).join("");
  svg.innerHTML = `${ticks}${fticks}<line class="ref" x1="34" x2="304" y1="${Y(-10)}" y2="${Y(-10)}"/>
    <path class="ax" d="M34 14V140H304"/><path class="tr" id="s11-trace" d="M${pts.join("L")}"/>
    <circle class="mk" id="s11-mk" cx="${X(S11.f[k0])}" cy="${Y(S11.db[k0])}" r="3.5" opacity="0"/>
    <text class="lb" id="s11-lb" x="${X(S11.f[k0]) - 8}" y="${Y(S11.db[k0]) + 3}" text-anchor="end" opacity="0">${(S11.f[k0] / 1e9).toFixed(3)} GHz · ${S11.db[k0].toFixed(1)} dB</text>
    <text x="304" y="166" text-anchor="end">f (GHz)</text><text x="34" y="9">|S11| (dB)</text>`;
  const trace = document.getElementById("s11-trace");
  const traceLen = trace.getTotalLength();
  trace.style.strokeDasharray = `${traceLen}`;
  const s11mk = document.getElementById("s11-mk"), s11lb = document.getElementById("s11-lb");
  const files = document.getElementById("story-files");
  files.innerHTML = ["patch-antenna.bas", "s11.s1p", "drawing_A3.pdf", "report.pdf", "fab/patch-antenna-F_Cu.gbr", "patch-antenna.zip"].map((n) => `<li>${n}</li>`).join("");
  const fileEls = [...files.children];

  const hud = document.getElementById("array-hud");
  const fGHz = (Math.round(adata.f / 1e6) / 1e3).toFixed(3);
  hud.innerHTML = `<p class="hud-head">4 × 1 patch array · ${fGHz} GHz</p>
    <p class="hud-mode" id="hud-mode"></p>
    <dl class="hud-nums"><div><dt>Scan θ<sub>0</sub></dt><dd id="hud-scan"></dd></div><div><dt>Main beam</dt><dd id="hud-beam"></dd></div><div><dt>D<sub>max</sub></dt><dd id="hud-dmax"></dd></div></dl>
    <table class="hud-ports"><thead><tr><th>Port</th><th class="num">Phase</th><th class="num">Active |Γ|</th></tr></thead><tbody>${
      adata.ports.map((p) => `<tr><th>P${p.port}</th><td class="num" data-ph></td><td class="num" data-g></td></tr>`).join("")}</tbody></table>`;
  const hudMode = document.getElementById("hud-mode"), hudScan = document.getElementById("hud-scan");
  const hudBeam = document.getElementById("hud-beam"), hudDmax = document.getElementById("hud-dmax");
  const hudPh = [...hud.querySelectorAll("[data-ph]")], hudG = [...hud.querySelectorAll("[data-g]")];
  const deg = (x, d = 0) => `${x > 0.05 ? "+" : x < -0.05 ? "−" : ""}${Math.abs(x).toFixed(d)}°`;
  let hudKey = "";
  function setHud(key, mode, scan, res, w, gam) {
    if (key === hudKey) return;
    hudKey = key;
    hudMode.textContent = mode;
    hudScan.textContent = scan === null ? "—" : deg(scan, 1);
    hudBeam.textContent = deg(res.beam);
    hudDmax.textContent = `${res.dmax.toFixed(2)} dBi`;
    w.forEach(([a, b], n) => {
      const on = a !== 0 || b !== 0;
      hudPh[n].textContent = on ? deg(Math.atan2(b, a) * (180 / Math.PI)) : "off";
      hudG[n].textContent = gam[n] === null ? "50 Ω" : `${gam[n].toFixed(1)} dB`;
    });
  }
  const slider = document.getElementById("array-scan");
  const sliderOut = document.getElementById("array-scan-out");
  slider?.addEventListener("input", () => {
    if (sliderOut) sliderOut.textContent = deg(Number(slider.value));
  });

  // the theme toggle (or the system theme) changes the page tokens: repaint the scene with them
  const recolor = () => {
    const m = new Color(css("--al-3d-metal", "#c98552")), d = new Color(css("--al-3d-dielectric", "#4f7a5f"));
    const a = new Color(css("--al-accent-text", "#dda172"));
    scene.traverse((o) => {
      const mat = o.material;
      if (!mat || o === apat || o === pattern) return;
      if (mat.color?.equals(metal)) mat.color.copy(m);
      else if (mat.color?.equals(diel)) mat.color.copy(d);
      else if (mat.color?.equals(accent)) mat.color.copy(a);
    });
    metal.copy(m); diel.copy(d); accent.copy(a);
    floor.material.color.set(css("--al-text", "#888"));
  };
  new MutationObserver(recolor).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", recolor);

  // ------------------------------------------------------------------ scroll -> scene
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let visible = true, width = 0, height = 0;
  function layout() {
    const r = canvas.getBoundingClientRect();
    if (r.width === width && r.height === height) return;
    width = r.width;
    height = r.height;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // wide screens: push the antenna right of the text column; narrow: above the text
    const shift = width > 960 ? -width * 0.18 : 0;
    camera.setViewOffset(width, height, shift, width <= 960 ? height * 0.16 : 0, width, height);
    camera.updateProjectionMatrix();
  }

  function camHow(p) {
    return {
      az: -120 + 95 * (p / 6),
      el: 30 + 10 * seg(p, 3.8, 4.8),
      dist: 17 + 4 * ease(seg(p, 3.8, 4.8)) - 1.5 * ease(seg(p, 0.6, 1.8)) * (1 - seg(p, 3.8, 4.8)),
      lz: 0.6 * ease(seg(p, 3.8, 4.8)),
    };
  }
  const CAM_ARRAY = { az: -8, el: 20, dist: 21, lz: 0.7 };

  /** the single-patch timeline, p = 0..6 */
  function applyPatch(p, time, fadeOut) {
    // 0: blueprint, collapsing into place as the solids arrive
    const bp = seg(p, 0.05, 0.5) * (1 - seg(p, 1.2, 1.9));
    blueMat.opacity = 0.75 * ease(bp);
    blue.visible = bp > 0;
    const lift = 1 - ease(seg(p, 0.6, 1.5));
    blue.children.forEach((e) => { e.position.z = e.userData.z + e.userData.lift * lift; });
    // 1: geometry assembles
    const g = seg(p, 0.7, 2.0);
    const gnd = parts.gnd, sub = parts.substrate, pat = parts.patch;
    const sG = ease(seg(g, 0, 0.3));
    gnd.scale.set(Math.max(sG, 0.001), Math.max(sG, 0.001), 1);
    gnd.visible = sG > 0;
    const sS = ease(seg(g, 0.25, 0.6));
    sub.scale.set(1, 1, Math.max(sS, 0.001));
    sub.position.z = sub.userData.base.lo[2] + (sub.userData.base.size[2] * sS) / 2;
    sub.visible = sS > 0;
    const sP = ease(seg(g, 0.55, 0.9));
    pat.visible = sP > 0;
    pat.position.z = pat.userData.base.c[2] + (1 - sP) * 1.6;
    pat.material.opacity = sP;
    pat.material.transparent = sP < 1;
    port.visible = g > 0.85;
    // 2: mesh sweeps across
    const m = seg(p, 2.0, 2.9);
    meshGeo.setDrawRange(0, Math.floor((ease(m) * meshCount) / 2) * 2);
    meshLines.material.opacity = 0.55 * (1 - seg(p, 3.2, 3.6));
    meshLines.visible = m > 0 && p < 3.6;
    // 3: currents (a slow breathing brightness: the map is the magnitude at resonance)
    const c = seg(p, 3.0, 3.5);
    const breathe = calm ? 1 : 0.82 + 0.18 * Math.sin(time / 380);
    cur.material.opacity = ease(c) * breathe * (1 - 0.35 * seg(p, 4.2, 4.6)) * (1 - fadeOut.cur);
    cur.visible = cur.material.opacity > 0.001;
    port.material.emissiveIntensity = 0.4 + 1.4 * c * (calm ? 1 : 0.5 + 0.5 * Math.sin(time / 190));
    // 4: pattern inflates
    const f = ease(seg(p, 4.0, 4.8)) * (1 - fadeOut.pattern);
    pattern.visible = f > 0.001;
    pattern.scale.setScalar(Math.max(f, 0.001));
    pattern.material.opacity = 0.9 - 0.35 * seg(p, 5.0, 5.4);
    // 5: |S11| and files
    const s = seg(p, 5.0, 5.7);
    const s11on = p > 4.95 && !fadeOut.overlays;
    svg.classList.toggle("on", s11on);
    trace.style.strokeDashoffset = `${traceLen * (1 - ease(s))}`;
    const done = s > 0.98 ? 1 : 0;
    s11mk.setAttribute("opacity", done);
    s11lb.setAttribute("opacity", done);
    fileEls.forEach((li, i) => li.classList.toggle("on", s11on && p > 5.35 + i * 0.08));
  }

  /** the array timeline, q = 0..4 */
  function applyArray(q) {
    const mo = ease(seg(q, 0.2, 0.75)); // one patch tiles out into four
    const single = q < 0.2;
    for (const k of ["gnd", "substrate", "patch"]) parts[k].visible = parts[k].visible && single;
    port.visible = port.visible && single;
    arr.visible = !single;
    if (arr.visible) {
      for (const m of board) {
        const b = m.userData.base;
        m.scale.set(lerp(sGnd.size[0] / b.size[0], 1, mo), lerp(sGnd.size[1] / b.size[1], 1, mo), 1);
      }
      patches.forEach((m, n) => {
        const b = m.userData.base;
        m.position.set(b.c[0], lerp(sPatch.c[1], b.c[1], mo), b.c[2]);
        const pm = aPorts[n];
        pm.position.set(pm.userData.c[0], m.position.y + pm.userData.dy, pm.userData.c[2]);
      });
    }
    world.scale.setScalar(lerp(1, SA, mo));

    const ap = ease(seg(q, 0.6, 1.0));
    apat.visible = ap > 0.001;
    apat.scale.setScalar(Math.max(ap, 0.001));

    // which weighting: uniform, port 1 alone (step 1), steered by the scroll (step 2) or the slider (step 3)
    let w, res, mode, scan = 0, key;
    const e1 = ease(seg(q, 1.1, 1.5)) * (1 - ease(seg(q, 1.8, 2.0)));
    if (q < 2) {
      if (e1 <= 0) {
        showArrayPattern("u", dbUniform);
      } else {
        for (let i = 0; i < dbMix.length; i++) dbMix[i] = lerp(dbUniform[i], dbP1[i], e1);
        showArrayPattern(`m${e1.toFixed(3)}`, dbMix);
      }
      // port 1's own pattern is drawn over port 1
      apat.position.y = lerp(apatAt[1], aPorts[0].userData.c[1], e1);
      const alone = e1 > 0.5;
      w = alone ? [[1, 0], [0, 0], [0, 0], [0, 0]] : AM.steering(0);
      res = alone ? p1 : { beam: 0, dmax: Math.max(...dbUniform) };
      mode = alone ? "Port 1 driven, ports 2–4 terminated in 50 Ω" : "All four ports fed in phase";
      scan = alone ? null : 0;
      key = alone ? "alone" : "uniform";
    } else {
      apat.position.y = apatAt[1];
      scan = q < 3
        ? 30 * Math.sin(2 * Math.PI * seg(q, 2.05, 2.95))
        : lerp(0, Number(slider?.value ?? 25), ease(seg(q, 3.0, 3.3)));
      scan = Math.round(scan * 4) / 4;
      w = AM.steering(scan);
      res = AM.pattern(w);
      showArrayPattern(`s${scan}`, res.d);
      mode = "Progressive phase −k·d·sin θ0 per element";
      key = `s${scan}`;
    }
    aPorts.forEach((m, n) => {
      const on = w[n][0] !== 0 || w[n][1] !== 0;
      m.material.emissiveIntensity = on ? 1.2 : 0.1;
    });
    hud.classList.toggle("on", q > 0.75);
    setHud(key, mode, scan, res, w, AM.activeGamma(w));
    return mo;
  }

  function apply(time) {
    const hp = clamp01((headerH() - heroEl.getBoundingClientRect().top) / heroEl.offsetHeight);
    const p = pinProgress(howEl) * 6;
    // the array chapter has 3 steps; its timeline keeps a 4-step layout with step 1 (port 1 alone) skipped
    const qa = pinProgress(arrEl) * 3;
    const q = qa < 1 ? qa : qa + 1;
    // the hero shows the finished antenna; scrolling it away rewinds the build back to the blueprint
    const pe = p > 0 || hp >= 1 ? p : 4.9 * (1 - ease(seg(hp, 0.3, 1)));
    const fade = { cur: ease(seg(q, 0.05, 0.35)), pattern: ease(seg(q, 0.02, 0.3)), overlays: q > 0.06 || p <= 0 };
    applyPatch(q > 0 ? 6 : pe, time, fade);
    const mo = applyArray(q);

    // camera: a slow orbit with the story, closer while building, wider for the pattern, side-on for the array
    const a = camHow(q > 0 ? 6 : pe);
    const sway = calm ? 0 : 10 * Math.sin(time / 7000) * (1 - ease(seg(hp, 0, 0.4)));
    const c = {
      az: lerp(a.az + sway, CAM_ARRAY.az, mo), el: lerp(a.el, CAM_ARRAY.el, mo),
      dist: lerp(a.dist, CAM_ARRAY.dist, mo), lz: lerp(a.lz, CAM_ARRAY.lz, mo),
    };
    // portrait screens: step back so the board fits the width, and look along the long array a little
    const portrait = camera.aspect < 1;
    if (portrait) c.az += -22 * mo;
    const az = c.az * (Math.PI / 180) + (calm ? 0 : Math.sin(time / 9000) * 0.05);
    const el = c.el * (Math.PI / 180);
    const dist = c.dist * (portrait ? Math.pow(1 / camera.aspect, lerp(0.5, 0.8, mo)) : 1);
    camera.position.set(dist * Math.cos(el) * Math.cos(az), dist * Math.cos(el) * Math.sin(az), dist * Math.sin(el));
    camera.up.set(0, 0, 1);
    camera.lookAt(new Vector3(0, 0, c.lz));
  }
  function frame(time) {
    if (visible && !document.hidden) {
      layout();
      apply(time);
      renderer.render(scene, camera);
    }
    requestAnimationFrame(frame);
  }
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(journey);
  requestAnimationFrame(frame);
}
