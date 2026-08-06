import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionNameFromIndex, sessionNameFrom, resolveSessionName } from '../lib/session-name-codex.mjs';

function withCodexHome(fn) {
  const prev = process.env.CODEX_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-codexhome-'));
  process.env.CODEX_HOME = dir;
  try { return fn(dir); } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
}

function writeRollout(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-codex-'));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const SID = 'abc-123';

test('sessionNameFromIndex reads the thread_name for a session id', () => {
  withCodexHome((home) => {
    fs.writeFileSync(path.join(home, 'session_index.jsonl'),
      [JSON.stringify({ id: 'other', thread_name: 'Nope' }),
       JSON.stringify({ id: SID, thread_name: 'Fix the parser' })].join('\n') + '\n');
    assert.equal(sessionNameFromIndex(SID), 'Fix the parser');
    assert.equal(sessionNameFromIndex('missing'), null);
  });
});

test('sessionNameFrom returns the first real user_message from the rollout', () => {
  const file = writeRollout([
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions ...' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Refactor the checkout flow' } },
  ]);
  assert.equal(sessionNameFrom(file), 'Refactor the checkout flow');
});

test('resolveSessionName prefers the index over the transcript', () => {
  withCodexHome((home) => {
    fs.writeFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id: SID, thread_name: 'Indexed title' }) + '\n');
    const file = writeRollout([{ type: 'event_msg', payload: { type: 'user_message', message: 'transcript title' } }]);
    assert.equal(resolveSessionName(SID, file), 'Indexed title');
  });
});
