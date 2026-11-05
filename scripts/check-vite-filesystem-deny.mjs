// Local synthetic regression evidence only. Never reads a real .env or certificate.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createServer, version } from 'vite';

// --out creates a fresh evidence directory; the default retains it in the OS temp folder.
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--out'), 'Usage: check-vite-filesystem-deny.mjs [--out fresh-directory]');
const evidence = args.length ? resolve(args[1]) : await mkdtemp(join(tmpdir(), 'fairbeam-vite-deny-'));
if (args.length) await mkdir(evidence);
const root = join(evidence, 'synthetic-root');
await mkdir(root); // exclusive fixture creation: no blind repeat over evidence
const deniedMarker = 'FAIRBEAM_SYNTHETIC_DENIED_CONTENT_20261105';
const allowedMarker = 'FAIRBEAM_SYNTHETIC_PUBLIC_CONTENT_20261105';
await writeFile(join(root, '.env'), `SYNTHETIC_TEST=${deniedMarker}\n`);
await writeFile(join(root, 'synthetic.crt'), `${deniedMarker}\n`);
await writeFile(join(root, 'allowed.txt'), `${allowedMarker}\n`);
await writeFile(join(root, 'index.html'), '<!doctype html><title>Synthetic Vite denial test</title>');
const result = { version, host: '127.0.0.1', fixture: 'synthetic-only', cases: [], startedUtc: new Date().toISOString(), status: 'running' };
const started = performance.now();
let server;
let error;
try {
  server = await createServer({
    configFile: false, envFile: false, root, publicDir: false,
    cacheDir: join(evidence, 'vite-cache'), logLevel: 'warn',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, strictPort: true, fs: { allow: [root] } },
  });
  result.defaultDenyPatterns = server.config.server.fs.deny;
  await server.listen();
  const address = server.httpServer.address();
  assert.equal(typeof address, 'object');
  assert.equal(address.address, '127.0.0.1');
  result.port = address.port;
  const base = `http://127.0.0.1:${address.port}`;
  for (const suffix of ['', '?raw']) {
    const response = await fetch(`${base}/allowed.txt${suffix}`, { signal: AbortSignal.timeout(5000) });
    const body = await response.text();
    result.cases.push({ kind: 'positive-control', request: `/allowed.txt${suffix}`, status: response.status, hasExpectedContent: body.includes(allowedMarker) });
    assert.equal(response.status, 200);
    assert.ok(body.includes(allowedMarker));
  }
  for (const filename of ['.env', 'synthetic.crt']) {
    for (const route of [`/${filename}`, `/@fs/${root.replaceAll('\\', '/')}/${filename}`]) {
      for (const query of ['', '?raw', '?import&raw', '?import&url&inline']) {
        const response = await fetch(`${base}${route}${query}`, { signal: AbortSignal.timeout(5000) });
        const body = await response.text();
        const row = { kind: 'denial', file: filename, route: route.startsWith('/@fs/') ? '@fs' : 'relative', query, status: response.status, deniedContentPresent: body.includes(deniedMarker) };
        result.cases.push(row);
        assert.equal(response.status, 403, JSON.stringify(row));
        assert.equal(row.deniedContentPresent, false);
      }
    }
  }
  result.status = 'passed';
} catch (caught) {
  error = caught;
  result.status = 'failed';
  result.error = `${caught.name}: ${caught.message}`;
} finally {
  try {
    if (server) await server.close();
    result.serverClosed = true;
  } catch (caught) {
    error ??= caught;
    result.status = 'failed';
    result.closeError = `${caught.name}: ${caught.message}`;
  }
  result.elapsedSeconds = (performance.now() - started) / 1000;
  result.endedUtc = new Date().toISOString();
  await writeFile(join(evidence, 'filesystem-deny-result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
}
console.log(JSON.stringify({ status: result.status, version, cases: result.cases.length, serverClosed: result.serverClosed, elapsedSeconds: result.elapsedSeconds, evidence }));
if (error) throw error;
