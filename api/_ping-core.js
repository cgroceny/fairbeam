// Opt-in weekly aggregate counts; accepts legacy reports but discards their extra fields.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** Minimal fields and legacy validation limits. */
export const SCHEMA = require("./_ping-schema.json");

/** Browser origins of the desktop app (the shell's own HTTP client sends no Origin at all). */
export const ALLOWED_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];
const MAX_ATTEMPTS = 5;
const DAY_MS = 86_400_000;

const KEYS = new Set(SCHEMA.legacy_keys);
const KEY_PATTERNS = SCHEMA.legacy_key_patterns.map((p) => new RegExp(p));
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?:-[0-9a-z.]{1,16})?$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

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
  const legacy = SCHEMA.legacy_schemas.includes(body.schema);
  const want = [...(legacy ? SCHEMA.legacy_fields : SCHEMA.fields)].sort();
  if (fields.length !== want.length || fields.some((f, i) => f !== want[i])) return fail("unexpected fields");
  const { schema, install_id, app_version, os, arch, gpu_available, day, counters } = body;
  // installed apps of earlier versions keep sending their own schema id; it is accepted, never written
  if (schema !== SCHEMA.schema && !SCHEMA.legacy_schemas.includes(schema)) return fail("schema");
  if (typeof app_version !== "string" || !VERSION.test(app_version)) return fail("app_version");
  if (!SCHEMA.os.includes(os)) return fail("os");
  if (!SCHEMA.arch.includes(arch)) return fail("arch");
  if (legacy) {
    if (typeof install_id !== "string" || !UUID_V4.test(install_id)) return fail("install_id");
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
  }
  return { ok: true, ping: { schema: SCHEMA.schema, app_version, os, arch } };
}

const json = (status, obj, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

async function readLimited(request, limit) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
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
  if (!env.STATS_GITHUB_TOKEN) return json(503, { error: "usage statistics are not enabled" }, cors);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return json(415, { error: "application/json only" }, cors);
  }
  const text = await readLimited(request, SCHEMA.max_body_bytes);
  if (text === null) return json(413, { error: "too large" }, cors);
  let body;
  try { body = JSON.parse(text); } catch { return json(400, { error: "invalid JSON" }, cors); }
  const nowMs = now();
  const v = validatePing(body, nowMs);
  if (!v.ok) return json(400, { error: `invalid ping: ${v.error}` }, cors);
  try {
    await incrementAggregate(deps, isoWeek(utcDay(nowMs)), v.ping);
    return json(202, { ok: true }, cors);
  } catch (e) {
    // Do not log request bodies, headers, addresses or exception details.
    return json(503, { error: "could not store" }, cors);
  }
}

/** UTC ISO week; the receiving time defines the aggregate, never a client date. */
export function isoWeek(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3 - (d.getUTCDay() + 6) % 7);
  const year = d.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d - first) / DAY_MS - 3 + (first.getUTCDay() + 6) % 7) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Update only a tuple's total. No event log, identity, IP address or user agent is stored. */
export async function incrementAggregate(deps, week, ping) {
  const { env, fetch: fetchImpl = globalThis.fetch } = deps;
  const repo = env.STATS_REPO ?? "";
  const branch = env.STATS_BRANCH || "main";
  if (!REPO.test(repo)) throw new Error("invalid stats repository");
  const path = `data/${week}--${ping.app_version}--${ping.os}--${ping.arch}.json`;
  const api = `https://api.github.com/repos/${repo}/contents/${path}`;
  const headers = {
    authorization: `Bearer ${env.STATS_GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "fairbeam-ping",
  };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const r = await fetchImpl(`${api}?ref=${encodeURIComponent(branch)}`, { headers });
    let sha, count = 0;
    if (r.ok) {
      const file = await r.json();
      const aggregate = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
      count = aggregate.count;
      if (!Number.isSafeInteger(count) || count < 0 || count === Number.MAX_SAFE_INTEGER) throw new Error("invalid total");
      sha = file.sha;
    } else if (r.status !== 404) throw new Error("storage read failed");
    const aggregate = { week, app_version: ping.app_version, os: ping.os, arch: ping.arch, count: count + 1 };
    const put = await fetchImpl(api, {
      method: "PUT", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ message: `Update usage total ${week}`, content: Buffer.from(JSON.stringify(aggregate) + "\n").toString("base64"), branch, ...(sha ? { sha } : {}) }),
    });
    if (put.status === 200 || put.status === 201) return;
    if (put.status === 409 || put.status === 422) continue;
    throw new Error("storage write failed");
  }
  throw new Error("storage contention");
}
