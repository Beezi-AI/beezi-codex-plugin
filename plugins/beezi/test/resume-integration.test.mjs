import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { runSessionStart } from '../lib/session-start.mjs';
import { queueDir, stateDir } from '../lib/paths.mjs';

// End-to-end over a real temp data root: session start → checkpoint → resume. The property under
// test is that a resumed session never re-reports work it already billed. Everything else in the
// engine is idempotent by segmentId; the cursor is the one piece of state that, if reset, silently
// doubles a user's numbers.

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-resume-'));
  const prev = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const SESSION = 'resume-1';
const WORK = '/repo';

const meta = () => ({ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { cwd: WORK } });
const turn = (ts) => ({ timestamp: ts, type: 'turn_context', payload: { cwd: WORK, model: 'gpt-5.2-codex' } });
// Cumulative totals, as Codex writes them.
const tokens = (ts, input, output) => ({
  timestamp: ts,
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, total_tokens: input + output } } },
});

function writeRollout(home, records) {
  const p = path.join(home, 'rollout.jsonl');
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return p;
}

const readState = () => JSON.parse(fs.readFileSync(path.join(stateDir(), `${SESSION}.json`), 'utf-8'));
const queued = () => fs.readdirSync(queueDir()).map((f) =>
  JSON.parse(fs.readFileSync(path.join(queueDir(), f), 'utf-8')));

// A checkpoint whose flush always fails, so payloads stay on disk for inspection.
const deps = (transcriptPath) => ({
  getAccessToken: async () => 'tok',
  fetchImpl: async () => { throw new Error('offline'); },
  resolveTranscript: () => ({ transcriptPath, sessionId: SESSION }),
  gitImpl: () => { throw new Error('not a git repository'); },
});

const totalTokens = () => queued().reduce((sum, p) => sum + p.token_total, 0);

test('a resumed session does not re-report work it already billed', async (t) => {
  const home = tmpHome(t);
  const roll = writeRollout(home, [
    meta(),
    turn('2026-01-01T00:00:01.000Z'),
    tokens('2026-01-01T00:00:02.000Z', 100, 20),
  ]);

  await runCheckpoint({ session_id: SESSION, cwd: WORK }, deps(roll));
  const firstCursor = readState().cursor;
  const firstTotal = totalTokens();
  assert.equal(firstTotal, 120, 'first window bills the whole rollout');

  // Resume: session start runs again on the same session, then a checkpoint with no new lines.
  await runSessionStart(
    { session_id: SESSION, cwd: WORK, transcript_path: roll },
    {
      getAccessToken: async () => 'tok',
      // whoami answers; the queue flush stays offline so the already-billed payloads remain on
      // disk and the totals below measure what was *reported*, not what survived the flush.
      fetchImpl: async (url) => {
        if (String(url).endsWith('/me/codex/whoami')) {
          return { ok: true, status: 200, json: async () => ({ email: 'a@b.c' }) };
        }
        throw new Error('offline');
      },
      gitImpl: () => { throw new Error('not a git repository'); },
      resolveSource: () => 'openai_api_key',
      readBillingConfig: () => null,
      writeBillingConfig: () => {},
      isStale: () => false,
    },
  );
  assert.equal(readState().cursor, firstCursor, 'session start must not reset the cursor');

  await runCheckpoint({ session_id: SESSION, cwd: WORK }, deps(roll));
  assert.equal(totalTokens(), firstTotal, 'a resume with no new activity bills nothing further');
});

test('activity after a resume bills only the increment', async (t) => {
  const home = tmpHome(t);
  const records = [meta(), turn('2026-01-01T00:00:01.000Z'), tokens('2026-01-01T00:00:02.000Z', 100, 20)];
  const roll = writeRollout(home, records);

  await runCheckpoint({ session_id: SESSION, cwd: WORK }, deps(roll));
  assert.equal(totalTokens(), 120);

  // The session continues: Codex appends a new cumulative total.
  records.push(tokens('2026-01-01T00:00:03.000Z', 180, 50));
  writeRollout(home, records);
  await runCheckpoint({ session_id: SESSION, cwd: WORK }, deps(roll));

  // 120 already billed + the increment (80 input, 30 output) = 230, not 350.
  assert.equal(totalTokens(), 230);
});

test('a repeated checkpoint over the same window produces one segment id, not two', async (t) => {
  const home = tmpHome(t);
  const roll = writeRollout(home, [
    meta(),
    turn('2026-01-01T00:00:01.000Z'),
    tokens('2026-01-01T00:00:02.000Z', 100, 20),
  ]);

  await runCheckpoint({ session_id: SESSION, cwd: WORK }, deps(roll));
  await runCheckpoint({ session_id: SESSION, cwd: WORK }, deps(roll));

  const ids = queued().map((p) => p.segmentId);
  assert.equal(new Set(ids).size, ids.length, 'queued segment ids must be unique');
  assert.equal(ids.length, 1);
});

test('work outside a git repo survives the whole round trip', async (t) => {
  const home = tmpHome(t);
  const roll = writeRollout(home, [
    meta(),
    turn('2026-01-01T00:00:01.000Z'),
    tokens('2026-01-01T00:00:02.000Z', 100, 20),
  ]);
  await runCheckpoint({ session_id: SESSION, cwd: WORK }, deps(roll));

  const payloads = queued();
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].remote, 'local:repo');
  assert.equal(payloads[0].token_total, 120);
});

test('the session state records where the transcript lives', async (t) => {
  const home = tmpHome(t);
  const roll = writeRollout(home, [
    meta(),
    turn('2026-01-01T00:00:01.000Z'),
    tokens('2026-01-01T00:00:02.000Z', 100, 20),
  ]);
  await runCheckpoint({ session_id: SESSION, cwd: WORK }, deps(roll));

  const state = readState();
  assert.equal(state.transcriptPath, roll);
  assert.equal(state.cwd, WORK);
});
