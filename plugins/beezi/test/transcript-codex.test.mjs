import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findRolloutBySessionId,
  isUsableSessionId,
  resolveCodexTranscript,
  resolveTranscriptByCwd,
} from '../lib/transcript-codex.mjs';

function withCodexHome(fn) {
  const prev = process.env.CODEX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-codexhome-'));
  process.env.CODEX_HOME = dir;
  try { return fn(dir); } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
}

// Sibling of withCodexHome for the OTHER root: state/ and queue/ hang off BEEZI_CODEX_HOME, not
// CODEX_HOME, so a state-scan test that only redirected the latter would read (and write) the
// real plugin data root.
function withBeeziHome(fn) {
  const prev = process.env.BEEZI_CODEX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-datahome-'));
  process.env.BEEZI_CODEX_HOME = dir;
  try { return fn(dir); } finally {
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
  }
}

// A state file exactly as the checkpoint and session start write them: `<id>.json` under state/.
function writeState(beeziHome, id, state) {
  const dir = path.join(beeziHome, 'state');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(state));
  return file;
}

// A rollout whose FILENAME cannot be parsed for an id — the case the session_meta read exists for.
function writeUnnamedRollout(home, name, records) {
  const dir = path.join(home, 'sessions', '2026', '01', '08');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
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
    // No id in this session_meta — the filename regex is the second source and stays.
    assert.equal(r.sessionId, SID);
  });
});

// ─── G-3-1: the session id comes off the record, not the filename ───────────

const OTHER_SID = '019c0000-1111-7222-8333-444455556666';

test('resolveTranscriptByCwd names a rollout whose FILENAME carries no uuid', () => {
  withCodexHome((home) => {
    const file = writeUnnamedRollout(home, 'rollout-restored-from-backup.jsonl', [
      { type: 'session_meta', payload: { id: SID, session_id: SID, cwd: '/my/repo' } },
    ]);
    const r = resolveTranscriptByCwd('/my/repo');
    assert.equal(r.transcriptPath, file);
    assert.equal(r.sessionId, SID, 'the record names the session the filename could not');
  });
});

test('resolveTranscriptByCwd falls back to session_id when the record has no id', () => {
  withCodexHome((home) => {
    writeUnnamedRollout(home, 'rollout-no-id-field.jsonl', [
      { type: 'session_meta', payload: { session_id: SID, cwd: '/my/repo' } },
    ]);
    assert.equal(resolveTranscriptByCwd('/my/repo').sessionId, SID);
  });
});

// On a SUBAGENT rollout `session_id` holds the PARENT's thread id while `id` is its own
// (lib/subagent-codex.mjs:91-104). These files are top-level in the same date tree and carry the
// parent's cwd, so this resolver sees them. Preferring `session_id` would return the parent's id
// against the CHILD's transcript — a pair that writes the parent's cursor from the child's lines,
// which is worse than the null id this change exists to remove.
test('resolveTranscriptByCwd prefers the rollout own id over a parent session_id', () => {
  withCodexHome((home) => {
    const file = writeUnnamedRollout(home, 'rollout-subagent.jsonl', [
      {
        type: 'session_meta',
        payload: { id: OTHER_SID, session_id: SID, thread_source: 'subagent', cwd: '/my/repo' },
      },
    ]);
    const r = resolveTranscriptByCwd('/my/repo');
    assert.equal(r.transcriptPath, file);
    assert.equal(r.sessionId, OTHER_SID, 'the id must name the transcript it is returned with');
  });
});

// The case that protects liveSession(): a transcript we can LOCATE but not NAME still comes back,
// because lib/session-audit.mjs matches the live session on its path. Returning null here would
// stop the backfill excluding the live session and double-bill it.
test('resolveTranscriptByCwd returns an unnameable transcript with a null id, not null', () => {
  withCodexHome((home) => {
    const file = writeUnnamedRollout(home, 'rollout-anonymous.jsonl', [
      { type: 'session_meta', payload: { cwd: '/my/repo' } },
    ]);
    const r = resolveTranscriptByCwd('/my/repo');
    assert.notEqual(r, null, 'never null: liveSession needs the path');
    assert.equal(r.transcriptPath, file);
    assert.equal(r.sessionId, null);
  });
});

test('a session_meta id of the literal "null" is not a session id', () => {
  withCodexHome((home) => {
    writeUnnamedRollout(home, 'rollout-stringified-null.jsonl', [
      { type: 'session_meta', payload: { id: 'null', session_id: 'undefined', cwd: '/my/repo' } },
    ]);
    assert.equal(resolveTranscriptByCwd('/my/repo').sessionId, null);
  });
});

// ─── the session_meta record is far larger than any fixed head slice ───────
//
// A real rollout's first line is dominated by `base_instructions`. Measured across 231 local
// rollouts: first lines crossed 8KB in 2026-02 and the largest is 48KB, and
// lib/session-name-codex.mjs:120-126 records ~37KB for session_meta alone once dynamic_tools is
// counted. A head read that stops mid-line leaves JSON.parse with an unterminated string, so the
// record reads as "no session_meta at all" and the file drops out of the cwd scan entirely.
//
// These fixtures MUST use writeUnnamedRollout. With a `rollout-<ISO>-<uuid>.jsonl` name the
// filename regex recovers the id on its own, so a sessionId assertion would pass with the bug
// present — a green test pinning nothing.
function oversizedMeta(kib, over) {
  return {
    type: 'session_meta',
    payload: Object.assign(
      { id: SID, cwd: '/my/repo', base_instructions: 'x'.repeat(kib * 1024) },
      over || {},
    ),
  };
}

test('resolveTranscriptByCwd reads a session_meta larger than 8KB', () => {
  withCodexHome((home) => {
    const file = writeUnnamedRollout(home, 'rollout-big-preamble.jsonl', [oversizedMeta(18)]);
    const r = resolveTranscriptByCwd('/my/repo');
    assert.notEqual(r, null, 'the rollout drops out of the cwd scan when the record cannot parse');
    assert.equal(r.transcriptPath, file);
    assert.equal(r.sessionId, SID, 'the id comes off the record the filename could not name');
  });
});

// 48KB is the largest first line measured on a real machine. A "generous" fixed cap that merely
// clears the 18KB case above would still be wrong for files already on disk.
test('resolveTranscriptByCwd reads a session_meta at the largest size seen in the wild', () => {
  withCodexHome((home) => {
    const file = writeUnnamedRollout(home, 'rollout-huge-preamble.jsonl', [oversizedMeta(48)]);
    const r = resolveTranscriptByCwd('/my/repo');
    assert.notEqual(r, null);
    assert.equal(r.transcriptPath, file);
    assert.equal(r.sessionId, SID);
  });
});

// The second route into the same record read: a hook that supplied a path but no usable id.
test('resolveCodexTranscript names an oversized rollout from its record', () => {
  withCodexHome((home) => {
    const file = writeUnnamedRollout(home, 'rollout-big-hook-path.jsonl', [oversizedMeta(18)]);
    assert.equal(resolveCodexTranscript({ transcript_path: file }).sessionId, SID);
  });
});

test('resolveCodexTranscript names a hook-provided path the hook did not name', () => {
  withCodexHome((home) => {
    const file = writeUnnamedRollout(home, 'rollout-hook-path.jsonl', [
      { type: 'session_meta', payload: { id: SID, cwd: '/my/repo' } },
    ]);
    assert.equal(resolveCodexTranscript({ transcript_path: file }).sessionId, SID);
    // A usable id ON the payload still wins: the hook is authoritative for its own session.
    assert.equal(
      resolveCodexTranscript({ session_id: OTHER_SID, transcript_path: file }).sessionId,
      OTHER_SID,
    );
  });
});

// ─── G-3-1: the state scan never answers with a poisoned file ───────────────

// `state/null.json` is ONE file shared by every id-less session in a directory. Deriving the id
// from its NAME made every later resolve from that cwd answer with the string "null" — a
// valid-looking id the server accepts — forever, because the match is on cwd alone.
test('findRolloutBySessionState skips state/null.json instead of answering "null"', () => {
  withCodexHome((home) => {
    withBeeziHome((beezi) => {
      const file = writeRollout(home, SID, [{ type: 'session_meta', payload: { cwd: '/my/repo' } }]);
      writeState(beezi, 'null', {
        cursor: 12, cwd: '/my/repo', transcriptPath: file, updatedAt: '2026-01-09T00:00:00.000Z',
      });

      const r = resolveTranscriptByCwd('/my/repo');

      assert.notEqual(r.sessionId, 'null');
      assert.equal(r.sessionId, SID, 'falls through to the rollout scan, which can name it');
      assert.equal(r.transcriptPath, file);
    });
  });
});

test('findRolloutBySessionState skips state/undefined.json too', () => {
  withCodexHome((home) => {
    withBeeziHome((beezi) => {
      const file = writeRollout(home, SID, [{ type: 'session_meta', payload: { cwd: '/my/repo' } }]);
      writeState(beezi, 'undefined', { cursor: 3, cwd: '/my/repo', transcriptPath: file });
      assert.notEqual(resolveTranscriptByCwd('/my/repo').sessionId, 'undefined');
    });
  });
});

test('a normally-named state file is still the first source', () => {
  withCodexHome((home) => {
    withBeeziHome((beezi) => {
      // A path that is NOT under the sessions tree, so only the state mapping can find it.
      const elsewhere = path.join(home, 'moved-rollout.jsonl');
      fs.writeFileSync(elsewhere, '{}\n');
      writeState(beezi, SID, { cursor: 9, cwd: '/somewhere/else', transcriptPath: elsewhere });

      const r = resolveTranscriptByCwd('/somewhere/else');

      assert.equal(r.sessionId, SID);
      assert.equal(r.transcriptPath, elsewhere);
    });
  });
});

// Forward compatibility: once the checkpoint persists `sessionId` inside the state file, the id
// stops depending on the filename at all.
test('an id recorded inside the state file wins over the filename', () => {
  withCodexHome((home) => {
    withBeeziHome((beezi) => {
      const elsewhere = path.join(home, 'moved-rollout.jsonl');
      fs.writeFileSync(elsewhere, '{}\n');
      writeState(beezi, 'null', {
        cursor: 9, sessionId: SID, cwd: '/somewhere/else', transcriptPath: elsewhere,
      });

      assert.equal(resolveTranscriptByCwd('/somewhere/else').sessionId, SID);
    });
  });
});

test('isUsableSessionId rejects the strings a missing id stringifies to', () => {
  assert.equal(isUsableSessionId(SID), true);
  assert.equal(isUsableSessionId('null'), false);
  assert.equal(isUsableSessionId('undefined'), false);
  assert.equal(isUsableSessionId('NaN'), false);
  assert.equal(isUsableSessionId(''), false);
  assert.equal(isUsableSessionId(null), false);
  assert.equal(isUsableSessionId(undefined), false);
  assert.equal(isUsableSessionId('../etc/passwd'), false);
  // Inherited Object.prototype members must not read as reserved.
  assert.equal(isUsableSessionId('constructor'), true);
  assert.equal(isUsableSessionId('toString'), true);
});
