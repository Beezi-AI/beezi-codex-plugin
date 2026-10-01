import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodeCrypto from 'node:crypto';

import {
  acquireLock,
  withLock,
  withLockAsync,
  inspectLock,
  heldLocks,
  forgetHeldLocks,
  lockRank,
  locksDir,
  lockFilePath,
  electionLock,
  runLock,
  sessionLock,
  sharedLock,
  LOCK_KINDS,
  LOCK_ORDER,
  DEFAULT_LEASE_MS,
  LIVENESS_GRACE_MS,
  CORRUPT_GRACE_MS,
  BREAKER_STALE_MS,
} from '../lib/single-instance-lock.mjs';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Deterministic harness.
//
// R3 is explicit that timing guesses are not evidence, so nothing here sleeps and nothing here
// races for real. The clock is a number the test advances, and the filesystem is an in-memory
// store shared by several VIEWS. Each view has its own operation log, so "the loser never unlinked
// the lock file" is a direct assertion over that party's own calls rather than an inference.
//
// The store also carries a one-shot hook that fires immediately BEFORE an operation takes effect.
// That is what turns "two contenders both read the stale record and then both unlink" from a
// timing hope into a scripted interleaving: the test suspends one party at the exact instruction
// that matters and runs the other one to completion inside it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) { t += ms; return t; },
    set(ms) { t = ms; return t; },
  };
}

function fsError(code, syscall, target) {
  const error = new Error(`${code}: ${syscall} '${target}'`);
  error.code = code;
  error.syscall = syscall;
  error.path = target;
  return error;
}

function makeStore(clock) {
  const files = new Map(); // absolute path -> { text, mtimeMs }
  const dirs = new Set();
  const hook = { before: null, after: null, depth: 0 };
  const faults = new Map(); // `${op}:${path}` -> errno

  const fire = (slot, op, target) => {
    const fn = hook[slot];
    if (!fn || hook.depth > 0) return;
    hook.depth += 1;
    try { fn(op, target); } finally { hook.depth -= 1; }
  };
  const arm = (slot, op, target, fn) => {
    hook[slot] = (gotOp, gotPath) => {
      if (gotOp !== op || gotPath !== target) return;
      hook[slot] = null;
      fn();
    };
  };
  const faultFor = (op, target) => faults.get(`${op}:${target}`) || null;

  const store = {
    files,
    clock,
    // Fire `fn` immediately BEFORE the next matching operation takes effect, once. This is the
    // suspension point for "party A is about to unlink; let party B run to completion first".
    once(op, target, fn) { arm('before', op, target, fn); },
    // Fire `fn` immediately AFTER the operation has taken effect but before its caller resumes —
    // "A has already read the old value; now let B commit on top of it".
    onceAfter(op, target, fn) { arm('after', op, target, fn); },
    clearHook() { hook.before = null; hook.after = null; },
    fail(op, target, code) { faults.set(`${op}:${target}`, code); },
    clearFaults() { faults.clear(); },
    read(target) { return files.has(target) ? files.get(target).text : null; },
    write(target, text) { files.set(target, { text, mtimeMs: clock.now() }); },
    view(label) {
      const log = [];
      const api = {
        label,
        log,
        countOp(op, target) {
          let n = 0;
          for (const entry of log) if (entry[0] === op && entry[1] === target) n += 1;
          return n;
        },
        writeFileSync(target, text, options) {
          const flag = (options && options.flag) || 'w';
          log.push(['writeFileSync', target, flag]);
          fire('before', 'writeFileSync', target);
          const fault = faultFor('writeFileSync', target);
          if (fault) throw fsError(fault, 'open', target);
          if (flag === 'wx' && files.has(target)) throw fsError('EEXIST', 'open', target);
          files.set(target, { text: String(text), mtimeMs: clock.now() });
          fire('after', 'writeFileSync', target);
        },
        readFileSync(target) {
          log.push(['readFileSync', target]);
          fire('before', 'readFileSync', target);
          const fault = faultFor('readFileSync', target);
          if (fault) throw fsError(fault, 'open', target);
          if (!files.has(target)) throw fsError('ENOENT', 'open', target);
          const value = files.get(target).text;
          fire('after', 'readFileSync', target);
          return value;
        },
        unlinkSync(target) {
          log.push(['unlinkSync', target]);
          fire('before', 'unlinkSync', target);
          const fault = faultFor('unlinkSync', target);
          if (fault) throw fsError(fault, 'unlink', target);
          if (!files.has(target)) throw fsError('ENOENT', 'unlink', target);
          files.delete(target);
          fire('after', 'unlinkSync', target);
        },
        statSync(target) {
          log.push(['statSync', target]);
          if (!files.has(target)) throw fsError('ENOENT', 'stat', target);
          return { mtimeMs: files.get(target).mtimeMs };
        },
        mkdirSync(target) {
          log.push(['mkdirSync', target]);
          dirs.add(target);
        },
        readdirSync(target) {
          log.push(['readdirSync', target]);
          const out = [];
          for (const key of files.keys()) {
            if (path.dirname(key) === target) out.push(path.basename(key));
          }
          return out;
        },
      };
      return api;
    },
  };
  return store;
}

// One party: its own filesystem view, its own pid/host, and whatever the test says about liveness.
function makeParty(store, clock, options = {}) {
  const view = store.view(options.label || 'party');
  const alive = options.alive === undefined ? true : options.alive;
  return {
    view,
    deps: {
      fs: view,
      now: clock.now,
      hostname: () => (options.host || 'HOST-A'),
      pid: () => (options.pid === undefined ? 4242 : options.pid),
      isProcessAlive: typeof alive === 'function' ? alive : () => alive,
    },
  };
}

const SESSION = sessionLock('sess-1');
const LOCK_FILE = SESSION.file;

// The breaker path the module derives for a generation. Recomputed here rather than exported, so
// a test that plants a breaker is asserting against the real naming rule.
function breakerPathOf(lockFile, generation) {
  const hash = nodeCrypto.createHash('sha1').update(String(generation)).digest('hex').slice(0, 16);
  return `${lockFile}.take-${hash}`;
}

function recordAt(store) {
  const raw = store.read(LOCK_FILE);
  return raw === null ? null : JSON.parse(raw);
}

function reset() {
  forgetHeldLocks();
}

// The module's lock-order bookkeeping is process-local module state. Without this, an assertion
// that fires mid-test leaks a phantom held lock into every later case and turns one real failure
// into a cascade of unrelated 'lock-order' refusals. Cases that call reset() inline do so to model
// a DIFFERENT process's bookkeeping; this hook is the safety net, not a substitute.
afterEach(() => forgetHeldLocks());

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The platform primitive the whole protocol rests on. This is the only test that touches a real
// filesystem, and it uses its own temp directory — never ~/.beezi-codex.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('the atomicity primitive: exclusive create raises EEXIST on the real filesystem', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-lock-prim-'));
  try {
    const target = path.join(dir, 'probe.lock');
    fs.writeFileSync(target, 'first', { flag: 'wx' });
    let code = null;
    try { fs.writeFileSync(target, 'second', { flag: 'wx' }); } catch (error) { code = error.code; }
    assert.equal(code, 'EEXIST', 'a second exclusive create must fail');
    assert.equal(fs.readFileSync(target, 'utf-8'), 'first', 'and must not have overwritten anything');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the module uses exclusive create — never rename — to claim the lock file', () => {
  const source = fs.readFileSync(new URL('../lib/single-instance-lock.mjs', import.meta.url), 'utf-8');
  assert.ok(/flag: 'wx'/.test(source), 'the claim is an exclusive create');
  // The header discusses rename at length; what must not exist is a CALL. Measured on Windows,
  // renameSync reports success to several processes racing on one source, so it cannot decide who
  // won a takeover.
  assert.ok(!/renameSync\s*\(/.test(source), 'renameSync is not used as an exclusivity primitive');
  // compat's removers close over compat's own module-level fs, so a mocked acquire path would
  // reach the real filesystem through them. R3/S8 require injectable removal, imports included.
  const compatImport = /import\s*\{([^}]*)\}\s*from\s*'\.\/compat\.mjs'/.exec(source);
  assert.ok(compatImport, 'the module imports from compat');
  assert.deepEqual(compatImport[1].split(',').map((s) => s.trim()).filter(Boolean), ['orDefault'],
    'no removal helper is imported: every unlink goes through the injected fs');
});

test('acquire on a real filesystem produces a readable record and releases cleanly', () => {
  reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-lock-real-'));
  try {
    const target = { kind: LOCK_KINDS.SESSION, name: 'real-1', file: path.join(dir, 'real-1.lock') };
    const first = acquireLock(target, { leaseMs: 5_000 });
    assert.equal(first.ok, true);
    const written = JSON.parse(fs.readFileSync(target.file, 'utf-8'));
    assert.equal(written.token, first.handle.token);
    assert.equal(written.kind, LOCK_KINDS.SESSION);

    const second = acquireLock(target, { leaseMs: 5_000 });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'held');

    assert.equal(first.handle.release().ok, true);
    assert.equal(fs.existsSync(target.file), false, 'release removes the lock file');
    // And no breaker files are left behind.
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Naming and ranking.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('every lock kind has a rank and the order is coarse to fine', () => {
  assert.deepEqual(LOCK_ORDER, ['election', 'run', 'session', 'shared', 'credential']);
  assert.equal(lockRank(LOCK_KINDS.ELECTION), 0);
  assert.equal(lockRank(LOCK_KINDS.RUN), 1);
  assert.equal(lockRank(LOCK_KINDS.SESSION), 2);
  assert.equal(lockRank(LOCK_KINDS.SHARED), 3);
  assert.equal(electionLock('watcher').kind, LOCK_KINDS.ELECTION);
  assert.equal(runLock('backfill').kind, LOCK_KINDS.RUN);
  assert.equal(sessionLock('x').kind, LOCK_KINDS.SESSION);
  assert.equal(sharedLock('queue').kind, LOCK_KINDS.SHARED);
});

test('a hostile session id cannot escape the locks directory', () => {
  // safeFileName maps everything outside [A-Za-z0-9._-] to '_', so dots survive but separators do
  // not — and it is the absence of a separator, not the absence of '..', that stops a traversal.
  const nasty = sessionLock('../../../etc/passwd');
  assert.equal(path.dirname(nasty.file), locksDir());
  assert.equal(path.basename(nasty.file), nasty.file.slice(locksDir().length + 1));
  assert.ok(!/[\\/]/.test(path.basename(nasty.file)), 'the file name holds no path separator');
  assert.equal(path.resolve(nasty.file), nasty.file, 'and resolves to itself: no traversal');
  assert.equal(path.dirname(lockFilePath('a/b\\c')), locksDir());
  assert.equal(path.dirname(sessionLock('C:\\Windows\\system32\\x').file), locksDir());
});

test('locks live under this plugin data root, not the Claude plugin root', () => {
  assert.equal(locksDir(), path.join(process.env.BEEZI_CODEX_HOME, 'locks'));
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// R3 CASE — two stale contenders.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('two stale contenders: exactly one wins, and the loser never unlinks the lock file', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);

  // A dead holder's record, already expired.
  const dead = makeParty(store, clock, { label: 'dead', pid: 999 });
  const held = acquireLock(SESSION, { leaseMs: 1_000 }, dead.deps);
  assert.equal(held.ok, true);
  const staleToken = held.handle.token;
  reset(); // the dead process is gone; its process-local bookkeeping goes with it
  clock.advance(500_000);

  const a = makeParty(store, clock, { label: 'A', pid: 101, alive: false });
  const b = makeParty(store, clock, { label: 'B', pid: 102, alive: false });

  // Suspend A at the exact instruction R3 names — the unlink of the stale lock — and run B's
  // entire acquire inside it. B has already read the same stale record A did.
  let bResult = null;
  store.once('unlinkSync', LOCK_FILE, () => {
    bResult = acquireLock(SESSION, { leaseMs: 30_000 }, b.deps);
  });

  const aResult = acquireLock(SESSION, { leaseMs: 30_000 }, a.deps);

  assert.equal(aResult.ok, true, 'A takes the stale lock');
  assert.notEqual(aResult.handle.token, staleToken, 'a takeover mints a new acquisition token');
  assert.equal(bResult.ok, false, 'B must not also succeed');
  assert.equal(bResult.reason, 'contended');

  // The load-bearing assertion: B never removed the lock file, so it could not have deleted A's
  // replacement. This is over B's OWN operation log, not a global one.
  assert.equal(b.view.countOp('unlinkSync', LOCK_FILE), 0, 'the loser unlinked nothing');
  assert.equal(recordAt(store).token, aResult.handle.token, "A's record is what is on disk");
  assert.equal(aResult.handle.verify().ok, true);
  reset();
});

test('a rejected acquisition never releases the holder', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const holder = makeParty(store, clock, { label: 'holder', pid: 11 });
  const other = makeParty(store, clock, { label: 'other', pid: 22 });

  const held = acquireLock(SESSION, { leaseMs: 60_000 }, holder.deps);
  assert.equal(held.ok, true);
  reset();

  const before = store.read(LOCK_FILE);
  const refused = acquireLock(SESSION, { leaseMs: 60_000 }, other.deps);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'held');
  assert.equal(refused.decision, 'lease');
  assert.equal(refused.holder.token, held.handle.token);
  assert.equal(other.view.countOp('unlinkSync', LOCK_FILE), 0);
  assert.equal(store.read(LOCK_FILE), before, 'the holder record is byte-for-byte untouched');
  assert.equal(held.handle.verify().ok, true);
  reset();
});

test('a refused acquisition fits a hook budget: bounded filesystem work, no sleeping', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const holder = makeParty(store, clock, { label: 'holder', pid: 11 });
  acquireLock(SESSION, { leaseMs: 60_000 }, holder.deps);
  reset();

  const hook = makeParty(store, clock, { label: 'hook', pid: 22 });
  const before = clock.now();
  const refused = acquireLock(SESSION, { leaseMs: 5_000, attempts: 3 }, hook.deps);
  assert.equal(refused.ok, false);
  // A deterministic proxy for "cheap enough for a hook": a fixed, small number of filesystem
  // calls. Never a wall-clock assertion.
  assert.ok(hook.view.log.length <= 12, `expected a small op count, got ${hook.view.log.length}`);
  assert.equal(clock.now(), before, 'the clock never moved: the lock is strictly non-blocking');
  reset();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// R3 CASE — a slow live holder.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('a slow live holder that keeps renewing is never taken over', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const holder = makeParty(store, clock, { label: 'holder', pid: 11 });
  const watcher = makeParty(store, clock, { label: 'watcher', pid: 22, alive: true });

  const held = acquireLock(SESSION, { leaseMs: 30_000 }, holder.deps);
  assert.equal(held.ok, true);
  reset();

  for (let beat = 0; beat < 20; beat += 1) {
    clock.advance(25_000);
    const renewed = held.handle.renew();
    assert.equal(renewed.ok, true, `renew ${beat} should succeed`);
    const contender = acquireLock(SESSION, { leaseMs: 5_000, attempts: 1 }, watcher.deps);
    assert.equal(contender.ok, false, `contender must be refused at beat ${beat}`);
    assert.equal(contender.reason, 'held');
    assert.equal(contender.decision, 'lease');
  }
  assert.equal(recordAt(store).token, held.handle.token);
  reset();
});

test('expired but the holder pid is alive and not renewing: refused until the liveness grace', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const holder = makeParty(store, clock, { label: 'holder', pid: 11 });
  const contender = makeParty(store, clock, { label: 'contender', pid: 22, alive: true });

  const held = acquireLock(SESSION, { leaseMs: 30_000 }, holder.deps);
  reset();
  const expiresAt = JSON.parse(store.read(LOCK_FILE)).expiresAt;

  clock.set(expiresAt + 1_000);
  const early = acquireLock(SESSION, {}, contender.deps);
  assert.equal(early.ok, false, 'expiry alone must not evict a live process');
  assert.equal(early.reason, 'held');
  assert.equal(early.decision, 'holder-alive-grace');

  clock.set(expiresAt + LIVENESS_GRACE_MS - 1);
  assert.equal(acquireLock(SESSION, {}, contender.deps).ok, false, 'still inside the grace');

  // The grace has a ceiling on purpose: a reused pid must not wedge the lock forever.
  clock.set(expiresAt + LIVENESS_GRACE_MS + 1);
  const late = acquireLock(SESSION, {}, contender.deps);
  assert.equal(late.ok, true, 'past the grace the lock is takeable even though the probe says alive');
  assert.notEqual(late.handle.token, held.handle.token);
  reset();
});

test('a renew colliding with an in-flight takeover is refused, and the next one reports lost', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const holder = makeParty(store, clock, { label: 'holder', pid: 11 });
  const taker = makeParty(store, clock, { label: 'taker', pid: 22, alive: false });

  const held = acquireLock(SESSION, { leaseMs: 30_000 }, holder.deps);
  reset();
  clock.advance(200_000);

  // Suspend the takeover right before it removes the stale record and let the holder try to renew
  // from inside that window. Both want to mutate the same generation, so the breaker decides.
  let renewDuringTakeover = null;
  store.once('unlinkSync', LOCK_FILE, () => {
    renewDuringTakeover = held.handle.renew();
  });

  const taken = acquireLock(SESSION, { leaseMs: 30_000 }, taker.deps);
  assert.equal(taken.ok, true);
  assert.equal(renewDuringTakeover.ok, false, 'renew cannot slip inside a takeover');
  assert.equal(renewDuringTakeover.reason, 'contended');
  assert.equal(renewDuringTakeover.stage, 'breaker');

  const after = held.handle.renew();
  assert.equal(after.ok, false);
  assert.equal(after.reason, 'lost', 'the old holder learns it lost the lock');
  assert.equal(after.holder.token, taken.handle.token);
  assert.equal(held.handle.live, false, 'a lost handle retires itself');
  assert.equal(recordAt(store).token, taken.handle.token, "the successor's record survived");
  reset();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// R3 CASE — an old holder releasing after a takeover.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('an old holder releasing after a takeover cannot remove the successor lock', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const old = makeParty(store, clock, { label: 'old', pid: 11 });
  const next = makeParty(store, clock, { label: 'next', pid: 22, alive: false });

  const oldHeld = acquireLock(SESSION, { leaseMs: 10_000 }, old.deps);
  reset();
  clock.advance(500_000);
  const successor = acquireLock(SESSION, { leaseMs: 30_000 }, next.deps);
  assert.equal(successor.ok, true);
  reset();

  const successorBytes = store.read(LOCK_FILE);
  const unlinksBefore = old.view.countOp('unlinkSync', LOCK_FILE);

  const released = oldHeld.handle.release();
  assert.equal(released.ok, false);
  assert.equal(released.reason, 'lost');
  assert.equal(released.holder.token, successor.handle.token);
  assert.equal(old.view.countOp('unlinkSync', LOCK_FILE), unlinksBefore,
    'the old holder performed no unlink of the lock file');
  assert.equal(store.read(LOCK_FILE), successorBytes, "the successor's record is byte-for-byte intact");
  assert.equal(successor.handle.verify().ok, true, 'the successor still owns the lock');
  reset();
});

test('a late release does not wedge lock ordering for its own process', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const old = makeParty(store, clock, { label: 'old', pid: 11 });
  const next = makeParty(store, clock, { label: 'next', pid: 22, alive: false });

  const oldHeld = acquireLock(SESSION, { leaseMs: 10_000 }, old.deps);
  assert.equal(heldLocks().length, 1);
  clock.advance(500_000);
  forgetHeldLocks();
  acquireLock(SESSION, { leaseMs: 30_000 }, next.deps);
  forgetHeldLocks();

  // Even though the release reports 'lost', the process-local entry must go, or every later
  // ordering check in this process would see a phantom session lock.
  const released = oldHeld.handle.release();
  assert.equal(released.reason, 'lost');
  assert.equal(oldHeld.handle.live, false);
  assert.deepEqual(heldLocks(), []);
  reset();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// R3 CASE — same-process reacquire.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('same-process reacquire: the second acquisition is refused while the first is held', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const me = makeParty(store, clock, { label: 'me', pid: 4242 });

  const first = acquireLock(SESSION, { leaseMs: 30_000 }, me.deps);
  assert.equal(first.ok, true);
  forgetHeldLocks(); // exercise the filesystem answer, not the process-local shortcut

  const second = acquireLock(SESSION, { leaseMs: 30_000 }, me.deps);
  assert.equal(second.ok, false, 'one process must not hold the same lock twice');
  assert.equal(second.reason, 'held');
  assert.equal(second.holder.pid, 4242, 'and it recognises itself as the holder');

  forgetHeldLocks();
  assert.equal(first.handle.release().ok, true);
  const third = acquireLock(SESSION, { leaseMs: 30_000 }, me.deps);
  assert.equal(third.ok, true);
  assert.notEqual(third.handle.token, first.handle.token,
    'a second acquisition by one process gets a distinct token');

  // The stale first handle must not be able to act on the new acquisition. PID and hostname are
  // identical here, so only the token can tell them apart.
  assert.equal(first.handle.release().reason, 'already-released');
  assert.equal(first.handle.renew().reason, 'released');
  assert.equal(recordAt(store).token, third.handle.token);
  reset();
});

test('same pid and host do not license a takeover of an expired lock', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const me = makeParty(store, clock, { label: 'me', pid: 4242, alive: true });
  acquireLock(SESSION, { leaseMs: 1_000 }, me.deps);
  forgetHeldLocks();
  clock.advance(30_000);

  const again = acquireLock(SESSION, { leaseMs: 1_000 }, me.deps);
  assert.equal(again.ok, false, 'recognising our own pid is not proof the first acquisition is done');
  assert.equal(again.decision, 'holder-alive-grace');
  reset();
});

test('tokens are unique across many acquisitions by one process', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const me = makeParty(store, clock, { label: 'me', pid: 4242 });
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const got = acquireLock(SESSION, { leaseMs: 1_000 }, me.deps);
    assert.equal(got.ok, true);
    assert.equal(seen.has(got.handle.token), false, 'tokens must never repeat');
    seen.add(got.handle.token);
    got.handle.release();
  }
  assert.equal(seen.size, 50);
  reset();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// R3 CASE — a hard-killed owner.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('a hard-killed owner is taken over as soon as its lease expires', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const victim = makeParty(store, clock, { label: 'victim', pid: 777 });
  const rescuer = makeParty(store, clock, { label: 'rescuer', pid: 888, alive: false });

  const held = acquireLock(SESSION, { leaseMs: 30_000 }, victim.deps);
  reset();
  // SIGKILL: no release, no renew, the record simply stops moving.
  const expiresAt = JSON.parse(store.read(LOCK_FILE)).expiresAt;

  clock.set(expiresAt - 1);
  assert.equal(acquireLock(SESSION, {}, rescuer.deps).ok, false, 'not yet expired');

  clock.set(expiresAt + 1);
  const status = inspectLock(SESSION, {}, rescuer.deps);
  assert.equal(status.held, true);
  assert.equal(status.takeoverReady, true);
  assert.equal(status.decision, 'holder-dead', 'a failed liveness probe, not age, decided it');

  const taken = acquireLock(SESSION, { leaseMs: 30_000 }, rescuer.deps);
  assert.equal(taken.ok, true, 'no liveness grace is owed to a process that is gone');
  assert.notEqual(taken.handle.token, held.handle.token);
  reset();
});

test('a holder on another host is judged on age alone, with a wider margin, and says so', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const remote = makeParty(store, clock, { label: 'remote', pid: 5, host: 'HOST-REMOTE' });
  const local = makeParty(store, clock, { label: 'local', pid: 6, host: 'HOST-A', alive: false });

  acquireLock(SESSION, { leaseMs: 10_000 }, remote.deps);
  reset();
  const expiresAt = JSON.parse(store.read(LOCK_FILE)).expiresAt;

  clock.set(expiresAt + 1_000);
  const early = acquireLock(SESSION, {}, local.deps);
  assert.equal(early.ok, false);
  assert.equal(early.decision, 'age-only', 'the decision records that no probe was possible');

  clock.set(expiresAt + 120_000);
  assert.equal(acquireLock(SESSION, {}, local.deps).ok, true);
  reset();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// R3 CASE — a failed renew.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('a renew whose write fails reports the failure and does not silently drop ownership', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const holder = makeParty(store, clock, { label: 'holder', pid: 11 });
  const held = acquireLock(SESSION, { leaseMs: 30_000 }, holder.deps);
  reset();

  const before = store.read(LOCK_FILE);
  store.fail('writeFileSync', LOCK_FILE, 'EACCES');
  clock.advance(10_000);
  const failed = held.handle.renew();
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'write-failed');
  assert.equal(failed.code, 'EACCES');
  assert.equal(store.read(LOCK_FILE), before, 'a failed renew leaves the record as it was');
  assert.equal(held.handle.live, true, 'a write failure is not evidence the lock was lost');

  store.clearFaults();
  assert.equal(held.handle.renew().ok, true, 'and the next renew recovers');
  reset();
});

test('a renew after the lock file vanished reports lost, and does not recreate it', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const holder = makeParty(store, clock, { label: 'holder', pid: 11 });
  const held = acquireLock(SESSION, { leaseMs: 30_000 }, holder.deps);
  reset();

  store.files.delete(LOCK_FILE);
  const failed = held.handle.renew();
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'lost');
  assert.equal(held.handle.live, false);
  assert.equal(store.read(LOCK_FILE), null, 'renew must not resurrect a lock it no longer holds');
  reset();
});

test('renew extends the lease and pushes back the takeover point', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const holder = makeParty(store, clock, { label: 'holder', pid: 11 });
  const other = makeParty(store, clock, { label: 'other', pid: 22, alive: false });
  const held = acquireLock(SESSION, { leaseMs: 30_000 }, holder.deps);
  reset();

  clock.advance(29_000);
  const renewed = held.handle.renew();
  assert.equal(renewed.ok, true);
  assert.equal(renewed.expiresAt, clock.now() + 30_000);
  assert.equal(JSON.parse(store.read(LOCK_FILE)).token, held.handle.token,
    'renew keeps the same generation, so the breaker path stays stable');

  clock.advance(5_000);
  assert.equal(acquireLock(SESSION, {}, other.deps).ok, false, 'the renewed lease is honoured');
  reset();
});

test('verify distinguishes still-ours, expired and lost', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const holder = makeParty(store, clock, { label: 'holder', pid: 11 });
  const thief = makeParty(store, clock, { label: 'thief', pid: 22, alive: false });
  const held = acquireLock(SESSION, { leaseMs: 10_000 }, holder.deps);
  reset();

  assert.equal(held.handle.verify().ok, true);
  clock.advance(11_000);
  const expired = held.handle.verify();
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'expired', 'still ours on disk, but past our own lease');

  clock.advance(500_000);
  acquireLock(SESSION, { leaseMs: 10_000 }, thief.deps);
  const lost = held.handle.verify();
  assert.equal(lost.ok, false);
  assert.equal(lost.reason, 'lost');
  reset();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// R3 CASE — overlapping watcher / hook / track calls whose transcripts grow between reads.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// A miniature of the checkpoint transaction R3 requires the lock to wrap: read the cursor, read
// however much transcript exists NOW, enqueue a segment, write the cursor back. The transcript
// grows underneath the writers, which is the point — the lock cannot stop that, it only has to
// stop two writers from computing a segment from the same cursor.
function makeWorld(store, clock) {
  const statePath = path.join(locksDir(), 'transaction-state.json');
  store.write(statePath, JSON.stringify({ cursor: 0 }));
  return {
    statePath,
    transcript: { lines: 0 },
    segments: [],
    runTransaction(party, label) {
      const view = party.view;
      const cursor = JSON.parse(view.readFileSync(statePath)).cursor;
      // The transcript may grow between the cursor read and the length read; that is realistic and
      // harmless. What must never happen is two writers reading the same cursor.
      const upTo = this.transcript.lines;
      if (upTo > cursor) {
        this.segments.push({ by: label, from: cursor, to: upTo });
        view.writeFileSync(statePath, JSON.stringify({ cursor: upTo }));
      }
      return { from: cursor, to: upTo };
    },
  };
}

function auditSegments(segments, finalLines) {
  const covered = new Array(finalLines).fill(0);
  for (const seg of segments) {
    for (let i = seg.from; i < seg.to; i += 1) covered[i] += 1;
  }
  return {
    duplicated: covered.filter((n) => n > 1).length,
    missed: covered.filter((n) => n === 0).length,
  };
}

test('overlapping watcher/hook/track writers: every transcript line is billed exactly once', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const world = makeWorld(store, clock);

  const watcher = makeParty(store, clock, { label: 'watcher', pid: 1 });
  const stopHook = makeParty(store, clock, { label: 'stop', pid: 2 });
  const track = makeParty(store, clock, { label: 'track', pid: 3 });

  world.transcript.lines = 5;

  const skipped = [];
  // Suspend the watcher inside its critical section, the instant after it has read the cursor, and
  // let the two other writers try to run. Both must defer rather than compute a segment from the
  // cursor the watcher is holding. The CONTROL test below runs this identical schedule with no
  // lock, so the two differ in exactly one thing.
  store.onceAfter('readFileSync', world.statePath, () => {
    world.transcript.lines = 6; // the transcript grows between the reads
    for (const [label, party] of [['stop', stopHook], ['track', track]]) {
      const attempt = withLock(SESSION, { leaseMs: 30_000, attempts: 1 }, () => {
        world.runTransaction(party, label);
      }, party.deps);
      if (attempt.skipped) skipped.push({ label, reason: attempt.reason });
    }
  });

  const watcherRun = withLock(SESSION, { leaseMs: 30_000 }, () => world.runTransaction(watcher, 'watcher'), watcher.deps);
  assert.equal(watcherRun.ok, true);
  assert.equal(watcherRun.release.ok, true, 'the watcher still owned the lock when it released');
  reset();

  assert.deepEqual(skipped.map((s) => s.label), ['stop', 'track'], 'both hooks deferred');
  assert.deepEqual(skipped.map((s) => s.reason), ['held', 'held']);
  assert.equal(world.segments.length, 1, 'exactly one writer computed a segment');

  // Now the deferred writers are re-run, as a hook or the next watcher tick would.
  world.transcript.lines = 9;
  const stopRun = withLock(SESSION, { leaseMs: 30_000 }, () => world.runTransaction(stopHook, 'stop'), stopHook.deps);
  assert.equal(stopRun.ok, true);
  reset();
  world.transcript.lines = 12;
  const trackRun = withLock(SESSION, { leaseMs: 30_000 }, () => world.runTransaction(track, 'track'), track.deps);
  assert.equal(trackRun.ok, true);
  reset();

  const audit = auditSegments(world.segments, 12);
  assert.equal(audit.duplicated, 0, 'no transcript line is billed twice');
  assert.equal(audit.missed, 0, 'and none is dropped');
  assert.deepEqual(world.segments.map((s) => [s.from, s.to]), [[0, 6], [6, 9], [9, 12]]);
  assert.equal(JSON.parse(store.read(world.statePath)).cursor, 12);
});

test('CONTROL: the same interleaving without the lock loses an update', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const world = makeWorld(store, clock);

  const watcher = makeParty(store, clock, { label: 'watcher', pid: 1 });
  const stopHook = makeParty(store, clock, { label: 'stop', pid: 2 });

  world.transcript.lines = 5;
  // The watcher has already read cursor=0 when the Stop hook runs. Same schedule as the locked
  // test, minus the lock.
  store.onceAfter('readFileSync', world.statePath, () => {
    world.transcript.lines = 6;
    world.runTransaction(stopHook, 'stop');
  });
  world.runTransaction(watcher, 'watcher');

  const audit = auditSegments(world.segments, 6);
  assert.equal(world.segments.length, 2);
  assert.ok(audit.duplicated > 0,
    'without the lock two writers compute overlapping segments from one cursor — this is the bug the lock exists to prevent');
  assert.deepEqual(world.segments.map((s) => [s.from, s.to]), [[0, 6], [0, 6]]);
  reset();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Per-use stale policy.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test("the holder's own lease governs a takeover, not the contender's stale policy", () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  // The backfill takes a ten-minute lease around its one-time seal.
  const backfill = makeParty(store, clock, { label: 'backfill', pid: 11 });
  const hook = makeParty(store, clock, { label: 'hook', pid: 22, alive: false });

  const run = runLock('backfill');
  const held = acquireLock(run, { leaseMs: 600_000 }, backfill.deps);
  assert.equal(held.ok, true);
  reset();

  // A Stop hook whose own policy is 1s must not conclude the backfill is stale after 5s.
  clock.advance(5_000);
  const refused = acquireLock(run, { leaseMs: 1_000, staleMs: 1_000 }, hook.deps);
  assert.equal(refused.ok, false, 'a short-lease contender cannot shorten the holder lease');
  assert.equal(refused.reason, 'held');
  assert.equal(refused.decision, 'lease');
  assert.equal(refused.holder.leaseMs, 600_000);
  reset();
});

test('a record claiming an absurd lease is capped, so a malformed lock cannot wedge forever', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const contender = makeParty(store, clock, { label: 'contender', pid: 22, alive: false });

  store.write(LOCK_FILE, JSON.stringify({
    v: 1,
    token: 'forever',
    kind: LOCK_KINDS.SESSION,
    name: SESSION.name,
    host: 'HOST-A',
    pid: 999,
    acquiredAt: clock.now(),
    renewedAt: clock.now(),
    leaseMs: 5_000_000_000,
    expiresAt: clock.now() + 5_000_000_000,
  }));

  clock.advance(60_000);
  assert.equal(acquireLock(SESSION, {}, contender.deps).ok, false, 'still inside the cap');
  clock.advance(35 * 60 * 1000);
  const taken = acquireLock(SESSION, {}, contender.deps);
  assert.equal(taken.ok, true, 'the 30-minute ceiling on a claimed lease applies');
  reset();
});

test('a record whose leaseMs and expiresAt disagree is judged on the shorter of the two', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const contender = makeParty(store, clock, { label: 'contender', pid: 22, alive: false });
  const base = clock.now();
  store.write(LOCK_FILE, JSON.stringify({
    v: 1,
    token: 'inconsistent',
    kind: LOCK_KINDS.SESSION,
    name: SESSION.name,
    host: 'HOST-A',
    pid: 999,
    acquiredAt: base,
    renewedAt: base,
    leaseMs: 5_000,
    expiresAt: base + 900_000, // a much longer claim than the lease it declares
  }));
  clock.set(base + 6_000);
  assert.equal(acquireLock(SESSION, {}, contender.deps).ok, true,
    'a malformed record fails towards recoverable, not towards wedged');
  reset();
});

test('a caller may narrow the cap for its own use', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const holder = makeParty(store, clock, { label: 'holder', pid: 11 });
  const contender = makeParty(store, clock, { label: 'contender', pid: 22, alive: false });
  acquireLock(SESSION, { leaseMs: 600_000 }, holder.deps);
  reset();

  clock.advance(120_000);
  assert.equal(acquireLock(SESSION, {}, contender.deps).ok, false);
  assert.equal(acquireLock(SESSION, { maxHolderLeaseMs: 60_000 }, contender.deps).ok, true,
    'an explicit ceiling is the per-use stale policy');
  reset();
});

test('an empty or truncated lock file is aged by its own small grace, not by the caller lease', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const contender = makeParty(store, clock, { label: 'contender', pid: 22, alive: false });

  // A writer that created the file and died before writing the record.
  store.write(LOCK_FILE, '');
  const status = inspectLock(SESSION, {}, contender.deps);
  assert.equal(status.held, true);
  assert.equal(status.holder.corrupt, true);
  assert.equal(status.takeoverReady, false, 'a just-created empty lock is not immediately free');

  clock.advance(CORRUPT_GRACE_MS + 1);
  const taken = acquireLock(SESSION, { leaseMs: 600_000 }, contender.deps);
  assert.equal(taken.ok, true, 'the corrupt grace is independent of the ten-minute lease we want');
  assert.equal(taken.handle.verify().ok, true);
  reset();
});

test('a record with a token but no timestamps cannot wedge the lock forever', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const contender = makeParty(store, clock, { label: 'contender', pid: 22, alive: false });

  // No renewedAt, no acquiredAt, no expiresAt. Trusting this record would mean nothing can ever
  // recover the lock, so it is aged by the file's own mtime instead.
  store.write(LOCK_FILE, JSON.stringify({ v: 1, token: 'timeless', host: 'HOST-A', pid: 999 }));
  const status = inspectLock(SESSION, {}, contender.deps);
  assert.equal(status.takeoverReady, false, 'not immediately free');
  assert.equal(status.decision, 'malformed-grace');

  clock.advance(CORRUPT_GRACE_MS + 1);
  assert.equal(acquireLock(SESSION, {}, contender.deps).ok, true, 'recoverable, not wedged');
  reset();
});

test('a timestampless record claiming a far-future expiry is honoured but still capped', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const contender = makeParty(store, clock, { label: 'contender', pid: 22, alive: false });
  const base = clock.now();

  // expiresAt with nothing to age it from: the claim is respected, but only up to the ceiling.
  store.write(LOCK_FILE, JSON.stringify({
    v: 1, token: 'claimant', host: 'HOST-A', pid: 999, expiresAt: base + 5_000_000_000,
  }));

  clock.set(base + CORRUPT_GRACE_MS + 1);
  assert.equal(acquireLock(SESSION, {}, contender.deps).ok, false, 'the claimed expiry is honoured');
  clock.set(base + 60_000);
  assert.equal(acquireLock(SESSION, {}, contender.deps).ok, false, 'still inside the ceiling');
  clock.set(base + 35 * 60 * 1000);
  assert.equal(acquireLock(SESSION, {}, contender.deps).ok, true,
    'past the 30-minute ceiling the lock is recoverable');
  reset();
});

test('a half-written JSON lock file is serialized on its bytes, not treated as free', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const a = makeParty(store, clock, { label: 'A', pid: 11, alive: false });
  const b = makeParty(store, clock, { label: 'B', pid: 12, alive: false });

  store.write(LOCK_FILE, '{"v":1,"token":"abc","lea');
  clock.advance(CORRUPT_GRACE_MS + 1);

  let bResult = null;
  store.once('unlinkSync', LOCK_FILE, () => {
    bResult = acquireLock(SESSION, {}, b.deps);
  });
  const aResult = acquireLock(SESSION, {}, a.deps);

  assert.equal(aResult.ok, true);
  assert.equal(bResult.ok, false, 'a corrupt lock is still one lock: only one contender may claim it');
  assert.equal(b.view.countOp('unlinkSync', LOCK_FILE), 0);
  reset();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Lock ordering.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('coarse to fine is allowed; fine to coarse is refused', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const me = makeParty(store, clock, { label: 'me', pid: 11 });

  const election = acquireLock(electionLock('watcher'), {}, me.deps);
  assert.equal(election.ok, true);
  const run = acquireLock(runLock('backfill'), {}, me.deps);
  assert.equal(run.ok, true);
  const session = acquireLock(sessionLock('s1'), { recoveryPermit: run.handle.token }, me.deps);
  assert.equal(session.ok, true);
  const shared = acquireLock(sharedLock('queue'), {}, me.deps);
  assert.equal(shared.ok, true);
  assert.equal(heldLocks().length, 4);

  const backwards = acquireLock(runLock('other'), {}, me.deps);
  assert.equal(backwards.ok, false);
  assert.equal(backwards.reason, 'lock-order');
  assert.ok(/rank/.test(backwards.detail));
  assert.equal(store.read(runLock('other').file), null, 'a refused ordering never touches the filesystem');

  shared.handle.release();
  session.handle.release();
  run.handle.release();
  election.handle.release();
  assert.deepEqual(heldLocks(), []);
  reset();
});

test('two session locks at once are refused: subagent work runs under its root session lock', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const me = makeParty(store, clock, { label: 'me', pid: 11 });

  const root = acquireLock(sessionLock('root'), {}, me.deps);
  assert.equal(root.ok, true);
  const child = acquireLock(sessionLock('child'), {}, me.deps);
  assert.equal(child.ok, false);
  assert.equal(child.reason, 'lock-order', 'same-rank nesting is the deadlock case, so it is refused');
  root.handle.release();
  reset();
});

test('the same lock name is answered by the filesystem, not by the ordering guard', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const me = makeParty(store, clock, { label: 'me', pid: 11 });
  const first = acquireLock(sessionLock('s1'), {}, me.deps);
  assert.equal(first.ok, true);
  const again = acquireLock(sessionLock('s1'), {}, me.deps);
  assert.equal(again.reason, 'held', 'not "lock-order" — the caller needs to see the real holder');
  assert.equal(again.holder.token, first.handle.token);
  first.handle.release();
  reset();
});

test('releasing removes the process-local ordering entry so the next pass is not wedged', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const me = makeParty(store, clock, { label: 'me', pid: 11 });
  const shared = acquireLock(sharedLock('queue'), {}, me.deps);
  assert.equal(acquireLock(electionLock('watcher'), {}, me.deps).reason, 'lock-order');
  shared.handle.release();
  const election = acquireLock(electionLock('watcher'), {}, me.deps);
  assert.equal(election.ok, true);
  election.handle.release();
  reset();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The breaker.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('a breaker held by a live process is never recovered, however old it looks', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const dead = makeParty(store, clock, { label: 'dead', pid: 999 });
  acquireLock(SESSION, { leaseMs: 1_000 }, dead.deps);
  reset();
  clock.advance(500_000);

  // A breaker for the stale generation, ancient, but whose holder answers the liveness probe.
  const staleToken = JSON.parse(store.read(LOCK_FILE)).token;
  const breakerFile = breakerPathOf(LOCK_FILE, staleToken);
  store.write(breakerFile, JSON.stringify({
    v: 1, id: 'zombie', host: 'HOST-A', pid: 31337, startedAt: clock.now() - BREAKER_STALE_MS * 100,
  }));

  const liveHolder = makeParty(store, clock, { label: 'contender', pid: 12, alive: (pid) => pid === 31337 });
  const refused = acquireLock(SESSION, {}, liveHolder.deps);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'contended', 'age alone does not release a section from a live process');
  assert.equal(store.read(breakerFile) !== null, true, 'the breaker survives');

  // Once the probe says the breaker holder is gone, the takeover proceeds.
  const afterDeath = makeParty(store, clock, { label: 'after', pid: 13, alive: false });
  assert.equal(acquireLock(SESSION, {}, afterDeath.deps).ok, true);
  reset();
});

test('a fresh breaker blocks a second takeover of the same generation', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const dead = makeParty(store, clock, { label: 'dead', pid: 999 });
  acquireLock(SESSION, { leaseMs: 1_000 }, dead.deps);
  reset();
  clock.advance(500_000);

  const staleToken = JSON.parse(store.read(LOCK_FILE)).token;
  const breakerFile = breakerPathOf(LOCK_FILE, staleToken);
  store.write(breakerFile, JSON.stringify({
    v: 1, id: 'in-flight', host: 'HOST-A', pid: 12, startedAt: clock.now(),
  }));

  const contender = makeParty(store, clock, { label: 'contender', pid: 13, alive: false });
  const refused = acquireLock(SESSION, { attempts: 1 }, contender.deps);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'contended');
  assert.equal(contender.view.countOp('unlinkSync', LOCK_FILE), 0);
  reset();
});

test('successful acquire sweeps only long-abandoned breakers for its own lock', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const me = makeParty(store, clock, { label: 'me', pid: 11 });

  const ancient = `${LOCK_FILE}.take-aaaaaaaaaaaaaaaa`;
  const recent = `${LOCK_FILE}.take-bbbbbbbbbbbbbbbb`;
  const otherLock = `${sessionLock('other').file}.take-cccccccccccccccc`;
  store.write(ancient, '{}');
  clock.advance(BREAKER_STALE_MS * 20);
  store.write(recent, '{}');
  store.write(otherLock, '{}');

  const got = acquireLock(SESSION, {}, me.deps);
  assert.equal(got.ok, true);
  assert.equal(store.read(ancient), null, 'a breaker older than ten stale windows is swept');
  assert.equal(store.read(recent) !== null, true, 'a recent one is left alone');
  assert.equal(store.read(otherLock) !== null, true, "another lock's breakers are not touched");
  got.handle.release();
  reset();
});

test('acquire leaves no breaker behind on the happy path or on refusal', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const dead = makeParty(store, clock, { label: 'dead', pid: 999 });
  const taker = makeParty(store, clock, { label: 'taker', pid: 11, alive: false });
  acquireLock(SESSION, { leaseMs: 1_000 }, dead.deps);
  reset();
  clock.advance(500_000);

  const taken = acquireLock(SESSION, { leaseMs: 30_000, sweep: false }, taker.deps);
  assert.equal(taken.ok, true);
  taken.handle.renew();
  taken.handle.release();

  const leftovers = [];
  for (const key of store.files.keys()) if (key.includes('.take-')) leftovers.push(key);
  assert.deepEqual(leftovers, [], 'every guarded section cleans up its own breaker');
  reset();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Transaction helpers.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('withLock skips the critical section entirely on contention', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const holder = makeParty(store, clock, { label: 'holder', pid: 11 });
  const hook = makeParty(store, clock, { label: 'hook', pid: 22 });
  acquireLock(SESSION, { leaseMs: 60_000 }, holder.deps);
  reset();

  let ran = 0;
  const result = withLock(SESSION, { attempts: 1 }, () => { ran += 1; }, hook.deps);
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'held');
  assert.equal(ran, 0, 'the section must not run when the lock was not taken');
  reset();
});

test('withLock releases even when the critical section throws', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const me = makeParty(store, clock, { label: 'me', pid: 11 });
  assert.throws(() => withLock(SESSION, {}, () => { throw new Error('boom'); }, me.deps), /boom/);
  assert.equal(store.read(LOCK_FILE), null, 'the lock file is gone');
  assert.deepEqual(heldLocks(), [], 'and the ordering entry with it');
  reset();
});

test('withLock reports a release that discovered the lock had been lost', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const me = makeParty(store, clock, { label: 'me', pid: 11 });
  const thief = makeParty(store, clock, { label: 'thief', pid: 22, alive: false });

  const result = withLock(SESSION, { leaseMs: 1_000 }, () => {
    // The section overruns its lease and a contender takes the lock underneath it.
    clock.advance(500_000);
    forgetHeldLocks();
    acquireLock(SESSION, { leaseMs: 30_000 }, thief.deps);
    forgetHeldLocks();
    return 'done';
  }, me.deps);

  assert.equal(result.ok, true);
  assert.equal(result.value, 'done');
  assert.equal(result.release.ok, false);
  assert.equal(result.release.reason, 'lost',
    'the caller can see that its section ran while somebody else owned the lock');
  reset();
});

test('withLockAsync awaits the section before releasing', async () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const me = makeParty(store, clock, { label: 'me', pid: 11 });

  let insideHeld = null;
  const result = await withLockAsync(SESSION, {}, async (handle) => {
    await Promise.resolve();
    insideHeld = store.read(LOCK_FILE) !== null && handle.verify().ok;
    return 42;
  }, me.deps);

  assert.equal(result.ok, true);
  assert.equal(result.value, 42);
  assert.equal(insideHeld, true, 'the lock was still held when the promise settled');
  assert.equal(store.read(LOCK_FILE), null, 'and released afterwards');
  reset();
});

test('withLockAsync skips on contention without running the section', async () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const holder = makeParty(store, clock, { label: 'holder', pid: 11 });
  const other = makeParty(store, clock, { label: 'other', pid: 22 });
  acquireLock(SESSION, { leaseMs: 60_000 }, holder.deps);
  reset();

  let ran = 0;
  const result = await withLockAsync(SESSION, { attempts: 1 }, async () => { ran += 1; }, other.deps);
  assert.equal(result.skipped, true);
  assert.equal(ran, 0);
  reset();
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Backfill run lock: renewal across a long scan and a clean abort when ownership is lost.
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('a backfill run lock renews across a long scan and aborts cleanly when ownership is lost', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const backfill = makeParty(store, clock, { label: 'backfill', pid: 11 });
  const intruder = makeParty(store, clock, { label: 'intruder', pid: 22, alive: false });

  const run = runLock('backfill');
  const held = acquireLock(run, { leaseMs: 60_000 }, backfill.deps);
  assert.equal(held.ok, true);
  reset();

  let sealed = false;
  let aborted = false;
  for (let batch = 0; batch < 10; batch += 1) {
    clock.advance(30_000);
    if (batch === 5) {
      // Somebody removed the lock file out from under the scan (disk cleanup, a manual rm).
      store.files.delete(run.file);
      acquireLock(run, { leaseMs: 60_000 }, intruder.deps);
      forgetHeldLocks();
    }
    const renewed = held.handle.renew();
    if (!renewed.ok) { aborted = true; break; }
  }
  assert.equal(aborted, true, 'the scan stops the moment the run lock is no longer ours');
  assert.equal(held.handle.live, false);

  // The seal is the thing that must never happen twice. Guarding it on verify() is the contract.
  if (held.handle.verify().ok) sealed = true;
  assert.equal(sealed, false, 'a run that lost its lock must not reach the one-time seal');
  reset();
});

test('inspectLock reports a holder without contending for the lock', () => {
  reset();
  const clock = makeClock();
  const store = makeStore(clock);
  const holder = makeParty(store, clock, { label: 'holder', pid: 11 });
  const observer = makeParty(store, clock, { label: 'observer', pid: 22 });

  assert.deepEqual(inspectLock(SESSION, {}, observer.deps).held, false);
  const held = acquireLock(SESSION, { leaseMs: 30_000 }, holder.deps);
  reset();

  const status = inspectLock(SESSION, {}, observer.deps);
  assert.equal(status.held, true);
  assert.equal(status.holder.token, held.handle.token);
  assert.equal(status.holder.pid, 11);
  assert.equal(status.takeoverReady, false);
  assert.equal(observer.view.countOp('writeFileSync', LOCK_FILE), 0, 'inspection writes nothing');
  assert.equal(observer.view.countOp('unlinkSync', LOCK_FILE), 0);
  reset();
});

test('defaults are the documented ones', () => {
  assert.equal(DEFAULT_LEASE_MS, 30_000);
  assert.equal(LIVENESS_GRACE_MS, 60_000);
  assert.equal(CORRUPT_GRACE_MS, 15_000);
  assert.equal(BREAKER_STALE_MS, 30_000);
});
