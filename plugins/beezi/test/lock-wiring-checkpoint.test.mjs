import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runCheckpoint, flushQueue } from '../lib/checkpoint.mjs';
import { initSessionState } from '../lib/session-start.mjs';
import { queueDir, stateDir, trackingStateFile } from '../lib/paths.mjs';
import { readTrackingState } from '../lib/tracking.mjs';
import { grantConsent, diagnosticsDir } from '../lib/diagnostics.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { linkAccount, accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';
import {
  acquireLock,
  inspectLock,
  heldLocks,
  forgetHeldLocks,
  sessionLock,
  sharedLock,
} from '../lib/single-instance-lock.mjs';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The WIRING, not the primitive. test/single-instance-lock.test.mjs proves the lock is a sound
// mutual exclusion; everything here proves the checkpoint write paths actually take it.
//
// Every case is a PAIR: the contended run and then the identical call with the lock released. That
// is what makes these tests bite — a concurrency test whose "blocked" branch would also pass with
// the lock deleted is worse than no test, so each one shows the same fixtures producing a
// different outcome for exactly one reason.
//
// Nothing sleeps and nothing spawns. "Another process holds it" is modelled the way the primitive's
// own suite models it: acquire with a foreign pid, then forgetHeldLocks() to drop THIS process's
// bookkeeping, so the production code under test can only learn about the holder from the
// filesystem — which is the only channel a real second process would have either.
// ─────────────────────────────────────────────────────────────────────────────────────────────

afterEach(() => forgetHeldLocks());

// The queue and the tracking cache are per account, and so are their locks:
// `shared:queue-<key>` and `shared:tracking-<key>`. The RANKS are what this file is about and they
// are unchanged — both are rank 3, so the sequential-not-nested property is exactly as load-bearing
// as it was when there was one of each.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');

const tmpHome = (t) => {
  const dir = sandboxHome(t, { prefix: 'beezi-lockwire-', beforeCleanup: forgetHeldLocks });
  linkAccount(dir, KEY);
  return dir;
};

// A holder that this process must not be able to recognise as its own.
function heldElsewhere(target) {
  const got = acquireLock(target, { leaseMs: 60_000 }, { pid: () => 999_999 });
  assert.equal(got.ok, true, 'the fixture itself must take the lock');
  forgetHeldLocks();
  return got.handle;
}

const listQueue = () => (fs.existsSync(queueDir(KEY)) ? fs.readdirSync(queueDir(KEY)).sort() : []);
const statePath = (id) => path.join(stateDir(), `${id}.json`);
const readState = (id) => JSON.parse(fs.readFileSync(statePath(id), 'utf-8'));
const writeState = (id, state) => {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(statePath(id), JSON.stringify(state));
};
const httpRes = (status, body = {}) => ({ status, json: async () => body });

const seg = (over = {}) => ({
  repoRoot: '/repo',
  branch: 'main',
  fromLine: 1,
  toLine: 4,
  stats: {
    models: { 'gpt-5.2-codex': { token_input: 10, token_output: 5, token_cache_read: 0, token_cache_creation: 0, requests: 1 } },
    token_total: 15, token_input: 10, token_output: 5, token_cache: 0,
    duration_sec: 12,
    code_changes: { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} },
    operations: {},
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: '2026-01-01T00:00:12.000Z',
  },
  ...over,
});

function stubTranscript(home) {
  const p = path.join(home, 'rollout.jsonl');
  fs.writeFileSync(p, '\n');
  return p;
}

const deps = (home, segments, over = {}) => ({
  linkedSessions: async () => [SESSION],
  fetchImpl: async () => { throw new Error('offline'); },
  resolveTranscript: () => ({ transcriptPath: stubTranscript(home), sessionId: 's1' }),
  computeDelta: () => ({ nextCursor: 4, segments, apiErrorEvents: [] }),
  gitImpl: () => 'https://host/org/repo.git',
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The session lock — lib/checkpoint.mjs runCheckpoint().
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('a checkpoint whose session lock is held elsewhere writes nothing at all', async (t) => {
  const home = tmpHome(t);
  let parsed = 0;
  const d = deps(home, [seg()], {
    computeDelta: () => { parsed += 1; return { nextCursor: 4, segments: [seg()], apiErrorEvents: [] }; },
  });

  const holder = heldElsewhere(sessionLock('s1'));
  const blocked = await runCheckpoint({ session_id: 's1', cwd: home }, d);

  assert.equal(blocked.lockSkipped, true);
  assert.equal(blocked.lockReason, 'held', "a busy lock, not 'lock-order'");
  assert.equal(blocked.enqueued, 0);
  // The lock is taken BEFORE the transaction, not around its tail: the transcript is never parsed.
  assert.equal(parsed, 0, 'a deferred checkpoint does no work, it does not do work and discard it');
  assert.deepEqual(listQueue(), [], 'nothing enqueued');
  assert.equal(fs.existsSync(statePath('s1')), false, 'no state written');

  // Same call, same fixtures, same transcript — the ONLY difference is who holds the lock.
  assert.equal(holder.release().ok, true);
  forgetHeldLocks();
  const free = await runCheckpoint({ session_id: 's1', cwd: home }, d);
  assert.equal(free.lockSkipped, undefined);
  assert.equal(free.enqueued, 1);
  assert.equal(parsed, 1);
  assert.equal(readState('s1').cursor, 4);
});

test('the session lock is taken even when state is NOT persisted, because the sink still enqueues', async (t) => {
  const home = tmpHome(t);
  const emitted = [];
  const options = { persistState: false, skipFlush: true, sink: (p) => emitted.push(p) };

  const holder = heldElsewhere(sessionLock('s1'));
  const blocked = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg()]), options);
  assert.equal(blocked.lockSkipped, true);
  assert.deepEqual(emitted, [], 'the backfill sink is a writer too, and it was not reached');

  assert.equal(holder.release().ok, true);
  forgetHeldLocks();
  const free = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg()]), options);
  assert.equal(free.enqueued, 1);
  assert.equal(emitted.length, 1);
});

test('the lock a checkpoint holds is the ROOT session lock, and exactly one of them', async (t) => {
  const home = tmpHome(t);
  let inside = null;
  let held = null;
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg()], {
    computeDelta: () => {
      inside = inspectLock(sessionLock('s1'));
      held = heldLocks();
      return { nextCursor: 4, segments: [seg()], apiErrorEvents: [] };
    },
  }), { skipFlush: true });

  assert.equal(inside.held, true, 'the transaction runs under the lock, not beside it');
  assert.equal(inside.holder.kind, 'session');
  assert.equal(path.basename(inside.file), 'session-s1.lock', 'keyed on the session id itself');
  assert.equal(held.length, 1, 'one lock, not one per subagent — rank 2 may never nest');
  assert.equal(held[0].rank, 2);

  // And it is handed back, so the next checkpoint on this session is not left waiting out a lease.
  assert.equal(inspectLock(sessionLock('s1')).held, false);
});

test('the session lock is released even when the transaction throws', async (t) => {
  const home = tmpHome(t);
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg()], {
    resolveSessionName: () => { throw new Error('boom'); },
  }));
  assert.equal(result.outcome, 'failed');
  assert.equal(inspectLock(sessionLock('s1')).held, false, 'a thrown section still hands the lock back');
  assert.deepEqual(heldLocks(), [], 'and the process-local ordering entry with it');

  // Proof that the release was real and not merely a stale file: the next checkpoint takes it.
  const ok = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg()]), { skipFlush: true });
  assert.equal(ok.enqueued, 1);
});

test('a transaction that LOST its lock mid-run does not commit the cursor', async (t) => {
  const home = tmpHome(t);
  let thief = null;
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg()], {
    computeDelta: () => {
      // Somebody else ends up owning this session's lock while we are still inside the section.
      fs.unlinkSync(sessionLock('s1').file);
      forgetHeldLocks();
      thief = acquireLock(sessionLock('s1'), { leaseMs: 60_000 }, { pid: () => 999_999 });
      forgetHeldLocks();
      return { nextCursor: 4, segments: [seg()], apiErrorEvents: [] };
    },
  }), { skipFlush: true });

  assert.equal(thief.ok, true);
  // The segments are still emitted: the server upserts by segmentId, so re-covering a window is
  // idempotent and suppressing it would lose data for nothing.
  assert.equal(result.enqueued, 0);
  assert.equal(result.outcome, 'deferred');
  // The cursor is what must not move. Advancing it here is the lost update R3 names — the other
  // owner is computing its own delta from the cursor we would have overwritten.
  assert.equal(fs.existsSync(statePath('s1')), false, 'a transaction that lost its lock must not commit');
  thief.handle.release();
});

test("an EXPIRED lease is not a lost lock: the state write still commits", async (t) => {
  const home = tmpHome(t);
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg()], {
    computeDelta: () => {
      // Our own lease lapses while we are on the network — the manual `track` path has no budget
      // and routinely outruns one. Nobody took the lock: the generation on disk is still ours.
      const file = sessionLock('s1').file;
      const record = JSON.parse(fs.readFileSync(file, 'utf-8'));
      record.renewedAt = Date.now() - 10 * 60 * 1000;
      record.expiresAt = Date.now() - 9 * 60 * 1000;
      fs.writeFileSync(file, JSON.stringify(record));
      return { nextCursor: 4, segments: [seg()], apiErrorEvents: [] };
    },
  }), { skipFlush: true });

  assert.equal(result.enqueued, 1);
  assert.equal(readState('s1').cursor, 4,
    "collapsing 'expired' into 'lost' would silently stop persisting state on the no-budget path");
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The queue lock — lib/checkpoint.mjs flushQueue(), covering its bare caller in session-start too.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('a flush whose queue lock is held elsewhere reads no file and posts nothing', async (t) => {
  tmpHome(t);
  fs.mkdirSync(queueDir(KEY), { recursive: true });
  fs.writeFileSync(path.join(queueDir(KEY), 'seg-1.json'), JSON.stringify({ segmentId: 's:1', sessionId: 's1' }));
  const posted = [];
  const fetchImpl = async (url, init) => { posted.push(JSON.parse(init.body)); return httpRes(200); };

  const holder = heldElsewhere(sharedLock(`queue-${KEY}`));
  const blocked = await flushQueue(KEY, SESSION, { fetchImpl });

  assert.equal(blocked.lockSkipped, true);
  assert.equal(blocked.lockReason, 'held');
  assert.equal(blocked.flushed, 0);
  assert.deepEqual(posted, [], 'a deferred drain does not double-post what the holder is posting');
  assert.deepEqual(listQueue(), ['seg-1.json'], 'and it does not unlink what the holder has not judged');

  assert.equal(holder.release().ok, true);
  forgetHeldLocks();
  const free = await flushQueue(KEY, SESSION, { fetchImpl });
  assert.equal(free.flushed, 1);
  assert.equal(posted.length, 1);
  assert.deepEqual(listQueue(), []);
});

test('the dark-mode verdict is written OUTSIDE the queue lock, so a 403 still reaches tracking.json', async (t) => {
  tmpHome(t);
  fs.mkdirSync(queueDir(KEY), { recursive: true });
  fs.writeFileSync(path.join(queueDir(KEY), 'seg-1.json'), JSON.stringify({ segmentId: 's:1', sessionId: 's1' }));

  const result = await flushQueue(KEY, SESSION, {
    fetchImpl: async () => httpRes(403, { code: 'TRACKING_DISABLED', message: 'audit mode' }),
  });

  assert.equal(result.trackingDisabled, true);
  // THE assertion. markTrackingDisabled takes `shared:tracking`, which is rank 3 — the same rank as
  // the queue lock the drain holds. Called from inside the drain it would be refused with
  // 'lock-order' (permanent, never retried) and this file would never be written, so the tenant
  // would go on being hammered for every queued report forever.
  assert.equal(fs.existsSync(trackingStateFile(KEY)), true, 'the verdict was recorded, not swallowed');
  const state = readTrackingState(KEY);
  assert.equal(state.trackingMode, 'disabled');
  assert.equal(state.reason, 'audit mode');
  assert.deepEqual(listQueue(), ['seg-1.json'], 'and the files are HELD, not dropped');
});

test('THE PRODUCTION PATH: session(2) → queue(3) → tracking(3) in one process', async (t) => {
  tmpHome(t);
  fs.mkdirSync(queueDir(KEY), { recursive: true });
  fs.writeFileSync(path.join(queueDir(KEY), 'seg-1.json'), JSON.stringify({ segmentId: 's:1', sessionId: 's1' }));

  // What a Stop hook actually does: runCheckpoint holds the rank-2 session lock and calls
  // flushQueue from inside it, which takes rank-3 `queue`, releases it, and then records the
  // dark-mode verdict under rank-3 `tracking`. The two rank-3 locks are sequential, never nested —
  // but that is a property of WHERE withLockAsync releases, and nothing else in this file pins it.
  // Held by THIS process on purpose: the ordering guard, not the filesystem, has to answer.
  const session = acquireLock(sessionLock('s1'), { leaseMs: 60_000 });
  assert.equal(session.ok, true);
  let insideQueueLock = null;

  const result = await flushQueue(KEY, SESSION, {
    fetchImpl: async () => {
      insideQueueLock = heldLocks().map((l) => l.rank).sort();
      return httpRes(403, { code: 'TRACKING_DISABLED', message: 'audit mode' });
    },
  });

  assert.deepEqual(insideQueueLock, [2, 3], 'the drain runs holding exactly session + queue');
  // If the queue lock were still held here, this write would be refused as 'lock-order'.
  assert.deepEqual(result.trackingDisabledWrite, { written: true, skipped: false, reason: null });
  assert.equal(readTrackingState(KEY).trackingMode, 'disabled');
  assert.deepEqual(heldLocks().map((l) => l.rank), [2], 'and the queue lock was handed back');

  session.handle.release();
});

test('a quarantined queue file is recorded as a diagnostic, not only counted in memory', async (t) => {
  tmpHome(t);
  grantConsent();
  fs.mkdirSync(queueDir(KEY), { recursive: true });
  fs.writeFileSync(path.join(queueDir(KEY), 'bad.json'), 'not json at all');

  const result = await flushQueue(KEY, SESSION, { fetchImpl: async () => httpRes(200) });
  assert.equal(result.quarantined, 1);

  const events = fs.readdirSync(diagnosticsDir())
    .map((f) => JSON.parse(fs.readFileSync(path.join(diagnosticsDir(), f), 'utf-8')));
  assert.equal(events.length, 1, 'the only place a segment leaves the drain for good must leave a trace');
  assert.equal(events[0].code, 'queue_file_quarantined');
  assert.equal(events[0].source, 'checkpoint');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// G-8-8 — the rate-limit drain's verdict, which runCheckpoint used to discard.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('the rate-limit drain result is surfaced on the checkpoint return', async (t) => {
  const home = tmpHome(t);
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg()], {
    drainRateLimitSnapshots: async () => ({ posted: 3, deferred: 2, reason: 'deadline' }),
  }), { emitTimeline: true, skipFlush: true });

  assert.deepEqual(result.rateLimits, { posted: 3, deferred: 2 });
});

test("the drain's early exits carry no `deferred`, so it is normalised rather than left undefined", async (t) => {
  const home = tmpHome(t);
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg()], {
    drainRateLimitSnapshots: async () => ({ posted: 0, reason: 'empty' }),
  }), { drainRateLimits: true, skipFlush: true });

  assert.deepEqual(result.rateLimits, { posted: 0, deferred: 0 });
});

test('a checkpoint that is not a turn end reports null, never a fabricated zero', async (t) => {
  const home = tmpHome(t);
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg()], {
    drainRateLimitSnapshots: async () => { throw new Error('must not run'); },
  }), { skipFlush: true });

  assert.equal(result.rateLimits, null, '"0 posted" would be a claim this run cannot make');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The fifth writer of state/<id>.json — lib/session-start.mjs initSessionState().
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('initSessionState defers instead of rewriting state a concurrent checkpoint owns', (t) => {
  const home = tmpHome(t);
  writeState('s1', { cursor: 42, cwd: 'OLD', transcriptPath: 'OLD' });

  const holder = heldElsewhere(sessionLock('s1'));
  const blocked = initSessionState('s1', { cwd: home, transcriptPath: '/new/rollout.jsonl' });

  assert.equal(blocked.written, false);
  assert.equal(blocked.reason, 'held');
  assert.deepEqual(readState('s1'), { cursor: 42, cwd: 'OLD', transcriptPath: 'OLD' },
    'a resume must not rewrite a file whose cursor another writer is mid-transaction on');

  assert.equal(holder.release().ok, true);
  forgetHeldLocks();
  const free = initSessionState('s1', { cwd: home, transcriptPath: '/new/rollout.jsonl' });
  assert.equal(free.written, true);
  const state = readState('s1');
  assert.equal(state.cursor, 42, 'and the resume guard still never resets a cursor');
  assert.equal(state.cwd, home);
  assert.equal(state.transcriptPath, '/new/rollout.jsonl');
});
