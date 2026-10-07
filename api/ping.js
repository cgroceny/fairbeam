// Disabled unless STATS_GITHUB_TOKEN and a stats repository are configured.
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
