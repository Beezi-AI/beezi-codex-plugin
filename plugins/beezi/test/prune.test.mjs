import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneStale } from '../lib/prune.mjs';
import { writeJsonSecure, safeFileName } from '../lib/fs-store.mjs';

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

function queueDir(homeDir) {
  return path.join(homeDir, 'queue');
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
