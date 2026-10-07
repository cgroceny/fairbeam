// Design checks in the UI language (src/designer/checkText.ts): the checks stay English on both
// sides (python/fairbeam/design_checks.py, src/designer/checks.ts) and are translated at display
// time by their code.
//
//   node --experimental-strip-types scripts/check-check-text.mjs
//
// 1. English: checkMessage / checkExplain / checkFixLabel give every check's own text unchanged,
//    for every check of the shared cases (python/tests/fixtures/designer_parity.json) on both sides.
// 2. Every `checks.explain.<code>` English is Python's EXPLANATIONS[code] exactly, and every Python
//    code has one (a key for a code Python lacks is a template with a {value}).
// 3. Turkish: every message template round-trips (the English template filled with the captured
//    values is the message again) and leaves no {placeholder}; the fixture's messages and a set of
//    server-only samples are counted (translated / total), the samples also against exact texts.
// Python as scripts/check-designer.mjs finds it ($FAIRBEAM_PYTHON, the openEMS venv, python3).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setLanguage } from "../src/i18n/index.ts";
import { designChecks } from "../src/designer/checks.ts";
import { checkExplain, checkFixLabel, checkMessage, checkTemplateEnglish, matchCheckMessage } from "../src/designer/checkText.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
let failures = 0;
const check = (cond, where, msg) => {
  checks++;
  if (!cond) {
    failures++;
    console.error(`  FAIL ${where}: ${msg}`);
  }
};

const win = process.platform === "win32";
const venv = win ? join(root, ".venv", "Scripts", "python.exe") : join(homedir(), "opt/openEMS/venv/bin/python");
const python = process.env.FAIRBEAM_PYTHON ?? (existsSync(venv) ? venv : win ? "python" : "python3");
const py = JSON.parse(execFileSync(python, [join(root, "python/tests/designer_fixture.py")], {
  env: { ...process.env, PYTHONPATH: [join(root, "python"), join(root, "python/tests")].join(delimiter) },
  maxBuffer: 64 << 20,
}).toString());
const explanations = JSON.parse(execFileSync(python, ["-c",
  "import ast,json,pathlib,sys; tree=ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')); print(json.dumps(next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='EXPLANATIONS' for t in n.targets))))",
  join(root, "python/fairbeam/design_checks.py")]).toString());
const en = JSON.parse(readFileSync(join(root, "src/i18n/en.json"), "utf8"));
const tr = JSON.parse(readFileSync(join(root, "src/i18n/tr.json"), "utf8"));

// every check of the shared cases, from TypeScript and from Python
const all = [];
py.cases.forEach((c) => {
  for (const k of designChecks(c.design)) all.push({ side: "TypeScript", name: c.name, c: k });
  for (const k of c.checks) all.push({ side: "Python", name: c.name, c: k });
});

// server-only messages the cases do not produce: [code, message, exact Turkish or null]
const SAMPLES = [
  ["metal-floating", "'patch' touches no other metal, no dielectric and no port: it floats 0.5 mm off 'substrate', on its x+ side (an isolated conductor in the air)",
    "'patch' başka hiçbir metale, dielektriğe ya da porta değmiyor: 'substrate' katısının x+ tarafında, ondan 0,5 mm uzakta duruyor (havada yalıtılmış bir iletken)"],
  ["metal-floating", "the connected metal 'a', 'b' touches no other metal, no dielectric and no port: it is a solid 1.5 × 2 × 3 mm block isolated in the air",
    "birbirine bağlı metal 'a', 'b' başka hiçbir metale, dielektriğe ya da porta değmiyor: havada yalıtılmış, 1,5 × 2 × 3 mm'lik dolu bir blok"],
  ["metal-floating", "'patch' touches no other metal, no dielectric and no port: it lies in the plane of the z+ face of 'substrate' (z = 1.524) but 2.5 mm past its x- edge", null],
  ["metal-overhang", "'patch' overhangs 'substrate' by 1.2 mm (x+) and 0.5 mm (y-): the metal lies on the dielectric's face but reaches past its edge into the air",
    "'patch', 'substrate' kenarını 1,2 mm (x+) ve 0,5 mm (y-) aşıyor: metal dielektriğin yüzünde duruyor ama kenarından havaya taşıyor"],
  ["metal-overhang", "'patch' overhangs 'substrate' by 3 mm (x+) and 1.2 mm (y-) and 0.5 mm (y+): the metal lies on the dielectric's face but reaches past its edge into the air", null],
  ["thin-metal", "'patch': 35 µm metal is modeled as a sheet at z = 1.524 (on its z-min face): thinner than the mesh can resolve, so its thickness would only shrink the timestep", null],
  ["thin-metal", "'gnd': 17.5 µm metal is modeled as a sheet at z = 0 (in its middle): thinner than the mesh can resolve, so its thickness would only shrink the timestep", null],
  ["air-pad", "the air padding is 10 mm, under half of λ/4 at f min (51 mm at 1.47 GHz): the open boundaries and the far-field box sit close to the structure",
    "hava payı 10 mm, f min'de λ/4 değerinin (1,47 GHz'de 51 mm) yarısından az: açık sınırlar ve uzak alan kutusu yapıya çok yakın"],
  ["port-in-metal", "the stop end of port 1 reaches into 'patch': the metal covers part of the port and shorts it there. A lumped port spans the gap between two conductors, from the face of one to the face of the other", null],
  ["port-in-metal", "port 2 runs through 'gnd': metal across its middle shorts it. A lumped port spans the gap between two conductors, from the face of one to the face of the other", null],
  ["port-at-null", "port 1 feeds 'patch' at its center. If this is a resonant patch, a center feed can sit near the voltage null of a fundamental mode and couple poorly. Consider moving it along the resonant length; 0.15 × that length off center is a starting point to tune, not a guaranteed 50 Ω feed.", null],
  ["cut-unsupported", "the cut overlaps primitives[1] (a brick with thickness at the cut's plane): a cut removes area from flat sheets (a zero-thickness brick, a polygon or a flat circle in the cut's plane), not from a solid; make that shape a sheet or subtract it with a Boolean",
    "kesim primitives[1] ile çakışıyor (kutu, kesim düzleminde kalınlığı olan bir şekil): kesim düz levhalardan (sıfır kalınlıklı kutu, çokgen ya da düz daire) alan çıkarır, katıdan çıkarmaz; o şekli levha yapın ya da Boolean ile çıkarın"],
  ["cut-unsupported", "the cut overlaps primitives[0] (a cylinder with thickness at the cut's plane): a cut removes area from flat sheets (a zero-thickness brick, a polygon or a flat circle in the cut's plane), not from a solid; make that shape a sheet or subtract it with a Boolean", null],
  ["cut-unused", "the cut touches no flat sheet of 'patch' in its plane (z = 1.6): it removes nothing", null],
  ["cut-all", "the cuts remove this whole sheet", null],
  ["mesh-cells", "the mesh has 45.2 M cells, over the server limit of 40 M cells: coarsen it or lower f max",
    "mesh 45,2 M hücreli, sunucunun 40 M hücre sınırının üzerinde: mesh'i kabalaştırın ya da f max'ı düşürün"],
  ["mesh-cells", "the mesh has 667.5 M cells, over the server limit of 40 M cells: lower f max (cells of 0.018 mm at 240 GHz): f max / f min = 143 is a very wide band; narrow it to the frequencies you need",
    "mesh 667,5 M hücreli, sunucunun 40 M hücre sınırının üzerinde: f max'ı düşürün (240 GHz'de 0,018 mm'lik hücreler): f max / f min = 143 çok geniş bir bant; bandı ihtiyacınız olan frekanslara daraltın"],
  ["mesh-cells", "the mesh has 41.0 M cells, over the server limit of 40 M cells: lower f max or the cells per wavelength (cells of 0.05 mm at 30 GHz)",
    "mesh 41,0 M hücreli, sunucunun 40 M hücre sınırının üzerinde: f max'ı ya da dalga boyu başına hücreyi düşürün (30 GHz'de 0,05 mm'lik hücreler)"],
  ["mesh-cells", "the mesh has 22.0 M cells: a long run and several GB of memory; the domain (300 × 300 × 250 mm) is mostly air: the open boundaries sit a quarter wavelength at f min (75 mm at 1 GHz) from the model on every side. Raise f min, or set a smaller distance under Simulation settings › Boundaries (Open, add space)", null],
  ["mesh-cells", "the mesh has 22.0 M cells: a long run and several GB of memory; the domain (300 × 300 × 250 mm) is mostly air: reduce the open boundaries' distance (mesh.pad) or coarsen the mesh", null],
  ["mesh-cells", "the mesh has 21.5 M cells: a long run and several GB of memory", null],
  ["mesh-warning", "automatic mesh: a gap of 0.01 mm between lines", null],
  ["excitation-too-long", "the excitation pulse alone takes about 61,234 timesteps (1.23 ns at a timestep of 20.1 fs, set by the smallest cell (0.01 mm)), more than max timesteps (60,000): the run stops before the fields can decay and cannot converge. To fix: model thin metal as sheets, coarsen the finest detail, or raise max timesteps",
    "uyarım darbesi tek başına yaklaşık 61.234 zaman adımı sürüyor (1,23 ns, en küçük hücrenin (0,01 mm) belirlediği 20,1 fs zaman adımıyla), bu da en fazla zaman adımından (60.000) fazla: çalıştırma alanlar sönümlenmeden durur ve yakınsayamaz. Çözüm: ince metali levha olarak modelleyin, en ince ayrıntıyı kabalaştırın ya da en fazla zaman adımını artırın"],
  ["excitation-too-long", "the excitation pulse alone takes about 61,234 timesteps (1.81 ns at a timestep of 1.18 ps, set by the smallest cell (0.5 mm)), more than max timesteps (60,000): the run stops before the fields can decay and cannot converge. To fix: model thin metal as sheets, coarsen the finest detail, or raise max timesteps",
    "uyarım darbesi tek başına yaklaşık 61.234 zaman adımı sürüyor (1,81 ns, en küçük hücrenin (0,5 mm) belirlediği 1,18 ps zaman adımıyla), bu da en fazla zaman adımından (60.000) fazla: çalıştırma alanlar sönümlenmeden durur ve yakınsayamaz. Çözüm: ince metali levha olarak modelleyin, en ince ayrıntıyı kabalaştırın ya da en fazla zaman adımını artırın"],
  ["excitation-too-long", "the excitation pulse alone takes about 35,000 of the 60,000 timesteps (1.23 ns at a timestep of 35.1 fs), which leaves little time for the fields to decay: the run may stop before it converges. To fix: model thin metal as sheets, coarsen the finest detail, or raise max timesteps", null],
  ["thin-metal-volume", "'ground': 35 µm metal is modeled as a sheet at z = -1.6 (on its z-max face) although mesh › thin metal is \"volume\": cells across it would make the timestep about 52x smaller (a run of many minutes that may never converge). The sheet keeps the drawn thickness for the losses and the exports",
    "'ground': 35 µm metal, z = −1,6 konumunda levha olarak modelleniyor (z-max yüzünde); mesh › ince metal \"volume\" olsa da: içine hücre koymak zaman adımını yaklaşık 52 kat küçültürdü (dakikalarca süren, belki hiç bitmeyen bir çalıştırma). Levha, kayıplar ve dışa aktarımlar için çizilen kalınlığı korur"],
  ["slow-ringdown", "'substrate': a 0.254 mm substrate (εr 2.2, tan δ 0.0009) is a high-Q cavity (Q about 68): the fields ring for about 50.5 ns after the pulse, which is about 309,288 timesteps at this mesh, more than the 60,000 the run may take, so it may stop before it converges. Running to 400,000 timesteps takes roughly 4 min on a CPU",
    "'substrate': 0,254 mm'lik alttaş (εr 2,2, tan δ 0,0009) yüksek Q'lu bir boşluktur (Q yaklaşık 68): alanlar darbeden sonra yaklaşık 50,5 ns çınlar; bu bu meshte yaklaşık 309.288 zaman adımı eder ve çalıştırmanın alabileceği 60.000 adımdan fazladır, bu yüzden yakınsamadan durabilir. 400.000 zaman adımına kadar çalıştırmak CPU'da kabaca 4 dk sürer"],
  ["run-too-long", "this run would need about 233,727 timesteps (the 1.81 ns excitation pulse and its decay at a timestep of 31 fs, set by the smallest cell (0.0117 mm)) on 1.56 M cells: roughly 24 min on a CPU, more than the run budget. To fix: model thin metal as sheets or coarsen the finest detail",
    "bu çalıştırma yaklaşık 233.727 zaman adımı isterdi (en küçük hücrenin (0,0117 mm) belirlediği 31 fs zaman adımıyla uyarım darbesi (1,81 ns) ve sönümlenmesi), 1,56 M hücrede: CPU'da kabaca 24 dk, çalıştırma bütçesinden fazla. Çözüm: ince metali levha olarak modelleyin ya da en ince ayrıntıyı kabalaştırın"],
  ["run-too-long", "this run would need about 233,727 timesteps (the 1.81 ns excitation pulse and its decay at a timestep of 31 fs) on 1.56 M cells: roughly 1.4 h on a CPU, more than the run budget. To fix: model thin metal as sheets or coarsen the finest detail", null],
  ["smallest-cell", "the smallest cell, 0.0116 mm along z at z = 0.0117, comes from 'ground': 35 µm metal kept as a volume",
    "en küçük hücre, z ekseninde 0,0117 konumunda 0,0116 mm: 'ground' parçasından geliyor, 35 µm kalınlıkta hacim olarak tutulan metal"],
  ["smallest-cell", "the smallest cell, 0.05 mm along x at x = 24.1, comes from 'substrate': 50 µm material", null],
  ["smallest-cell", "the smallest cell is 0.0117 mm along y at y = -3.2", null],
  ["mesh-feature", "a feature 0.035 mm thick along z falls between mesh lines: the automatic mesh cannot resolve it and FDTD drops it (make it thicker or a sheet, or raise cells per wavelength)", null],
  ["wire-thin", "the wire's radius (0.1 mm) is below the mesh cell across it (0.5 mm): FDTD sees a line of cell edges whose effective radius is set by the mesh, not by the radius (raise the radius or refine the mesh)", null],
  ["field-plane-position", "z = 90 mm is outside the simulation domain (-40.00 to 45.50 mm): the plane would be recorded at the domain's edge", null],
  ["monitor-band", "4.9 GHz is outside the simulated band 1.47–3.185 GHz", "4,9 GHz, simüle edilen 1,47–3,185 GHz bandının dışında"],
  ["build", "does not build: the radius must be > 0", "oluşturulamıyor: yarıçap > 0 olmalı"],
  ["expr", "unknown name 'nope' in 'L/2 + nope'", "'L/2 + nope' içinde bilinmeyen ad: 'nope'"],
  ["expr", "unexpected ','", "beklenmeyen ',': ondalık ayracı olarak nokta yazın (2.45)"],
  ["expr", "sqrt() takes 1 argument(s)", null],
  ["expr", "sqrt is a function: sqrt(...)", null],
  ["expr", "'0x10': write plain decimal numbers (no 0x.., 0b.., 1_000)", null],
  ["preview_unavailable", "Server checks unavailable: the preview failed", null],
];
// fix buttons: [code, English label, exact Turkish label, template key]
const FIXES = [
  ["port-at-null", "Move the feed to x = -4.5 mm (0.15 × the 30 mm side off the center)", "Beslemeyi x = −4,5 mm konumuna taşı (merkezden 30 mm'lik kenarın 0,15 katı)", "checks.fix.port-at-null.move"],
  ["excitation-too-long", "Set max timesteps to 160,000", "En fazla zaman adımını 160.000 yap", "checks.fix.excitation-too-long.set"],
  ["slow-ringdown", "Set max timesteps to 400,000", "En fazla zaman adımını 400.000 yap", "checks.fix.slow-ringdown.set"],
  ["run-too-long", "Model 35 µm metal as sheets", "35 µm metali levha olarak modelle", "checks.fix.run-too-long.sheets"],
  ["excitation-too-long", "Model 17.5 µm metal as sheets", "17,5 µm metali levha olarak modelle", "checks.fix.excitation-too-long.sheets"],
  ["tan-d-band", "Give tan δ at f0", "tan δ'yı f0 frekansında ver", "checks.fix.tan-d-band.f0"],
  ["tan-d-band", "Give tan δ at the band center (2.25 GHz)", "tan δ'yı bant ortasında ver (2,25 GHz)", "checks.fix.tan-d-band.centre"],
  ["port-in-metal", "Move the end onto the face of 'gnd' (z = 0 mm)", "Ucu 'gnd' yüzüne taşı (z = 0 mm)", "checks.fix.port-in-metal.face"],
  ["port-floating", "Move the end onto the nearest metal face ('patch', z = 1.524 mm)", "Ucu en yakın metal yüzeyine taşı ('patch', z = 1,524 mm)", "checks.fix.port-floating.snap"],
  ["no-port", "Add a probe port between 'gnd' and 'patch'", "'gnd' ile 'patch' arasına bir sonda portu ekle", "checks.fix.no-port.probe"],
  ["metal-overhang", "Trim the metal to 'substrate'", "Metali 'substrate' sınırlarına kırp", "checks.fix.metal-overhang.trim"],
  ["air-pad", "Set the air padding to λ/4 (51 mm)", "Hava payını λ/4 yap (51 mm)", "checks.fix.air-pad.quarter"],
  ["air-pad", "Set the air padding to λ/8 (25.5 mm)", "Hava payını λ/8 yap (25,5 mm)", "checks.fix.air-pad.eighth"],
];
const PREVIEW_EXPLAIN = "The run server is not reachable. The mesh numbers and the server's checks shown are from the last successful preview, not from this draft; the list only has the checks made in the browser. Retry the preview (status bar) once the server responds.";

// ---- 1. English: the checks' own texts
setLanguage("en");
for (const { side, name, c } of all) {
  const where = `${side} case '${name}' ${c.code}`;
  check(checkMessage(c) === c.message, where, `message changed in English: ${JSON.stringify(checkMessage(c))}`);
  check(c.explain !== undefined && checkExplain(c) === c.explain, where, "explanation changed in English");
  if (c.fix) check(checkFixLabel(c) === c.fix.label, where, "fix label changed in English");
}
for (const [code, message] of SAMPLES) check(checkMessage({ code, message }) === message, `sample ${code}`, "message changed in English");
for (const [code, label] of FIXES) check(checkFixLabel({ code, fix: { label, set: {} } }) === label, `fix sample ${code}`, "changed in English");
check(checkExplain({ code: "x", explain: undefined }) === en["checks.explainFallback"], "fallback", "no explanation: the general hint");

// ---- 2. explanations: the English is Python's
for (const [code, text] of Object.entries(explanations)) {
  const key = `checks.explain.${code}`;
  check(en[key] === text, key, en[key] === undefined ? "missing (Python has this code)" : "English differs from Python's EXPLANATIONS");
}
for (const key of Object.keys(en).filter((k) => k.startsWith("checks.explain."))) {
  const code = key.slice("checks.explain.".length);
  if (!(code in explanations)) check(/\{\w+\}/.test(en[key]), key, "a code Python lacks: expected a template with a {value}");
}

// ---- 3. Turkish: templates round-trip; count what is translated
setLanguage("tr");
const placeholder = /\{\w+\}/;
const counted = new Map();
const used = new Set();
const tryMessage = (code, message, where) => {
  const m = matchCheckMessage({ code, message });
  const out = checkMessage({ code, message });
  if (m) {
    used.add(m.key);
    check(checkTemplateEnglish(m.key, m.params) === message, where, `template ${m.key} does not round-trip: ${JSON.stringify(m.params)}`);
    check(!placeholder.test(out) || placeholder.test(message), where, `unfilled placeholder in ${JSON.stringify(out)}`);
    check(tr[m.key] !== undefined, where, `${m.key} has no Turkish`);
  }
  return { matched: !!m, out };
};
for (const { side, c } of all) {
  const id = `${c.code}|${c.message}`;
  if (counted.has(id)) continue;
  const r = tryMessage(c.code, c.message, `${side} ${c.code}: ${c.message}`);
  counted.set(id, r.matched);
  check(checkExplain(c) === tr[`checks.explain.${c.code}`], `${side} ${c.code}`, "explanation not shown in Turkish");
}
let samplesDone = 0;
for (const [code, message, want] of SAMPLES) {
  const r = tryMessage(code, message, `sample ${code}`);
  if (r.matched) samplesDone++;
  check(r.matched, `sample ${code}`, `no template matches ${JSON.stringify(message)}`);
  if (want !== null) check(r.out === want, `sample ${code}`, `Turkish is ${JSON.stringify(r.out)}, expected ${JSON.stringify(want)}`);
}
for (const [code, label, want, key] of FIXES) {
  const got = checkFixLabel({ code, fix: { label, set: {} } });
  check(got === want, `fix sample ${code}`, `Turkish is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  used.add(key);
}
// every button of the shared cases, from either side, is translated (no template left out)
for (const { side, c } of all) {
  if (!c.fix) continue;
  const got = checkFixLabel(c);
  check(got !== c.fix.label, `${side} ${c.code} fix`, `label not translated in Turkish: ${JSON.stringify(c.fix.label)}`);
}
const pe = checkExplain({ code: "preview_unavailable", explain: PREVIEW_EXPLAIN });
check(pe.startsWith("The run server is not reachable. ") && pe !== PREVIEW_EXPLAIN && !placeholder.test(pe), "preview_unavailable", `explanation: ${JSON.stringify(pe)}`);
// a server wording fairbeam does not know stays English, also in Turkish
check(checkMessage({ code: "radius", message: "the radius must be positive" }) === "the radius must be positive", "unknown wording", "must stay as it is");
check(checkExplain({ code: "radius", explain: "Another text." }) === "Another text.", "unknown explanation", "must stay as it is");
setLanguage("en");

const translated = [...counted.values()].filter(Boolean).length;
const untranslated = [...counted.entries()].filter(([, ok]) => !ok).map(([id]) => id);
if (untranslated.length) console.log(`  not translated (English shown):\n    ${untranslated.join("\n    ")}`);
const templates = Object.keys(en).filter((k) => /^checks\.(msg|sub|fix)\./.test(k));
const unused = templates.filter((k) => !used.has(k) && !k.startsWith("checks.sub."));
if (unused.length) console.log(`  templates no case or sample exercises: ${unused.length}`);
console.log(`check-check-text: ${checks} checks, ${failures} failed; fixture messages translated ${translated}/${counted.size}, samples ${samplesDone}/${SAMPLES.length}; ${templates.length} templates`);
process.exit(failures ? 1 : 0);
