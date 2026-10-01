import '../tools/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../lib/paths.mjs';
import * as watcher from '../lib/rollout-watcher.mjs';
import * as rates from '../lib/rate-limits-codex.mjs';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { drainRateLimitSnapshots } from '../lib/usage-report-codex.mjs';
import { runAudit, SYNC_MODE } from '../lib/session-audit.mjs';
import { pruneStale } from '../lib/prune.mjs';
import { acquireLock, sharedLock, forgetHeldLocks } from '../lib/single-instance-lock.mjs';
import { linkAccount, accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// One linked account: these regressions are about the engine, not about which tenant is reported
// to, so every one of them runs against a single account the way a real single-account install
// does — which is also the case the keyed layout has to keep working unchanged.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'fake');

function home(t) {
  const oldHome = process.env.BEEZI_CODEX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-data-'));
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => { forgetHeldLocks(); process.env.BEEZI_CODEX_HOME = oldHome; fs.rmSync(dir, { recursive: true, force: true }); });
  linkAccount(dir, KEY);
  return dir;
}
const id = '11111111-2222-3333-4444-555555555555';
const at = n => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const meta = cwd => ({ type: 'session_meta', timestamp: at(0), payload: { id, cwd } });
const token = n => ({ type: 'event_msg', timestamp: at(n), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: n * 10, cached_input_tokens: 0, output_tokens: n, total_tokens: n * 11 } } } });
const rows = cwd => [meta(cwd), { type: 'turn_context', timestamp: at(1), payload: { cwd, model: 'gpt-5.2-codex' } }, token(10), token(20), token(30), token(40), token(50)];
const write = (file, records) => fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
const cpDeps = (dir, file) => ({ linkedSessions: async () => [SESSION], env: {}, readCodexAuthSignals: () => ({ authMode: null, hasStoredApiKey: false }), resolveTranscript: () => ({ sessionId: id, transcriptPath: file }), gitImpl: () => null, readAgents: () => ({}), findSubagentRollouts: () => [] });
const observation = n => ({ observedAt: at(n), limitId: 'codex', planType: 'plus', fiveHour: { pct: n * 10, resetsAt: 1800000000 }, sevenDay: null, monthly: null, raw: null });

test('F1: existing unreadable metadata fails closed while ENOENT keeps defaults', t => {
  const dir = home(t), file = path.join(dir, 'env.json');
  assert.equal(paths.environment.readEnvJson(file).present, false);
  fs.writeFileSync(file, '{}');
  const read = fs.readFileSync;
  fs.readFileSync = function (p, ...args) { if (p === file) { const e = new Error('denied'); e.code = 'EACCES'; throw e; } return read.call(this, p, ...args); };
  let metadata;
  try { metadata = paths.environment.readEnvJson(file); } finally { fs.readFileSync = read; }
  assert.equal(metadata.present, true);
  assert.ok(paths.environment.resolveEnvironment({ envJson: metadata, env: {} }).error);
});

test('F2: incomplete rollout headers are reclassified by the same watcher', async t => {
  const dir = home(t), file = path.join(dir, `rollout-${id}.jsonl`);
  fs.writeFileSync(file, '{"type":"session_meta"');
  const deps = { headCache: new Map(), listRolloutFiles: () => [file], yieldControl: async () => {} };
  assert.equal((await watcher.scanPass({ sessionsDir: dir }, deps)).tops.size, 0);
  write(file, [meta(dir)]);
  assert.equal((await watcher.scanPass({ sessionsDir: dir }, deps)).tops.size, 1);
});

test('F3: a retained observation with a pruned cursor consults coverage before resuming', async t => {
  const dir = home(t), file = path.join(dir, `rollout-${id}.jsonl`), records = rows(dir);
  const deps = cpDeps(dir, file), sent = [];
  write(file, records.slice(0, 5));
  await runCheckpoint({ session_id: id, cwd: dir }, deps, { skipFlush: true, sink: p => sent.push(p) });
  const stat = fs.statSync(file), before = Date.now() - 15 * 86400000;
  watcher.saveObservations({ version: 1, sessions: { [id]: { mtimeMs: stat.mtimeMs, size: stat.size, at: before } }, children: {} });
  const state = path.join(paths.stateDir(), `${id}.json`);
  fs.utimesSync(state, before / 1000, before / 1000); pruneStale();
  assert.equal(fs.existsSync(state), false);
  write(file, records);
  let coverageCalls = 0;
  await watcher.runWatchPass({ linkedSessions: async () => [SESSION], pruneStale: () => {}, listRolloutFiles: () => [file], yieldControl: async () => {},
    fetchCoverage: async () => { coverageCalls++; return new Map([[id, 5]]); }, isLiveTrackingAllowed: () => true, readTrackingState: () => null,
    runCheckpoint: (input, _deps, opts) => runCheckpoint(input, { ...deps, ..._deps }, { ...opts, drainRateLimits: false, skipFlush: true, sink: p => sent.push(p) }),
  }, { sessionsDir: dir, cooldownMs: 0 });
  assert.equal(coverageCalls, 1);
  assert.deepEqual(sent.map(p => [p.from_line, p.to_line]), [[1, 5], [6, 7]]);
  assert.equal(sent.reduce((n, p) => n + p.token_total, 0), 550);
});

test('F4: a competing quota append defers, then survives retry after clear', t => {
  // Two files since the split: the debounce SERIES is machine-level, the pending QUEUE is the
  // account's. The refusal the case is about is unchanged — a record that lands mid-clear is told
  // the queue is busy rather than interleaving with it — it is now the series lock that says so,
  // because a rank-3 lock may not be taken while the clear holds the rank-3 pending one.
  const dir = home(t);
  const io = { file: path.join(dir, 'usage.json'), pendingFile: path.join(dir, 'usage-pending.json') };
  rates.recordRateLimitObservations([observation(1)], [KEY], io);
  const acknowledged = rates.readPendingRateLimits(KEY, io);
  const read = fs.readFileSync;
  let armed = true, blocked = false;
  fs.readFileSync = function (p, ...args) {
    const snapshot = read.call(this, p, ...args);
    if (p === io.pendingFile && armed) {
      armed = false;
      try { rates.recordRateLimitObservations([observation(2)], [KEY], io); }
      catch (e) { blocked = e.code === 'RATE_LIMIT_QUEUE_BUSY'; }
    }
    return snapshot;
  };
  try { rates.clearPendingRateLimits(KEY, acknowledged, io); } finally { fs.readFileSync = read; }
  assert.equal(blocked, true);
  rates.recordRateLimitObservations([observation(2)], [KEY], io);
  assert.deepEqual(rates.readPendingRateLimits(KEY, io).map(r => r.fetched_at), [at(2)]);
});

test('F4: a busy quota queue prevents checkpoint cursor advancement until retry', async t => {
  const dir = home(t), file = path.join(dir, 'rollout.jsonl');
  const records = rows(dir).slice(0, 3);
  records[2].payload.rate_limits = { primary: { used_percent: 20, window_minutes: 300, resets_at: 1800000000 } };
  write(file, records);
  const held = acquireLock(sharedLock('rate-limit-observations'), {});
  assert.equal(held.ok, true);
  forgetHeldLocks(); // simulate an independent process holding the machine-wide lock
  const sent = [], options = { skipFlush: true, sink: p => sent.push(p) };
  const first = await runCheckpoint({ session_id: id, cwd: dir }, cpDeps(dir, file), options);
  assert.equal(first.skipped.rateLimitDeferred, true);
  assert.equal(watcher.checkpointSucceeded(first), false);
  assert.equal(fs.existsSync(path.join(paths.stateDir(), `${id}.json`)), false);
  assert.equal(sent.length, 0);
  held.handle.release();
  await runCheckpoint({ session_id: id, cwd: dir }, cpDeps(dir, file), options);
  assert.equal(sent.length, 1);
  assert.equal(rates.readPendingRateLimits(KEY).length, 1);
});

for (const drain of [{ lockSkipped: true }, { unreadable: 1 }]) {
  test(`F5: history sync defers on incomplete drain ${JSON.stringify(drain)}`, async t => {
    home(t);
    let asked = false;
    const result = await runAudit({ linkedSessions: async () => [SESSION], getDefaultKey: async () => KEY,
      flushQueueImpl: async () => ({ flushed: 0, failed: 0, deferred: 0, ...drain }),
      readTrackingStateImpl: () => null,
      fetchCoverageImpl: async () => { asked = true; return new Map(); },
      whoamiImpl: async () => { asked = true; return { valid: true }; },
    }, { mode: SYNC_MODE, dryRun: true });
    assert.equal(result.reason, 'pending-not-drained');
    assert.equal(asked, false);
  });
}

test('F6: queued quota rows receive billing.json identifiers on upload', async t => {
  home(t);
  fs.mkdirSync(path.dirname(paths.billingConfigFile()), { recursive: true });
  fs.writeFileSync(paths.billingConfigFile(), JSON.stringify({ accountId: 'billing-account', email: 'billing@example.com' }));
  rates.recordRateLimitObservations([observation(1)], [KEY]);
  const posted = [];
  await drainRateLimitSnapshots(KEY, SESSION, { env: {}, readChatgptAuth: () => ({ accountId: 'account-B' }),
    fetchImpl: async (_url, opts) => { posted.push(JSON.parse(opts.body)); return { status: 200 }; },
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].account_uuid, 'billing-account');
  assert.equal(posted[0].account_email, 'billing@example.com');
  assert.equal(rates.readPendingRateLimits(KEY).length, 0);
});

test('F7: shortening a checkpointed rollout preserves its cursor and emits no overlap', async t => {
  const dir = home(t), file = path.join(dir, 'rollout.jsonl'), records = rows(dir);
  const deps = cpDeps(dir, file), sent = [];
  const checkpoint = () => runCheckpoint({ session_id: id, cwd: dir }, deps, { skipFlush: true, sink: p => sent.push(p) });
  write(file, records.slice(0, 5)); await checkpoint();
  write(file, records); await checkpoint();
  write(file, records.slice(0, 6));
  const result = await checkpoint();
  assert.equal(result.skipped.deltaFailed, true);
  assert.equal(watcher.checkpointSucceeded(result), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.stateDir(), `${id}.json`))).cursor, 7);
  assert.equal(sent.reduce((n, p) => n + p.token_total, 0), 550);
});

test('F8: pruning cannot remove a successor acquired after the old lock stat', t => {
  home(t);
  const target = sharedLock('review-race'), old = Date.now() - 2 * 3600000;
  const first = acquireLock(target, { leaseMs: 30000 }, { now: () => old });
  assert.equal(first.ok, true);
  fs.utimesSync(target.file, old / 1000, old / 1000); forgetHeldLocks();
  const stat = fs.statSync;
  let armed = true, successor;
  fs.statSync = function (p, ...args) {
    const snapshot = stat.call(this, p, ...args);
    if (p === target.file && armed) { armed = false; successor = acquireLock(target, { leaseMs: 30000 }); forgetHeldLocks(); }
    return snapshot;
  };
  try { pruneStale(); } finally { fs.statSync = stat; }
  assert.ok(successor.ok);
  assert.equal(successor.handle.verify().ok, true);
  successor.handle.release();
});
