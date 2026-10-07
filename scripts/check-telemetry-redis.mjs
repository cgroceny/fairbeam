// Optional integration check using a disposable Redis instance over a Unix socket.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { COUNT_INSTALL_LUA, WEEK_SALT_LUA, hashInstall } from '../api/_ping-core.js';
const serverPath = process.env.FAIRBEAM_REDIS_SERVER;
const cliPath = process.env.FAIRBEAM_REDIS_CLI;
if (!serverPath || !cliPath) {
  console.log('Redis integration skipped: set FAIRBEAM_REDIS_SERVER and FAIRBEAM_REDIS_CLI.');
} else {
  const dir = mkdtempSync('/tmp/fairbeam-redis-test-');
  const socket = join(dir, 'redis.sock');
  const server = spawn('nice', ['-n', '15', serverPath, '--port', '0', '--unixsocket', socket,
    '--save', '', '--appendonly', 'no', '--dir', dir], { stdio: 'ignore' });
  const closed = new Promise(resolve => server.once('exit', resolve));
  const command = (...args) => execFileSync(cliPath, ['-s', socket, '--raw', ...args.map(String)], { encoding: 'utf8' }).trim();
  try {
    for (let n = 0; !existsSync(socket) && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(socket), 'Redis started');
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const id = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b', other = '2b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b';
    const saltKey = week => `salt:${week}`;
    const salt = (week, candidate) => command('EVAL', WEEK_SALT_LUA, 1, saltKey(week), candidate, expires);
    const count = (week, who, saltValue, tuple = week) => command('EVAL', COUNT_INSTALL_LUA, 3,
      `ids:${week}`, `tuple:${tuple}`, 'aggregates', hashInstall(saltValue, who), expires, tuple);
    // the first request creates the week's salt, later ones (and concurrent ones) get the same value
    const salt1 = salt('week1', 'a'.repeat(64));
    assert.equal(salt1, 'a'.repeat(64));
    assert.equal(salt('week1', 'b'.repeat(64)), salt1);
    assert.equal(count('week1', id, salt1), '1');
    assert.equal(count('week1', id, salt1), '1');
    assert.equal(count('week1', other, salt1), '2');
    assert.equal(command('HGET', 'aggregates', 'cumulative_weekly_distinct'), '2');
    const hash = command('SMEMBERS', 'ids:week1').split('\n').sort()[0];
    assert.match(hash, /^[a-f0-9]{64}$/); assert.ok(![id, other].includes(hash));
    for (const key of ['salt:week1', 'ids:week1', 'tuple:week1']) {
      assert.equal(command('EXPIRETIME', key), String(expires));
      command('EXPIREAT', key, 1); assert.equal(command('EXISTS', key), '0');
    }
    assert.equal(command('HGET', 'aggregates', 'week1'), '2', 'aggregate survives expiry');
    // the next week starts with a new salt: the same install ID gives a different hash and is counted again
    const salt2 = salt('week2', 'c'.repeat(64));
    assert.equal(salt2, 'c'.repeat(64));
    assert.equal(count('week2', id, salt2), '1');
    assert.notEqual(command('SMEMBERS', 'ids:week2'), hash);
    assert.equal(command('HGET', 'aggregates', 'cumulative_weekly_distinct'), '3', 'cumulative count is a weekly sum');
    // A second version tuple counts independently, without increasing the week's global count.
    assert.equal(count('week2', id, salt2, 'version2'), '1');
    assert.equal(command('HGET', 'aggregates', 'cumulative_weekly_distinct'), '3');
    for (const stored of [command('HGETALL', 'aggregates'), command('KEYS', '*'), command('SMEMBERS', 'ids:week2')]) assert.ok(!stored.includes(id) && !stored.includes(other));
    console.log('Redis integration: deduplication, salt reuse/rotation, tuple separation, expiry and aggregate retention passed.');
  } finally {
    server.kill('SIGTERM'); await closed;
    rmSync(dir, { recursive: true, force: true });
  }
}
