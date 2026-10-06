#!/usr/bin/env node
// Initial-load report for a Vite build: which JS/CSS the page loads before first render (the entry
// script, its modulepreloads and stylesheets) versus lazy chunks, raw and gzip sizes.
// Usage: node scripts/bundle-report.mjs [dist-dir]   (default dist-demo; run npm run build:demo first)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const dir = resolve(process.argv[2] ?? "dist-demo");
const html = readFileSync(join(dir, "index.html"), "utf8");
const initial = new Set([...html.matchAll(/(?:src|href)="[^"]*?\/?(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]));
const files = readdirSync(join(dir, "assets")).filter((f) => /\.(js|css)$/.test(f)).map((f) => `assets/${f}`);
const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
const rows = files.map((f) => {
  const buf = readFileSync(join(dir, f));
  return { f, raw: statSync(join(dir, f)).size, gz: gzipSync(buf, { level: 9 }).length, initial: initial.has(f) };
}).sort((a, b) => b.gz - a.gz);
const sum = (xs, k) => xs.reduce((n, r) => n + r[k], 0);
const init = rows.filter((r) => r.initial);
const lazy = rows.filter((r) => !r.initial);
console.log(`initial: ${init.length} files, ${kib(sum(init, "raw"))} raw, ${kib(sum(init, "gz"))} gzip`);
for (const r of init) console.log(`  ${r.f.padEnd(52)} ${kib(r.raw).padStart(11)} ${kib(r.gz).padStart(11)}`);
console.log(`lazy:    ${lazy.length} files, ${kib(sum(lazy, "raw"))} raw, ${kib(sum(lazy, "gz"))} gzip`);
for (const r of lazy.filter((r) => r.gz > 4096)) console.log(`  ${r.f.padEnd(52)} ${kib(r.raw).padStart(11)} ${kib(r.gz).padStart(11)}`);
