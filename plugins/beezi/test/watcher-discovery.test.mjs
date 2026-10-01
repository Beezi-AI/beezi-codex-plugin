import { stateDir } from '../lib/paths.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  scanPass, planPass, runWatchPass, checkpointSucceeded,
  loadObservations, saveObservations, observationFor, childObservationFor,
  pruneObservations, observationFile,
} from '../lib/rollout-watcher.mjs';
import { pruneStale } from '../lib/prune.mjs';
import { makeMachine as sandboxMachine, uuid } from '../tools/suite-fixtures.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// The pass resolves every linked account and hands the whole list to runCheckpoint, which fans the
// one delta out into each of their queues. `linkedSessions` is therefore the seam that says
// whether this machine is linked at all.
const SESSION = accountSession(TEST_KEY, 'token');


// R2's discovery traps, one test each, plus the observation watermark's contract.
//
// Everything is injected: the clock, the filesystem root, the timer, the checkpoint and the
// network. There is not one sleep in this file — R3 is explicit that a timing guess is not
// evidence, and a discovery test that waits for an mtime to tick is exactly that.

// ── machine fixture ─────────────────────────────────────────────────────────────────────────

const makeMachine = (t) => sandboxMachine(t, 'watcher-disc-');

function writeRollout(machine, { day = ['2026', '09', '10'], id, records }) {
  const dir = path.join(machine.sessionsDir, ...day);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-10T00-00-00-${id}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const parentMeta = (id, cwd) => ({ type: 'session_meta', payload: { id, cwd: cwd || '/repo' } });
const childMeta = (own, root) => ({
  type: 'session_meta',
  payload: { id: own, session_id: root, thread_source: 'subagent', agent_nickname: 'helper' },
});

function touch(file, mtimeMs) {
  const seconds = mtimeMs / 1000;
  fs.utimesSync(file, seconds, seconds);
}

// A pass driver with every seam closed: no network, no real checkpoint, no prune, no audit.
function passDeps(overrides) {
  const calls = { checkpoints: [], audits: [], prunes: 0, yields: 0 };
  const deps = {
    now: () => 1_000_000,
    linkedSessions: async () => [SESSION],
    runCheckpoint: async (input, _deps, options) => {
      calls.checkpoints.push({ input, options });
      return { outcome: 'committed', enqueued: 1, flush: null, sessionErrors: [], skipped: {}, rateLimits: null, agents: {} };
    },
    runAudit: async (_deps, options) => { calls.audits.push(options); return { ok: true, reason: null }; },
    pruneStale: () => { calls.prunes += 1; },
    fetchCoverage: async () => new Map(),
    loadCoverageCheckpoints: () => ({ version: 1, sessions: {} }),
    loadLedger: () => ({ sessions: {}, unreadable: {} }),
    readTrackingState: () => null,
    isLiveTrackingAllowed: () => true,
    yieldControl: async () => { calls.yields += 1; },
    ...overrides,
  };
  return { deps, calls };
}

// ── trap 1: directory mtime must never gate discovery ───────────────────────────────────────

test('1. an append that leaves the parent directory mtime untouched is still discovered', async (t) => {
  const m = makeMachine(t);
  const id = uuid(1);
  const file = writeRollout(m, { id, records: [parentMeta(id)] });

  const dir = path.dirname(file);
  const dirBefore = fs.statSync(dir).mtimeMs;

  const first = await scanPass({ sessionsDir: m.sessionsDir }, {});
  assert.equal(first.tops.size, 1);
  const seen = first.tops.get(id);

  // The append. R2's measured fact: writing INTO an existing file does not touch the directory's
  // own mtime, so a "did today's folder change?" pre-check misses every append there will ever be.
  fs.appendFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: {} })}\n`);
  touch(file, seen.mtimeMs + 60_000);
  const dirAfter = fs.statSync(dir).mtimeMs;
  assert.equal(dirAfter, dirBefore, 'precondition: the append did not move the directory mtime');

  const second = await scanPass({ sessionsDir: m.sessionsDir }, {});
  const now = second.tops.get(id);
  assert.ok(now.mtimeMs > seen.mtimeMs || now.size > seen.size, 'the file itself moved');

  const record = loadObservations({});
  record.sessions[id] = { mtimeMs: seen.mtimeMs, size: seen.size, at: 1 };
  const plan = planPass({ isEstablished: () => true, tops: second.tops, observations: record, now: 2_000_000, cooldownMs: 0 });
  assert.deepEqual(plan.due.map((e) => e.sessionId), [id], 'the appended session must be due');
});

// ── trap 2: resumed rollouts live in older date directories ─────────────────────────────────

test('2. a resumed rollout in an old date directory is discovered like any other', async (t) => {
  const m = makeMachine(t);
  const old = uuid(2);
  const today = uuid(3);
  const oldFile = writeRollout(m, { day: ['2025', '11', '04'], id: old, records: [parentMeta(old)] });
  writeRollout(m, { day: ['2026', '09', '10'], id: today, records: [parentMeta(today)] });
  // The resume: an old file that has JUST been written to.
  touch(oldFile, 1_500_000);

  const scan = await scanPass({ sessionsDir: m.sessionsDir }, {});
  assert.deepEqual([...scan.tops.keys()].sort(), [old, today].sort(), 'both date directories are walked');
  assert.equal(scan.tops.get(old).mtimeMs, 1_500_000);
});

// ── trap 3: a changed child schedules its ROOT ──────────────────────────────────────────────

test('3. a child-only append schedules the ROOT with the subagent sweep on', async (t) => {
  const m = makeMachine(t);
  const root = uuid(4);
  const agent = uuid(5);
  const rootFile = writeRollout(m, { id: root, records: [parentMeta(root)] });
  const childFile = writeRollout(m, { id: agent, records: [childMeta(agent, root)] });
  touch(rootFile, 1_000);
  touch(childFile, 900_000);

  const scan = await scanPass({ sessionsDir: m.sessionsDir }, {});
  assert.deepEqual([...scan.tops.keys()], [root], 'the child is NOT a top-level session');
  assert.equal(scan.children.length, 1);
  assert.equal(scan.children[0].rootSessionId, root);

  // The parent's own file has not moved since we last saw it. Only the child has.
  const record = loadObservations({});
  record.sessions[root] = { mtimeMs: 1_000, size: scan.tops.get(root).size, at: 1 };
  const plan = planPass({ isEstablished: () => true, tops: scan.tops, children: scan.children, observations: record, now: 2_000_000, cooldownMs: 0 });
  assert.deepEqual(plan.due.map((e) => e.sessionId), [root], 'the changed child must schedule its root');

  // And the pass must actually enable the sweep — excluding subagents from a listing does not
  // bill them (R2 / G-7-1); `sweepSubagents` is what does.
  const { deps, calls } = passDeps({ now: () => 2_000_000 });
  saveObservations(record);
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), `${root}.json`), JSON.stringify({ cursor: 1 }));
  await runWatchPass(deps, { sessionsDir: m.sessionsDir, cooldownMs: 0 });
  assert.equal(calls.checkpoints.length, 1);
  assert.equal(calls.checkpoints[0].input.session_id, root);
  assert.equal(calls.checkpoints[0].options.sweepSubagents, true);

  // The child's own observation advances with the root's success, so an unchanged child does not
  // reschedule the root forever.
  const after = loadObservations({});
  assert.ok(childObservationFor(after, agent), 'the child observation was stamped');
  const plan2 = planPass({
    tops: scan.tops, children: scan.children, observations: after, now: 3_000_000, cooldownMs: 0,
  });
  assert.deepEqual(plan2.due, [], 'nothing changed since, so nothing is due');
});

// ── trap 4: a continuously growing rollout must not be starved ──────────────────────────────

test('4. a continuously growing rollout is processed every cooldown, never skipped by quiet-age', async (t) => {
  const m = makeMachine(t);
  const id = uuid(6);
  const file = writeRollout(m, { id, records: [parentMeta(id)] });

  const record = loadObservations({});
  // Already established — a boundary exists, so this is the incremental path. (The unestablished
  // case is routed by coverage instead; see watcher-eligibility.test.mjs.)
  record.sessions[id] = { mtimeMs: 0, size: 0, at: 0 };
  const cooldownMs = 60_000;
  let clock = 1_000_000;
  const processedAt = [];

  // Twenty ticks, ten seconds apart, with the file growing at EVERY tick. There is no quiet-age
  // threshold anywhere in the plan, so the only thing that spaces the work out is the cooldown —
  // and the session must never fall out of the plan altogether.
  for (let i = 0; i < 20; i += 1) {
    fs.appendFileSync(file, `${JSON.stringify({ type: 'event_msg', payload: { i } })}\n`);
    touch(file, clock);
    const scan = await scanPass({ sessionsDir: m.sessionsDir }, {});
    const plan = planPass({ isEstablished: () => true, tops: scan.tops, observations: record, now: clock, cooldownMs });
    if (plan.due.length > 0) {
      processedAt.push(clock);
      record.sessions[id] = { mtimeMs: scan.tops.get(id).mtimeMs, size: scan.tops.get(id).size, at: clock };
    } else {
      assert.equal(plan.cooling, 1, 'a skipped tick must report the session as cooling, not vanished');
    }
    clock += 10_000;
  }

  assert.ok(processedAt.length >= 3, `a growing rollout must keep being processed, got ${processedAt.length}`);
  for (let i = 1; i < processedAt.length; i += 1) {
    assert.ok(processedAt[i] - processedAt[i - 1] >= cooldownMs, 'the cooldown bounds the rate');
  }
});

// ── bounded work ────────────────────────────────────────────────────────────────────────────

test('5. head reads are bounded per pass and the remainder is rescheduled, never dropped', async (t) => {
  const m = makeMachine(t);
  const ids = [];
  for (let i = 10; i < 20; i += 1) {
    const id = uuid(i);
    ids.push(id);
    writeRollout(m, { id, records: [parentMeta(id)] });
  }

  const first = await scanPass({ sessionsDir: m.sessionsDir, maxHeadReads: 4 }, {});
  assert.equal(first.classified, 4, 'the head-read budget is honoured');
  assert.equal(first.truncated, true, 'the pass reports that it did not finish');
  assert.ok(first.tops.size <= 4);

  // The rotating index is what stops a bounded pass revisiting the same prefix forever.
  const second = await scanPass({ sessionsDir: m.sessionsDir, maxHeadReads: 4, startIndex: first.nextIndex }, {});
  const seen = new Set([...first.tops.keys(), ...second.tops.keys()]);
  assert.ok(seen.size > first.tops.size, 'the second pass reaches files the first could not');
});

test('6. the scan yields to the event loop every chunk — MCP responsiveness during a large scan', async (t) => {
  const m = makeMachine(t);
  for (let i = 30; i < 45; i += 1) writeRollout(m, { id: uuid(i), records: [parentMeta(uuid(i))] });

  let yields = 0;
  await scanPass(
    { sessionsDir: m.sessionsDir, chunkSize: 3 },
    { yieldControl: async () => { yields += 1; } },
  );
  // 15 files, a yield every 3: four yields at steps 3/6/9/12. The exact number matters less than
  // that a scan CANNOT run to completion without returning to the loop — R2 is explicit that "do
  // not write to stdout" does not protect JSON-RPC from a synchronous filesystem/JSON stall.
  assert.ok(yields >= 4, `expected the scan to yield repeatedly, got ${yields}`);
});

test('7. a stop() mid-scan abandons the pass at the next chunk boundary', async (t) => {
  const m = makeMachine(t);
  for (let i = 50; i < 62; i += 1) writeRollout(m, { id: uuid(i), records: [parentMeta(uuid(i))] });

  let stopped = false;
  const scan = await scanPass(
    { sessionsDir: m.sessionsDir, chunkSize: 2 },
    { yieldControl: async () => { stopped = true; }, shouldStop: () => stopped },
  );
  assert.equal(scan.truncated, true, 'the pass stopped early');
  assert.ok(scan.tops.size < 12, 'it did not walk the whole tree after being told to stop');
});

// ── the observation watermark ───────────────────────────────────────────────────────────────

test('8. the watermark advances only after a durable checkpoint success', async (t) => {
  const m = makeMachine(t);
  const id = uuid(70);
  const file = writeRollout(m, { id, records: [parentMeta(id)] });
  touch(file, 500_000);

  // Establish it, so the pass takes the incremental path rather than the coverage one.
  fs.mkdirSync(path.join(m.home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(m.home, 'state', `${id}.json`), JSON.stringify({ cursor: 3, sessionId: id }));

  // Every refusal shape runCheckpoint can report, in the shape it really reports them: each one
  // carries a non-'committed' outcome, and none of them may stamp the watermark.
  const refusals = [
    { outcome: 'deferred', reason: 'not-checkpointed', enqueued: 0, lockSkipped: true, lockReason: 'held' },
    { outcome: 'deferred', reason: 'not-checkpointed', enqueued: 0, unnamedSession: true, skipped: {} },
    { outcome: 'deferred', reason: 'not-checkpointed', enqueued: 0, skipped: { deltaFailed: true } },
    { outcome: 'failed', reason: 'payload-build-failed', enqueued: 0, skipped: { emitFailed: 1 } },
  ];
  for (const outcome of refusals) {
    fs.rmSync(observationFile(), { force: true });
    const { deps } = passDeps({ runCheckpoint: async () => outcome });
    await runWatchPass(deps, { sessionsDir: m.sessionsDir, cooldownMs: 0 });
    const record = loadObservations({});
    assert.equal(
      observationFor(record, id),
      null,
      `a checkpoint reporting ${JSON.stringify(outcome)} must leave the watermark alone`,
    );
  }

  // And a checkpoint that read the window but found no new usage IS success: `enqueued === 0` is a
  // complete read of a quiet session, and gating on a non-empty enqueue would re-read it forever.
  fs.rmSync(observationFile(), { force: true });
  const { deps } = passDeps({ runCheckpoint: async () => ({ outcome: 'committed', enqueued: 0, skipped: {} }) });
  await runWatchPass(deps, { sessionsDir: m.sessionsDir, cooldownMs: 0 });
  const stamped = observationFor(loadObservations({}), id);
  assert.ok(stamped, 'a zero-enqueue checkpoint is a success');
  assert.equal(stamped.mtimeMs, 500_000, 'the observation is the one taken BEFORE the run');
});

test('9. checkpointSucceeded reads the outcome, which is where every refusal already lands', () => {
  // `enqueued === 0` is a complete read of a quiet session, so it is success.
  assert.equal(checkpointSucceeded({ outcome: 'committed', enqueued: 0, skipped: {} }), true);
  assert.equal(checkpointSucceeded({ outcome: 'failed', enqueued: 4, skipped: { noRemote: 2, emitFailed: 1 } }), false);
  // runCheckpoint reports each refusal as a non-'committed' outcome, carrying the flag alongside
  // rather than instead of it — see lib/checkpoint.mjs's emptyResult(). Real-shape coverage for
  // deltaFailed and rateLimitDeferred lives in test/review-data-regressions.test.mjs (F4, F7).
  assert.equal(checkpointSucceeded({ outcome: 'deferred', lockSkipped: true, lockReason: 'held' }), false);
  assert.equal(checkpointSucceeded({ outcome: 'deferred', unnamedSession: true }), false);
  assert.equal(checkpointSucceeded({ outcome: 'deferred', skipped: { deltaFailed: true } }), false);
  assert.equal(checkpointSucceeded({ outcome: 'deferred', skipped: { rateLimitDeferred: true } }), false);
  assert.equal(checkpointSucceeded({ outcome: 'deferred', gated: true }), false);
  assert.equal(checkpointSucceeded(null), false);
  assert.equal(checkpointSucceeded(undefined), false);
});

test('10. the watermark is a NEW root-level file, not a field in cursor state, and survives pruning', (t) => {
  const m = makeMachine(t);
  assert.equal(path.dirname(observationFile()), m.home, 'it lives at the data root');
  assert.equal(path.basename(observationFile()), 'watcher.json');

  saveObservations({ version: 1, sessions: { a: { mtimeMs: 1, size: 2, at: 3 } }, children: {} });
  const fifteenDays = 15 * 24 * 60 * 60 * 1000;
  const seconds = (Date.now() - fifteenDays) / 1000;
  fs.utimesSync(observationFile(), seconds, seconds);

  pruneStale();
  assert.equal(fs.existsSync(observationFile()), true, 'prune sweeps state/ and queue/, not the root');
  assert.equal(observationFor(loadObservations({}), 'a').mtimeMs, 1);

  // R2 forbids inventing a persisted mtimeMs on the existing per-session cursor state. Nothing the
  // watcher writes may appear in state/<id>.json.
  const stateFile = path.join(m.home, 'state', 'sess.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ cursor: 7 }));
  saveObservations({ version: 1, sessions: { sess: { mtimeMs: 9, size: 9, at: 9 } }, children: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf-8')), { cursor: 7 }, 'cursor state is untouched');
});

test('11. a record from another version is discarded rather than trusted', (t) => {
  makeMachine(t);
  fs.mkdirSync(path.dirname(observationFile()), { recursive: true });
  fs.writeFileSync(observationFile(), JSON.stringify({ version: 99, sessions: { a: { mtimeMs: 5 } } }));
  const record = loadObservations({});
  assert.equal(record.version, 1);
  assert.deepEqual(record.sessions, {}, 'a foreign version costs one re-read, never a wrong answer');

  fs.writeFileSync(observationFile(), 'not json at all');
  assert.deepEqual(loadObservations({}).sessions, {}, 'an unreadable record is empty, not fatal');
});

test('12. the watermark is bounded — the oldest observation is evicted first', () => {
  const record = { version: 1, sessions: {}, children: {} };
  for (let i = 0; i < 10; i += 1) record.sessions[`s${i}`] = { mtimeMs: i, size: i, at: i };
  pruneObservations(record, 4);
  assert.deepEqual(Object.keys(record.sessions).sort(), ['s6', 's7', 's8', 's9'], 'newest four kept');
});

test('13. a restart re-reads the watermark from disk and re-checkpoints nothing unchanged', async (t) => {
  const m = makeMachine(t);
  const id = uuid(80);
  const file = writeRollout(m, { id, records: [parentMeta(id)] });
  touch(file, 400_000);
  fs.mkdirSync(path.join(m.home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(m.home, 'state', `${id}.json`), JSON.stringify({ cursor: 1, sessionId: id }));

  const first = passDeps({});
  await runWatchPass(first.deps, { sessionsDir: m.sessionsDir, cooldownMs: 0 });
  assert.equal(first.calls.checkpoints.length, 1, 'the first pass processes it');

  // "Restart" = a brand-new pass with a brand-new head cache and no in-memory carry-over. Only the
  // file on disk survives, which is the whole point of a DURABLE watermark.
  const second = passDeps({ now: () => 1_100_000 });
  await runWatchPass(second.deps, { sessionsDir: m.sessionsDir, cooldownMs: 0 });
  assert.equal(second.calls.checkpoints.length, 0, 'an unchanged session is not re-read after a restart');

  // ...and it comes straight back the moment the file moves again.
  touch(file, 1_200_000);
  const third = passDeps({ now: () => 1_300_000 });
  await runWatchPass(third.deps, { sessionsDir: m.sessionsDir, cooldownMs: 0 });
  assert.equal(third.calls.checkpoints.length, 1, 'a later append is picked up');
});

test('14. pruning runs on the watcher\'s own schedule, with no trusted SessionStart hook', async (t) => {
  const m = makeMachine(t);
  writeRollout(m, { id: uuid(90), records: [parentMeta(uuid(90))] });

  const first = passDeps({ now: () => 1_000_000 });
  await runWatchPass(first.deps, { sessionsDir: m.sessionsDir });
  assert.equal(first.calls.prunes, 1, 'the first pass sweeps');

  const second = passDeps({ now: () => 1_000_001 });
  await runWatchPass(second.deps, { sessionsDir: m.sessionsDir });
  assert.equal(second.calls.prunes, 0, 'and does not sweep again a millisecond later');

  const later = passDeps({ now: () => 1_000_000 + 7 * 60 * 60 * 1000 });
  await runWatchPass(later.deps, { sessionsDir: m.sessionsDir });
  assert.equal(later.calls.prunes, 1, 'but does sweep again once the interval has passed');
});

test('15. an unlinked machine does no work and reports it, rather than erroring once a tick', async (t) => {
  const m = makeMachine(t);
  writeRollout(m, { id: uuid(95), records: [parentMeta(uuid(95))] });
  const { deps, calls } = passDeps({
    linkedSessions: async () => [],
    runCheckpoint: async () => { throw new Error('must not run unlinked'); },
  });
  const out = await runWatchPass(deps, { sessionsDir: m.sessionsDir });
  assert.equal(out.reason, 'unlinked');
  assert.equal(calls.checkpoints.length, 0);
  assert.equal(out.errors, 0, 'unlinked is a state, not an error');
});

test('16. a session checkpointed per pass is capped, and the excess stays due', async (t) => {
  const m = makeMachine(t);
  const record = { version: 1, sessions: {}, children: {} };
  const tops = new Map();
  for (let i = 100; i < 110; i += 1) {
    const id = uuid(i);
    tops.set(id, { sessionId: id, transcriptPath: `/x/${id}`, cwd: '/r', mtimeMs: 900_000, size: 10 });
    record.sessions[id] = { mtimeMs: 1, size: 1, at: i };
  }
  const plan = planPass({ isEstablished: () => true, tops, observations: record, now: 2_000_000, cooldownMs: 0, maxSessions: 3 });
  assert.equal(plan.due.length, 3, 'the per-pass cap holds');
  assert.equal(plan.deferred, 7, 'the rest are deferred, not dropped');
  // Oldest observation first, so the same head of the list is not serviced forever.
  assert.deepEqual(plan.due.map((e) => e.sessionId), [uuid(100), uuid(101), uuid(102)]);
});

test('17. a child-scheduled root whose own file was not scanned stamps NO parent watermark', async (t) => {
  const m = makeMachine(t);
  // The agent's id sorts FIRST, so with a one-file head-read budget the scan classifies the child
  // and never reaches the parent — the truncation case this test exists for.
  const agent = uuid(120);
  const root = uuid(129);

  // The root is not in `tops` — reachable whenever the head-read budget truncates before the
  // parent's file is classified, which is exactly the bounded-scan path. The entry planPass
  // fabricates for it carries no stat, so nothing may be written to the parent's watermark from a
  // wall-clock stand-in: the observation contract is "the stat taken before the run", and there
  // was no stat.
  const record = loadObservations({});
  record.sessions[root] = { mtimeMs: 111, size: 222, at: 1 };
  const children = [{ agentThreadId: agent, rootSessionId: root, transcriptPath: '/x', mtimeMs: 900_000, size: 40 }];

  const plan = planPass({
    tops: new Map(), children, observations: record, now: 2_000_000, cooldownMs: 0,
    isEstablished: () => true,
  });
  assert.deepEqual(plan.due.map((e) => e.sessionId), [root]);
  assert.equal(plan.due[0].synthetic, true, 'the entry is marked as having no stat behind it');
  assert.equal(plan.due[0].mtimeMs, null, 'and carries no fabricated mtime');

  // Drive it through a real pass: the parent's stored observation must be untouched, while the
  // child's advances so the root is not rescheduled forever.
  saveObservations(record);
  const rootFile = writeRollout(m, { id: root, records: [parentMeta(root)] });
  touch(rootFile, 111);
  const childFile = writeRollout(m, { id: agent, records: [childMeta(agent, root)] });
  touch(childFile, 900_000);
  fs.mkdirSync(path.join(m.home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(m.home, 'state', `${root}.json`), JSON.stringify({ cursor: 2, sessionId: root }));

  // maxHeadReads of 1, with the child sorting first, so the parent's own file is never classified.
  const { deps, calls } = passDeps({ now: () => 2_000_000 });
  await runWatchPass(deps, { sessionsDir: m.sessionsDir, cooldownMs: 0, maxHeadReads: 1 });

  const after = loadObservations({});
  const parent = observationFor(after, root);
  assert.equal(parent.mtimeMs, 111, 'the parent watermark still holds the last real observation');
  assert.equal(parent.size, 222, 'and its size witness is not blanked to null');
  if (calls.checkpoints.length > 0) {
    assert.equal(calls.checkpoints[0].options.sweepSubagents, true, 'the root bills its children');
  }
});
