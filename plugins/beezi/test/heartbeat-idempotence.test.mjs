import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runCheckpoint } from '../lib/checkpoint.mjs';
import { stateDir } from '../lib/paths.mjs';
import { acquireLock, forgetHeldLocks, sessionLock } from '../lib/single-instance-lock.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// One linked account, injected: from 0.13 on runCheckpoint resolves every account that can produce
// a token and fans the one delta out into each of their queues.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');


// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MONEY QUESTION (G-3-2): a mid-turn heartbeat and the turn-end checkpoint that follows it
// must not bill the same tokens twice.
//
// WHY THE REAL DELTA ENGINE IS USED HERE. Every other checkpoint test injects
// `computeDelta: () => ({ nextCursor: 4, segments: [...] })`. Such a test can say nothing at all
// about double-billing, because PARTITIONING is exactly what the stub replaces. So these tests
// write a real rollout, grow it between passes the way a live turn does, and let
// lib/delta-codex.mjs decide the windows.
//
// THE ARGUMENT THE TESTS PIN. A segment id is `${sessionId}:${fromLine}-${toLine}` and the server
// upserts on `segmentId::model`. Within one window, runs break ONLY at (repoRoot, branch)
// transitions, which sit at ABSOLUTE line numbers — so where a window is cut has no effect on any
// boundary except the cut itself. The window is `[state.cursor, nextCursor)`, and emitting the
// segments and advancing the cursor happen inside ONE rank-2 session-lock transaction. Therefore
// the turn-end checkpoint's window begins exactly one line past where the heartbeat's ended:
// disjoint line ranges, disjoint segment ids, every token billed once.
//
// THE ONE CONDITION, STATED RATHER THAN HIDDEN. That rests entirely on segment emission and cursor
// advance being in the same lock-held transaction. The single path that breaks the pairing is a
// transaction that LOSES its lock mid-run: lib/checkpoint.mjs gates the state write on
// stillOwnsSession, so segments are emitted and the cursor is not advanced. The replay then covers
// a SUPERSET window and repartitions it. That hazard is pre-existing and identical on today's
// git-boundary + Stop pair; the heartbeat neither creates it nor widens it — by advancing the
// cursor more often it makes the un-advanced window SHORTER. The last test in this file is that
// case, pinned rather than papered over.
// ─────────────────────────────────────────────────────────────────────────────────────────────

afterEach(() => forgetHeldLocks());

const tmpHome = (t) => sandboxHome(t, { prefix: 'beezi-heartbeat-', beforeCleanup: forgetHeldLocks });

const at = (sec) => new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString();

const meta = { timestamp: at(0), type: 'session_meta', payload: { cwd: '/repoA' } };
const turn = { timestamp: at(1), type: 'turn_context', payload: { cwd: '/repoA', model: 'gpt-5.2-codex' } };
// Codex reports CUMULATIVE totals, so a window's bill is the increment over the last total seen
// before it — which is why a re-partitioned replay is the thing to worry about and a re-covered
// identical window is not.
const tokens = (sec, input, output) => ({
  timestamp: at(sec),
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: 0,
        output_tokens: output,
        reasoning_output_tokens: 0,
        total_tokens: input + output,
      },
    },
  },
});

// Lines 1..7 of a turn that is still running at line 5 — where the heartbeat lands.
const TURN = [
  meta,                      // 1
  turn,                      // 2
  tokens(10, 100, 10),       // 3
  tokens(20, 200, 30),       // 4
  tokens(30, 300, 60),       // 5   ← a 15-minute heartbeat fires around here
  tokens(40, 400, 90),       // 6
  tokens(50, 500, 120),      // 7   ← Stop
];

function rollout(home, upTo) {
  const file = path.join(home, 'rollout.jsonl');
  fs.writeFileSync(file, TURN.slice(0, upTo).map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

// Deliberately NOT injecting computeDelta — see the header. Everything else is stubbed so the
// suite stays hermetic and offline.
const deps = (file) => ({
  linkedSessions: async () => [SESSION],
  fetchImpl: async () => { throw new Error('offline'); },
  resolveTranscript: () => ({ transcriptPath: file, sessionId: 's1' }),
  gitImpl: () => 'https://host/org/repo.git',
});

// What the heartbeat path in scripts/checkpoint.mjs passes, minus the budget (which only bounds
// network work and would make these tests clock-dependent).
const HEARTBEAT = { emitTimeline: true, skipFlush: true };
const TURN_END = { emitTimeline: true, skipFlush: true };

async function checkpoint(home, upTo, options) {
  const out = [];
  const result = await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(rollout(home, upTo)),
    { ...options, sink: (p) => out.push(p) },
  );
  return { result, out };
}

const sum = (payloads, field) => payloads.reduce((n, p) => n + p[field], 0);
const cursorOf = () => JSON.parse(fs.readFileSync(path.join(stateDir(), 's1.json'), 'utf-8')).cursor;

test('a heartbeat plus the turn-end checkpoint bill exactly what one whole-turn pass bills', async (t) => {
  // The control: one checkpoint over the finished turn, in its own home so it shares no cursor.
  const solo = tmpHome(t);
  const whole = await checkpoint(solo, 7, TURN_END);
  assert.ok(whole.out.length > 0, 'the fixture must actually produce billable segments');

  // The heartbeat path: mid-turn at line 5, then Stop at line 7.
  const split = tmpHome(t);
  const beat = await checkpoint(split, 5, HEARTBEAT);
  const stop = await checkpoint(split, 7, TURN_END);
  const both = [...beat.out, ...stop.out];

  assert.ok(beat.out.length > 0, 'the heartbeat shipped the mid-turn window — that is the whole row');
  assert.ok(stop.out.length > 0, 'and the turn end still had the rest to ship');

  // THE assertion, in money rather than in ids: the same turn costs the same either way.
  for (const field of ['token_total', 'token_input', 'token_output', 'token_cache']) {
    assert.equal(sum(both, field), sum(whole.out, field),
      `${field}: a heartbeat must not add a single token to the turn's bill`);
  }

  // THE CONTROL, so the equality above cannot pass vacuously. Had the heartbeat failed to commit
  // its cursor, the turn end would have replayed from zero — and that is what a double bill looks
  // like in this fixture. If this comparison ever stops showing a difference, the fixture has gone
  // token-free and every assertion above it is empty.
  const replayHome = tmpHome(t);
  const fromZero = await checkpoint(replayHome, 7, TURN_END);
  assert.ok(sum([...beat.out, ...fromZero.out], 'token_total') > sum(whole.out, 'token_total'),
    'overlapping windows DO over-bill — which is the failure the cursor commit prevents');
});

test('the cursor IS the partition boundary: the two windows are disjoint and their ids cannot collide', async (t) => {
  const home = tmpHome(t);
  const beat = await checkpoint(home, 5, HEARTBEAT);
  const afterBeat = cursorOf();
  const stop = await checkpoint(home, 7, TURN_END);

  const last = beat.out[beat.out.length - 1];
  const first = stop.out[0];
  assert.equal(last.to_line, afterBeat, 'the heartbeat committed the cursor it billed up to');
  assert.equal(first.from_line, last.to_line + 1,
    'the turn end starts one line past the heartbeat — no line is inside both windows');
  assert.equal(cursorOf(), 7);

  // And therefore no id is shared, which is what the server's `segmentId::model` upsert keys on.
  const ids = [...beat.out, ...stop.out].map((p) => p.segmentId);
  assert.equal(new Set(ids).size, ids.length, 'disjoint windows produce disjoint segment ids');
  for (const id of ids) assert.match(id, /^s1:\d+-\d+$/);
});

test('re-covering an identical window is idempotent: the same lines produce the same segmentId', async (t) => {
  // The control that makes the disjointness test bite. If the cursor never advanced, a "no
  // duplicate ids" assertion would still pass by accident — so this pins the other half: the id is
  // a pure function of the window, so a replay of the SAME window upserts rather than adds.
  const a = tmpHome(t);
  const first = await checkpoint(a, 5, HEARTBEAT);
  const b = tmpHome(t);
  const again = await checkpoint(b, 5, HEARTBEAT);

  assert.deepEqual(again.out.map((p) => p.segmentId), first.out.map((p) => p.segmentId));
  assert.deepEqual(again.out.map((p) => p.token_total), first.out.map((p) => p.token_total));
});

test('wall clock is not double-billed either: the heartbeat claims its intervals under the same lock', async (t) => {
  const solo = tmpHome(t);
  const whole = await checkpoint(solo, 7, TURN_END);

  const split = tmpHome(t);
  const beat = await checkpoint(split, 5, HEARTBEAT);
  const stop = await checkpoint(split, 7, TURN_END);

  // duration_sec is computed against state.coveredIntervals, which the heartbeat commits alongside
  // the cursor — so the turn end subtracts the seconds the heartbeat already billed. It may be
  // LESS than the single pass (the gap between the two windows stops being interior time); it may
  // never be more.
  assert.ok(sum([...beat.out, ...stop.out], 'duration_sec') <= sum(whole.out, 'duration_sec'),
    'summing two passes must never exceed what one pass over the same turn bills');
});

test('a heartbeat carries no new payload key — the wire shape is a turn end, only earlier', async (t) => {
  // An unknown field on /sessions/report is a 400, and flushQueue treats a 400 as permanent: it
  // DELETES the queued segment (REVIEW R4). So the heartbeat's payloads must be key-identical to
  // the ones a turn end already ships.
  const solo = tmpHome(t);
  const whole = await checkpoint(solo, 5, TURN_END);
  const beatHome = tmpHome(t);
  const beat = await checkpoint(beatHome, 5, HEARTBEAT);

  assert.equal(beat.out.length, whole.out.length);
  for (let i = 0; i < beat.out.length; i += 1) {
    assert.deepEqual(Object.keys(beat.out[i]).sort(), Object.keys(whole.out[i]).sort(),
      'the heartbeat invents no field the DTO has not whitelisted');
  }
});

test('a heartbeat whose session lock is held elsewhere writes nothing, and the turn end loses nothing', async (t) => {
  const home = tmpHome(t);

  // Another writer of this session is mid-transaction — a Stop hook, or the manual track path.
  // Modelled as the primitive's own suite does: a foreign pid, then drop this process's
  // bookkeeping, so the code under test can only learn about the holder from the filesystem.
  const got = acquireLock(sessionLock('s1'), { leaseMs: 60_000 }, { pid: () => 999_999 });
  assert.equal(got.ok, true);
  forgetHeldLocks();

  const blocked = await checkpoint(home, 5, HEARTBEAT);
  assert.equal(blocked.result.lockSkipped, true);
  assert.equal(blocked.result.lockReason, 'held', "a busy lock, not 'lock-order'");
  assert.deepEqual(blocked.out, [], 'a deferred heartbeat enqueues nothing');
  assert.equal(fs.existsSync(path.join(stateDir(), 's1.json')), false, 'and commits no cursor');

  // The window is not lost: the turn end picks it up whole, and bills it exactly once. Note the
  // heartbeat still CONSUMED its marker interval — see lib/timing.mjs claimHeartbeat — which is
  // right, because the holder was checkpointing this same session.
  assert.equal(got.handle.release().ok, true);
  forgetHeldLocks();
  const stop = await checkpoint(home, 7, TURN_END);
  assert.equal(stop.out[0].from_line, 1, 'the deferred window was picked up from the start');
  assert.equal(cursorOf(), 7);
});

test('THE RESIDUAL, pinned: a transaction that loses its lock repartitions on replay', async (t) => {
  // Not a defect this row introduces — it is the pre-existing consequence of emitting segments
  // and committing the cursor being separable (lib/checkpoint.mjs gates the state write on
  // stillOwnsSession). It is pinned here so the ONE condition the no-double-bill argument rests on
  // is visible in the suite rather than only in a comment.
  const home = tmpHome(t);
  const out = [];
  const file = rollout(home, 5);
  let thief = null;
  const beat = await runCheckpoint({ session_id: 's1', cwd: home }, {
    ...deps(file),
    // Steal the lock while the transaction is still inside its section.
    resolveSessionName: (...args) => {
      fs.unlinkSync(sessionLock('s1').file);
      forgetHeldLocks();
      thief = acquireLock(sessionLock('s1'), { leaseMs: 60_000 }, { pid: () => 999_999 });
      forgetHeldLocks();
      return null;
    },
  }, { ...HEARTBEAT, sink: (p) => out.push(p) });

  assert.equal(thief.ok, true);
  assert.equal(out.length, 0, 'the segments were still emitted — suppressing them would lose data');
  assert.equal(fs.existsSync(path.join(stateDir(), 's1.json')), false, 'but the cursor did not commit');
  thief.handle.release();
  forgetHeldLocks();

  const stop = await checkpoint(home, 7, TURN_END);
  // The replay covers a SUPERSET of the heartbeat's window, so it re-bills those lines under a
  // wider id rather than upserting the narrower one. Documented, bounded, and unchanged from the
  // git-boundary + Stop pair that ships today.
  assert.equal(stop.out[0].from_line, 1, 'the replay starts from the uncommitted cursor');
  assert.equal(beat.enqueued, out.length);
});
