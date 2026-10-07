// Disabled unless a Redis REST store is connected (Vercel integration: KV_REST_API_URL and KV_REST_API_TOKEN).
import { handlePing } from "./_ping-core.js";

const deps = () => ({ env: process.env, fetch: globalThis.fetch, now: Date.now });

export function POST(request) {
  return handlePing(request, deps());
}

export function OPTIONS(request) {
  return handlePing(request, deps());
}

export function GET(request) {
  return handlePing(request, deps());
}
