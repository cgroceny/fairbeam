// POST https://fairbeam.org/api/ping: one day of the desktop app's pseudonymous usage counts
// (docs/TELEMETRY.md). Disabled: without STATS_GITHUB_TOKEN and STATS_SALT in the Vercel
// environment it answers 503 and does nothing. The logic is in _ping-core.js.
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
