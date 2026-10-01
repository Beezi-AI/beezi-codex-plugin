import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { stateDir } from '../lib/paths.mjs';
import { ENDPOINTS } from '../lib/config.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// One linked account, injected: from 0.13 on runCheckpoint resolves every account that can produce
// a token and fans the one delta out into each of their queues.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');


const tmpHome = (t) => sandboxHome(t, 'beezi-cperr-');

const readState = (id) =>
  JSON.parse(fs.readFileSync(path.join(stateDir(), `${id}.json`), 'utf-8'));

const writeState = (id, state) => {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), `${id}.json`), JSON.stringify(state));
};

// A stand-in transcript path: computeDelta is injected, so the file only has to exist.
function stubTranscript(home) {
  const p = path.join(home, 'rollout.jsonl');
  fs.writeFileSync(p, '\n');
  return p;
}

const err = (over = {}) => ({
  error: 'rate_limit', details: 'usage_limit_exceeded', text: 'limit hit',
  occurredAt: '2026-01-01T00:00:00.000Z', ...over,
});

// Collects /sessions/errors posts and answers with `status`.
function errorSink(statusFor = () => 200) {
  const posted = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith(ENDPOINTS.sessionErrors)) {
      const body = JSON.parse(init.body);
      posted.push(body);
      return { ok: true, status: statusFor(posted.length), json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { fetchImpl, posted };
}

const base = (home, apiErrorEvents, extra = {}) => ({
  linkedSessions: async () => [SESSION],
  resolveTranscript: () => ({ transcriptPath: stubTranscript(home), sessionId: 's1' }),
  computeDelta: () => ({ nextCursor: 5, segments: [], apiErrorEvents }),
  ...extra,
});

test('detected API errors are reported to /sessions/errors', async (t) => {
  const home = tmpHome(t);
  const { fetchImpl, posted } = errorSink();
  await runCheckpoint({ session_id: 's1', cwd: home }, { ...base(home, [err()]), fetchImpl });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].sessionId, 's1');
  assert.equal(posted[0].error, 'rate_limit');
  assert.equal(posted[0].errorDetails, 'usage_limit_exceeded');
  assert.equal(posted[0].lastAssistantMessage, 'limit hit');
  assert.equal(posted[0].occurredAt, '2026-01-01T00:00:00.000Z');
});

test('the reported error code comes from the event, not a hardcoded rate_limit', async (t) => {
  const home = tmpHome(t);
  const { fetchImpl, posted } = errorSink();
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    { ...base(home, [err({ error: 'billing_error', details: 'insufficient_quota' })]), fetchImpl },
  );
  assert.equal(posted[0].error, 'billing_error');
});

test('a report the server refused is parked in state, not lost with the cursor', async (t) => {
  const home = tmpHome(t);
  // The cursor advances regardless, so an unreported error is outside every future window.
  const { fetchImpl, posted } = errorSink(() => 500);
  await runCheckpoint({ session_id: 's1', cwd: home }, { ...base(home, [err()]), fetchImpl });

  assert.equal(posted.length, 1);
  const state = readState('s1');
  assert.equal(state.pendingErrors.length, 1);
  assert.equal(state.pendingErrors[0].error, 'rate_limit');
  assert.equal(state.cursor, 5, 'the cursor still advanced');
});

test('a parked error is drained by the next checkpoint', async (t) => {
  const home = tmpHome(t);
  writeState('s1', { cursor: 5, pendingErrors: [err({ text: 'from last turn' })] });
  const { fetchImpl, posted } = errorSink();
  await runCheckpoint({ session_id: 's1', cwd: home }, { ...base(home, [], { computeDelta: () => ({ nextCursor: 6, segments: [], apiErrorEvents: [] }) }), fetchImpl });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].lastAssistantMessage, 'from last turn');
  assert.deepEqual(readState('s1').pendingErrors, []);
});

test('the error loop stops at the hook budget and parks the remainder', async (t) => {
  const home = tmpHome(t);
  // Each post consumes the whole remaining budget, as a stalled server does.
  let nowMs = 1_000_000;
  const posted = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith(ENDPOINTS.sessionErrors)) {
      posted.push(JSON.parse(init.body));
      nowMs += 3000;
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const events = [err({ text: 'a' }), err({ text: 'b' }), err({ text: 'c' })];
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    { ...base(home, events), fetchImpl, now: () => nowMs },
    { budgetMs: 4000 },
  );

  assert.equal(posted.length, 2, 'two 3s posts fit a 4s budget; the third is not started');
  const parked = readState('s1').pendingErrors;
  assert.equal(parked.length, 1);
  assert.equal(parked[0].text, 'c');
});

test('parked errors are bounded so an offline machine cannot grow its state forever', async (t) => {
  const home = tmpHome(t);
  const many = Array.from({ length: 40 }, (_, i) => err({ text: `e${i}` }));
  const { fetchImpl } = errorSink(() => 500);
  await runCheckpoint({ session_id: 's1', cwd: home }, { ...base(home, many), fetchImpl });

  const parked = readState('s1').pendingErrors;
  assert.equal(parked.length, 20);
  assert.equal(parked.at(-1).text, 'e39', 'the newest are the ones kept');
});

test('no errors means no state churn and no posts', async (t) => {
  const home = tmpHome(t);
  const { fetchImpl, posted } = errorSink();
  await runCheckpoint({ session_id: 's1', cwd: home }, { ...base(home, []), fetchImpl });
  assert.equal(posted.length, 0);
  assert.equal(readState('s1').pendingErrors, undefined);
});
