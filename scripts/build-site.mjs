#!/usr/bin/env node
// Build the public static site into site-dist/:
//   /           the site pages from landing/*: index.html (the home page), features.html,
//               roadmap.html (its board rendered from landing/roadmap.json by
//               scripts/roadmap-render.mjs), docs/, guide.html (the public copy of
//               docs/GETTING-STARTED.md) and privacy.html, with design-system/tokens.css copied
//               next to them
//   /app/       the viewer in demo mode (vite --mode demo, base /app/, bundled example projects)
//   /media/     example drawings and figures from examples/drawings/, landing/media/ and the
//               story data (media/patch-story.json, reduced from public/projects/patch-antenna.json)
//   /story/     the scroll story (landing-src/story.js bundled with three.js)
//   /fonts/     IBM Plex woff2 files from @fontsource (already in node_modules)
// Usage: npm run build:site   (type-checks first). Serve locally: python3 -m http.server -d site-dist 5330
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { renderRoadmap } from "./roadmap-render.mjs";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const out = resolve(root, "site-dist");

function pathIsWithin(base, target) {
  const rel = relative(base, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function resetBuildOutput() {
  if (!pathIsWithin(root, out) || out === root) {
    throw new Error(`Refusing to clear build output outside the repository: ${out}`);
  }
  let entry;
  try {
    entry = lstatSync(out);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (entry) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to recursively clear site-dist because it is a symlink or junction: ${out}`);
    }
    if (!entry.isDirectory()) {
      throw new Error(`Refusing to clear site-dist because it is not a directory: ${out}`);
    }
    const actual = realpathSync(out);
    if (!pathIsWithin(root, actual) || actual === root) {
      throw new Error(`Refusing to recursively clear site-dist resolved outside the repository: ${actual}`);
    }
    rmSync(actual, { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });
  const createdEntry = lstatSync(out);
  if (createdEntry.isSymbolicLink() || !createdEntry.isDirectory()) {
    throw new Error(`Build output must be a real directory, not a symlink or file: ${out}`);
  }
  const created = realpathSync(out);
  if (!pathIsWithin(root, created) || created === root) {
    throw new Error(`Build output resolved outside the repository: ${created}`);
  }
}

const MEDIA = [
  "wilkinson-divider_sparams_transmission.svg",
  "patch-antenna_A3.svg",
  "patch-antenna_s11.svg",
  "patch-antenna_pattern_2.453GHz.svg",
];
const FONTS = [
  ["ibm-plex-sans", "ibm-plex-sans-latin-400-normal.woff2"],
  ["ibm-plex-sans", "ibm-plex-sans-latin-ext-400-normal.woff2"],
  ["ibm-plex-sans", "ibm-plex-sans-latin-600-normal.woff2"],
  ["ibm-plex-mono", "ibm-plex-mono-latin-400-normal.woff2"],
];

// Validate publication inputs before clearing output or starting the slower build steps.
const roadmap = renderRoadmap(JSON.parse(readFileSync(join(root, "landing", "roadmap.json"), "utf8")));

resetBuildOutput();

// 1. demo app -> site-dist/app (base /app/, VITE_FAIRBEAM_DEMO=1 from .env.demo)
await build({ root, mode: "demo", logLevel: "warn", build: { outDir: join(out, "app"), emptyOutDir: true } });

// 2. landing page and the shared tokens (copied, not duplicated)
cpSync(join(root, "landing"), out, { recursive: true, filter: (src) => !src.endsWith(".md") && !src.endsWith("roadmap.json") });
cpSync(join(root, "design-system", "tokens.css"), join(out, "tokens.css"));
cpSync(join(root, "public", "favicon.svg"), join(out, "favicon.svg"));

// 2b. the roadmap board, rendered into its page at build time: no fetch, and it reads without JS
{
  const page = join(out, "roadmap.html");
  const html = readFileSync(page, "utf8");
  const slot = /<!-- roadmap:start[\s\S]*?<!-- roadmap:end -->/;
  if (!slot.test(html)) {
    console.error("build-site: landing/roadmap.html has no <!-- roadmap:start --> … <!-- roadmap:end --> slot");
    process.exit(1);
  }
  writeFileSync(page, html.replace(slot, () => roadmap));
}

// 3. media and fonts
mkdirSync(join(out, "media"), { recursive: true });
for (const f of MEDIA) cpSync(join(root, "examples", "drawings", f), join(out, "media", f));
mkdirSync(join(out, "fonts"), { recursive: true });
for (const [pkg, f] of FONTS) cpSync(join(root, "node_modules", "@fontsource", pkg, "files", f), join(out, "fonts", f));

// 3b. the scroll story: its data (the real patch-antenna simulation, reduced) and its bundle
{
  const b = JSON.parse(readFileSync(join(root, "public", "projects", "patch-antenna.json"), "utf8"));
  const part = (name) => b.parts.find((p) => p.name === name);
  const r = b.results;
  const pr = r.ports[String(b.ports[0].number)];
  const every = (a, n) => a.filter((_, i) => i % n === 0 || i === a.length - 1);
  const db = (i) => 10 * Math.log10(Math.max(1e-30, pr.s11_re[i] ** 2 + pr.s11_im[i] ** 2));
  // every 4th point, plus the true minimum so the story's marker shows the real resonance
  const kMin = [...r.frequency.keys()].reduce((a, i) => (db(i) < db(a) ? i : a), 0);
  const idx = [...new Set([...every([...r.frequency.keys()], 4), kMin])].sort((a, b) => a - b);
  const plane = b.fields.planes.find((pl) => pl.parts.includes("patch"));
  const ff = r.farfield[0];
  const story = {
    source: "public/projects/patch-antenna.json",
    parts: ["gnd", "substrate", "patch"].map((n) => ({ name: n, type: part(n).type, start: part(n).primitives[0].start, stop: part(n).primitives[0].stop })),
    port: { start: b.ports[0].start, stop: b.ports[0].stop },
    mesh: { x: b.mesh.x, y: b.mesh.y },
    current: { u_range: plane.u_range, v_range: plane.v_range, nu: plane.nu, nv: plane.nv, values: plane.frequencies[0].values },
    farfield: { f: ff.f, theta: ff.theta, phi: ff.phi, d: ff.directivity_dbi.map((row) => row.map((v) => Math.round(v * 100) / 100)), dmax: ff.dmax_dbi },
    s11: {
      f: idx.map((i) => r.frequency[i]),
      db: idx.map((i) => Math.round(db(i) * 100) / 100),
    },
  };
  writeFileSync(join(out, "media", "patch-story.json"), JSON.stringify(story));
  // the array chapter: the 4 × 1 patch array's boxes, ports, S-matrix at the pattern frequency and
  // its embedded element patterns (every other φ, re-encoded as int16 with one scale per port)
  {
    const a = JSON.parse(readFileSync(join(root, "public", "projects", "patch-array-4x1.json"), "utf8"));
    const ep = a.results.element_patterns;
    const [nt, np] = ep.shape;
    const f0 = ep.frequencies[0];
    const fr = a.results.frequency;
    const k0 = fr.reduce((best, f, i) => (Math.abs(f - f0) < Math.abs(fr[best] - f0) ? i : best), 0);
    const sp = a.results.sparams;
    const phiKeep = [...ep.phi.keys()].filter((j) => j % 2 === 0);
    const decode = (text, scale) => {
      const buf = Buffer.from(text, "base64");
      return Float64Array.from({ length: nt * np }, (_, i) => (buf.readInt16LE(i * 2) * scale) / 32767);
    };
    const ports = ep.ports.map((pt) => {
      const fs = pt.fields[0];
      const comps = ["e_theta_re", "e_theta_im", "e_phi_re", "e_phi_im"].map((c) => {
        const full = decode(fs[c], fs.scale);
        return Float64Array.from({ length: nt * phiKeep.length }, (_, i) => full[Math.floor(i / phiKeep.length) * np + phiKeep[i % phiKeep.length]]);
      });
      const scale = Math.max(...comps.map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
      const enc = (c) => {
        const buf = Buffer.alloc(c.length * 2);
        c.forEach((v, i) => buf.writeInt16LE(Math.round((v / scale) * 32767), i * 2));
        return buf.toString("base64");
      };
      return { port: pt.port, position: pt.position, scale, e: comps.map(enc) };
    });
    const arrayStory = {
      source: "public/projects/patch-array-4x1.json",
      f: f0,
      theta: ep.theta,
      phi: phiKeep.map((j) => ep.phi[j]),
      phase_center: ep.phase_center,
      parts: a.parts.flatMap((pt) => pt.primitives.map((pr) => ({ name: pt.name, type: pt.type, start: pr.start, stop: pr.stop }))),
      ports,
      s: sp.ports.map((i) => sp.ports.map((j) => {
        const c = sp.s[`${i},${j}`];
        return [Math.round(c.re[k0] * 1e5) / 1e5, Math.round(c.im[k0] * 1e5) / 1e5];
      })),
    };
    writeFileSync(join(out, "media", "array-story.json"), JSON.stringify(arrayStory));
  }
  await build({
    configFile: false, root, logLevel: "warn", publicDir: false,
    build: {
      outDir: join(out, "story"), emptyOutDir: true, target: "es2022", minify: true,
      lib: { entry: join(root, "landing-src", "story.js"), formats: ["es"], fileName: () => "story.js" },
    },
  });
}

// 4. sanity checks, size budgets and a size report
const PAGES = ["index.html", "features.html", "roadmap.html", "docs/index.html", "guide.html", "privacy.html"];
const must = [...PAGES, "styles.css", "tokens.css", "script.js", "language.js", "navigation.js", "navigation.css", "story/story.js", "media/patch-story.json", "media/array-story.json", "app/index.html", "app/projects/index.json"];
const missing = must.filter((p) => !existsSync(join(out, p)));
if (missing.length) {
  console.error(`build-site: missing ${missing.join(", ")}`);
  process.exit(1);
}
const size = (dir) => readdirSync(dir).reduce((n, f) => {
  const p = join(dir, f);
  const s = statSync(p);
  return n + (s.isDirectory() ? size(p) : s.size);
}, 0);
const kib = (n) => `${(n / 1024).toFixed(0)} KiB`;
const bytes = (p) => statSync(join(out, p)).size;

// Budgets keep the home page short and light: long material belongs on features.html, roadmap.html
// and the docs. The home page images are the <img> sources and video posters of index.html (the film
// itself loads only when it is played; it counts towards media). media/ is held below its size before
// the redesign (8.66 MiB): new pictures replace old ones instead of adding to them.
const MiB = 1024 * 1024;
const BUDGET = { homeHtml: 32 * 1024, homeImages: 1 * MiB, pageHtml: 128 * 1024, media: 8.65 * MiB };
const home = readFileSync(join(out, "index.html"), "utf8");
const homeImageFiles = [...new Set([...home.matchAll(/<(?:img|video)\b[^>]*?\s(?:src|poster)="(media\/[^"]+\.(?:jpe?g|png|webp|avif|svg))"/g)].map((m) => m[1]))];
const usage = {
  homeHtml: bytes("index.html"),
  homeImages: homeImageFiles.reduce((n, p) => n + bytes(p), 0),
  pageHtml: Math.max(...PAGES.map(bytes)),
  media: size(join(out, "media")),
};
const over = Object.keys(BUDGET).filter((k) => usage[k] > BUDGET[k]);
const pages = PAGES.reduce((n, p) => n + bytes(p), 0);
const shared = ["styles.css", "navigation.css", "tokens.css", "script.js", "navigation.js", "language.js", "favicon.svg"].reduce((n, f) => n + bytes(f), 0);
console.log(`site-dist/ built: pages ${kib(pages)} (home ${kib(usage.homeHtml)} + ${homeImageFiles.length} images ${kib(usage.homeImages)}) + shared css/js ${kib(shared)} + media ${kib(usage.media)} + fonts ${kib(size(join(out, "fonts")))}; app ${kib(size(join(out, "app")))}`);
if (over.length) {
  console.error(`build-site: over budget: ${over.map((k) => `${k} ${kib(usage[k])} > ${kib(BUDGET[k])}`).join(", ")}`);
  process.exit(1);
}
