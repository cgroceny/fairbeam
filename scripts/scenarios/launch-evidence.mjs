// Evidence before a page exists. Never retry launch or change its options, timeout or cleanup.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { channel } from 'node:diagnostics_channel';
import { browserExecutableIdentity, hostedImageIdentity } from './browser-identity.mjs';

const LIMIT = 64;
const text = (value, limit = 4000) => {
  if (typeof value !== 'string') return '[not a string]';
  return value.slice(0, 100000)
    .replace(/^.*(?:-EncodedCommand\b|-enc\s|\bCommandLine\s*[:=]|\bLaunching\s).*$/gim, '[command omitted]')
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/gi, value => {
      try {
        const url = new URL(value);
        if (!['http:', 'https:', 'ws:', 'wss:', 'file:'].includes(url.protocol)) return '[URL omitted]';
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        return url.href;
      } catch { return '[URL omitted]'; }
    })
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/((?:["']?)(?:[\w-]*(?:token|password|secret|authorization)|api[_-]?key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .slice(0, limit);
};
const errorText = error => {
  try { return text(typeof error === 'string' ? error : error?.stack ?? error?.message ?? '[unknown error]'); }
  catch { return '[unreadable error]'; } // Evidence must not replace even an unusual thrown object.
};
const pid = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const knownArgs = new Set(['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader']);
const childProcessChannel = channel('child_process'); // Public, experimental in supported Node versions.

/** Observe this launch only. The channel publishes before spawnfile, PID and stdio exist. */
export function observeLaunchOutput(executablePath, getOwnedPid, processChannel = childProcessChannel) {
  const state = { available: false, matched: false, candidateLimit: 16, candidates: 0, ignoredCandidates: 0,
    observerErrors: 0, droppedLines: 0, omittedLines: 0, partialLines: 0, records: [], childEvents: [] };
  const cleanups = new Set(), frames = [];
  let stopped = false, matchedPid = null, retainedBytes = 0;
  const guarded = callback => (...args) => {
    if (stopped) return;
    try { callback(...args); } catch { state.observerErrors++; }
  };
  const cleanup = action => {
    const remove = () => { cleanups.delete(remove); try { action(); } catch { state.observerErrors++; } };
    cleanups.add(remove);
    return remove;
  };
  const listen = (emitter, event, callback, once = false) => {
    const handler = guarded(callback);
    const remove = cleanup(() => emitter.removeListener(event, handler));
    try { emitter[once ? 'once' : 'on'](event, handler); } catch { remove(); state.observerErrors++; }
    return remove;
  };
  const retain = (stream, line) => {
    // Deliberately omit whole URL-bearing lines, including paths and DevTools endpoints.
    // These are bounded pattern-based protections, not a guarantee for arbitrary secret formats.
    if (/DevTools|\b(?:[a-z][a-z\d+.-]*:\/\/|(?:about|data|blob|file|mailto|javascript|chrome|edge|devtools|urn):)|(?:^|\s)(?:\/\/|www\.)/i.test(line)) { state.omittedLines++; return; }
    const safe = text(line, 4096), bytes = Buffer.byteLength(safe);
    if (state.records.length >= LIMIT || retainedBytes + bytes > 16384) { state.droppedLines++; return; }
    state.records.push({ stream, text: safe }); retainedBytes += bytes;
  };
  const observeStream = (stream, name) => {
    if (!stream) return;
    const frame = { pending: Buffer.alloc(0), oversized: false };
    frames.push(frame);
    listen(stream, 'data', chunk => {
      if (getOwnedPid() !== matchedPid) return; // Fail closed if ownership becomes ambiguous.
      if (!Buffer.isBuffer(chunk)) { state.droppedLines++; frame.pending = Buffer.alloc(0); frame.oversized = true; return; }
      for (let start = 0; start < chunk.length;) {
        const newline = chunk.indexOf(10, start), end = newline === -1 ? chunk.length : newline;
        if (!frame.oversized && frame.pending.length + end - start > 4096) {
          frame.pending = Buffer.alloc(0); frame.oversized = true; state.droppedLines++;
        }
        if (!frame.oversized) frame.pending = Buffer.concat([frame.pending, chunk.subarray(start, end)]);
        if (newline === -1) break;
        if (!frame.oversized) retain(name, frame.pending.toString('utf8').replace(/\r$/, ''));
        frame.pending = Buffer.alloc(0); frame.oversized = false; start = end + 1;
      }
    }); // Observe only: never read, pause, resume, destroy or change the stream encoding.
  };
  try {
    if (!processChannel?.subscribe || !processChannel?.unsubscribe) throw new Error('Unavailable channel');
    const subscriber = guarded(message => {
      if (state.matched) return;
      if (state.candidates >= state.candidateLimit) { state.ignoredCandidates++; return; }
      const child = message.process;
      state.candidates++;
      const removeSpawn = listen(child, 'spawn', () => {
        removeSpawn();
        if (state.matched || child.spawnfile !== executablePath || !pid(child.pid) || child.pid !== getOwnedPid()) return;
        matchedPid = child.pid; state.matched = true;
        observeStream(child.stdout, 'stdout'); observeStream(child.stderr, 'stderr');
        for (const event of ['exit', 'close']) listen(child, event, (code, signal) => {
          if (state.childEvents.length < 2) state.childEvents.push({ event,
            code: Number.isInteger(code) ? code : null,
            signal: typeof signal === 'string' && /^[A-Z0-9]{1,16}$/.test(signal) ? signal : null });
        }, true); // ChildProcess observations only; they do not establish OS liveness.
      }, true);
    });
    cleanup(() => processChannel.unsubscribe(subscriber));
    processChannel.subscribe(subscriber); state.available = true;
  } catch { state.observerErrors++; }
  return { finish() {
    if (!stopped) {
      stopped = true;
      for (const remove of [...cleanups]) remove();
      for (const frame of frames) {
        if (frame.pending.length || frame.oversized) state.partialLines++;
        frame.pending = Buffer.alloc(0);
      }
      try {
        if (state.matched && getOwnedPid() !== matchedPid) {
          state.matched = false; state.records = []; state.childEvents = [];
        }
      } catch { state.observerErrors++; state.matched = false; state.records = []; state.childEvents = []; }
    }
    return state;
  } };
}

async function installedVersion(name) {
  try {
    const data = JSON.parse(await readFile(new URL(`../../node_modules/${name}/package.json`, import.meta.url), 'utf8'));
    return typeof data.version === 'string' && /^[\d][\w.+-]{0,40}$/.test(data.version) ? data.version : null;
  } catch { return null; }
}

/** Returns the exact browser or rethrows the exact launch error. The logger accepts no payloads. */
export async function launchWithEvidence(puppeteer, options, { directory, stack, report = console.error, processChannel = childProcessChannel } = {}) {
  const started = Date.now(), lifecycle = [];
  let ownedPid = null, ambiguousPid = false, dropped = 0, outputDirectory;
  const logger = channel => channel === 'puppeteer:browsers:launcher' ? message => {
    if (typeof message !== 'string') return;
    const match = /^(?:Launched (\d+)|Trying to kill (\d+)|Browser process (\d+) (onExit|exists))$/.exec(message);
    if (!match) return; // In particular, discard launch arguments, environment objects and protocol traffic.
    const processId = pid(Number(match[1] ?? match[2] ?? match[3]));
    if (!processId) return;
    if (match[1] && ownedPid === null) ownedPid = processId;
    if (match[1] && processId !== ownedPid) ambiguousPid = true;
    if (processId !== ownedPid) return;
    if (lifecycle.length === LIMIT) { dropped++; return; }
    lifecycle.push({ atMs: Date.now() - started, pid: processId,
      event: match[1] ? 'spawn' : match[2] ? 'cleanup-requested' : match[4] === 'onExit' ? 'exit' : 'process-present' });
  } : undefined;
  const warn = error => { try { report(`Could not save browser launch evidence: ${errorText(error)}`); } catch { /* evidence is secondary */ } };
  const write = async (name, record) => {
    try {
      if (!outputDirectory) {
        await mkdir(directory, { recursive: true });
        outputDirectory = await mkdtemp(join(directory, 'browser-launch-'));
      }
      await writeFile(join(outputDirectory, name), JSON.stringify(record,
        (_key, value) => typeof value === 'string' ? text(value) : value, 2), { flag: 'wx' });
    } catch (error) { warn(error); }
  };
  const intent = {
    schema: 'fairbeam.browser-launch-evidence/1', phase: 'before-launch', startedAt: new Date().toISOString(),
    nodeVersion: process.version, platform: process.platform,
    installedPackages: { puppeteerCore: await installedVersion('puppeteer-core'), browsers: await installedVersion('@puppeteer/browsers') },
    puppeteerModuleOverride: Boolean(process.env.FAIRBEAM_PUPPETEER),
    executablePath: text(options.executablePath), headless: options.headless,
    executableIdentity: await browserExecutableIdentity(options.executablePath), hostedImage: hostedImageIdentity(),
    approvedArguments: (options.args ?? []).filter(arg => knownArgs.has(arg)).slice(0, LIMIT),
    // Report whether defaults apply; never copy an arbitrary profile, argument or environment payload.
    explicitProfile: typeof options.userDataDir === 'string' || (options.args ?? []).some(arg => typeof arg === 'string' && arg.startsWith('--user-data-dir')),
    explicitTimeout: Object.hasOwn(options, 'timeout'), explicitTransport: Object.hasOwn(options, 'pipe'),
  };
  intent.prelaunchPreparationMs = Date.now() - started;
  await write('prelaunch.json', intent);
  const observer = observeLaunchOutput(options.executablePath, () => ambiguousPid ? null : ownedPid, processChannel);
  try {
    const browser = await puppeteer.launch({ ...options, logger });
    const browserOutput = observer.finish(); // Detach before any asynchronous evidence write or caller cleanup.
    await write('launched.json', { schema: intent.schema, phase: 'launched', elapsedMs: Date.now() - started, ownedPid, ambiguousPid, lifecycle, dropped, browserOutput });
    return browser;
  } catch (error) {
    const failure = { schema: intent.schema, phase: 'launch-failed', elapsedMs: Date.now() - started,
      error: errorText(error), ownedPid, ambiguousPid, lifecycle, dropped, browserOutput: observer.finish(), processes: [], captureErrors: [] };
    try {
      const children = stack?.diagnostics?.() ?? [];
      if (!Array.isArray(children)) throw new Error('Stack diagnostics did not return a process list');
      failure.processes = children.slice(0, 4).map(child => ({
        name: text(child.name, 80), pid: pid(child.pid), exited: child.exited === true,
        exitCode: Number.isInteger(child.exitCode) ? child.exitCode : null,
        signalCode: typeof child.signalCode === 'string' ? text(child.signalCode, 40) : null,
        output: text(child.output),
      }));
    } catch (captureError) { failure.captureErrors.push(errorText(captureError)); }
    await write('failure.json', failure); // Separate from intent: a failed write cannot erase prelaunch evidence.
    throw error;
  } finally {
    observer.finish();
  }
}
