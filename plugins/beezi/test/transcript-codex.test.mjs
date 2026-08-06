import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRolloutBySessionId, resolveCodexTranscript, resolveTranscriptByCwd } from '../lib/transcript-codex.mjs';

function withCodexHome(fn) {
  const prev = process.env.CODEX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-codexhome-'));
  process.env.CODEX_HOME = dir;
  try { return fn(dir); } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
}

function writeRollout(home, sessionId, records) {
  const dir = path.join(home, 'sessions', '2026', '01', '08');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-01-08T18-15-41-${sessionId}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const SID = '019b9e64-70b0-7b02-856d-172ee1af767c';

test('findRolloutBySessionId locates the rollout under the date tree', () => {
  withCodexHome((home) => {
    const file = writeRollout(home, SID, [{ type: 'session_meta', payload: { cwd: '/repo' } }]);
    const found = findRolloutBySessionId(SID);
    assert.equal(found.transcriptPath, file);
    assert.equal(found.sessionId, SID);
  });
});

test('findRolloutBySessionId rejects a malformed id and unknown ids', () => {
  withCodexHome(() => {
    assert.equal(findRolloutBySessionId('../etc/passwd'), null);
    assert.equal(findRolloutBySessionId('nope'), null);
  });
});

test('resolveCodexTranscript prefers a provided transcript_path', () => {
  withCodexHome((home) => {
    const file = writeRollout(home, SID, [{ type: 'session_meta', payload: { cwd: '/repo' } }]);
    const r = resolveCodexTranscript({ session_id: SID, transcript_path: file });
    assert.equal(r.transcriptPath, file);
  });
});

test('resolveCodexTranscript falls back to the session id when no path is given', () => {
  withCodexHome((home) => {
    const file = writeRollout(home, SID, [{ type: 'session_meta', payload: { cwd: '/repo' } }]);
    const r = resolveCodexTranscript({ session_id: SID });
    assert.equal(r.transcriptPath, file);
  });
});

test('resolveTranscriptByCwd matches on the rollout launch cwd', () => {
  withCodexHome((home) => {
    const file = writeRollout(home, SID, [{ type: 'session_meta', payload: { cwd: '/my/repo' } }]);
    const r = resolveTranscriptByCwd('/my/repo');
    assert.equal(r.transcriptPath, file);
    assert.equal(r.sessionId, SID);
  });
});
