import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runWatchPass, loadObservations, observationFor } from '../lib/rollout-watcher.mjs';
import { makeMachine as sandboxMachine, uuid } from '../tools/suite-fixtures.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// The pass resolves every linked account and hands the whole list to runCheckpoint, which fans the
// one delta out into each of their queues. `linkedSessions` is therefore the seam that says
// whether this machine is linked at all.
const SESSION = accountSession(TEST_KEY, 'token');


// R2's eligibility matrix, driven through the watcher rather than through the coverage core.
//
// The sketch this replaces was `if (!seen && isImported(ledger, id)) continue`. Three facts make
// it unsafe and all three are exercised below: the ledger records no imported LINE boundary, it
// marks REJECTED sessions imported, and per-session cursors are pruned at 14 days so "no cursor"
// means "old", not "never delivered".
//
// The one rule that outranks everything here: UNAVAILABLE IS NOT ZERO. A coverage request that
// could not be answered defers every session it covered. It never becomes a scan from line 0 —
// that is how one network blip turns into every linked machine re-uploading its whole history.

const makeMachine = (t) => sandboxMachine(t, 'watcher-elig-');

const NOW = 2_000_000_000;

// `mtimeMs` decides which of the two unestablished paths a session takes: inside the active
// window it is live capture (coverage decides the boundary), outside it, it is history (the
// tracking-policy-aware sync route).
function writeRollout(machine, id, { mtimeMs = NOW - 1000, subagentOf = null } = {}) {
  const dir = path.join(machine.sessionsDir, '2026', '09', '10');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-10T00-00-00-${id}.jsonl`);
  const meta = subagentOf
    ? { type: 'session_meta', payload: { id, session_id: subagentOf, thread_source: 'subagent' } }
    : { type: 'session_meta', payload: { id, cwd: '/repo' } };
  fs.writeFileSync(file, `${JSON.stringify(meta)}\n`);
  const seconds = mtimeMs / 1000;
  fs.utimesSync(file, seconds, seconds);
  return file;
}

function writeCursor(machine, id, cursor) {
  fs.mkdirSync(path.join(machine.home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(machine.home, 'state', `${id}.json`), JSON.stringify({ cursor, sessionId: id }));
}

function passDeps(overrides) {
  const calls = { checkpoints: [], audits: [], coverageAsks: [] };
  const deps = {
    now: () => NOW,
    linkedSessions: async () => [SESSION],
    runCheckpoint: async (input, _d, options) => {
      calls.checkpoints.push({ id: input.session_id, options });
      return { outcome: 'committed', enqueued: 1, skipped: {} };
    },
    runAudit: async (_d, options) => { calls.audits.push(options); return { ok: true, reason: null }; },
    pruneStale: () => {},
    fetchCoverage: async (ids) => { calls.coverageAsks.push(ids); return new Map(); },
    loadCoverageCheckpoints: () => ({ version: 1, sessions: {} }),
    loadLedger: () => ({ sessions: {}, unreadable: {} }),
    readTrackingState: () => null,
    isLiveTrackingAllowed: () => true,
    yieldControl: async () => {},
    ...overrides,
  };
  return { deps, calls };
}

const opts = (machine, extra) => ({ sessionsDir: machine.sessionsDir, cooldownMs: 0, ...extra });

// ── unavailable is not zero ─────────────────────────────────────────────────────────────────

test('1. coverage unavailable defers every session — it never becomes a scan from zero', async (t) => {
  const m = makeMachine(t);
  const id = uuid(1);
  writeRollout(m, id);

  const { deps, calls } = passDeps({ fetchCoverage: async () => null });
  const out = await runWatchPass(deps, opts(m));

  assert.equal(calls.checkpoints.length, 0, 'nothing may be checkpointed on an unanswerable coverage query');
  assert.equal(out.deferredUnavailable, 1);
  assert.equal(out.deferredGap, 0, 'unavailable is its own reason, not a gap');
  assert.equal(observationFor(loadObservations({}), id), null, 'and nothing is marked as seen');
});

test('2. a coverage request that THROWS is unavailable too, not an empty answer', async (t) => {
  const m = makeMachine(t);
  writeRollout(m, uuid(2));
  const { deps, calls } = passDeps({
    fetchCoverage: async () => { throw new Error('ECONNRESET'); },
  });
  const out = await runWatchPass(deps, opts(m));
  assert.equal(calls.checkpoints.length, 0);
  assert.equal(out.deferredUnavailable, 1);
  assert.equal(out.errors, 0, 'an offline machine is a state, not an error');
});

// ── confirmed zero, and the partial prefix ──────────────────────────────────────────────────

test('3. a confirmed zero replays from line 0 with the subagent sweep ON', async (t) => {
  const m = makeMachine(t);
  const id = uuid(3);
  writeRollout(m, id);
  // The server answered and holds nothing: an id asked about and absent from the Map is a
  // CONFIRMED zero, which is a different fact from "we could not ask".
  const { deps, calls } = passDeps({ fetchCoverage: async () => new Map() });
  await runWatchPass(deps, opts(m));

  assert.equal(calls.checkpoints.length, 1);
  assert.equal(calls.checkpoints[0].options.startCursor, 0);
  assert.equal(
    calls.checkpoints[0].options.sweepSubagents,
    false,
    'a whole-session replay from 0 is the one case where children may be replayed',
  );
});

test('4. a stored contiguous prefix becomes a startCursor HARD OVERRIDE, with children deferred', async (t) => {
  const m = makeMachine(t);
  const id = uuid(4);
  writeRollout(m, id);
  const { deps, calls } = passDeps({ fetchCoverage: async () => new Map([[id, 240]]) });
  await runWatchPass(deps, opts(m));

  assert.equal(calls.checkpoints.length, 1);
  // Without this, coverage is inert for a partial-prefix session: the local cursor is absent, the
  // checkpoint would start at 0, and lines 1-240 would be re-sent under different segment ids.
  assert.equal(calls.checkpoints[0].options.startCursor, 240);
  assert.equal(
    calls.checkpoints[0].options.sweepSubagents,
    false,
    'a parent prefix says nothing about which children landed — childSweepAllowed(240) is false',
  );
});

test('5. our own confirmation running ahead of the server\'s prefix is a GAP, and defers', async (t) => {
  const m = makeMachine(t);
  const id = uuid(5);
  writeRollout(m, id);
  const { deps, calls } = passDeps({
    fetchCoverage: async () => new Map([[id, 10]]),
    // We believe we delivered through line 90; the server's contiguous prefix stops at 10. Some of
    // what we delivered is therefore stored past a gap, and no start line can be proven free.
    loadCoverageCheckpoints: () => ({ version: 1, sessions: { [id]: { line: 90 } } }),
  });
  const out = await runWatchPass(deps, opts(m));
  assert.equal(calls.checkpoints.length, 0);
  assert.equal(out.deferredGap, 1);
  assert.equal(out.deferredUnavailable, 0);
});

// ── the ledger cases R2 names ───────────────────────────────────────────────────────────────

test('6. an IMPORTED session that resumes and grows is still processed', async (t) => {
  const m = makeMachine(t);
  const id = uuid(6);
  writeRollout(m, id);
  writeCursor(m, id, 12); // hooks ran, so the boundary is established locally

  const { deps, calls } = passDeps({
    // The ledger says this session was imported. The unsafe sketch would `continue` here forever.
    loadLedger: () => ({ sessions: { [id]: { at: 'x', outcome: 'accepted', reports: 4 } }, unreadable: {} }),
    fetchCoverage: async () => { throw new Error('coverage must not be needed for an established session'); },
  });
  await runWatchPass(deps, opts(m));

  assert.equal(calls.checkpoints.length, 1, 'ledger membership never excludes a session');
  assert.equal(calls.checkpoints[0].id, id);
  assert.equal(
    calls.checkpoints[0].options.startCursor,
    undefined,
    'an established session uses its own cursor, not a coverage override',
  );
});

test('7. a REJECTED ledger entry is not delivery — a repo that is later connected replays in full', async (t) => {
  const m = makeMachine(t);
  const id = uuid(7);
  writeRollout(m, id); // no cursor: the reports were rejected, nothing was ever stored

  const { deps, calls } = passDeps({
    loadLedger: () => ({ sessions: { [id]: { at: 'x', outcome: 'rejected', reports: 0 } }, unreadable: {} }),
    fetchCoverage: async () => new Map(),
  });
  await runWatchPass(deps, opts(m));

  assert.equal(calls.checkpoints.length, 1, 'a rejected session is eligible the moment its repo is connected');
  assert.equal(calls.checkpoints[0].options.startCursor, 0);
});

test('8. an ACCEPTED ledger entry with a confirmed zero prefix DEFERS rather than replaying', async (t) => {
  const m = makeMachine(t);
  const id = uuid(8);
  writeRollout(m, id);

  const { deps, calls } = passDeps({
    // Delivered before, and the server's contiguous prefix from line 1 is empty — which is exactly
    // what a session whose stored rows all sit past a gap answers. Replaying from 0 would
    // double-count it under new segment ids.
    loadLedger: () => ({ sessions: { [id]: { at: 'x', outcome: 'accepted', reports: 9 } }, unreadable: {} }),
    fetchCoverage: async () => new Map(),
  });
  const out = await runWatchPass(deps, opts(m));
  assert.equal(calls.checkpoints.length, 0);
  assert.equal(out.deferredGap, 1);
});

// ── pruned cursor ───────────────────────────────────────────────────────────────────────────

test('9. a pruned cursor routes to coverage, never to a scan from zero', async (t) => {
  const m = makeMachine(t);
  const id = uuid(9);
  writeRollout(m, id);
  // pruneStale took state/<id>.json at 14 days. "No cursor" means old, not never-delivered.
  assert.equal(fs.existsSync(path.join(m.home, 'state', `${id}.json`)), false, 'precondition');

  const { deps, calls } = passDeps({ fetchCoverage: async () => new Map([[id, 512]]) });
  await runWatchPass(deps, opts(m));
  assert.equal(calls.checkpoints[0].options.startCursor, 512, 'the server, not the missing cursor, sets the line');
});

// ── the two unestablished paths do not overlap ──────────────────────────────────────────────

test('10. an unestablished QUIET session goes down the sync route, not a direct checkpoint', async (t) => {
  const m = makeMachine(t);
  const id = uuid(10);
  // Older than lib/session-audit.mjs's active window: this is history, and R2 requires history to
  // ride the tracking-policy-aware sync route so it cannot bypass an audit-only tenant or touch
  // the one-time backfill's seal.
  writeRollout(m, id, { mtimeMs: NOW - (2 * 60 * 60 * 1000) });

  const { deps, calls } = passDeps({
    fetchCoverage: async () => { throw new Error('the quiet path must not ask coverage itself'); },
  });
  const out = await runWatchPass(deps, opts(m));

  assert.equal(calls.checkpoints.length, 0, 'no direct replay of history');
  // One repair pass PER ACCOUNT, each naming the account it uploads to: the audit uploads to the
  // account it was given, so a second linked workspace would never have its history repaired.
  assert.deepEqual(calls.audits, [{ mode: 'sync', key: SESSION.key }], 'exactly one sync-mode audit, for the one linked account');
  assert.equal(out.history.length, 1, 'one audit result per linked account is surfaced');
});

test('11. an unestablished ACTIVE session is the one the sync route refuses, so coverage handles it', async (t) => {
  const m = makeMachine(t);
  const id = uuid(11);
  writeRollout(m, id, { mtimeMs: NOW - 1000 }); // well inside the 30-minute active window

  const { deps, calls } = passDeps({ fetchCoverage: async () => new Map() });
  await runWatchPass(deps, opts(m));
  assert.equal(calls.audits.length, 0, 'a live session is not history');
  assert.equal(calls.checkpoints.length, 1);
});

test('12. the sync route runs on its own long interval, not every tick', async (t) => {
  const m = makeMachine(t);
  writeRollout(m, uuid(12), { mtimeMs: NOW - (2 * 60 * 60 * 1000) });

  const first = passDeps({});
  await runWatchPass(first.deps, opts(m));
  assert.equal(first.calls.audits.length, 1);

  const second = passDeps({ now: () => NOW + 1000 });
  await runWatchPass(second.deps, opts(m));
  assert.equal(second.calls.audits.length, 0, 'a second tick a second later must not re-run it');

  const later = passDeps({ now: () => NOW + 7 * 60 * 60 * 1000 });
  await runWatchPass(later.deps, opts(m));
  assert.equal(later.calls.audits.length, 1, 'but the interval does come round');
});

// ── tenant policy ───────────────────────────────────────────────────────────────────────────

test('13. an audit-only tenant gets no live capture from the watcher', async (t) => {
  const m = makeMachine(t);
  const live = uuid(13);
  const old = uuid(14);
  writeRollout(m, live, { mtimeMs: NOW - 1000 });
  writeCursor(m, live, 5);
  writeRollout(m, old, { mtimeMs: NOW - (2 * 60 * 60 * 1000) });

  const { deps, calls } = passDeps({
    readTrackingState: () => ({ version: 1, trackingMode: 'backfill_only' }),
    isLiveTrackingAllowed: () => false,
  });
  await runWatchPass(deps, opts(m));

  assert.equal(calls.checkpoints.length, 0, 'no live checkpoint on a dark tenant');
  // The history route still runs — runAudit refuses an audit-only tenant itself, in the one place
  // that also knows the server's verdict. The watcher does not reimplement that check.
  assert.deepEqual(calls.audits, [{ mode: 'sync', key: SESSION.key }]);
});

test('14. a missing tracking cache fails OPEN, matching lib/tracking.mjs\'s documented posture', async (t) => {
  const m = makeMachine(t);
  const id = uuid(15);
  writeRollout(m, id);
  writeCursor(m, id, 1);
  const { deps, calls } = passDeps({
    readTrackingState: () => { throw new Error('unreadable'); },
  });
  await runWatchPass(deps, opts(m));
  assert.equal(calls.checkpoints.length, 1, 'a fresh install is not dark-moded by its own empty cache');
});

// ── bounds on the eligibility work itself ───────────────────────────────────────────────────

test('15. one coverage request per SESSION, bounded by the establish cap, and the remainder waits', async (t) => {
  const m = makeMachine(t);
  for (let i = 20; i < 30; i += 1) writeRollout(m, uuid(i));

  const { deps, calls } = passDeps({ fetchCoverage: async (ids) => { calls.coverageAsks.push(ids); return null; } });
  await runWatchPass(deps, opts(m, { maxEstablish: 2 }));

  assert.equal(calls.coverageAsks.length, 2, 'eligibility is serialized per session and capped by maxEstablish');
  assert.equal(calls.coverageAsks[0].length, 1, 'one session lock protects each coverage request');
});

test('16. establishment is capped per pass, so a fresh machine does not checkpoint everything at once', async (t) => {
  const m = makeMachine(t);
  const ids = [];
  for (let i = 40; i < 50; i += 1) { ids.push(uuid(i)); writeRollout(m, uuid(i)); }

  const { deps, calls } = passDeps({ fetchCoverage: async () => new Map() });
  // Path B has its own ceiling, counted separately from path A's: a first read of a session is a
  // whole-transcript parse, so it is the more expensive of the two and gets the smaller number.
  const out = await runWatchPass(deps, opts(m, { maxEstablish: 2 }));
  assert.equal(out.established, 2);
  assert.equal(calls.checkpoints.length, 2, 'the rest stay unestablished and are picked up next pass');
});

test('18. the two paths have separate ceilings, and the pass total is their sum', async (t) => {
  const m = makeMachine(t);
  // Three established (path A) and three not (path B), all active.
  for (let i = 70; i < 73; i += 1) { writeRollout(m, uuid(i)); writeCursor(m, uuid(i), 4); }
  for (let i = 80; i < 83; i += 1) writeRollout(m, uuid(i));

  const { deps, calls } = passDeps({ fetchCoverage: async () => new Map() });
  const out = await runWatchPass(deps, opts(m, { maxSessions: 2, maxEstablish: 1 }));

  assert.equal(out.established, 1, 'path B is bounded on its own');
  assert.equal(calls.checkpoints.length, 3, 'and the pass total is maxSessions + maxEstablish');
  const withStartCursor = calls.checkpoints.filter((c) => c.options.startCursor !== undefined);
  assert.equal(withStartCursor.length, 1, 'only the coverage path passes a startCursor override');
});

test('17. a checkpoint that throws is contained — the pass reports it and keeps going', async (t) => {
  const m = makeMachine(t);
  const bad = uuid(60);
  const good = uuid(61);
  writeRollout(m, bad, { mtimeMs: NOW - 2000 });
  writeRollout(m, good, { mtimeMs: NOW - 1000 });
  writeCursor(m, bad, 1);
  writeCursor(m, good, 1);

  const { deps, calls } = passDeps({
    runCheckpoint: async (input) => {
      calls.checkpoints.push({ id: input.session_id, options: {} });
      if (input.session_id === bad) throw new Error('boom');
      return { outcome: 'committed', enqueued: 1, skipped: {} };
    },
  });
  const out = await runWatchPass(deps, opts(m));
  assert.equal(calls.checkpoints.length, 2, 'one session failing does not abandon the pass');
  assert.equal(out.errors, 1);
  assert.equal(out.succeeded, 1);
  assert.equal(observationFor(loadObservations({}), bad), null, 'and the failure is retried next pass');
});
