import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAudit, SYNC_MODE, HISTORY_RUN_LOCK, RUN_LEASE_MS } from '../lib/session-audit.mjs';
import { BackfillSessionStatus, BackfillHalt } from '../lib/audit-flush.mjs';
import { ReplayDecision } from '../lib/session-coverage.mjs';
import { TrackingMode } from '../lib/tracking.mjs';
import { LOCK_KINDS } from '../lib/single-instance-lock.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// One account per run: its session, its ledger, its coverage record.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');

// G-3-3 under REVIEW.md §R2. Every case R2 names has a test here; the file is ordered by that
// list. Nothing touches the real ~/.beezi-codex or ~/.codex and nothing reaches the network —
// every seam runAudit reads is injected.

// ─── harness ────────────────────────────────────────────────────────────────────────────────

const rollout = (sessionId, over = {}) => ({
  sessionId,
  transcriptPath: `C:/sessions/2026/01/01/rollout-2026-01-01T00-00-00-${sessionId}.jsonl`,
  cwd: 'C:/work/app',
  mtimeMs: 1_000,
  size: 1024,
  ...over,
});

// A parent segment payload, shaped like lib/checkpoint.mjs:458 emits one.
const seg = (sessionId, fromLine, toLine, over = {}) => ({
  segmentId: `${sessionId}:${fromLine}-${toLine}`,
  sessionId,
  remote: 'r',
  branch: 'main',
  from_line: fromLine,
  to_line: toLine,
  ...over,
});

const childSeg = (sessionId, agentId, fromLine, toLine) =>
  seg(sessionId, fromLine, toLine, { segmentId: `${sessionId}:${agentId}:${fromLine}-${toLine}`, is_subagent: true, agent_id: agentId });

const flushResult = (over = {}) => ({
  chunks: 1,
  stored: 0,
  skipped: 0,
  timelines: 0,
  timelinesDropped: 0,
  itemErrors: 0,
  retryableFailures: 0,
  permanentRejections: 0,
  unattributed: 0,
  bySession: new Map(),
  halt: null,
  lastError: null,
  ...over,
});

const emptyQueue = () => ({
  flushed: 0, rejected: 0, failed: 0, deferred: 0, expired: 0,
  quarantined: 0, salvaged: 0, unreadable: 0, unnamed: 0,
  trackingDisabled: false, lastError: null,
});

// A lock double that always grants and records what it was asked for. Injected rather than
// exercised for real so a test's outcome never depends on another test's lock file.
function fakeLock(over = {}) {
  const events = [];
  const handle = {
    kind: LOCK_KINDS.RUN,
    verify: () => { events.push('verify'); return over.verify ? over.verify(events) : { ok: true }; },
    renew: (opts) => { events.push(`renew:${opts.leaseMs}`); return over.renew ? over.renew(events) : { ok: true }; },
    release: () => { events.push('release'); return { ok: true }; },
  };
  const acquire = (target, options) => {
    events.push(`acquire:${target.kind}:${target.name}:${options.leaseMs}`);
    if (over.acquire) return over.acquire(target, options);
    return { ok: true, handle };
  };
  return { acquire, events, handle };
}

// runCheckpoint double: `plan[sessionId]` is a function of the startCursor it was given, so a test
// can assert both what was ASKED for and what came back.
function fakeCheckpoint(plan) {
  const calls = [];
  const impl = async (input, _deps, options) => {
    calls.push({
      sessionId: input.session_id,
      startCursor: options.startCursor,
      sweepSubagents: options.sweepSubagents,
    });
    const make = plan[input.session_id];
    const reports = make ? make(options.startCursor, options) : [];
    for (const payload of reports) options.sink(payload);
    return { outcome: 'committed', enqueued: reports.length, flush: null, sessionErrors: [], agents: {}, skipped: { noRemote: 0, emitFailed: 0, deltaFailed: false } };
  };
  return { impl, calls };
}

function fakeFlush(statusFor = () => BackfillSessionStatus.ACCEPTED) {
  const calls = [];
  const impl = async (groups, _key, _session, _deps, options) => {
    calls.push({ groups, options });
    const bySession = new Map();
    let stored = 0;
    for (const g of groups) {
      const status = statusFor(g.sessionId);
      bySession.set(g.sessionId, { status, reason: null });
      if (status === BackfillSessionStatus.ACCEPTED || status === BackfillSessionStatus.PARTIAL) stored += g.reports.length;
    }
    return flushResult({ stored, bySession });
  };
  return { impl, calls };
}

function makeDeps(over = {}) {
  const ledger = { version: 1, identity: null, sessions: {}, unreadable: {}, complete: false, updatedAt: null };
  const coverageRecord = { version: 1, identity: null, environment: '', apiBase: null, sessions: {}, updatedAt: null };
  const saved = [];
  const lock = over.lock || fakeLock();
  const checkpoint = over.checkpoint || fakeCheckpoint({});
  const flush = over.flush || fakeFlush();
  const deps = {
    now: () => 10 * 60 * 60 * 1000,
    linkedSessions: async () => [SESSION],
    getDefaultKey: async () => KEY,
    whoamiImpl: async () => ({ valid: true, trackingMode: TrackingMode.LIVE, backfillCompleted: false }),
    recordWhoamiImpl: () => {},
    listRollouts: () => [rollout('s1')],
    resolveTranscriptByCwdImpl: () => null,
    readStateImpl: () => null,
    readTrackingStateImpl: () => null,
    markBackfillCompletedImpl: () => {},
    completeBackfillImpl: async () => ({ completed: true, code: null }),
    loadLedgerImpl: () => ledger,
    saveLedgerImpl: (_key, l) => saved.push(l),
    runCheckpointImpl: checkpoint.impl,
    flushBackfillChunksImpl: flush.impl,
    computeSessionTimelineImpl: () => null,
    postSessionErrorImpl: async () => ({ reported: true }),
    flushQueueImpl: async () => emptyQueue(),
    fetchCoverageImpl: async () => new Map(),
    loadCoverageCheckpointsImpl: () => coverageRecord,
    saveCoverageCheckpointsImpl: () => true,
    acquireLockImpl: lock.acquire,
    ...over.deps,
  };
  return { deps, ledger, coverageRecord, saved, lock, checkpoint, flush };
}

const sync = (h, options = {}) => runAudit(h.deps, { mode: SYNC_MODE, ...options });

// The 30-day window is shared policy, not a backfill-only rule: a session out of scope for the
// one-time import must be out of scope here too, or the two commands disagree about the same file.
test('the 30-day window applies to sync as well, and is never reconciled', async () => {
  const NOW = 100 * 24 * 60 * 60 * 1000;
  const asked = [];
  const h = makeDeps({
    deps: {
      now: () => NOW,
      listRollouts: () => [
        rollout('ancient', { mtimeMs: NOW - 31 * 24 * 60 * 60 * 1000 }),
        rollout('recent', { mtimeMs: NOW - 2 * 24 * 60 * 60 * 1000 }),
      ],
      fetchCoverageImpl: async (ids) => { asked.push(...ids); return new Map(); },
    },
  });

  const result = await sync(h);

  assert.equal(result.tooOld, 1);
  assert.equal(result.candidates, 1);
  assert.deepEqual(asked, ['recent'], 'the server is never asked about an out-of-window session');
});

// When the window empties the candidate list there is no coverage call at all, so `coverageKnown`
// must stay null: sync.mjs prints a NETWORK failure on `false`, and "we never asked" is not that.
test('a machine with only out-of-window history does not report a coverage failure', async () => {
  const NOW = 100 * 24 * 60 * 60 * 1000;
  let asked = 0;
  const h = makeDeps({
    deps: {
      now: () => NOW,
      listRollouts: () => [rollout('ancient', { mtimeMs: NOW - 60 * 24 * 60 * 60 * 1000 })],
      fetchCoverageImpl: async () => { asked += 1; return new Map(); },
    },
  });

  const result = await sync(h);

  assert.equal(result.tooOld, 1);
  assert.equal(result.candidates, 0);
  assert.equal(asked, 0, 'no candidates means no coverage request');
  assert.equal(result.coverageKnown, null, 'not false — sync would call that a network failure');
  assert.equal(result.sessionsImported, 0);
});

// ─── R2 case list ───────────────────────────────────────────────────────────────────────────

test('R2/no hooks trusted — a session the server has never seen replays from line 0', async () => {
  const checkpoint = fakeCheckpoint({ s1: (from) => [seg('s1', from + 1, 40)] });
  const h = makeDeps({ checkpoint, deps: { fetchCoverageImpl: async () => new Map() } });
  const result = await sync(h);
  assert.equal(result.coverageKnown, true);
  assert.equal(result.candidates, 1);
  assert.equal(checkpoint.calls[0].startCursor, 0);
  assert.equal(result.sessionsImported, 1);
  assert.equal(result.deferred, 0);
});

test('R2/imported session append — a ledgered session is NOT skipped in sync; coverage picks the cursor', async () => {
  const checkpoint = fakeCheckpoint({ s1: (from) => [seg('s1', from + 1, 260)] });
  const h = makeDeps({ checkpoint, deps: { fetchCoverageImpl: async () => new Map([['s1', 200]]) } });
  // Delivered by the one-time import at line 200, then the session resumed and grew.
  h.ledger.sessions.s1 = { at: 'x', outcome: BackfillSessionStatus.ACCEPTED, reports: 3 };
  const result = await sync(h);
  assert.equal(result.alreadyImported, 0, 'the ledger skip must not fire in sync mode');
  assert.equal(result.candidates, 1);
  assert.equal(checkpoint.calls[0].startCursor, 200);
  assert.equal(result.sessionsImported, 1);
});

test('R2/imported session append — the SAME session is still skipped by the ledger in backfill mode', async () => {
  const h = makeDeps();
  h.ledger.sessions.s1 = { at: 'x', outcome: BackfillSessionStatus.ACCEPTED, reports: 3 };
  const result = await runAudit(h.deps, {});
  assert.equal(result.alreadyImported, 1);
  assert.equal(result.candidates, 0);
});

test('R2/rejected then connected repo — a REJECTED ledger entry is not delivery, so it replays in full', async () => {
  const checkpoint = fakeCheckpoint({ s1: (from) => [seg('s1', from + 1, 90)] });
  const h = makeDeps({ checkpoint, deps: { fetchCoverageImpl: async () => new Map() } });
  h.ledger.sessions.s1 = { at: 'x', outcome: BackfillSessionStatus.REJECTED, reports: 4 };
  const result = await sync(h);
  assert.equal(result.deferred, 0, 'a rejection is evidence of refusal, never of coverage');
  assert.equal(checkpoint.calls[0].startCursor, 0);
  assert.equal(result.sessionsImported, 1);
});

test('R2/pruned cursor — no local state at all still resumes from the server prefix', async () => {
  const checkpoint = fakeCheckpoint({ s1: (from) => [seg('s1', from + 1, 700)] });
  const h = makeDeps({
    checkpoint,
    deps: { readStateImpl: () => null, fetchCoverageImpl: async () => new Map([['s1', 640]]) },
  });
  const result = await sync(h);
  assert.equal(checkpoint.calls[0].startCursor, 640);
  assert.equal(result.deferred, 0);
});

test('R2/unavailable coverage — deferred with a visible status, never a scan from zero', async () => {
  const checkpoint = fakeCheckpoint({ s1: () => [seg('s1', 1, 40)] });
  const h = makeDeps({ checkpoint, deps: { fetchCoverageImpl: async () => null } });
  const result = await sync(h);
  assert.equal(result.coverageKnown, false, '"could not ask" is its own state');
  assert.equal(result.deferred, 1);
  assert.equal(result.deferredUnavailable, 1);
  assert.equal(result.deferredGap, 0);
  assert.equal(result.candidates, 0);
  assert.equal(checkpoint.calls.length, 0, 'nothing may be parsed, let alone sent');
});

test('R2/unavailable coverage — a THROWN coverage call is also unavailable, not zero', async () => {
  const checkpoint = fakeCheckpoint({ s1: () => [seg('s1', 1, 40)] });
  const h = makeDeps({
    checkpoint,
    deps: { fetchCoverageImpl: async () => { throw new Error('offline'); } },
  });
  const result = await sync(h);
  assert.equal(result.coverageKnown, false);
  assert.equal(result.deferredUnavailable, 1);
  assert.equal(checkpoint.calls.length, 0);
});

test('R2/narrow then wide — the narrow live segment is drained FIRST, so coverage reflects it', async () => {
  const order = [];
  const checkpoint = fakeCheckpoint({ s1: (from) => [seg('s1', from + 1, 300)] });
  const h = makeDeps({
    checkpoint,
    deps: {
      flushQueueImpl: async () => { order.push('drain'); return { ...emptyQueue(), flushed: 1 }; },
      fetchCoverageImpl: async () => { order.push('coverage'); return new Map([['s1', 120]]); },
    },
  });
  const result = await sync(h);
  assert.deepEqual(order, ['drain', 'coverage'], 'coverage must be asked AFTER the queue is empty');
  assert.equal(result.pendingDrained, 1);
  // And the replay starts strictly above the narrow segment the drain just delivered.
  assert.equal(checkpoint.calls[0].startCursor, 120);
  const sent = h.flush.calls[0].groups[0].reports;
  assert.equal(sent[0].from_line, 121);
});

test('R2/wide then narrow — a replay that would overlap stored lines is REFUSED, not reconciled', async () => {
  // The engine ignores startCursor and hands back a WIDE report starting at line 1 over a prefix
  // the server already holds to 120. Segment ids encode from-to, so this would be a second row
  // for the same lines rather than a supersession. It must never reach the wire.
  const checkpoint = fakeCheckpoint({ s1: () => [seg('s1', 1, 300)] });
  const h = makeDeps({ checkpoint, deps: { fetchCoverageImpl: async () => new Map([['s1', 120]]) } });
  const result = await sync(h);
  assert.equal(checkpoint.calls[0].startCursor, 120, 'the boundary was asked for');
  assert.equal(result.deferredOverlap, 1);
  assert.equal(result.deferred, 1);
  assert.equal(result.sessionsImported, 0);
  assert.equal(h.flush.calls.length, 0, 'nothing was sent');
});

test('R2/child-only append — parent coverage never authorises a child replay', async () => {
  // Parent resumed at 400: the coverage answer excludes agent rows entirely, so the sweep is off
  // and the children are reported as deferred rather than re-sent.
  const checkpoint = fakeCheckpoint({ s1: (from) => [seg('s1', from + 1, 460)] });
  const h = makeDeps({ checkpoint, deps: { fetchCoverageImpl: async () => new Map([['s1', 400]]) } });
  const result = await sync(h);
  assert.equal(checkpoint.calls[0].sweepSubagents, false);
  assert.equal(result.childrenDeferred, 1);
});

test('R2/child-only append — a whole-session replay from zero DOES sweep the children', async () => {
  const checkpoint = fakeCheckpoint({
    s1: (from) => [seg('s1', from + 1, 40), childSeg('s1', 'a1', 1, 12)],
  });
  const h = makeDeps({ checkpoint, deps: { fetchCoverageImpl: async () => new Map() } });
  const result = await sync(h);
  assert.equal(checkpoint.calls[0].sweepSubagents, false);
  assert.equal(result.childrenDeferred, 1);
  assert.equal(result.sessionsImported, 1);
});

test('R2/child-only append — a child segment below the parent boundary is not an overlap', async () => {
  // Child line numbers index the CHILD's own rollout. Judging them against the parent's boundary
  // would defer every session that has ever fanned out.
  const checkpoint = fakeCheckpoint({
    s1: (from) => [seg('s1', from + 1, 460), childSeg('s1', 'a1', 1, 12)],
  });
  const h = makeDeps({ checkpoint, deps: { fetchCoverageImpl: async () => new Map([['s1', 400]]) } });
  const result = await sync(h);
  assert.equal(result.deferredOverlap, 0);
  assert.equal(result.sessionsImported, 1);
});

test('R2/old-date resume — an old rollout that grew is repaired from the server prefix', async () => {
  // Discovery is by rollout id, not by date directory: a 2025 path is as eligible as today's.
  const old = rollout('s1', { transcriptPath: 'C:/sessions/2025/12/30/rollout-2025-12-30T09-00-00-s1.jsonl', mtimeMs: 500 });
  const checkpoint = fakeCheckpoint({ s1: (from) => [seg('s1', from + 1, 2600)] });
  const h = makeDeps({
    checkpoint,
    deps: { listRollouts: () => [old], fetchCoverageImpl: async () => new Map([['s1', 2500]]) },
  });
  const result = await sync(h);
  assert.equal(result.candidates, 1);
  assert.equal(checkpoint.calls[0].startCursor, 2500);
});

test('R2/continuous writes — a rollout still being written is left to its own window', async () => {
  const hot = rollout('s1', { mtimeMs: 10 * 60 * 60 * 1000 });
  const h = makeDeps({ deps: { listRollouts: () => [hot] } });
  const result = await sync(h);
  assert.equal(result.active, 1);
  assert.equal(result.candidates, 0);
  assert.equal(result.deferred, 0, 'an open session is not a coverage problem');
});

test('R2/continuous writes — the live session is still excluded by transcript path', async () => {
  const h = makeDeps({
    deps: { resolveTranscriptByCwdImpl: () => ({ sessionId: null, transcriptPath: rollout('s1').transcriptPath }) },
  });
  const result = await sync(h);
  assert.equal(result.live, 1);
  assert.equal(result.candidates, 0);
});

test('R2/restart — a re-run after a completed sync sends nothing the second time', async () => {
  const coverage = new Map();
  const checkpoint = fakeCheckpoint({ s1: (from) => (from >= 40 ? [] : [seg('s1', from + 1, 40)]) });
  const h = makeDeps({ checkpoint, deps: { fetchCoverageImpl: async () => coverage } });
  const first = await sync(h);
  assert.equal(first.sessionsImported, 1);
  // The delivery is now durable in the checkpoint record, and the server has the prefix.
  assert.equal(h.coverageRecord.sessions.s1.line, 40);
  coverage.set('s1', 40);
  const second = await sync(h);
  assert.equal(second.sessionsImported, 0);
  assert.equal(second.empty, 1);
  assert.equal(second.deferred, 0);
});

test('R2/restart — a PARTIAL delivery writes NO checkpoint, so the next run replays instead of deferring', async () => {
  // PARTIAL means the server rejected some of the session's reports — the common trigger being a
  // session spanning a connected and an unconnected repository. parentMaxLine is what we SENT, so
  // recording it would put the checkpoint permanently ahead of the real prefix and every later run
  // would read that contradiction as a coverage gap and defer the session forever.
  const checkpoint = fakeCheckpoint({ s1: (from) => [seg('s1', from + 1, 40)] });
  const flush = fakeFlush(() => BackfillSessionStatus.PARTIAL);
  const h = makeDeps({ checkpoint, flush, deps: { fetchCoverageImpl: async () => new Map() } });
  const first = await sync(h);
  assert.equal(first.sessionsImported, 1);
  assert.equal(h.coverageRecord.sessions.s1, undefined, 'a partly-refused delivery proves nothing');

  // The accepted subset may or may not form a prefix, so a coverage answer of 0 still defers —
  // that part is correct and safe. What must NOT happen is the session deferring once the server
  // DOES report a prefix, which is exactly what a false checkpoint of 40 would cause: the run
  // would read 25 < 40 as a contradiction and refuse a replay that is provably append-only.
  const resumed = makeDeps({
    checkpoint,
    deps: { fetchCoverageImpl: async () => new Map([['s1', 25]]), loadCoverageCheckpointsImpl: () => h.coverageRecord },
  });
  resumed.ledger.sessions.s1 = { at: 'x', outcome: BackfillSessionStatus.PARTIAL, reports: 1 };
  const second = await sync(resumed);
  assert.equal(second.deferredGap, 0, 'a partly-refused session must stay repairable, not defer forever');
  assert.equal(resumed.checkpoint.calls[resumed.checkpoint.calls.length - 1].startCursor, 25);
});

test('R2/restart — an ACCEPTED delivery is the only thing that writes a checkpoint', async () => {
  const checkpoint = fakeCheckpoint({ s1: (from) => [seg('s1', from + 1, 40)] });
  for (const [status, expected] of [
    [BackfillSessionStatus.ACCEPTED, 40],
    [BackfillSessionStatus.PARTIAL, undefined],
    [BackfillSessionStatus.REJECTED, undefined],
    [BackfillSessionStatus.FAILED, undefined],
  ]) {
    const h = makeDeps({
      checkpoint,
      flush: fakeFlush(() => status),
      deps: { fetchCoverageImpl: async () => new Map() },
    });
    await sync(h);
    const entry = h.coverageRecord.sessions.s1;
    assert.equal(entry === undefined ? undefined : entry.line, expected, `status ${status}`);
  }
});

test('R2/identity change — a coverage record bound to another machine is not consulted', async () => {
  // loadCoverageCheckpoints answers an EMPTY record for a foreign binding (pinned in
  // coverage-store.test.mjs), so a from-zero replay stays legal instead of deferring on a
  // stranger's checkpoint.
  const checkpoint = fakeCheckpoint({ s1: (from) => [seg('s1', from + 1, 40)] });
  const h = makeDeps({
    checkpoint,
    deps: {
      loadCoverageCheckpointsImpl: (_key, binding) => ({ version: 1, ...binding, sessions: {}, updatedAt: null }),
      fetchCoverageImpl: async () => new Map(),
    },
  });
  const result = await sync(h);
  assert.equal(result.deferred, 0);
  assert.equal(checkpoint.calls[0].startCursor, 0);
});

test('R2/identity change — a checkpoint that DOES survive still defers a contradicting zero', async () => {
  const checkpoint = fakeCheckpoint({ s1: (from) => [seg('s1', from + 1, 40)] });
  const h = makeDeps({ checkpoint, deps: { fetchCoverageImpl: async () => new Map() } });
  h.coverageRecord.sessions.s1 = { line: 900, at: 'x', source: 'delivered' };
  const result = await sync(h);
  assert.equal(result.deferredGap, 1);
  assert.equal(checkpoint.calls.length, 0);
});

test('R2/offline queue — undelivered reports stop the run instead of poisoning the coverage answer', async () => {
  let askedCoverage = false;
  const h = makeDeps({
    deps: {
      flushQueueImpl: async () => ({ ...emptyQueue(), failed: 2, lastError: 'network' }),
      fetchCoverageImpl: async () => { askedCoverage = true; return new Map(); },
    },
  });
  const result = await sync(h);
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'pending-not-drained');
  assert.equal(result.lastError, 'network');
  assert.equal(askedCoverage, false, 'coverage would have been stale by exactly those reports');
});

test('R2/offline queue — a deferred (budget-bounded) drain stops the run too', async () => {
  const h = makeDeps({ deps: { flushQueueImpl: async () => ({ ...emptyQueue(), deferred: 3 }) } });
  const result = await sync(h);
  assert.equal(result.reason, 'pending-not-drained');
});

test('R2/audit-only tenant — sync refuses locally rather than becoming the bypass', async () => {
  const h = makeDeps({
    deps: { readTrackingStateImpl: () => ({ identity: null, trackingMode: TrackingMode.BACKFILL_ONLY }) },
  });
  const result = await sync(h);
  assert.equal(result.reason, 'audit-only');
  assert.equal(result.upgradeAdvised, true);
  assert.equal(result.candidates, 0);
});

test('R2/audit-only tenant — the server\u2019s own verdict refuses even with a stale local cache', async () => {
  const h = makeDeps({
    deps: { whoamiImpl: async () => ({ valid: true, trackingMode: TrackingMode.DISABLED, backfillCompleted: false }) },
  });
  const result = await sync(h);
  assert.equal(result.reason, 'audit-only');
});

test('R2/audit-only tenant — a dark queue drain also refuses', async () => {
  const h = makeDeps({ deps: { flushQueueImpl: async () => ({ ...emptyQueue(), trackingDisabled: true }) } });
  const result = await sync(h);
  assert.equal(result.reason, 'audit-only');
});

// ─── the one-time seal is neither honoured nor touched by sync ───────────────────────────────

test('seal — sync runs against a sealed local cache instead of early-returning', async () => {
  const checkpoint = fakeCheckpoint({ s1: (from) => [seg('s1', from + 1, 40)] });
  const h = makeDeps({
    checkpoint,
    deps: {
      readTrackingStateImpl: () => ({ identity: null, trackingMode: TrackingMode.LIVE, backfillCompleted: true }),
      whoamiImpl: async () => ({ valid: true, trackingMode: TrackingMode.LIVE, backfillCompleted: true }),
      fetchCoverageImpl: async () => new Map(),
    },
  });
  h.ledger.complete = true;
  const result = await sync(h);
  assert.notEqual(result.reason, 'already-completed');
  assert.equal(result.sessionsImported, 1);
});

test('seal — sync never seals, and never calls completeBackfill', async () => {
  let sealCalls = 0;
  const checkpoint = fakeCheckpoint({ s1: (from) => [seg('s1', from + 1, 40)] });
  const h = makeDeps({
    checkpoint,
    deps: {
      completeBackfillImpl: async () => { sealCalls += 1; return { completed: true, code: null }; },
      fetchCoverageImpl: async () => new Map(),
    },
  });
  const result = await sync(h);
  assert.equal(result.finalized, false);
  assert.equal(sealCalls, 0);
  assert.equal(h.ledger.complete, false);
});

test('seal — an empty sync run still does not seal', async () => {
  let sealCalls = 0;
  const h = makeDeps({
    deps: {
      listRollouts: () => [],
      completeBackfillImpl: async () => { sealCalls += 1; return { completed: true, code: null }; },
    },
  });
  const result = await sync(h);
  assert.equal(sealCalls, 0);
  assert.equal(result.finalized, false);
});

test('seal — the historical replay uses the sync route, not the sealed backfill route', async () => {
  const checkpoint = fakeCheckpoint({ s1: (from) => [seg('s1', from + 1, 40)] });
  const h = makeDeps({ checkpoint, deps: { fetchCoverageImpl: async () => new Map() } });
  await sync(h);
  assert.equal(h.flush.calls[0].options.endpoint, '/sessions/sync');
});

test('seal — the one-time import still uses the backfill route and still seals', async () => {
  const checkpoint = fakeCheckpoint({ s1: () => [seg('s1', 1, 40)] });
  const h = makeDeps({ checkpoint });
  const result = await runAudit(h.deps, {});
  assert.equal(h.flush.calls[0].options.endpoint, undefined, 'the default route is read from ENDPOINTS');
  assert.equal(result.finalized, true);
});

// ─── the backfill run lock ───────────────────────────────────────────────────────────────────

test('lock — the run takes a RUN-rank lock with a lease longer than one chunk timeout', async () => {
  const lock = fakeLock();
  const h = makeDeps({ lock });
  await runAudit(h.deps, {});
  assert.equal(lock.events[0], `acquire:${LOCK_KINDS.RUN}:run-${HISTORY_RUN_LOCK}:${RUN_LEASE_MS}`);
  assert.ok(RUN_LEASE_MS > 60_000, 'per-batch renewal cannot rescue a lease shorter than one request');
  assert.equal(lock.events[lock.events.length - 1], 'release');
});

test('lock — sync and backfill contend for the SAME run lock', async () => {
  const names = [];
  const lock = fakeLock();
  const record = (target, options) => { names.push(target.name); return lock.acquire(target, options); };
  await runAudit(makeDeps({ deps: { acquireLockImpl: record } }).deps, {});
  await runAudit(makeDeps({ deps: { acquireLockImpl: record } }).deps, { mode: SYNC_MODE });
  assert.equal(names[0], names[1]);
});

test('lock — a busy lock is a benign skip, not an error', async () => {
  const h = makeDeps({ deps: { acquireLockImpl: () => ({ ok: false, reason: 'held', holder: { pid: 9 } }) } });
  const result = await runAudit(h.deps, {});
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'run-in-progress');
  assert.equal(result.scanned, 0);
});

test('lock — a lock-order refusal is surfaced as a defect, never retried as busy', async () => {
  const h = makeDeps({
    deps: { acquireLockImpl: () => ({ ok: false, reason: 'lock-order', detail: 'session held' }) },
  });
  const result = await runAudit(h.deps, {});
  assert.equal(result.ok, false, 'lock-order will fail forever — it must not read as a busy lock');
  assert.equal(result.reason, 'lock-order');
  assert.equal(result.lastError, 'session held');
});

test('lock — it is renewed once per dispatched batch, before the request', async () => {
  const lock = fakeLock();
  const checkpoint = fakeCheckpoint({
    s1: () => [seg('s1', 1, 10)],
    s2: () => [seg('s2', 1, 10)],
  });
  const h = makeDeps({ lock, checkpoint, deps: { listRollouts: () => [rollout('s1'), rollout('s2')] } });
  await runAudit(h.deps, {});
  assert.equal(lock.events.filter((e) => e.startsWith('renew:')).length, 1);
  assert.equal(lock.events.filter((e) => e === 'renew:' + RUN_LEASE_MS).length, 1);
});

test('lock — ownership is verified immediately before the seal', async () => {
  const lock = fakeLock();
  const order = [];
  const h = makeDeps({
    lock,
    deps: {
      listRollouts: () => [],
      completeBackfillImpl: async () => { order.push('seal'); return { completed: true, code: null }; },
    },
  });
  const originalVerify = lock.handle.verify;
  lock.handle.verify = () => { order.push('verify'); return originalVerify(); };
  await runAudit(h.deps, {});
  assert.deepEqual(order, ['verify', 'seal']);
});

test('lock — lost ownership aborts the seal cleanly', async () => {
  const lock = fakeLock({ verify: () => ({ ok: false, reason: 'lost', holder: { pid: 4 } }) });
  let sealCalls = 0;
  const h = makeDeps({
    lock,
    deps: {
      listRollouts: () => [],
      completeBackfillImpl: async () => { sealCalls += 1; return { completed: true, code: null }; },
    },
  });
  const result = await runAudit(h.deps, {});
  assert.equal(sealCalls, 0, 'a run that no longer owns the machine must not close the one-time pull');
  assert.equal(result.finalized, false);
  assert.match(result.lastError, /lock lost/);
  assert.equal(lock.events[lock.events.length - 1], 'release');
});

test('lock — a lost renewal abandons the batch unsent and halts', async () => {
  const lock = fakeLock({ renew: () => ({ ok: false, reason: 'lost' }) });
  const checkpoint = fakeCheckpoint({ s1: () => [seg('s1', 1, 10)] });
  const h = makeDeps({ lock, checkpoint });
  const result = await runAudit(h.deps, {});
  assert.equal(result.halt, BackfillHalt.LOCK_LOST);
  assert.equal(h.flush.calls.length, 0, 'nothing may be sent under a lock we no longer hold');
  assert.equal(result.finalized, false);
  assert.equal(h.ledger.sessions.s1, undefined, 'the session stays unledgered and eligible');
});

test('lock — a merely contended renewal does not abandon the run', async () => {
  const lock = fakeLock({ renew: () => ({ ok: false, reason: 'contended' }) });
  const checkpoint = fakeCheckpoint({ s1: () => [seg('s1', 1, 10)] });
  const h = makeDeps({ lock, checkpoint });
  const result = await runAudit(h.deps, {});
  assert.equal(result.halt, null);
  assert.equal(result.sessionsImported, 1);
});

test('lock — a throwing acquire is reported, not swallowed', async () => {
  const h = makeDeps({ deps: { acquireLockImpl: () => { throw new Error('locks dir unwritable'); } } });
  const result = await runAudit(h.deps, {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'lock-failed');
  assert.match(result.lastError, /unwritable/);
});

// ─── result shape ───────────────────────────────────────────────────────────────────────────

test('shape — coverageKnown stays null for a backfill run', async () => {
  const h = makeDeps();
  const result = await runAudit(h.deps, {});
  assert.equal(result.coverageKnown, null, 'never consulted is not the same as could not ask');
  assert.equal(result.mode, 'backfill');
});

test('shape — a lock refusal answers the same field set as a real run', async () => {
  const real = await runAudit(makeDeps().deps, {});
  const refused = await runAudit(
    makeDeps({ deps: { acquireLockImpl: () => ({ ok: false, reason: 'held' }) } }).deps,
    {},
  );
  assert.deepEqual(Object.keys(refused).sort(), Object.keys(real).sort());
});

test('shape — ReplayDecision is the vocabulary the audit routes on', () => {
  assert.equal(ReplayDecision.REPLAY, 'replay');
  assert.equal(ReplayDecision.DEFER, 'defer');
});
