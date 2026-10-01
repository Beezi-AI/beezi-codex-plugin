import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAllRollouts } from '../lib/transcript-index-codex.mjs';

// Discovery for the history backfill: every top-level session in the date-partitioned tree,
// subagent rollouts excluded, one entry per session id, oldest first.

const UUID_A = '019fd897-9320-7c20-9585-8fa3fff07bf7';
const UUID_B = '029fd897-9320-7c20-9585-8fa3fff07bf8';
const UUID_C = '039fd897-9320-7c20-9585-8fa3fff07bf9';

const meta = (id, over = {}) => ({
  timestamp: '2026-08-06T19:41:50.274Z',
  type: 'session_meta',
  payload: { id, session_id: id, thread_source: 'user', source: 'cli', cwd: 'C:\\repo', ...over },
});

const subMeta = (id, parentId) =>
  meta(id, { session_id: parentId, parent_thread_id: parentId, thread_source: 'subagent' });

function makeTree(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-index-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeRollout(root, datePath, name, records, mtimeMs = null) {
  const dir = path.join(root, ...datePath.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (mtimeMs != null) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test('finds top-level rollouts across the date tree with id, cwd, size and mtime', (t) => {
  const root = makeTree(t);
  writeRollout(root, '2026/07/01', `rollout-2026-07-01T00-00-00-${UUID_A}.jsonl`, [meta(UUID_A)]);
  writeRollout(root, '2026/08/02', `rollout-2026-08-02T00-00-00-${UUID_B}.jsonl`, [meta(UUID_B)]);

  const entries = listAllRollouts({ sessionsDir: root });

  assert.equal(entries.length, 2);
  const byId = Object.fromEntries(entries.map((e) => [e.sessionId, e]));
  assert.equal(byId[UUID_A].cwd, 'C:\\repo');
  assert.ok(byId[UUID_A].size > 0);
  assert.ok(Number.isFinite(byId[UUID_A].mtimeMs));
});

// The discriminator is subagentIdentityFrom on the first record — the same check the parent's
// sweep uses to CLAIM these files, so classification can never disagree between the two.
test('excludes subagent rollouts — they bill through their parent', (t) => {
  const root = makeTree(t);
  writeRollout(root, '2026/08/01', `rollout-2026-08-01T00-00-00-${UUID_A}.jsonl`, [meta(UUID_A)]);
  writeRollout(root, '2026/08/01', `rollout-2026-08-01T00-01-00-${UUID_B}.jsonl`, [subMeta(UUID_B, UUID_A)]);
  // The oldest subagent format: no explicit parent link, but session_id !== id IS the link.
  writeRollout(root, '2026/08/01', `rollout-2026-08-01T00-02-00-${UUID_C}.jsonl`, [
    meta(UUID_C, { session_id: UUID_A, thread_source: 'subagent' }),
  ]);

  const entries = listAllRollouts({ sessionsDir: root });

  assert.deepEqual(entries.map((e) => e.sessionId), [UUID_A]);
});

test('falls back to the filename UUID when the first record is not a session_meta', (t) => {
  const root = makeTree(t);
  writeRollout(root, '2026/08/01', `rollout-2026-08-01T00-00-00-${UUID_A}.jsonl`, [
    { timestamp: '2026-08-01T00:00:00Z', type: 'event_msg', payload: { type: 'task_started' } },
  ]);

  const entries = listAllRollouts({ sessionsDir: root });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].sessionId, UUID_A);
  assert.equal(entries[0].cwd, null, 'no session_meta means no launch cwd');
});

test('a file with neither a session_meta id nor a filename UUID is skipped', (t) => {
  const root = makeTree(t);
  writeRollout(root, '2026/08/01', 'rollout-2026-08-01T00-00-00-not-a-uuid.jsonl', [
    { timestamp: '2026-08-01T00:00:00Z', type: 'event_msg', payload: { type: 'task_started' } },
  ]);

  assert.deepEqual(listAllRollouts({ sessionsDir: root }), []);
});

// A session_meta id that is the string JavaScript makes from a missing value is not a session:
// keyed on it, every id-less rollout would import as one shared phantom session.
test('an id of the literal "null" is not a session id', (t) => {
  const root = makeTree(t);
  writeRollout(root, '2026/08/01', 'rollout-2026-08-01T00-00-00-anonymous.jsonl', [
    meta('null', { session_id: 'undefined' }),
  ]);

  assert.deepEqual(listAllRollouts({ sessionsDir: root }), []);
});

// Codex resume can leave two rollouts with the same trailing session id. The ledger dedupes only
// across runs — without collapsing here one session would be parsed and billed twice in one run.
test('two rollouts sharing a session id collapse to the newest file', (t) => {
  const root = makeTree(t);
  writeRollout(root, '2026/08/01', `rollout-2026-08-01T00-00-00-${UUID_A}.jsonl`, [meta(UUID_A)], 1_000);
  const newer = writeRollout(
    root, '2026/08/03', `rollout-2026-08-03T00-00-00-${UUID_A}.jsonl`, [meta(UUID_A)], 9_000,
  );

  const entries = listAllRollouts({ sessionsDir: root });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].transcriptPath, newer);
});

test('entries come back oldest-first so an interrupted import advances chronologically', (t) => {
  const root = makeTree(t);
  writeRollout(root, '2026/08/02', `rollout-2026-08-02T00-00-00-${UUID_B}.jsonl`, [meta(UUID_B)], 5_000);
  writeRollout(root, '2026/07/01', `rollout-2026-07-01T00-00-00-${UUID_A}.jsonl`, [meta(UUID_A)], 1_000);
  writeRollout(root, '2026/08/04', `rollout-2026-08-04T00-00-00-${UUID_C}.jsonl`, [meta(UUID_C)], 9_000);

  const entries = listAllRollouts({ sessionsDir: root });

  assert.deepEqual(entries.map((e) => e.sessionId), [UUID_A, UUID_B, UUID_C]);
});

test('a missing sessions tree yields an empty list, never a throw', () => {
  assert.deepEqual(listAllRollouts({ sessionsDir: 'C:/definitely/not/a/dir' }), []);
});

test('non-rollout files and an empty file are skipped', (t) => {
  const root = makeTree(t);
  const dir = path.join(root, '2026', '08', '01');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a rollout');
  fs.writeFileSync(path.join(dir, `rollout-2026-08-01T00-00-00-${UUID_A}.jsonl`), '');

  assert.deepEqual(listAllRollouts({ sessionsDir: root }), []);
});
