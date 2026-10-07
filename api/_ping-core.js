// Opt-in weekly install counts; accepts legacy reports but stores nothing from them.
import { createHmac, randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** Minimal fields and legacy validation limits. */
export const SCHEMA = require("./_ping-schema.json");

/** Browser origins of the desktop app (the shell's own HTTP client sends no Origin at all). */
export const ALLOWED_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];
const DAY_MS = 86_400_000;

const KEYS = new Set(SCHEMA.legacy_keys);
const KEY_PATTERNS = SCHEMA.legacy_key_patterns.map((p) => new RegExp(p));
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?:-[0-9a-z.]{1,16})?$/;

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
  const minimal = body.schema === "fairbeam.ping/2";
  const want = [...(legacy ? SCHEMA.legacy_fields : minimal ? SCHEMA.fields.filter(f => f !== "install_id") : SCHEMA.fields)].sort();
  if (fields.length !== want.length || fields.some((f, i) => f !== want[i])) return fail("unexpected fields");
  const { schema, install_id, app_version, os, arch, gpu_available, day, counters } = body;
  // installed apps of earlier versions keep sending their own schema id; it is accepted, never written
  if (schema !== SCHEMA.schema && !minimal && !SCHEMA.legacy_schemas.includes(schema)) return fail("schema");
  if (typeof app_version !== "string" || !VERSION.test(app_version)) return fail("app_version");
  if (!SCHEMA.os.includes(os)) return fail("os");
  if (!SCHEMA.arch.includes(arch)) return fail("arch");
  if (!minimal && (typeof install_id !== "string" || !UUID_V4.test(install_id))) return fail("install_id");
  if (legacy) {
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
  return { ok: true, ping: { schema: minimal || legacy ? "fairbeam.ping/2" : SCHEMA.schema, app_version, os, arch, ...(!minimal && !legacy ? { install_id } : {}) } };
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
  if (!storageEnv(env)) return json(503, { error: "usage statistics are not enabled" }, cors);
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
    // Earlier report formats are validated and acknowledged; nothing from them is stored.
    if (v.ping.install_id) await countInstall(deps, isoWeek(utcDay(nowMs)), v.ping, nowMs);
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

/** Monday 00:00 UTC of an ISO week ("2026-W41"), so an aggregate carries no request time. */
export function weekStart(week) {
  const [year, w] = week.split("-W").map(Number);
  const jan4 = Date.UTC(year, 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  return new Date(monday + (w - 1) * 7 * DAY_MS).toISOString().replace(".000Z", "Z");
}

// Storage is a Redis REST store connected through Vercel (Upstash). The integration injects the URL
// and token, so nobody types a secret. Both naming schemes of the integration are accepted.
export function storageEnv(env = {}) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || "";
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || "";
  return url && token && /^https:\/\/[a-z0-9.-]+(?::[0-9]+)?\/?$/i.test(url) ? { url, token } : null;
}

// The week's salt: created by the first request of the ISO week, shared by concurrent requests and
// deleted by Redis at the week boundary. Nothing derived from an install ID is involved here.
export const WEEK_SALT_LUA = `
local salt = redis.call('GET', KEYS[1])
if not salt then
  salt = ARGV[1]
  redis.call('SET', KEYS[1], salt, 'EXAT', ARGV[2])
end
return salt
`;

// Receives only the salted hash, never the install ID. One atomic update per ping: hash sets
// (whole week, and version/OS/architecture of the week) expire at the boundary after the
// aggregates were incremented, so deleting them cannot lose a total.
export const COUNT_INSTALL_LUA = `
local first = redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIREAT', KEYS[1], ARGV[2])
if first == 1 then redis.call('HINCRBY', KEYS[3], 'cumulative_weekly_distinct', 1) end
local added = redis.call('SADD', KEYS[2], ARGV[1])
redis.call('EXPIREAT', KEYS[2], ARGV[2])
if added == 1 then redis.call('HINCRBY', KEYS[3], ARGV[3], 1) end
return tonumber(redis.call('HGET', KEYS[3], ARGV[3]))
`;

/** Salted, keyed hash of an install ID; only this value ever reaches Redis. */
export const hashInstall = (salt, installId) => createHmac("sha256", salt).update(installId).digest("hex");

async function redis(deps, command) {
  const store = storageEnv(deps.env);
  if (!store) throw new Error("install storage unavailable");
  const response = await (deps.fetch ?? globalThis.fetch)(store.url, {
    method: "POST", headers: { authorization: `Bearer ${store.token}`, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error("install storage failed");
  const { result, error } = await response.json();
  if (error) throw new Error("install storage failed");
  return result;
}

/** Counts one install for the ISO week; returns the tuple's distinct-install total so far. */
export async function countInstall(deps, week, ping, nowMs) {
  const tuple = `${week}--${ping.app_version}--${ping.os}--${ping.arch}`;
  const expires = Math.floor(Date.parse(weekStart(week)) / 1000) + 7 * 86400;
  if (expires <= Math.floor(nowMs / 1000)) throw new Error("expired week");
  const salt = await redis(deps, ["EVAL", WEEK_SALT_LUA, "1", `fairbeam:{counts}:salt:${week}`, randomBytes(32).toString("hex"), String(expires)]);
  if (typeof salt !== "string" || !/^[0-9a-f]{64}$/.test(salt)) throw new Error("invalid salt");
  const total = await redis(deps, ["EVAL", COUNT_INSTALL_LUA, "3",
    `fairbeam:{counts}:ids:${week}`, `fairbeam:{counts}:ids:${tuple}`, "fairbeam:{counts}:aggregates",
    hashInstall(salt, ping.install_id), String(expires), tuple]);
  if (!Number.isSafeInteger(total) || total < 1) throw new Error("invalid install total");
  return total;
}
