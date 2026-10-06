import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
// "Render with Blender" client: the job request (geometry, parts, ports in metres), the progress/cancel/failure flow against a
// stubbed server, the state kept outside the panel, and the Blender path setting. (The server and Blender side: python/tests/test_blender_render.py.)
globalThis.FileReader = class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.(); }); }
};
const { blenderParts, blenderPorts, buildBlenderRequest, renderWithBlender, progressFromJob, blenderFileUrl, detectBlender } = await import("../src/render/blender.ts");
const store = await import("../src/render/blenderStore.ts");
const settings = await import("../src/lib/generalSettings.ts");

const box = (a, b) => ({ kind: "box", start: a, stop: b, bbox: [a, b], exact: true, priority: 1 });
const bundle = {
  model: { id: "Patch antenna/v2", name: "Patch" }, units: { length: "mm", length_m: 0.001 },
  parts: [
    { name: "substrate", type: "Material", primitives: [box([-30, -30, 0], [30, 30, 1.5])], material: { eps_r: 3.38 } },
    { name: "gnd", type: "Metal", primitives: [box([-30, -30, 0], [30, 30, 0])] },
    { name: "patch", type: "Metal", color: "#ffd700", primitives: [box([-16, -20, 1.5], [16, 20, 1.5])] },
    { name: "cut", type: "Material", void: true, primitives: [box([0, 0, 0], [1, 1, 1])] },
  ],
  ports: [{ number: 1, type: "lumped", R: 50, direction: "z", start: [-6, 0, 0], stop: [-6, 0, 1.5], excite: true }],
  lumped_elements: [{ name: "R1", label: "R1", type: "resistor", R: 100, direction: "x", start: [0, 0, 1.5], stop: [1, 0, 1.5] }],
};
const design = {
  schema: "fairbeam.design/1", model: { id: "patch", name: "Patch" },
  materials: [{ name: "FR4", kind: "dielectric", library: "fr4" }, { name: "copper", kind: "metal" }],
  parts: [
    { name: "substrate", material: "FR4", primitives: [], component: "board" },
    { name: "gnd", material: "copper", primitives: [] },
    { name: "patch", material: "copper", color: "#B87333", primitives: [] },
  ],
};
const options = { angles: ["iso", "top"], width: 800, height: 500, background: "studio", ports: "auto", solderMask: "none", groundShadow: true, projection: "perspective", engine: "app", quality: "preview" };

// parts, ports
const parts = blenderParts(bundle, design);
assert.deepEqual(parts.map(p => [p.name, p.kind]), [["substrate", "dielectric"], ["gnd", "metal"], ["patch", "metal"], ["cut", "void"]]);
assert.equal(parts[0].material, "FR4");
assert.equal(parts[0].library, "fr4");
assert.equal(parts[0].eps_r, 3.38);
assert.equal(parts[2].color, "#B87333", "the design's colour override wins");
assert.equal(blenderParts(bundle, null)[2].color, "#ffd700");
const { ports, lumped } = blenderPorts(bundle);
assert.deepEqual(ports[0].start, [-0.006, 0, 0]);
assert.ok(Math.abs(ports[0].stop[2] - 0.0015) < 1e-12);
assert.equal(lumped[0].R, 100);
assert.ok(Math.abs(lumped[0].stop[0] - 0.001) < 1e-12);

// the request
const request = await buildBlenderRequest(options, design, bundle, { device: "cpu", blenderPath: "C:\\Blender\\blender.exe" });
assert.equal(request.design_id, "patch", "named after the design");
assert.equal((await buildBlenderRequest(options, null, bundle)).design_id, "Patch_antenna_v2", "a bundle without a design: a safe file-name id");
assert.equal(request.options.engine, "blender");
assert.equal(request.save_blend, true);
assert.equal(request.device, "cpu");
assert.equal(request.blender, "C:\\Blender\\blender.exe");
const glb = Buffer.from(request.glb_base64, "base64");
assert.equal(glb.subarray(0, 4).toString(), "glTF");
const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
assert.equal(json.meshes.length, 3, "voids are not exported");
assert.ok(json.nodes.some(n => n.extras?.component === "patch"), "the part name travels in the node extras: the script's key");

// a stubbed server
let calls = [];
function serve(script) {
  calls = [];
  let polls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${url}`);
    const reply = (status, body) => new Response(JSON.stringify(body), { status });
    if (url === "/api/render-jobs" && method === "POST") return reply(201, script.created);
    if (/\/cancel$/.test(url)) { script.cancelled = true; return reply(202, {}); }
    if (/^\/api\/render-jobs\/rb-/.test(url)) { const step = script.steps[Math.min(polls++, script.steps.length - 1)]; return reply(200, script.cancelled && script.onCancel ? script.onCancel : step); }
    if (url.startsWith("/api/blender")) return reply(200, { found: true, ok: true, path: "x", download_url: "" });
    return reply(404, { error: "no route" });
  };
}
const job = (over) => ({ id: "rb-1", design: "patch", status: "running", stage: "rendering", progress: 0.1, angle_index: 1, angle_count: 2, angle: "iso", sample: 4, samples: 32,
  device: "optix:RTX", note: "", images: [], blend: null, folder: "C:\\ws\\renders\\patch", error: null, elapsed_s: 1, image_seconds: [], blender: { version: "4.2.3" }, ...over });
const img = (i, name) => ({ index: i, angle: name, name: `patch_${name}.png`, path: `C:\\x\\patch_${name}.png`, seconds: 2.5, url: `/api/renders/patch/file/patch_${name}.png` });
const real = globalThis.fetch;
const done = job({ status: "done", stage: "done", progress: 1, images: [img(1, "iso"), img(2, "top")], blend: "patch.blend", image_seconds: [2.5, 2.5], elapsed_s: 6 });
serve({ created: job({ status: "queued", stage: "starting", progress: 0 }), steps: [job(), job({ progress: 0.5, images: [img(1, "iso")], angle_index: 2, angle: "top" }), done] });
const seen = [];
const run = renderWithBlender(options, design, { bundle, onProgress: p => seen.push(p) });
const result = await run.result;
assert.equal(result.status, "done");
assert.equal(result.images.length, 2);
assert.deepEqual(seen.map(p => p.status), ["queued", "running", "running", "done"]);
assert.deepEqual(seen.map(p => p.progress), [0, 0.1, 0.5, 1]);
assert.equal(seen[1].angleIndex, 1);
assert.equal(seen[1].samples, 32);
assert.equal(seen[2].images[0].url, "/api/renders/patch/file/patch_iso.png");
assert.equal(result.blend, "patch.blend");
assert.ok(calls[0].startsWith("POST /api/render-jobs"));
assert.equal(blenderFileUrl("a b", "c.png"), "/api/renders/a%20b/file/c.png");
assert.equal(progressFromJob(job({ elapsed_s: 3.5 })).elapsedS, 3.5);

// cancel: the server is told, the promise resolves with the cancelled job (never rejects)
serve({ created: job(), steps: [job()], onCancel: job({ status: "cancelled", stage: "rendering" }) });
const cancelling = renderWithBlender(options, design, { bundle });
await new Promise(r => setTimeout(r, 50));
await cancelling.cancel();
assert.equal((await cancelling.result).status, "cancelled");
assert.ok(calls.some(c => c === "POST /api/render-jobs/rb-1/cancel"));

// a failed render rejects with the server's message
serve({ created: job(), steps: [job({ status: "failed", error: "RuntimeError: no mesh" })] });
await assert.rejects(renderWithBlender(options, design, { bundle }).result, /no mesh/);
// a refused start (no Blender) surfaces the server's sentence
globalThis.fetch = async () => new Response(JSON.stringify({ error: "Blender was not found. Install Blender from blender.org or set its path in Settings." }), { status: 409 });
await assert.rejects(renderWithBlender(options, design, { bundle }).result, /blender\.org/);

// the state outside the panel
serve({ created: job({ status: "queued" }), steps: [job(), done] });
assert.equal(store.blenderProgress(), null);
const finished = store.startBlenderRender(options, design, { bundle });
await new Promise(r => setTimeout(r, 30));
assert.equal(store.blenderBusy(), true, "busy while the render runs");
await store.startBlenderRender(options, design, { bundle });          // a second start while busy is ignored
assert.equal(calls.filter(c => c === "POST /api/render-jobs").length, 1);
await finished;
assert.equal(store.blenderBusy(), false);
assert.equal(store.blenderProgress().status, "done");
assert.equal(store.blenderProgress().images.length, 2, "kept after the panel is gone");
globalThis.fetch = async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 });
await store.startBlenderRender(options, design, { bundle });
assert.equal(store.blenderFailure(), "boom");
assert.equal(store.blenderBusy(), false);
serve({ created: job(), steps: [job()] });
assert.equal((await detectBlender("C:\\b\\blender.exe")).ok, true);
assert.equal(calls.at(-1), "GET /api/blender?path=C%3A%5Cb%5Cblender.exe");
globalThis.fetch = real;

// the Blender path setting
assert.equal(settings.GENERAL_DEFAULTS.blenderPath, "");
const mem = new Map();
const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
settings.writeGeneralSettings({ ...settings.GENERAL_DEFAULTS, blenderPath: "D:\\Apps\\Blender\\blender.exe" }, storage);
assert.equal(settings.readGeneralSettings(storage).blenderPath, "D:\\Apps\\Blender\\blender.exe");
mem.set(settings.GENERAL_SETTINGS_KEY, JSON.stringify({ blenderPath: 5, units: "compact" }));
const recovered = settings.readGeneralSettings(storage);
assert.equal(recovered.blenderPath, "", "a malformed path falls back to automatic detection");
assert.equal(recovered.units, "compact", "without losing the other settings");
assert.throws(() => settings.writeGeneralSettings({ ...settings.GENERAL_DEFAULTS, blenderPath: 5 }, storage), /Invalid/);

// the dialog's RenderOptions become the server's: quality mapped, the live camera as a direction, the folder id shared with the app renderer
{
  const { toBlenderOptions, blenderQualityFor, blenderEngine } = await import("../src/render/blender.ts");
  const { renderFolderId } = await import("../src/render/options.ts");
  const app = { angles: ["iso", "current"], width: 640, height: 400, background: "transparent", ports: "connector", solderMask: "green", groundShadow: false, projection: "orthographic", engine: "app", quality: "high" };
  const view = { position: [10, -10, 8], target: [0, 0, 2], up: [0, 0, 1], fov: 32 };
  const wire = toBlenderOptions(app, "preview", view);
  assert.equal(wire.engine, "blender");
  assert.equal(wire.quality, "preview");
  assert.deepEqual(wire.angles, ["iso", { name: "current", direction: [10, -10, 6], up: [0, 0, 1] }]);
  assert.deepEqual([wire.width, wire.height, wire.background, wire.ports, wire.solderMask, wire.groundShadow, wire.projection], [640, 400, "transparent", "connector", "green", false, "orthographic"]);
  assert.equal(toBlenderOptions(app).quality, "final", "high maps to final");
  assert.equal(blenderQualityFor("standard"), "preview");
  assert.deepEqual(toBlenderOptions(app, "final", null).angles, ["iso", "current"], "no camera: the server draws iso");
  const req = await buildBlenderRequest(app, design, bundle, { designId: "My Patch v2", quality: "final", view });
  assert.equal(req.design_id, renderFolderId("My Patch v2"), "the same folder id as the in-app renderer");
  assert.equal(req.options.quality, "final");
  assert.equal(typeof blenderEngine.render, "function", "blenderEngine implements BlenderEngine");
}

// the Blender look table is the in-app one: same colours, roughness, metallic and coat for every material class
{
  const { MATERIAL_LOOKS } = await import("../src/render/materials.ts");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const win = process.platform === "win32";
  const venv = win ? join(root, ".venv", "Scripts", "python.exe") : join(homedir(), "opt/openEMS/venv/bin/python");
  const python = process.env.FAIRBEAM_PYTHON ?? (existsSync(venv) ? venv : win ? "python" : "python3");
  // read as data, not imported: blender_render.py runs inside Blender and the package import needs the solver
  const table = JSON.parse(execFileSync(python, ["-c",
    "import ast,json,pathlib,sys; tree=ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')); print(json.dumps(next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='LOOK_TABLE' for t in n.targets))))",
    join(root, "python/fairbeam/blender_render.py")]).toString());
  assert.deepEqual(Object.keys(table).sort(), Object.keys(MATERIAL_LOOKS).sort(), "the same material classes in both renderers");
  for (const [id, look] of Object.entries(MATERIAL_LOOKS)) {
    const [colour, roughness, metallic, coat, coatRoughness] = table[id];
    assert.deepEqual([colour.toLowerCase(), roughness, metallic, coat, coat ? coatRoughness : 0],
      [look.baseColor.toLowerCase(), look.roughness, look.metallic, look.coat, look.coat ? look.coatRoughness : 0], `${id}: the Blender look equals the in-app look`);
  }
}

console.log("Blender render client: request, progress, cancel, failure, kept state and path setting pass");
