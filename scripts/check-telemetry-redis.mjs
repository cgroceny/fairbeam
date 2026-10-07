// Optional integration check using a disposable Redis instance over a Unix socket.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { COUNT_INSTALL_LUA } from '../api/_ping-core.js';
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
    const id = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b';
    const keys = week => [`salt:${week}`, `ids:${week}`, `tuple:${week}`, 'aggregates'];
    const count = (week, install = id, salt = 'random-salt', tuple = week) => command('EVAL', COUNT_INSTALL_LUA, 4, ...keys(week), salt, install, expires, tuple);
    assert.equal(count('week1'), '1');
    assert.equal(count('week1', id, 'ignored-salt'), '1');
    assert.equal(command('GET', 'salt:week1'), 'random-salt');
    assert.equal(count('week1', '2b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b'), '2');
    assert.equal(command('HGET', 'aggregates', 'cumulative_weekly_distinct'), '2');
    const hash = command('SMEMBERS', 'ids:week1').split('\n')[0];
    assert.match(hash, /^[a-f0-9]{40}$/); assert.notEqual(hash, id);
    for (const key of keys('week1').slice(0, 3)) {
      assert.equal(command('EXPIRETIME', key), String(expires));
      command('EXPIREAT', key, 1); assert.equal(command('EXISTS', key), '0');
    }
    assert.equal(command('HGET', 'aggregates', 'week1'), '2', 'aggregate survives expiry');
    assert.equal(count('week2', id, 'new-salt'), '1');
    assert.notEqual(command('SMEMBERS', 'ids:week2'), hash);
    assert.equal(command('HGET', 'aggregates', 'cumulative_weekly_distinct'), '3', 'cumulative count is a weekly sum');
    // A second version tuple counts independently, without increasing the week's global count.
    assert.equal(command('EVAL', COUNT_INSTALL_LUA, 4, 'salt:week2', 'ids:week2', 'tuple:version2', 'aggregates', 'ignored', id, expires, 'version2'), '1');
    assert.equal(command('HGET', 'aggregates', 'cumulative_weekly_distinct'), '3');
    assert.ok(!command('HGETALL', 'aggregates').includes(id));
    console.log('Redis integration: deduplication, salt reuse/rotation, tuple separation, expiry and aggregate retention passed.');
  } finally {
    server.kill('SIGTERM'); await closed;
    rmSync(dir, { recursive: true, force: true });
  }
}
