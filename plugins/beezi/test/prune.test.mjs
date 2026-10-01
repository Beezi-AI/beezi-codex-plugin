import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneStale, LOCK_STALE_AGE_MS } from '../lib/prune.mjs';
import { linkAccount, TEST_KEY } from '../tools/account-fixtures.mjs';
import { writeJsonSecure, safeFileName } from '../lib/fs-store.mjs';
import {
  acquireLock, electionLock, sessionLock, locksDir, forgetHeldLocks, MAX_HOLDER_LEASE_MS,
} from '../lib/single-instance-lock.mjs';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setHome(dir) {
  process.env.BEEZI_CODEX_HOME = dir;
}

function stateDir(homeDir) {
  return path.join(homeDir, 'state');
}

// The queue moved under accounts/<key>/ when the layout became per-account, and pruneStale sweeps
// every linked account's. Linking one is therefore part of the fixture: a queue whose account is
// not in the index is not swept, which is the safe direction but not what this file is testing.
const KEY = TEST_KEY;

function queueDir(homeDir) {
  return path.join(homeDir, 'accounts', KEY, 'queue');
}

function writeFile(dir, name, content = '{}') {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

function ageFile(p, ageMs, now = Date.now()) {
  // utimesSync takes seconds
  const timeSec = (now - ageMs) / 1000;
  fs.utimesSync(p, timeSec, timeSec);
}

// ─── test 1: prunes old state file ──────────────────────────────────────────

test('1. prunes old state file (mtime 15 days ago)', (t) => {
  const homeDir = makeTmpDir(t);
  setHome(homeDir);
  linkAccount(homeDir, KEY);

  const now = Date.now();
  const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000;

  const p = writeFile(stateDir(homeDir), 'old.json');
  ageFile(p, fifteenDaysMs, now);

  pruneStale(now);

  assert.equal(fs.existsSync(p), false, 'old state file must be pruned');
});

// ─── test 2: keeps recent state file ────────────────────────────────────────

test('2. keeps recent state file (mtime now)', (t) => {
  const homeDir = makeTmpDir(t);
  setHome(homeDir);
  linkAccount(homeDir, KEY);

  const now = Date.now();

  const p = writeFile(stateDir(homeDir), 'fresh.json');
  ageFile(p, 0, now); // mtime = now

  pruneStale(now);

  assert.equal(fs.existsSync(p), true, 'recent state file must be kept');
});

// ─── test 3: prunes old queue file, keeps recent queue file ─────────────────

test('3. prunes old queue file, keeps recent queue file', (t) => {
  const homeDir = makeTmpDir(t);
  setHome(homeDir);
  linkAccount(homeDir, KEY);

  const now = Date.now();
  const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000;

  const qd = queueDir(homeDir);
  const oldFile = writeFile(qd, 'old-seg.json');
  const recentFile = writeFile(qd, 'recent-seg.json');

  ageFile(oldFile, fifteenDaysMs, now);
  ageFile(recentFile, 0, now);

  pruneStale(now);

  assert.equal(fs.existsSync(oldFile), false, 'old queue file must be pruned');
  assert.equal(fs.existsSync(recentFile), true, 'recent queue file must be kept');
});

// ─── test 4: missing dirs → no throw ────────────────────────────────────────

test('4. missing dirs → no throw', (t) => {
  const homeDir = makeTmpDir(t);
  setHome(homeDir);
  linkAccount(homeDir, KEY);
  // Neither state/ nor queue/ exist in homeDir

  assert.doesNotThrow(() => pruneStale(Date.now()));
});

// ─── test 5: custom maxAgeMs boundary ────────────────────────────────────────

test('5. custom maxAgeMs boundary — 2-day-old file pruned at 1d, kept at 3d', (t) => {
  const now = Date.now();
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
  const oneDayMs = 1 * 24 * 60 * 60 * 1000;
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

  // ── scenario A: maxAgeMs = 1 day → file aged 2 days should be pruned ──
  const homeDirA = makeTmpDir(t);
  process.env.BEEZI_CODEX_HOME = homeDirA;

  const pA = writeFile(stateDir(homeDirA), 'file-a.json');
  ageFile(pA, twoDaysMs, now);

  pruneStale(now, oneDayMs);
  assert.equal(fs.existsSync(pA), false, '2-day-old file pruned with maxAgeMs=1day');

  // ── scenario B: maxAgeMs = 3 days → file aged 2 days should be kept ──
  const homeDirB = makeTmpDir(t);
  process.env.BEEZI_CODEX_HOME = homeDirB;

  const pB = writeFile(stateDir(homeDirB), 'file-b.json');
  ageFile(pB, twoDaysMs, now);

  pruneStale(now, threeDaysMs);
  assert.equal(fs.existsSync(pB), true, '2-day-old file kept with maxAgeMs=3days');
});

test('a stale session takes its subagent directory with it', (t) => {
  const home = makeTmpDir(t);
  setHome(home);
  const agents = path.join(stateDir(home), 'sess-old.agents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'agent-a.json'), '{}');
  fs.writeFileSync(path.join(stateDir(home), 'sess-old.json'), '{}');

  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(agents, old, old);
  fs.utimesSync(path.join(stateDir(home), 'sess-old.json'), old, old);

  pruneStale();

  // unlinkSync cannot remove a directory, so without the directory branch these accumulate forever
  // while every other stale entry is swept.
  assert.equal(fs.existsSync(agents), false);
  assert.equal(fs.existsSync(path.join(stateDir(home), 'sess-old.json')), false);
});

test('a live session keeps its subagent directory', (t) => {
  const home = makeTmpDir(t);
  setHome(home);
  const agents = path.join(stateDir(home), 'sess-new.agents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'agent-a.json'), '{}');
  pruneStale();
  assert.equal(fs.existsSync(agents), true);
});

test('a failed atomic replace leaves the old file intact rather than tearing it', (t) => {
  const home = makeTmpDir(t);
  setHome(home);
  const target = path.join(stateDir(home), 'held.json');
  fs.mkdirSync(stateDir(home), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ cursor: 42 }));

  // Simulate the AV/indexer case: the rename cannot land. The old contract overwrote in place,
  // which is the torn write the tmp+rename exists to prevent, in the one case where contention is
  // proven. Now it throws and the previous state survives — a re-reported window the server
  // upserts, rather than a `{cursor: 0}` fallback that re-bills the whole session.
  const realRename = fs.renameSync;
  fs.renameSync = () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
  t.after(() => { fs.renameSync = realRename; });

  assert.throws(() => writeJsonSecure(target, { cursor: 99 }), /could not atomically replace/);
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf-8')).cursor, 42, 'old contents preserved');
  assert.equal(fs.readdirSync(stateDir(home)).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp file left behind');
});

test('safeFileName reduces untrusted input to one harmless path component', () => {
  assert.equal(safeFileName('../../../evil'), '.._.._.._evil');
  assert.equal(safeFileName('a/b\\c'), 'a_b_c');
  assert.equal(safeFileName('C:\\Windows\\System32'), 'C__Windows_System32');
  assert.equal(safeFileName(''), 'unknown');
  assert.equal(safeFileName(null), 'unknown');
  assert.equal(safeFileName('x'.repeat(500)).length, 120, 'bounded for filesystem name limits');
  for (const evil of ['../../../evil', 'a/b', '..', 'a\\b', 'C:/x', 'C:\\x']) {
    assert.ok(!/[\\/]/.test(safeFileName(evil)), `no separator survives: ${evil}`);
  }
});

// ─── backfill durability: root-level files are outside prune's reach ────────

// The audit ledger and tracking cache record one-time facts (which sessions the history pull
// delivered, whether the pull is sealed). If prune could expire them, every old session would
// look importable again after 14 quiet days.
test('the audit ledger and tracking state at the home root survive pruning', (t) => {
  const homeDir = makeTmpDir(t);
  setHome(homeDir);
  linkAccount(homeDir, KEY);

  const now = Date.now();
  const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000;

  const ledger = writeFile(homeDir, 'audit-ledger.json');
  const tracking = writeFile(homeDir, 'tracking.json');
  ageFile(ledger, fifteenDaysMs, now);
  ageFile(tracking, fifteenDaysMs, now);

  pruneStale(now);

  assert.equal(fs.existsSync(ledger), true, 'the ledger must outlive the prune window');
  assert.equal(fs.existsSync(tracking), true, 'the tracking cache must outlive the prune window');
});

// ─── locks/ — the residual filed twice against G-8-3, closed by G-1-1 ────────
//
// The watcher is what GENERATES abandoned lock files: it holds `election-watcher` for the whole
// life of an MCP process, and that process is hard-killed at session end, so the record is left on
// disk with no release. Breakers are in the same position — `sweepAbandonedBreakers` only runs on
// a successful acquire of that exact lock, so litter belonging to a lock nobody takes again stays
// forever.
//
// The reason this sweep was deferred rather than dropped in with the rest is that it INTERACTS
// WITH LIVE ACQUISITION, and that interaction is what these tests are about. An unguarded
// stat-then-unlink from prune is precisely the check-then-unlink race R3 names: it could delete a
// lock a successor created microseconds earlier, and both parties would then believe they hold it.
// What makes it safe is that it only ever reaches files no live holder could own — LOCK_STALE_AGE_MS
// is a floor no caller's window can lower.

test('locks — an abandoned lock file is swept once it is far past any possible lease', (t) => {
  const home = makeTmpDir(t);
  setHome(home);
  t.after(() => forgetHeldLocks());

  const dir = locksDir();
  fs.mkdirSync(dir, { recursive: true });
  const abandoned = path.join(dir, 'election-watcher.lock');
  fs.writeFileSync(abandoned, JSON.stringify({ v: 1, token: 'dead', host: 'gone', pid: 999999 }));
  const now = Date.now();
  ageFile(abandoned, LOCK_STALE_AGE_MS + 60_000, now);

  pruneStale(now);
  assert.equal(fs.existsSync(abandoned), false, 'a corpse from a killed watcher must not accumulate');
});

test('locks — breaker cleanup remains inside the lock recovery protocol', (t) => {
  const home = makeTmpDir(t);
  setHome(home);
  t.after(() => forgetHeldLocks());

  const dir = locksDir();
  fs.mkdirSync(dir, { recursive: true });
  const breaker = path.join(dir, 'session-abc.lock.take-0123456789abcdef');
  fs.writeFileSync(breaker, JSON.stringify({ v: 1, id: 'x', host: 'gone', pid: 999999, startedAt: 0 }));
  const now = Date.now();
  ageFile(breaker, LOCK_STALE_AGE_MS + 60_000, now);

  pruneStale(now);
  assert.equal(fs.existsSync(breaker), true, 'generic pruning cannot establish breaker ownership');
});

test('locks — a LIVE lock is never swept, and the holder still owns it afterwards', (t) => {
  const home = makeTmpDir(t);
  setHome(home);
  t.after(() => forgetHeldLocks());

  const held = acquireLock(electionLock('watcher'), { leaseMs: 60_000 });
  assert.equal(held.ok, true, 'precondition: the lock was taken');
  t.after(() => held.handle.release());

  // The aggressive window a caller is entitled to pass for state/ and queue/. Without the floor
  // this would delete a lock a hook is holding right now, and the next acquirer would take it
  // while the first was mid-transaction — a lost update, not a tidy directory.
  pruneStale(Date.now(), 1);

  assert.equal(fs.existsSync(held.handle.file), true, 'the live lock survived');
  const owned = held.handle.verify();
  assert.equal(owned.ok, true, `the holder still owns it (${owned.reason})`);
});

test('locks — the stale window is derived from the lease ceiling, not chosen by hand', () => {
  // A record may not claim a lease longer than MAX_HOLDER_LEASE_MS, and a live holder renews,
  // which rewrites the file and moves its mtime. So anything past this window is provably dead.
  assert.ok(LOCK_STALE_AGE_MS >= MAX_HOLDER_LEASE_MS, 'the window must cover the longest legal lease');
});

test('locks — the caller\'s retention window does not reach locks/ in either direction', (t) => {
  const home = makeTmpDir(t);
  setHome(home);
  t.after(() => forgetHeldLocks());

  const dir = locksDir();
  fs.mkdirSync(dir, { recursive: true });
  const corpse = path.join(dir, 'run-backfill.lock');
  fs.writeFileSync(corpse, JSON.stringify({ v: 1, token: 'dead', host: 'gone', pid: 999999 }));
  const now = Date.now();
  ageFile(corpse, LOCK_STALE_AGE_MS + 60_000, now);

  // A thirty-day retention window for analytics data must not keep a dead lock for thirty days,
  // and a one-second window must not shorten the lock rule either (the live-lock test above).
  pruneStale(now, 30 * 24 * 60 * 60 * 1000);
  assert.equal(fs.existsSync(corpse), false, 'lock hygiene is independent of data retention');
});

test('locks — a renewed lock keeps moving out of reach of the sweep', (t) => {
  const home = makeTmpDir(t);
  setHome(home);
  t.after(() => forgetHeldLocks());

  const held = acquireLock(sessionLock('sess-live'), { leaseMs: 5_000 });
  assert.equal(held.ok, true);
  t.after(() => held.handle.release());

  // Age it past the floor, then renew: the renew rewrites the record, which is what moves the
  // mtime back inside the protected window. This is the property the sweep leans on.
  ageFile(held.handle.file, LOCK_STALE_AGE_MS + 60_000);
  assert.equal(held.handle.renew({ leaseMs: 5_000 }).ok, true);

  pruneStale(Date.now(), 1);
  assert.equal(fs.existsSync(held.handle.file), true, 'a renewing holder is never swept');
});

test('locks — a stale lock in locks/ does NOT block a fresh acquisition after the sweep', (t) => {
  const home = makeTmpDir(t);
  setHome(home);
  t.after(() => forgetHeldLocks());

  const dir = locksDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'election-watcher.lock');
  fs.writeFileSync(file, JSON.stringify({ v: 1, token: 'dead', host: 'gone', pid: 999999 }));
  const now = Date.now();
  ageFile(file, LOCK_STALE_AGE_MS + 60_000, now);

  pruneStale(now);
  const taken = acquireLock(electionLock('watcher'), { leaseMs: 1_000 });
  assert.equal(taken.ok, true, 'the next watcher elects itself on a clean path');
  taken.handle.release();
});

test('locks — a missing locks/ directory is not an error', (t) => {
  const home = makeTmpDir(t);
  setHome(home);
  assert.equal(fs.existsSync(path.join(home, 'locks')), false);
  assert.doesNotThrow(() => pruneStale(Date.now()));
});
