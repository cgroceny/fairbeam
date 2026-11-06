// Fake launch failures and owned Node children: no browser, app server or solver is started.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { launchWithEvidence, observeLaunchOutput } from './scenarios/launch-evidence.mjs';
import { browserIdentitySelfTest } from './check-browser-identity.mjs';

function fixtureChannel() {
  const subscribers = new Set();
  return { subscribers, subscribe: callback => subscribers.add(callback), unsubscribe: callback => subscribers.delete(callback),
    publish: message => { for (const callback of [...subscribers]) callback(message); } };
}
function fixtureChild(bus, executablePath, processId) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  bus.publish({ process: child }); // Like Node, publication precedes spawn fields.
  child.spawnfile = executablePath; child.pid = processId;
  return child;
}
function assertDetached(bus, children) {
  assert.equal(bus.subscribers.size, 0);
  for (const child of children) {
    for (const event of ['spawn', 'exit', 'close', 'error']) assert.equal(child.listenerCount(event), 0, event);
    for (const stream of [child.stdout, child.stderr]) assert.equal(stream.listenerCount('data'), 0);
  }
}

function observerSelfTest() {
  const bus = fixtureChannel(), children = [], owner = { pid: 7 };
  const observer = observeLaunchOutput('fixture-browser', () => owner.pid, bus);
  const make = (exe, processId) => { const child = fixtureChild(bus, exe, processId); children.push(child); return child; };
  const otherExe = make('other-browser', 7), otherPid = make('fixture-browser', 8);
  for (const child of [otherExe, otherPid]) {
    child.emit('spawn'); child.stdout.emit('data', Buffer.from('unrelated-secret\n'));
    assert.equal(child.stdout.listenerCount('data'), 0);
  }
  const child = make('fixture-browser', 7);
  child.emit('spawn');
  assert.equal(child.listenerCount('error'), 0, 'Never alter unhandled child error behavior');
  const output = (stream, value) => child[stream].emit('data', Buffer.from(value));
  output('stdout', 'token=split-'); output('stdout', 'secret\nordinary output\n');
  output('stderr', 'DevTools list'); output('stderr', 'ening on ws://127.0.0.1/devtools/browser/secret-id\n');
  output('stdout', 'URL https:'); output('stdout', '//host/secret-path?token=secret-query\n');
  output('stdout', 'opaque bl'); output('stdout', 'ob:private-opaque-path\n');
  output('stderr', '[123:45:1021/0123:ERROR:gpu/init.cc(123)] GPU process launch failed\n');
  output('stderr', 'Bearer split-'); output('stderr', 'bearer\n');
  output('stdout', '"password": "split '); output('stdout', 'quoted secret"\n');
  output('stdout', 'x'.repeat(4097)); output('stdout', 'secret-tail\nfollowing line\n');
  output('stderr', 'password=unterminated-secret');
  child.emit('exit', 12, 'SIGTERM'); child.emit('close', 12, 'SIGTERM');
  const result = observer.finish(), serialized = JSON.stringify(result);
  assert.equal(result.matched, true);
  assert.equal(result.omittedLines, 3); assert.equal(result.droppedLines, 1); assert.equal(result.partialLines, 1);
  assert.deepEqual(result.childEvents, [{ event: 'exit', code: 12, signal: 'SIGTERM' }, { event: 'close', code: 12, signal: 'SIGTERM' }]);
  assert(result.records.some(record => record.text === 'following line'));
  assert(result.records.some(record => record.text.includes('ERROR:gpu/init.cc(123)')));
  assert.match(serialized, /ordinary output|redacted/);
  assert.doesNotMatch(serialized, /split-secret|split-bearer|quoted secret|unterminated-secret|unrelated-secret|secret-path|secret-query|secret-id|secret-tail|private-opaque-path|DevTools|ws:\/\/|https:\/\//);
  assertDetached(bus, children);
  child.stdout.emit('data', Buffer.from('after-finish-secret\n'));
  assert.equal(JSON.stringify(observer.finish()), serialized);

  const boundedBus = fixtureChannel(), pending = [], bounded = observeLaunchOutput('fixture-browser', () => 7, boundedBus);
  for (let i = 0; i < 40; i++) pending.push(fixtureChild(boundedBus, 'fixture-browser', i + 1));
  const boundedResult = bounded.finish();
  assert.equal(boundedResult.candidates, 16); assert.equal(boundedResult.ignoredCandidates, 24);
  assertDetached(boundedBus, pending);
  const capBus = fixtureChannel(), capped = observeLaunchOutput('fixture-browser', () => 7, capBus);
  const capChild = fixtureChild(capBus, 'fixture-browser', 7); capChild.emit('spawn');
  for (let i = 0; i < 100; i++) capChild.stdout.emit('data', Buffer.from('safe line\n'));
  const capResult = capped.finish();
  assert.equal(capResult.records.length, 64); assert.equal(capResult.droppedLines, 36);
  assertDetached(capBus, [capChild]);
  const sizeBus = fixtureChannel(), sized = observeLaunchOutput('fixture-browser', () => 7, sizeBus);
  const sizeChild = fixtureChild(sizeBus, 'fixture-browser', 7); sizeChild.emit('spawn');
  for (let i = 0; i < 10; i++) sizeChild.stdout.emit('data', Buffer.from('ü'.repeat(2000) + '\n'));
  const sizeResult = sized.finish();
  assert(sizeResult.records.reduce((sum, record) => sum + Buffer.byteLength(record.text), 0) <= 16384);
  assert.equal(sizeResult.droppedLines, 6); assertDetached(sizeBus, [sizeChild]);

  const badBus = fixtureChannel(), bad = observeLaunchOutput('fixture-browser', () => { throw new Error('observer-secret'); }, badBus);
  badBus.publish(Object.defineProperty({}, 'process', { get() { throw new Error('subscriber-secret'); } }));
  const badChild = fixtureChild(badBus, 'fixture-browser', 7); badChild.emit('spawn');
  const badResult = bad.finish();
  assert.equal(badResult.observerErrors, 2); assert.doesNotMatch(JSON.stringify(badResult), /observer-secret|subscriber-secret/);
  assertDetached(badBus, [badChild]);
  const streamBus = fixtureChannel(), streamObserver = observeLaunchOutput('fixture-browser', () => 7, streamBus);
  const streamChild = fixtureChild(streamBus, 'fixture-browser', 7);
  Object.defineProperty(streamChild, 'stdout', { get() { throw new Error('stream-observer-secret'); } });
  streamChild.emit('spawn');
  assert.equal(streamObserver.finish().observerErrors, 1); assert.equal(streamBus.subscribers.size, 0);
  assert.equal(streamChild.listenerCount('spawn'), 0); assert.equal(streamChild.listenerCount('error'), 0);
  const unavailable = observeLaunchOutput('fixture-browser', () => 7, null).finish();
  assert.equal(unavailable.available, false); assert.equal(unavailable.observerErrors, 1);
  const failingBus = fixtureChannel(), originalSubscribe = failingBus.subscribe;
  failingBus.subscribe = callback => { originalSubscribe(callback); throw new Error('subscribe-secret'); };
  const failedSubscription = observeLaunchOutput('fixture-browser', () => 7, failingBus).finish();
  assert.equal(failedSubscription.available, false); assert.equal(failingBus.subscribers.size, 0);

  const ambiguousBus = fixtureChannel(), ambiguousOwner = { pid: 7 };
  const ambiguous = observeLaunchOutput('fixture-browser', () => ambiguousOwner.pid, ambiguousBus);
  const ambiguousChild = fixtureChild(ambiguousBus, 'fixture-browser', 7); ambiguousChild.emit('spawn');
  ambiguousChild.stdout.emit('data', Buffer.from('discard this when ownership is lost\n'));
  ambiguousOwner.pid = null;
  const ambiguousResult = ambiguous.finish();
  assert.equal(ambiguousResult.matched, false); assert.deepEqual(ambiguousResult.records, []);
  assertDetached(ambiguousBus, [ambiguousChild]);
  const dataBus = fixtureChannel(); let ownerThrows = false;
  const dataObserver = observeLaunchOutput('fixture-browser', () => { if (ownerThrows) throw new Error('data-secret'); return 7; }, dataBus);
  const dataChild = fixtureChild(dataBus, 'fixture-browser', 7); dataChild.emit('spawn'); ownerThrows = true;
  dataChild.stdout.emit('data', Buffer.from('never retain this\n'));
  const dataResult = dataObserver.finish();
  assert.equal(dataResult.observerErrors, 2); assert.deepEqual(dataResult.records, []);
  assertDetached(dataBus, [dataChild]);
  const concurrentBus = fixtureChannel();
  const first = observeLaunchOutput('fixture-browser', () => 7, concurrentBus), second = observeLaunchOutput('fixture-browser', () => 8, concurrentBus);
  const firstChild = fixtureChild(concurrentBus, 'fixture-browser', 7), secondChild = fixtureChild(concurrentBus, 'fixture-browser', 8);
  firstChild.emit('spawn'); secondChild.emit('spawn');
  firstChild.stdout.emit('data', Buffer.from('first owner\n')); secondChild.stdout.emit('data', Buffer.from('second owner\n'));
  assert.deepEqual(first.finish().records.map(record => record.text), ['first owner']);
  assert.equal(concurrentBus.subscribers.size, 1);
  assert.deepEqual(second.finish().records.map(record => record.text), ['second owner']);
  assertDetached(concurrentBus, [firstChild, secondChild]);
}

async function ownedNodeChildSelfTest(root, records) {
  const script = join(root, 'owned-node-child.mjs');
  await writeFile(script, `
setTimeout(() => process.exit(72), 10000).unref();
process.once('message', async () => {
  const chunks = process.argv[2] === 'other' ? ['unrelated-real-secret\\n'] :
    ['token=real-split-', 'secret\\n', 'normal consumer output\\n', 'DevTools listening on ws://host/private-id\\n',
     'https://host/private-path?token=query-secret\\n', 'password=partial-real-secret'];
  for (const chunk of chunks) await new Promise(resolve => process.stdout.write(chunk, resolve));
  await new Promise(resolve => process.stderr.write('safe stderr\\n', resolve));
  process.disconnect();
});
`);
  const actualChannel = channel('child_process'), baseline = actualChannel.hasSubscribers;
  for (const outcome of ['success', 'failure', 'abnormal-fixture']) {
    const directory = join(root, `owned-child-${outcome}`), children = [], normalOutput = new Map();
    const options = { executablePath: process.execPath, headless: true, args: [], marker: {} };
    const browser = {}, original = new Error('owned child controlled launch failure');
    let launches = 0, cleanupErrors = 0;
    const fake = { launch: async supplied => {
      launches++;
      for (const key of Object.keys(options)) assert.equal(supplied[key], options[key]);
      const completion = [], childErrors = [];
      try {
        for (const kind of ['other', 'owned']) {
          const child = spawn(process.execPath, [script, kind], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
          children.push(child);
          const output = { stdout: [], stderr: [] };
          normalOutput.set(child, output); // Chunk order is defined per child/pipe, not across processes or pipes.
          const consumeStdout = chunk => output.stdout.push(chunk.toString('utf8'));
          const consumeStderr = chunk => output.stderr.push(chunk.toString('utf8'));
          const onError = error => childErrors.push(error);
          // These are the fixture's normal consumers and error handling, not observer listeners.
          child.stdout.on('data', consumeStdout); child.stderr.on('data', consumeStderr); child.once('error', onError);
          completion.push(new Promise(resolve => child.once('close', code => {
            child.removeListener('error', onError); child.stdout.removeListener('data', consumeStdout); child.stderr.removeListener('data', consumeStderr);
            resolve(code);
          })));
          if (kind === 'owned') {
            supplied.logger('puppeteer:browsers:launcher')(`Launched ${child.pid}`);
            if (outcome === 'abnormal-fixture') throw original;
          }
          await new Promise((resolve, reject) => child.send('write', error => error ? reject(error) : resolve()));
        }
        const codes = await Promise.all(completion);
        if (childErrors.length) throw childErrors[0];
        assert(codes.every(code => code === 0), 'Owned Node fixtures must exit normally');
        if (outcome === 'failure') throw original;
        return browser;
      } finally {
        // Only handles created by this fixture, never a PID scan or global process cleanup.
        // Await actual close events even after spawn, IPC or assertion failures; preserve the thrown object.
        for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill(); } catch { cleanupErrors++; }
          }
        }
        await Promise.all(completion);
      }
    } };
    if (outcome !== 'success') await assert.rejects(launchWithEvidence(fake, options, { directory }), error => error === original);
    else assert.equal(await launchWithEvidence(fake, options, { directory }), browser);
    assert.equal(launches, 1);
    assert.equal(cleanupErrors, 0);
    assert.equal(actualChannel.hasSubscribers, baseline);
    for (const child of children) {
      if (outcome === 'abnormal-fixture') assert(child.exitCode !== null || child.signalCode !== null);
      else assert.equal(child.exitCode, 0);
      for (const event of ['spawn', 'exit', 'close', 'error']) assert.equal(child.listenerCount(event), 0);
      for (const stream of [child.stdout, child.stderr]) assert.equal(stream.listenerCount('data'), 0);
    }
    const record = await (await records(directory)).read(outcome !== 'success' ? 'failure.json' : 'launched.json');
    if (outcome === 'abnormal-fixture') continue; // Both owned handles have closed before the original error reaches us.
    assert.equal(record.browserOutput.matched, true);
    assert(record.browserOutput.records.some(entry => entry.text === 'normal consumer output'));
    assert(record.browserOutput.records.some(entry => entry.text === 'safe stderr'));
    assert.deepEqual(record.browserOutput.childEvents.map(event => event.event), ['exit', 'close']);
    assert.doesNotMatch(JSON.stringify(record.browserOutput), /unrelated-real-secret|real-split-secret|private-id|private-path|query-secret|partial-real-secret|DevTools/);
    assert.match(normalOutput.get(children[0]).stdout.join(''), /unrelated-real-secret/);
    assert.match(normalOutput.get(children[1]).stdout.join(''), /token=real-split-secret/);
    assert.match(normalOutput.get(children[1]).stdout.join(''), /DevTools listening on ws:\/\/host\/private-id/);
    assert.match(normalOutput.get(children[1]).stderr.join(''), /safe stderr/);
  }
}

export async function browserLaunchEvidenceSelfTest() {
  await browserIdentitySelfTest();
  const root = await mkdtemp(join(tmpdir(), 'fairbeam-launch-evidence-test-'));
  const records = async directory => {
    const entries = await readdir(directory);
    assert.equal(entries.length, 1);
    const folder = join(directory, entries[0]);
    return { folder, read: async name => JSON.parse(await readFile(join(folder, name), 'utf8')) };
  };
  try {
    observerSelfTest();
    const directory = join(root, 'failed'), events = [], messages = [];
    const options = { executablePath: 'fixture-browser', headless: true,
      args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'], marker: {} };
    const original = new Error('fixture timeout https://user:pass@127.0.0.1/error?token=url-secret#fragment token=error-secret');
    const secretObject = { toString() { throw new Error('Logger must not inspect an object'); }, secret: 'object-secret' };
    let calls = 0, cleaned = false;
    const stack = { diagnostics: () => {
      assert.equal(cleaned, false, 'Capture must precede caller cleanup');
      events.push('capture');
      return Array.from({ length: 8 }, () => ({ name: 'vite password=name-secret', pid: 123,
        exited: false, output: 'https://user:pass@127.0.0.1/?token=stack-url-secret Bearer bearer-secret\n'
          + '"token": "quoted secret with spaces"\n'
          + 'powershell -EncodedCommand ZW5jb2RlZC1zZWNyZXQ=\n' + 'x'.repeat(20000),
        env: { secret: 'environment-secret' }, command: 'command-secret' }));
    } };
    const fake = { launch: async supplied => {
      calls++;
      assert.deepEqual(Object.keys(supplied).sort(), [...Object.keys(options), 'logger'].sort());
      for (const key of Object.keys(options)) assert.equal(supplied[key], options[key], `Preserve option ${key}`);
      const { read } = await records(directory);
      const prelaunch = await read('prelaunch.json');
      assert.equal(prelaunch.phase, 'before-launch');
      assert.equal(prelaunch.executableIdentity.scope, 'selected-executable-on-disk-before-launch');
      assert.equal(prelaunch.executableIdentity.status, 'unavailable');
      assert.equal(prelaunch.executableIdentity.sha256, null);
      assert(Number.isSafeInteger(prelaunch.prelaunchPreparationMs) && prelaunch.prelaunchPreparationMs >= 0);
      assert.deepEqual(Object.keys(prelaunch.hostedImage).sort(), ['imageOS', 'imageVersion', 'runnerArch', 'runnerOS']);
      events.push('launch');
      assert.equal(supplied.logger('puppeteer:protocol:SEND ►'), undefined);
      const log = supplied.logger('puppeteer:browsers:launcher');
      log(secretObject); log('Launching secret command', secretObject);
      log('Launched 123', secretObject); log('Browser process 999 exists');
      for (let i = 0; i < 90; i++) log('Browser process 123 exists', secretObject);
      throw original;
    } };
    try {
      await assert.rejects(launchWithEvidence(fake, options, { directory, stack, report: message => messages.push(message) }),
        error => error === original, 'Rethrow the exact original object');
    } finally {
      const { read } = await records(directory);
      assert.equal((await read('failure.json')).phase, 'launch-failed', 'Evidence must exist before caller cleanup');
      cleaned = true; events.push('cleanup');
    }
    assert.equal(calls, 1, 'Never retry a failed launch');
    assert.deepEqual(events, ['launch', 'capture', 'cleanup']);
    assert.deepEqual(messages, []);
    const { read } = await records(directory), failed = await read('failure.json'), intent = await read('prelaunch.json');
    assert.equal(failed.ownedPid, 123);
    assert.equal(failed.lifecycle.length, 64); assert.equal(failed.dropped, 27);
    assert(failed.lifecycle.every(entry => entry.pid === 123));
    assert.equal(failed.processes.length, 4);
    assert(failed.processes.every(entry => entry.output.length <= 4000));
    assert.equal(intent.explicitTimeout, false); assert.equal(intent.explicitProfile, false);
    assert.equal(intent.explicitTransport, false);
    assert.deepEqual(intent.approvedArguments, options.args);
    assert.doesNotMatch(JSON.stringify({ failed, intent }), /url-secret|error-secret|name-secret|bearer-secret|quoted secret|ZW5jb2Rl|object-secret|environment-secret|command-secret|user:pass|fragment/);

    const successDir = join(root, 'success'), browser = {};
    let succeeded = 0;
    assert.equal(await launchWithEvidence({ launch: async () => { succeeded++; return browser; } }, options,
      { directory: successDir, stack: { diagnostics: () => { throw new Error('Successful launch needs no failure snapshot'); } } }), browser);
    assert.equal(succeeded, 1);
    const success = await records(successDir);
    assert.equal((await success.read('launched.json')).phase, 'launched');
    await assert.rejects(success.read('failure.json'), { code: 'ENOENT' });

    // An existing non-executable fixture exercises the actual prelaunch disk read
    // without executing a browser or treating an absent version resource as fatal.
    const fixturePath = join(root, 'metadata-only.bin');
    await writeFile(fixturePath, 'abc');
    const metadataDir = join(root, 'metadata');
    assert.equal(await launchWithEvidence({ launch: async supplied => {
      assert.equal(supplied.executablePath, fixturePath);
      const { read } = await records(metadataDir);
      const identity = (await read('prelaunch.json')).executableIdentity;
      assert.equal(identity.status, 'recorded');
      assert.equal(identity.stableDuringRead, true);
      assert.equal(identity.bytes, 3);
      assert.equal(identity.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      assert.equal(identity.fileVersion, null);
      assert.equal(identity.productVersion, null);
      return browser;
    } }, { ...options, executablePath: fixturePath }, { directory: metadataDir }), browser);

    const badDirectory = join(root, 'regular-file');
    await writeFile(badDirectory, 'not a directory');
    const warnings = [], secondary = { directory: badDirectory, report: message => warnings.push(message) };
    for (const outcome of ['success', 'failure']) {
      const bus = fixtureChannel(), children = [];
      const fakeWriteFailure = { launch: async supplied => {
        const child = fixtureChild(bus, options.executablePath, 123); children.push(child);
        supplied.logger('puppeteer:browsers:launcher')('Launched 123'); child.emit('spawn');
        child.stdout.emit('data', Buffer.from('token=write-error-secret\n'));
        if (outcome === 'failure') throw original;
        return browser;
      } };
      const evidence = { ...secondary, processChannel: bus };
      if (outcome === 'failure') await assert.rejects(launchWithEvidence(fakeWriteFailure, options, evidence), error => error === original);
      else assert.equal(await launchWithEvidence(fakeWriteFailure, options, evidence), browser);
      assertDetached(bus, children);
    }
    assert(warnings.length >= 2, 'Evidence write failures must be reported, not change launch outcomes');
    assert.doesNotMatch(warnings.join('\n'), /error-secret|url-secret/);
    const captureDir = join(root, 'capture-error');
    await assert.rejects(launchWithEvidence({ launch: async () => { throw original; } }, options,
      { directory: captureDir, stack: { diagnostics: () => { throw new Error('token=capture-secret'); } } }), error => error === original);
    assert.doesNotMatch(JSON.stringify(await (await records(captureDir)).read('failure.json')), /capture-secret/);
    const unreadable = Object.create(null, { stack: { get() { throw new Error('unreadable stack'); } } });
    await assert.rejects(launchWithEvidence({ launch: async () => { throw unreadable; } }, options,
      { directory: join(root, 'unreadable') }), error => error === unreadable);
    const unavailableDir = join(root, 'unavailable');
    await assert.rejects(launchWithEvidence({ launch: async () => { throw original; } }, options,
      { directory: unavailableDir, processChannel: null }), error => error === original);
    assert.equal((await (await records(unavailableDir)).read('failure.json')).browserOutput.available, false);
    await ownedNodeChildSelfTest(root, records);
  } finally {
    assert.equal(resolve(dirname(root)), resolve(tmpdir()));
    assert(basename(root).startsWith('fairbeam-launch-evidence-test-'));
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await browserLaunchEvidenceSelfTest();
  console.log('Browser launch evidence checks passed (no browser started).');
}
