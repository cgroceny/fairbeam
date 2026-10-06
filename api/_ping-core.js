// The receiving side of the desktop app's usage statistics (docs/TELEMETRY.md), used by
// api/ping.js. Not a function itself: Vercel skips files in api/ that start with "_".
//
// POST /api/ping with one day of counts. The function:
//   - answers 503 and does nothing unless STATS_GITHUB_TOKEN and STATS_SALT are set;
//   - validates strictly (size, the eight schema fields, known counter keys, numeric caps);
//   - replaces the install id by HMAC-SHA256(STATS_SALT, id), so the plain id is never stored;
//   - accepts at most MAX_PER_ID_PER_DAY pings per hashed id per receiving day;
//   - appends one line to data/<receiving day>.jsonl in the stats repository (STATS_REPO) through the
//     GitHub Contents API, retrying when the file changed in between (SHA conflict).
// Everything it needs comes in as `deps` ({env, fetch, now}), so the tests use a fake GitHub.
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** The one list of fields and counter keys (also read by the desktop shell). */
export const SCHEMA = require("./_ping-schema.json");

/** Browser origins of the desktop app (the shell's own HTTP client sends no Origin at all). */
export const ALLOWED_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];
export const MAX_PER_ID_PER_DAY = 2;
/** A daily file continues in data/<day>-2.jsonl beyond this, so every read stays under 1 MB. */
export const MAX_FILE_BYTES = 700_000;
const MAX_SHARDS = 50;
const MAX_ATTEMPTS = 5;
const DAY_MS = 86_400_000;

const KEYS = new Set(SCHEMA.keys);
const KEY_PATTERNS = SCHEMA.key_patterns.map((p) => new RegExp(p));
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?:-[0-9a-z.]{1,16})?$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function dayNumber(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(t) || utcDay(t) !== day ? null : Math.floor(t / DAY_MS);
}

export const keyAllowed = (key) => KEYS.has(key) || KEY_PATTERNS.some((re) => re.test(key));

/** {ok: true, ping} or {ok: false, error}: exactly the schema, nothing more. */
export function validatePing(body, nowMs) {
  const fail = (error) => ({ ok: false, error });
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("not an object");
  const fields = Object.keys(body).sort();
  const want = [...SCHEMA.fields].sort();
  if (fields.length !== want.length || fields.some((f, i) => f !== want[i])) return fail("unexpected fields");
  const { schema, install_id, app_version, os, arch, gpu_available, day, counters } = body;
  // installed apps of earlier versions keep sending their own schema id; it is accepted, never written
  if (schema !== SCHEMA.schema && !SCHEMA.legacy_schemas.includes(schema)) return fail("schema");
  if (typeof install_id !== "string" || !UUID_V4.test(install_id)) return fail("install_id");
  if (typeof app_version !== "string" || !VERSION.test(app_version)) return fail("app_version");
  if (!SCHEMA.os.includes(os)) return fail("os");
  if (!SCHEMA.arch.includes(arch)) return fail("arch");
  if (typeof gpu_available !== "boolean") return fail("gpu_available");
  const n = dayNumber(day);
  const today = Math.floor(nowMs / DAY_MS);
  // a whole previous day; one day of slack for a clock that is ahead
  if (n === null || n > today + 1 || n < today - SCHEMA.max_age_days) return fail("day");
  if (!counters || typeof counters !== "object" || Array.isArray(counters) || Object.getPrototypeOf(counters) !== Object.prototype) return fail("counters");
  const entries = Object.entries(counters);
  if (entries.length < 1 || entries.length > SCHEMA.max_keys) return fail("counters: size");
  for (const [k, v] of entries) {
    if (!keyAllowed(k)) return fail("counters: unknown key");
    if (!Number.isInteger(v) || v < 0 || v > SCHEMA.max_value) return fail("counters: value");
  }
  return { ok: true, ping: body };
}

/** The stored id: keyed with the server's salt, so it cannot be traced back to the install id. */
export const hashId = (salt, id) => createHmac("sha256", salt).update(id).digest("hex").slice(0, 16);

const json = (status, obj, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

async function readLimited(request, limit) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  const buf = await request.arrayBuffer();
  return buf.byteLength > limit ? null : new TextDecoder().decode(buf);
}

export async function handlePing(request, deps) {
  const { env = {}, now = Date.now } = deps;
  const origin = request.headers.get("origin");
  const cors = origin && ALLOWED_ORIGINS.includes(origin)
    ? { "access-control-allow-origin": origin, vary: "Origin" }
    : {};
  if (origin && !cors["access-control-allow-origin"]) return json(403, { error: "origin not allowed" });
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" } });
  }
  if (request.method !== "POST") return json(405, { error: "POST only" }, { ...cors, allow: "POST, OPTIONS" });
  if (!env.STATS_GITHUB_TOKEN || !env.STATS_SALT) return json(503, { error: "usage statistics are not enabled" }, cors);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return json(415, { error: "application/json only" }, cors);
  }
  const text = await readLimited(request, SCHEMA.max_body_bytes);
  if (text === null) return json(413, { error: "too large" }, cors);
  let body;
  try { body = JSON.parse(text); } catch { return json(400, { error: "invalid JSON" }, cors); }
  const nowMs = now();
  const v = validatePing(body, nowMs);
  if (!v.ok) return json(400, { error: `invalid ping: ${v.error}` }, cors);
  const p = v.ping;
  const line = { day: p.day, id: hashId(env.STATS_SALT, p.install_id), v: p.app_version, os: p.os, arch: p.arch, gpu: p.gpu_available, c: p.counters };
  try {
    const result = await appendLine(deps, utcDay(nowMs), line);
    if (result === "limited") return json(429, { error: "too many pings today" }, cors);
    if (result === "duplicate") return json(200, { ok: true, duplicate: true }, cors);
    return json(202, { ok: true }, cors);
  } catch (e) {
    console.error("ping: storing failed:", e instanceof Error ? e.message : e);
    return json(503, { error: "could not store" }, cors);
  }
}

/** Append `line` to the receiving day's file: "stored", "duplicate" (this id sent this day
 * already) or "limited" (MAX_PER_ID_PER_DAY reached). Retries on a SHA conflict. */
export async function appendLine(deps, receivedDay, line) {
  const { env, fetch: fetchImpl = globalThis.fetch } = deps;
  const repo = env.STATS_REPO ?? "";
  const branch = env.STATS_BRANCH || "main";
  if (!REPO.test(repo)) throw new Error("STATS_REPO must be owner/name");
  const api = `https://api.github.com/repos/${repo}/contents/`;
  const headers = {
    authorization: `Bearer ${env.STATS_GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "fairbeam-ping",
  };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let seen = 0;
    let target = null;
    for (let shard = 1; shard <= MAX_SHARDS && !target; shard++) {
      const path = `data/${receivedDay}${shard === 1 ? "" : `-${shard}`}.jsonl`;
      const r = await fetchImpl(`${api}${path}?ref=${encodeURIComponent(branch)}`, { headers });
      if (r.status === 404) { target = { path, sha: null, text: "" }; break; }
      if (!r.ok) throw new Error(`GitHub GET ${r.status}`);
      const file = await r.json();
      const text = Buffer.from(file.content ?? "", "base64").toString("utf8");
      for (const raw of text.split("\n")) {
        if (!raw.trim()) continue;
        let l;
        try { l = JSON.parse(raw); } catch { continue; }
        if (l.id !== line.id) continue;
        if (l.day === line.day) return "duplicate";
        seen++;
      }
      if ((file.size ?? text.length) < MAX_FILE_BYTES) target = { path, sha: file.sha, text };
    }
    if (!target) throw new Error("no room left in today's files");
    if (seen >= MAX_PER_ID_PER_DAY) return "limited";
    const next = `${target.text}${target.text && !target.text.endsWith("\n") ? "\n" : ""}${JSON.stringify(line)}\n`;
    const put = await fetchImpl(`${api}${target.path}`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ message: `ping ${receivedDay}`, content: Buffer.from(next, "utf8").toString("base64"), branch, ...(target.sha ? { sha: target.sha } : {}) }),
    });
    if (put.status === 200 || put.status === 201) return "stored";
    // another ping changed the file in between: read it again
    if (put.status === 409 || put.status === 422) {
      await new Promise((ok) => setTimeout(ok, 40 * (attempt + 1) + Math.floor(Math.random() * 60)));
      continue;
    }
    throw new Error(`GitHub PUT ${put.status}`);
  }
  throw new Error("the file kept changing");
}
