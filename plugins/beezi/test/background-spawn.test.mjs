import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnDetached } from '../lib/background-spawn.mjs';

test('spawnDetached passes the script and args, detached and unref\'d', () => {
  const calls = [];
  let unrefs = 0;
  const ok = spawnDetached('/s.mjs', { spawnImpl: (exe, args, opts) => { calls.push({ exe, args, opts }); return { unref() { unrefs += 1; } }; } }, ['--account', 'k']);
  assert.equal(ok, true);
  assert.deepEqual(calls[0].args, ['/s.mjs', '--account', 'k']);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.equal(unrefs, 1);
});

test('a throwing spawn reports false', () => {
  assert.equal(spawnDetached('/s.mjs', { spawnImpl: () => { throw new Error('EAGAIN'); } }), false);
});
