import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { runAudit } from '../lib/session-audit.mjs';
import { BackfillSessionStatus, BackfillHalt, MAX_BODY_BYTES, MAX_CHUNK_ITEMS } from '../lib/audit-flush.mjs';
import { TrackingMode } from '../lib/tracking.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// Two uploads in flight: every seam runAudit reads is injected, and deferred doubles let each test pick the finish order.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');

// ─── harness ────────────────────────────────────────────────────────────────

const rollout = (sessionId) => ({
  sessionId,
  transcriptPath: `C:/sessions/2026/01/01/rollout-2026-01-01T00-00-00-${sessionId}.jsonl`,
  cwd: 'C:/work/app',
  mtimeMs: 1_000,
  size: 1024,
});

// `count` parent payloads for one session, shaped like lib/checkpoint.mjs emits them.
const reportsOf = (sessionId, count) => Array.from({ length: count }, (_u, i) => ({
  segmentId: `${sessionId}:${i + 1}-${i + 2}`,
  sessionId,
  remote: 'r',
  branch: 'main',
  from_line: i + 1,
  to_line: i + 2,
}));

const committed = () => ({
  outcome: 'committed', enqueued: 0, flush: null, sessionErrors: [], agents: {},
  skipped: { noRemote: 0, emitFailed: 0, deltaFailed: false },
});

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

const verdicts = (groups, status) => new Map(groups.map((g) => [g.sessionId, { status, reason: null }]));

// A lock double that always grants; `renew` may answer otherwise. Records every call.
function fakeLock(over = {}) {
  const events = [];
  const handle = {
    verify: () => { events.push('verify'); return { ok: true }; },
    renew: (opts) => { events.push(`renew:${opts.leaseMs}`); return over.renew ? over.renew(events) : { ok: true }; },
    release: () => { events.push('release'); return { ok: true }; },
  };
  return { acquire: () => ({ ok: true, handle }), events };
}

// A flush double whose every call waits until the test settles or fails it.
function deferredFlush(events) {
  const calls = [];
  let active = 0;
  let peak = 0;
  const impl = (groups, _key, session, deps) => new Promise((resolve, reject) => {
    active += 1;
    peak = Math.max(peak, active);
    const ids = groups.map((g) => g.sessionId);
    const done = () => { active -= 1; events.push(`settled:${ids.join(',')}`); };
    calls.push({
      ids,
      groups,
      session,
      deps,
      activeAtStart: active,
      settle: (over = {}) => {
        done();
        resolve(flushResult({ stored: groups.length, bySession: verdicts(groups, BackfillSessionStatus.ACCEPTED), ...over }));
      },
      fail: (error) => { done(); reject(error); },
    });
  });
  return { impl, calls, peak: () => peak };
}

// A flush double that accepts everything at once and records each batch.
function settlingFlush() {
  const calls = [];
  const impl = async (groups) => {
    calls.push({ ids: groups.map((g) => g.sessionId), groups });
    return flushResult({ stored: groups.length, bySession: verdicts(groups, BackfillSessionStatus.ACCEPTED) });
  };
  return { impl, calls };
}

const response = (status, body = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

// A fake fetch's request body as text, inflated when the flush sent it gzipped.
const requestText = (init) => (init.headers != null && init.headers['Content-Encoding'] === 'gzip'
  ? zlib.gunzipSync(init.body).toString('utf-8')
  : init.body);

// A fetch whose every request waits for the test to answer it; `overlapping` counts open requests for the same sessions.
function heldFetch() {
  const requests = [];
  const impl = (url, init) => new Promise((resolve) => {
    const body = JSON.parse(requestText(init));
    const sessions = Array.isArray(body.sessions) ? body.sessions : [];
    const ids = [...new Set(sessions.map((r) => r.sessionId))];
    const overlapping = requests.filter((r) => !r.answered && r.ids.some((id) => ids.indexOf(id) !== -1)).length;
    const request = {
      url,
      ids,
      overlapping,
      bearer: init.headers.Authorization,
      segmentIds: sessions.map((r) => r.segmentId),
      answered: false,
      answer: (status, reply) => { request.answered = true; resolve(response(status, reply)); },
    };
    requests.push(request);
  });
  return { impl, requests, open: () => requests.filter((r) => !r.answered) };
}

const accept = (request) => request.answer(200, { stored: request.segmentIds.length, skipped: 0, errors: [] });

const tick = () => new Promise((resolve) => setImmediate(resolve));
const ticks = async (n = 20) => { for (let i = 0; i < n; i += 1) await tick(); };

// Lets immediates and I/O run until `ready()` holds; fails instead of hanging.
async function until(ready, what) {
  for (let i = 0; i < 1000; i += 1) {
    if (ready()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}

// Today's batching rule, restated: a batch closes right after the group that takes it to 50 items or 4 MB.
function todaysBatches(groups) {
  const batches = [];
  let current = [];
  let bytes = 0;
  let items = 0;
  for (const group of groups) {
    current.push(group.sessionId);
    bytes += Buffer.byteLength(JSON.stringify({ reports: group.reports, timeline: null }), 'utf-8');
    items += group.reports.length;
    if (bytes >= MAX_BODY_BYTES || items >= MAX_CHUNK_ITEMS) {
      batches.push(current);
      current = [];
      bytes = 0;
      items = 0;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function makeDeps(over = {}) {
  const ledger = { version: 1, identity: null, sessions: {}, unreadable: {}, complete: false, updatedAt: null };
  const coverageRecord = { version: 1, identity: null, environment: '', apiBase: null, sessions: {}, updatedAt: null };
  const saved = [];
  const events = over.events || [];
  const lock = over.lock || fakeLock();
  const reports = over.reports || { s1: 1 };
  const deps = {
    now: () => 10 * 60 * 60 * 1000,
    linkedSessions: async () => [SESSION],
    getDefaultKey: async () => KEY,
    whoamiImpl: async () => ({ valid: true, trackingMode: TrackingMode.LIVE, backfillCompleted: false }),
    recordWhoamiImpl: () => {},
    listRollouts: () => Object.keys(reports).map((id) => rollout(id)),
    resolveTranscriptByCwdImpl: () => null,
    readStateImpl: () => null,
    readTrackingStateImpl: () => null,
    readChatgptAuthImpl: () => null,
    readBillingConfigImpl: () => null,
    markBackfillCompletedImpl: () => events.push('mark-completed'),
    completeBackfillImpl: async (session) => {
      events.push(`complete:${session.token}`);
      return { completed: true, code: null };
    },
    loadLedgerImpl: () => ledger,
    saveLedgerImpl: (_key, l) => saved.push(JSON.parse(JSON.stringify(l))),
    runCheckpointImpl: async (input, _d, options) => {
      for (const payload of reportsOf(input.session_id, reports[input.session_id])) options.sink(payload);
      return committed();
    },
    computeSessionTimelineImpl: () => null,
    postSessionErrorImpl: async () => ({ reported: true }),
    loadCoverageCheckpointsImpl: () => coverageRecord,
    saveCoverageCheckpointsImpl: () => true,
    acquireLockImpl: lock.acquire,
    ...(over.flush ? { flushBackfillChunksImpl: over.flush.impl } : {}),
    ...over.deps,
  };
  return { deps, ledger, saved, events, lock };
}

// ─── lanes ──────────────────────────────────────────────────────────────────

test('two batches fly at once; B may finish first; the last batch goes alone and /complete follows it', async () => {
  const events = [];
  const flush = deferredFlush(events);
  const h = makeDeps({ events, flush, reports: { s1: 50, s2: 50, s3: 50, s4: 50 } });
  const run = runAudit(h.deps, {});

  await until(() => flush.calls.length === 2, 'two flights');
  await ticks();
  assert.equal(flush.calls.length, 2, 'never a third while two are in flight');
  assert.deepEqual(flush.calls.map((c) => c.ids), [['s1'], ['s2']]);
  assert.equal(typeof flush.calls[0].deps.renewSession, 'function');

  flush.calls[1].settle();
  await until(() => flush.calls.length === 3, 'the freed lane');
  assert.deepEqual(flush.calls[2].ids, ['s3']);

  flush.calls[0].settle();
  await ticks();
  assert.equal(flush.calls.length, 3, 'the last batch waits for every flight');

  flush.calls[2].settle();
  await until(() => flush.calls.length === 4, 'the last batch');
  assert.deepEqual(flush.calls[3].ids, ['s4']);
  assert.equal(flush.calls[3].activeAtStart, 1, 'the last batch is alone');
  assert.equal(events.some((e) => e.startsWith('complete')), false, '/complete waits for the last batch');

  flush.calls[3].settle();
  const result = await run;

  assert.equal(flush.peak(), 2);
  assert.equal(result.finalized, true);
  assert.equal(result.sessionsImported, 4);
  assert.deepEqual(events, ['settled:s2', 'settled:s1', 'settled:s3', 'settled:s4', 'complete:tok', 'mark-completed']);
  for (const id of ['s1', 's2', 's3', 's4']) assert.equal(h.ledger.sessions[id].outcome, BackfillSessionStatus.ACCEPTED);
});

test('a server halt while the other lane flies launches nothing new, still ledgers that lane, and never seals', async () => {
  const events = [];
  const flush = deferredFlush(events);
  const h = makeDeps({ events, flush, reports: { s1: 50, s2: 50, s3: 50, s4: 50 } });
  const run = runAudit(h.deps, {});

  await until(() => flush.calls.length === 2, 'two flights');
  flush.calls[0].settle({
    halt: BackfillHalt.FORBIDDEN,
    stored: 0,
    retryableFailures: 1,
    bySession: verdicts(flush.calls[0].groups, BackfillSessionStatus.FAILED),
  });
  await ticks();
  assert.equal(flush.calls.length, 2, 'no batch launches after the halt');

  flush.calls[1].settle();
  const result = await run;

  assert.equal(flush.calls.length, 2);
  assert.equal(result.halt, BackfillHalt.FORBIDDEN);
  assert.equal(h.ledger.sessions.s2.outcome, BackfillSessionStatus.ACCEPTED, 'the in-flight lane is still ledgered');
  for (const id of ['s1', 's3', 's4']) assert.equal(h.ledger.sessions[id], undefined);
  assert.equal(events.some((e) => e.startsWith('complete')), false);
  assert.equal(result.finalized, false);
});

test('a lease lost while the other lane flies halts LOCK_LOST, still ledgers that lane, and keeps LOCK_LOST', async () => {
  const lock = fakeLock({
    renew: (lockEvents) => (lockEvents.filter((e) => e.startsWith('renew:')).length >= 3 ? { ok: false, reason: 'lost' } : { ok: true }),
  });
  const events = [];
  const flush = deferredFlush(events);
  const h = makeDeps({ events, flush, lock, reports: { s1: 50, s2: 50, s3: 50, s4: 50 } });
  const run = runAudit(h.deps, {});

  await until(() => flush.calls.length === 2, 'two flights');
  flush.calls[0].settle();
  await ticks();
  assert.equal(flush.calls.length, 2, 'the batch the lost lease caught is never sent');

  // Its first chunk landed, a later one was refused: a second halt that must not mask LOCK_LOST.
  flush.calls[1].settle({ halt: BackfillHalt.FORBIDDEN });
  const result = await run;

  assert.equal(result.halt, BackfillHalt.LOCK_LOST);
  assert.equal(result.ok, true);
  assert.equal(lock.events.filter((e) => e.startsWith('renew:')).length, 3);
  assert.equal(h.ledger.sessions.s1.outcome, BackfillSessionStatus.ACCEPTED);
  assert.equal(h.ledger.sessions.s2.outcome, BackfillSessionStatus.ACCEPTED, 'settled after the halt and still ledgered');
  for (const id of ['s3', 's4']) assert.equal(h.ledger.sessions[id], undefined);
  assert.equal(events.some((e) => e.startsWith('complete')), false);
  assert.equal(result.finalized, false);
});

test('a failed flight surfaces once the other lane settles, never as an unhandled rejection', async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));
  const events = [];
  const flush = deferredFlush(events);
  const h = makeDeps({ events, flush, reports: { s1: 50, s2: 50, s3: 50, s4: 50 } });
  const outcome = runAudit(h.deps, {}).then(() => null, (error) => error);

  await until(() => flush.calls.length === 2, 'two flights');
  flush.calls[0].fail(new Error('boom'));
  await ticks();
  assert.equal(flush.calls.length, 2, 'nothing launches after a failure');
  assert.deepEqual(unhandled, []);

  flush.calls[1].settle();
  const error = await outcome;

  assert.match(String(error && error.message), /boom/);
  assert.equal(h.ledger.sessions.s2.outcome, BackfillSessionStatus.ACCEPTED, 'the other lane is still ledgered');
  assert.equal(events.some((e) => e.startsWith('complete')), false);
  assert.deepEqual(unhandled, []);
});

test('batches close exactly where they always did: right after the group that reaches 50 items or 4 MB', async () => {
  const pad = 'x'.repeat(1_500_000);
  const fixture = [
    ['s1', 30], ['s2', 30], ['s3', 10], ['s4', 45], ['s5', 5], ['s6', 50], ['s7', 1],
    ['b1', 1, pad], ['b2', 1, pad], ['b3', 1, pad], ['s8', 1],
  ];
  const groups = fixture.map(([id, count, padding]) => ({
    sessionId: id,
    reports: reportsOf(id, count).map((r) => (padding ? { ...r, session_name: padding } : r)),
  }));
  const byId = new Map(groups.map((g) => [g.sessionId, g.reports]));
  const flush = settlingFlush();
  const h = makeDeps({
    flush,
    deps: {
      listRollouts: () => groups.map((g) => rollout(g.sessionId)),
      runCheckpointImpl: async (input, _d, options) => {
        for (const payload of byId.get(input.session_id)) options.sink(payload);
        return committed();
      },
    },
  });

  const result = await runAudit(h.deps, {});

  assert.deepEqual(todaysBatches(groups), [['s1', 's2'], ['s3', 's4'], ['s5', 's6'], ['s7', 'b1', 'b2', 'b3'], ['s8']]);
  assert.deepEqual(flush.calls.map((c) => c.ids), todaysBatches(groups));
  assert.deepEqual(
    flush.calls.flatMap((c) => c.groups.flatMap((g) => g.reports.map((r) => r.segmentId))),
    groups.flatMap((g) => g.reports.map((r) => r.segmentId)),
  );
  assert.equal(result.finalized, true);
});

test('a dry run plans the same batches, sends nothing and renews nothing', async () => {
  const flush = settlingFlush();
  const lock = fakeLock();
  const h = makeDeps({ flush, lock, reports: { s1: 50, s2: 50, s3: 50 } });

  const result = await runAudit(h.deps, { dryRun: true });

  assert.equal(flush.calls.length, 0);
  assert.equal(result.plannedReports, 150);
  assert.equal(result.plannedChunks, 3);
  assert.deepEqual(h.saved, []);
  assert.equal(lock.events.some((e) => e.startsWith('renew:')), false);
  assert.equal(result.ok, true);
  assert.equal(result.finalized, false);
});

test('a split session goes out part by part, in order, on one lane while the other lane flies', async () => {
  const wire = heldFetch();
  const h = makeDeps({
    reports: { s1: 120, s2: 50, s3: 1 },
    deps: { fetchImpl: wire.impl, getAccessToken: async () => { throw new Error('no renewal expected'); } },
  });
  const forSession = (id) => wire.requests.filter((r) => r.ids.indexOf(id) !== -1);
  const run = runAudit(h.deps, {});

  await until(() => wire.requests.length === 2, 's1 part 1 beside s2');
  assert.equal(forSession('s1').length, 1);
  accept(forSession('s2')[0]);
  await ticks();
  assert.equal(forSession('s1').length, 1, 'part 2 waits for part 1');
  accept(forSession('s1')[0]);
  await until(() => forSession('s1').length === 2, 's1 part 2');
  accept(forSession('s1')[1]);
  await until(() => forSession('s1').length === 3, 's1 part 3');
  accept(forSession('s1')[2]);
  await until(() => forSession('s3').length === 1, 'the last batch');
  accept(forSession('s3')[0]);
  const result = await run;

  assert.deepEqual(forSession('s1').map((r) => r.segmentIds.length), [50, 50, 20]);
  assert.deepEqual(forSession('s1').flatMap((r) => r.segmentIds), reportsOf('s1', 120).map((r) => r.segmentId));
  assert.ok(forSession('s1').every((r) => r.overlapping === 0), 'never two parts of one session in flight');
  assert.equal(h.ledger.sessions.s1.outcome, BackfillSessionStatus.ACCEPTED);
  assert.equal(result.finalized, true);
});

// Answer 401 only after both lanes are in flight: before Wave 2 a 401 here falls through to the real token store.
test('a 401 on both lanes renews once; the retries, the last batch and /complete all carry the new token', async () => {
  const wire = heldFetch();
  const asks = [];
  let grant;
  const granted = new Promise((resolve) => { grant = resolve; });
  const h = makeDeps({
    reports: { s1: 50, s2: 50, s3: 50 },
    deps: {
      linkedSessions: async () => [accountSession(KEY, 'stale')],
      fetchImpl: wire.impl,
      getAccessToken: async (key, _d, options) => { asks.push([key, options.forceRefresh === true]); return granted; },
    },
  });
  const run = runAudit(h.deps, {});

  await until(() => wire.requests.length === 2, 'both lanes to post');
  // gzip runs off the main thread, so either lane may post first.
  assert.deepEqual(wire.requests.map((r) => r.ids[0]).sort(), ['s1', 's2']);
  assert.deepEqual(wire.requests.map((r) => r.bearer), ['Bearer stale', 'Bearer stale']);
  wire.requests[0].answer(401, {});
  wire.requests[1].answer(401, {});
  await ticks();
  assert.equal(wire.requests.length, 2, 'both lanes wait on the renewal');
  assert.deepEqual(asks, [[KEY, true]], 'one forced refresh for both lanes');

  grant('fresh');
  await until(() => wire.requests.length === 4, 'both retries');
  assert.deepEqual(wire.requests.slice(2).map((r) => r.bearer), ['Bearer fresh', 'Bearer fresh']);
  wire.requests.slice(2).forEach((r) => accept(r));
  await until(() => wire.requests.length === 5, 'the last batch');
  assert.equal(wire.open().length, 1, 'the last batch goes alone');
  assert.deepEqual([wire.requests[4].ids, wire.requests[4].bearer], [['s3'], 'Bearer fresh']);
  accept(wire.requests[4]);
  const result = await run;

  assert.deepEqual(asks, [[KEY, true]]);
  assert.ok(h.events.includes('complete:fresh'));
  assert.equal(result.finalized, true);
  for (const id of ['s1', 's2', 's3']) assert.equal(h.ledger.sessions[id].outcome, BackfillSessionStatus.ACCEPTED);
});

test('the run renews once per stale token: lanes share one refresh, and a minted token is never refreshed again', async () => {
  const events = [];
  const flush = deferredFlush(events);
  const asks = [];
  let grant;
  const script = [new Promise((resolve) => { grant = resolve; })];
  const h = makeDeps({
    events,
    flush,
    reports: { s1: 50, s2: 50, s3: 50 },
    deps: {
      getAccessToken: async (key, _d, options) => {
        asks.push([key, options.forceRefresh === true]);
        const next = script.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  });
  const run = runAudit(h.deps, {});

  await until(() => flush.calls.length === 2, 'two flights');
  const [a, b] = flush.calls;
  const renewing = [a.deps.renewSession(a.session), b.deps.renewSession(b.session)];
  assert.equal(asks.length, 1, 'the second lane joins the pending refresh');
  grant('fresh');
  const [ra, rb] = await Promise.all(renewing);
  assert.equal(ra, rb);
  assert.equal(ra.token, 'fresh');
  assert.equal(ra.clientId, SESSION.clientId);
  assert.equal(await a.deps.renewSession(a.session), ra, 'a token already replaced answers the current session');
  assert.equal(asks.length, 1);

  a.settle();
  b.settle();
  await until(() => flush.calls.length === 3, 'the last batch');
  const last = flush.calls[2];
  assert.equal(last.session.token, 'fresh', 'later dispatches carry the renewed token');
  assert.equal(await last.deps.renewSession(last.session), null, 'a 401 on the minted token answers null');
  assert.equal(await last.deps.renewSession(last.session), null, 'and keeps answering null');
  assert.equal(asks.length, 1, 'no second forced refresh');
  assert.deepEqual(asks[0], [KEY, true]);

  last.settle();
  await run;
  assert.ok(events.includes('complete:fresh'));
});

// Every POST draws a 401: the one refresh is spent, so the later chunks fail without asking again.
for (const [label, answer] of [
  ['no token', null],
  ['the same token', 'tok'],
  ['a failed refresh', new Error('refresh failed')],
  ['a token that draws a 401 too', 'fresh'],
]) {
  test(`a renewal that yields ${label} is not repeated for the later 401 chunks`, async () => {
    const asks = [];
    const h = makeDeps({
      reports: { s1: 50, s2: 50, s3: 1 },
      deps: {
        fetchImpl: async () => response(401, {}),
        getAccessToken: async (key, _d, options) => {
          asks.push([key, options.forceRefresh === true]);
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    });

    const result = await runAudit(h.deps, {});

    assert.deepEqual(asks, [[KEY, true]], 'one forced refresh for the whole run');
    assert.equal(result.reportsFailed, 101);
    assert.equal(result.finalized, false);
    for (const id of ['s1', 's2', 's3']) assert.equal(h.ledger.sessions[id], undefined);
    assert.equal(h.events.some((e) => e.startsWith('complete')), false);
  });
}

test('a throw from the parse loop itself waits for the batch in flight before the run rejects', async () => {
  const wire = heldFetch();
  const lock = fakeLock();
  const h = makeDeps({
    lock,
    reports: { s1: 50, s2: 1, s3: 1 },
    deps: {
      fetchImpl: wire.impl,
      // s3's report cannot be serialised, so queueing it throws outside every per-session guard.
      runCheckpointImpl: async (input, _d, options) => {
        if (input.session_id !== 's3') {
          for (const payload of reportsOf(input.session_id, input.session_id === 's1' ? 50 : 1)) options.sink(payload);
        } else {
          options.sink({ ...reportsOf('s3', 1)[0], token_total: BigInt(1) });
        }
        return committed();
      },
      saveLedgerImpl: () => lock.events.push('save-ledger'),
    },
  });

  const run = runAudit(h.deps, {});
  let settled = false;
  run.then(() => { settled = true; }, () => { settled = true; });
  await until(() => wire.requests.length === 1, 's1 in flight');
  await ticks();
  assert.equal(settled, false, 'the run waits for the batch in flight');
  assert.equal(lock.events.includes('release'), false, 'the lock is still held');

  const before = lock.events.length;
  accept(wire.requests[0]);
  await assert.rejects(run, /BigInt/);

  assert.deepEqual(wire.requests.map((r) => r.ids), [['s1']]);
  const after = lock.events.slice(before).filter((e) => e === 'save-ledger' || e === 'release');
  assert.deepEqual(after, ['save-ledger', 'release'], 'the flight ledgers before the lock is released');
});
