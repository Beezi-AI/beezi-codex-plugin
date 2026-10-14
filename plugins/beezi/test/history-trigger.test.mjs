import test from 'node:test';
import assert from 'node:assert/strict';
import { startHistoryWorker, maybeStartPendingHistory, takeDeferFlag, HISTORY_WORKER_SCRIPT } from '../lib/history-trigger.mjs';

const T0 = Date.parse('2026-10-13T10:00:00.000Z');
const row = (key, pending) => ({ key, status: 'linked', tenants: [{ id: 'A' }, { id: 'B' }], pendingHistory: pending });
const spawnLog = () => {
  const calls = [];
  return { calls, spawnImpl: (exe, args) => { calls.push(args); return { unref() {} }; } };
};

test('startHistoryWorker spawns only for an account with pending history', async () => {
  const s = spawnLog();
  const listAccounts = async () => [row('k1', [{ tenantId: 'B', requestedAt: new Date(T0).toISOString() }]), row('k2', [])];
  assert.equal(await startHistoryWorker('k1', { listAccounts, spawnImpl: s.spawnImpl }), true);
  assert.equal(await startHistoryWorker('k2', { listAccounts, spawnImpl: s.spawnImpl }), false);
  assert.deepEqual(s.calls, [[HISTORY_WORKER_SCRIPT, '--account', 'k1']]);
});

test('maybeStartPendingHistory spawns only due accounts', async () => {
  const s = spawnLog();
  const fresh = new Date(T0 - 60 * 1000).toISOString();
  const listAccounts = async () => [
    row('due', [{ tenantId: 'B', requestedAt: fresh, lastAttemptAt: null }]),
    row('recent', [{ tenantId: 'B', requestedAt: fresh, lastAttemptAt: fresh }]),
  ];
  assert.equal(await maybeStartPendingHistory({ listAccounts, spawnImpl: s.spawnImpl, now: () => T0 }), 1);
  assert.deepEqual(s.calls, [[HISTORY_WORKER_SCRIPT, '--account', 'due']]);
});

test('a throwing account list never escapes', async () => {
  const listAccounts = async () => { throw new Error('index locked'); };
  assert.equal(await maybeStartPendingHistory({ listAccounts }), 0);
  assert.equal(await startHistoryWorker('k1', { listAccounts }), false);
});

test('takeDeferFlag strips the flag wherever it sits', () => {
  assert.deepEqual(takeDeferFlag(['rule', 'add', '--defer-upload', '--repo', 'x']), { deferUpload: true, argv: ['rule', 'add', '--repo', 'x'] });
  assert.deepEqual(takeDeferFlag(['joined']), { deferUpload: false, argv: ['joined'] });
});
