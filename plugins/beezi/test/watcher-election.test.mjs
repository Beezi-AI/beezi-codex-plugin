import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  startWatcher, scanPass, WATCHER_ENV_VAR, TICK_MS, ELECTION_LEASE_MS,
} from '../lib/rollout-watcher.mjs';
import {
  acquireLock, electionLock, lockRank, locksDir, forgetHeldLocks, LOCK_ORDER,
} from '../lib/single-instance-lock.mjs';
import { createBridge } from '../lib/mcp-bridge.mjs';
import { makeMachine as sandboxMachine, uuid } from '../tools/suite-fixtures.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// The pass resolves every linked account and hands the whole list to runCheckpoint, which fans the
// one delta out into each of their queues. `linkedSessions` is therefore the seam that says
// whether this machine is linked at all.
const SESSION = accountSession(TEST_KEY, 'token');


// R3's half of G-1-1: the election lock, and the two things it is NOT.
//
// M-1-2's standing model — one MCP process per session, resident for the whole session, with no
// session identity — means N watchers per machine, all equally eligible. The election lock is what
// makes exactly one of them do the work, so it is load-bearing rather than belt-and-braces.
//
// It is NOT the checkpoint transaction: lib/checkpoint.mjs takes its own rank-2 session lock, and
// a global election excludes only other watchers. And a 'lock-order' refusal is NOT a busy lock —
// it is a defect in this process's own acquisition sequence that will fail identically forever.

const makeMachine = (t) => sandboxMachine(t, { prefix: 'watcher-elect-', beforeCleanup: forgetHeldLocks });

function writeRollout(machine, id) {
  const dir = path.join(machine.sessionsDir, '2026', '09', '10');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-10T00-00-00-${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/repo' } })}\n`);
  return file;
}

// A watcher whose every seam is closed and whose timer is a recorder.
function makeWatcher(machine, overrides, options) {
  const armed = [];
  const cleared = [];
  const calls = { checkpoints: 0, scans: 0, tokens: 0, passes: [] };
  const handle = startWatcher(
    {
      env: { [WATCHER_ENV_VAR]: '1' },
      setTimeoutImpl: (fn, ms) => { const h = { fn, ms }; armed.push(h); return h; },
      clearTimeoutImpl: (h) => { cleared.push(h); },
      now: () => 1_000_000,
      linkedSessions: async () => { calls.tokens += 1; return [SESSION]; },
      listRolloutFiles: (root) => { calls.scans += 1; return []; },
      runCheckpoint: async () => { calls.checkpoints += 1; return { outcome: 'committed', enqueued: 0, skipped: {} }; },
      runAudit: async () => ({ ok: true }),
      pruneStale: () => {},
      fetchCoverage: async () => new Map(),
      loadCoverageCheckpoints: () => ({ version: 1, sessions: {} }),
      loadLedger: () => ({ sessions: {}, unreadable: {} }),
      readTrackingState: () => null,
      isLiveTrackingAllowed: () => true,
      yieldControl: async () => {},
      onPass: (pass) => calls.passes.push(pass),
      ...overrides,
    },
    { sessionsDir: machine.sessionsDir, ...options },
  );
  return { handle, armed, cleared, calls };
}

test('1. the election lock is rank 0 and named election-watcher — coarser than every lock below it', () => {
  const desc = electionLock('watcher');
  assert.equal(desc.kind, 'election');
  assert.equal(desc.name, 'election-watcher');
  assert.equal(lockRank('election'), 0);
  // Nothing the pass reaches for afterwards can be a lock-order violation, which is why the
  // watcher may hold this across a runCheckpoint (rank 2), a flushQueue (rank 3) and a
  // runAudit (rank 1).
  assert.deepEqual(LOCK_ORDER, ['election', 'run', 'session', 'shared', 'credential']);
});

test('2. an opted-in watcher arms exactly one tick timer, and the timer is cleared on stop', (t) => {
  const m = makeMachine(t);
  const w = makeWatcher(m, {}, {});
  assert.equal(w.handle.started, true);
  assert.equal(w.armed.length, 1, 'one chained timer, not an interval');
  assert.equal(w.armed[0].ms, TICK_MS);

  w.handle.stop();
  assert.deepEqual(w.cleared, [w.armed[0]], 'stop() CLEARS the timer — never unref()s it (G-10-2)');
  assert.equal(w.handle.armed, false);
});

test('3. the first tick takes the election lock; a second watcher is refused and does no work', async (t) => {
  const m = makeMachine(t);
  const first = makeWatcher(m, {}, {});
  t.after(() => first.handle.stop());
  await first.handle.tick();
  assert.equal(first.handle.elected, true, 'the first watcher won the election');
  assert.ok(first.calls.scans > 0, 'and it did the work');
  assert.equal(fs.existsSync(path.join(locksDir(), 'election-watcher.lock')), true);

  // A second MCP process on the same machine. It contends for the same file and loses — the
  // primitive answers 'held', which is transient and simply means "not this tick".
  const second = makeWatcher(m, {}, {});
  t.after(() => second.handle.stop());
  const pass = await second.handle.tick();
  assert.equal(pass.reason, 'not-elected');
  assert.equal(second.calls.scans, 0, 'a watcher that is not elected reads nothing');
  assert.equal(second.calls.tokens, 0, 'and asks for no token');
  assert.equal(second.handle.elected, false);
});

test('4. the lock is renewed at the top of every tick, not re-acquired', async (t) => {
  const m = makeMachine(t);
  const acquires = [];
  const renews = [];
  const w = makeWatcher(m, {
    acquireLockImpl: (target, opts) => {
      acquires.push({ target, opts });
      const handle = {
        release: () => ({ ok: true }),
        renew: (o) => { renews.push(o); return { ok: true, expiresAt: 1 }; },
        verify: () => ({ ok: true }),
      };
      return { ok: true, handle };
    },
  }, {});
  t.after(() => w.handle.stop());

  await w.handle.tick();
  await w.handle.tick();
  await w.handle.tick();

  assert.equal(acquires.length, 1, 'acquired once, then held across ticks');
  assert.equal(acquires[0].target.name, 'election-watcher');
  assert.equal(acquires[0].opts.leaseMs, ELECTION_LEASE_MS);
  assert.ok(ELECTION_LEASE_MS > TICK_MS, 'the lease must outlive a tick, or a renew races its own expiry');
  assert.equal(renews.length, 2, 'every later tick renews first');
  assert.deepEqual(renews[0], { leaseMs: ELECTION_LEASE_MS });
});

test('5. a renew that reports "lost" abandons the tick before any work, and re-contends next tick', async (t) => {
  const m = makeMachine(t);
  writeRollout(m, uuid(1));
  let acquired = 0;
  let lostOnce = false;
  const w = makeWatcher(m, {
    acquireLockImpl: () => {
      acquired += 1;
      return {
        ok: true,
        handle: {
          release: () => ({ ok: true }),
          verify: () => ({ ok: true }),
          renew: () => {
            if (lostOnce) return { ok: true, expiresAt: 1 };
            lostOnce = true;
            // The successor already owns the lock; the primitive has retired our handle.
            return { ok: false, reason: 'lost', holder: { token: 'someone-else' } };
          },
        },
      };
    },
  }, {});
  t.after(() => w.handle.stop());

  await w.handle.tick();                 // acquires
  const scansAfterFirst = w.calls.scans;
  const lost = await w.handle.tick();    // renew -> lost

  assert.equal(lost.reason, 'not-elected');
  assert.equal(w.calls.scans, scansAfterFirst, 'a lost tick scans nothing');
  assert.equal(w.calls.checkpoints, 0, 'and checkpoints nothing — that is the overlap the lock prevents');

  await w.handle.tick();                 // contends again from scratch
  assert.equal(acquired, 2, 'the next tick re-acquires rather than assuming ownership');
});

test('6. a lock-order refusal is surfaced and stops the loop — it is a bug, not a busy lock', async (t) => {
  const m = makeMachine(t);
  const w = makeWatcher(m, {
    acquireLockImpl: () => ({ ok: false, reason: 'lock-order', detail: 'rank violation', holder: null }),
  }, {});
  t.after(() => w.handle.stop());

  const pass = await w.handle.tick();
  assert.equal(pass.reason, 'lock-order');
  assert.equal(w.calls.scans, 0);
  // Retrying it would fail identically forever, so the loop must not re-arm.
  assert.equal(w.handle.armed, false, 'the loop stops rather than spinning on a permanent refusal');

  const again = await w.handle.tick();
  assert.equal(again.reason, 'busy', 'a stopped watcher runs no further passes');
});

test('7. a real lock already held on this machine keeps the watcher out, and stop() gives it back', async (t) => {
  const m = makeMachine(t);
  writeRollout(m, uuid(2));

  // A live holder, taken through the real primitive — not a stub.
  const holder = acquireLock(electionLock('watcher'), { leaseMs: 60_000 });
  assert.equal(holder.ok, true);

  const w = makeWatcher(m, {}, {});
  t.after(() => w.handle.stop());
  const pass = await w.handle.tick();
  assert.equal(pass.reason, 'not-elected', 'a live holder is respected');
  assert.equal(w.calls.checkpoints, 0);

  holder.handle.release();
  const after = await w.handle.tick();
  assert.notEqual(after.reason, 'not-elected', 'once the holder released, the election is winnable');
  assert.equal(w.handle.elected, true);

  // And the watcher releases on shutdown rather than leaving a corpse for the takeover path.
  w.handle.stop();
  assert.equal(fs.existsSync(path.join(locksDir(), 'election-watcher.lock')), false);
});

test('8. ticks never overlap — a pass still running is not re-entered', async (t) => {
  const m = makeMachine(t);
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const w = makeWatcher(m, {
    getAccessToken: async () => { await gate; return 'token'; },
  }, {});
  t.after(() => { release(); w.handle.stop(); });

  const first = w.handle.tick();
  const second = await w.handle.tick();
  assert.equal(second.reason, 'busy', 'the second entry is refused while the first is in flight');
  release();
  await first;
});

test('9. a pass that throws is contained: the tick catches it, the loop survives and re-arms', async (t) => {
  const m = makeMachine(t);
  for (let i = 70; i < 76; i += 1) writeRollout(m, uuid(i));

  // The throw has to reach the TICK's catch, not a `try` further in. Most of the pass is already
  // defensive — a listRolloutFiles that explodes is swallowed by scanPass, getAccessToken that
  // throws reads as "unlinked" — so the yield between scan chunks is used instead: it is the one
  // await in the scan that is deliberately not wrapped, because a broken scheduler is not
  // something the pass should paper over. An unhandled rejection here would be FATAL in Node and
  // would take the MCP bridge down with it, which is the property under test.
  const w = makeWatcher(m, {
    listRolloutFiles: (root) => {
      const dir = path.join(root, '2026', '09', '10');
      return fs.readdirSync(dir).map((n) => path.join(dir, n));
    },
    yieldControl: async () => { throw new Error('exploded mid-scan'); },
  }, { chunkSize: 1 });
  t.after(() => w.handle.stop());

  const pass = await w.handle.tick();
  assert.equal(pass.reason, 'error', 'the tick caught it rather than rejecting');
  assert.equal(pass.errors, 1);
  assert.match(pass.error, /exploded mid-scan/, 'and the cause is carried on the summary');
  assert.equal(w.handle.armed, true, 'the loop is still armed for the next tick');
  assert.deepEqual(w.calls.passes.map((p) => p.reason), ['error'], 'exactly one pass was reported');
});

// ── MCP responsiveness during a large scan ──────────────────────────────────────────────────

test('10. the JSON-RPC channel is answered WHILE a large scan is in flight', async (t) => {
  const m = makeMachine(t);
  for (let i = 10; i < 60; i += 1) writeRollout(m, uuid(i));

  const written = [];
  const bridge = createBridge({
    url: 'https://api.test/api/mcp',
    // Unlinked: answered locally, no network — and no filesystem either, which matters here
    // because what is being timed is how fast the JSON-RPC channel answers during a scan. The
    // filesystem work was never the token stub (that was honoured); it was the UN-INJECTED
    // `checkEnvironment`, which reads the environment binding on every message.
    checkEnvironment: () => ({ status: 'ok' }),
    getDefaultKey: async () => null,
    listAccounts: async () => [],
    fetchImpl: async () => { throw new Error('must not reach the network'); },
    write: (line) => written.push(JSON.parse(line)),
    logError: () => {},
  });

  const order = [];
  // The real yield, not a stub: this is the property under test. A scan that ran its 50 stats and
  // head reads synchronously would finish before the runtime could deliver anything else, however
  // carefully it avoided stdout — R2's point exactly.
  const scan = scanPass({ sessionsDir: m.sessionsDir, chunkSize: 2 }, {}).then(() => order.push('scan'));
  const rpc = bridge
    .handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/list' })
    .then(() => order.push('rpc'));

  await Promise.all([scan, rpc]);
  assert.equal(order[0], 'rpc', 'the tool call must be answered before the scan completes');
  assert.equal(written.length, 1);
  assert.equal(written[0].id, 7);
  assert.ok(Array.isArray(written[0].result.tools), 'and answered correctly');
});
