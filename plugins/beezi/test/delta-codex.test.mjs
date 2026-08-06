import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeDelta } from '../lib/delta-codex.mjs';

function writeRollout(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-codex-'));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const meta = (cwd) => ({ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { cwd } });
const turn = (cwd, model, ts) => ({ timestamp: ts, type: 'turn_context', payload: { cwd, model } });
const tokens = (ts, input, cached, output) => ({
  timestamp: ts,
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } } },
});

const identityResolvers = {
  repoRootOf: (dir) => dir,
  branchAt: () => 'main',
};

test('accumulates token increments from cumulative totals, mapping components', () => {
  const file = writeRollout([
    meta('/repoA'),
    turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
    tokens('2026-01-01T00:00:02.000Z', 100, 40, 10),
    tokens('2026-01-01T00:00:03.000Z', 150, 60, 30),
  ]);
  const { segments, nextCursor } = computeDelta(file, 0, identityResolvers);
  assert.equal(segments.length, 1);
  const seg = segments[0];
  assert.equal(seg.repoRoot, '/repoA');
  assert.equal(seg.branch, 'main');
  const m = seg.stats.models['gpt-5.2-codex'];
  // input_noncached = (100-40) + (50-20) = 60 + 30 = 90; cache_read = 40 + 20 = 60; output = 10 + 20 = 30
  assert.equal(m.token_input, 90);
  assert.equal(m.token_cache_read, 60);
  assert.equal(m.token_output, 30);
  assert.equal(m.token_cache_creation, 0);
  assert.equal(m.requests, 2);
  assert.equal(seg.stats.token_total, 180); // 90 + 30 + 60
  assert.equal(nextCursor, 4);
});

test('cursor baseline: a second window only bills the new increment', () => {
  const records = [
    meta('/repoA'),
    turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
    tokens('2026-01-01T00:00:02.000Z', 100, 0, 10), // line 3
    tokens('2026-01-01T00:00:03.000Z', 200, 0, 40), // line 4
  ];
  const file = writeRollout(records);
  // First window consumes lines 1..3 (cursor 0 → 4 conceptually), then re-run from cursor 3.
  const second = computeDelta(file, 3, identityResolvers);
  assert.equal(second.segments.length, 1);
  const m = second.segments[0].stats.models['gpt-5.2-codex'];
  // Only line 4's increment over line 3's baseline: input 100, output 30.
  assert.equal(m.token_input, 100);
  assert.equal(m.token_output, 30);
});

test('a cwd switch splits into two segments attributed to each repo', () => {
  const file = writeRollout([
    meta('/repoA'),
    turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
    tokens('2026-01-01T00:00:02.000Z', 100, 0, 10),
    turn('/repoB', 'gpt-5.2-codex', '2026-01-01T00:00:03.000Z'),
    tokens('2026-01-01T00:00:04.000Z', 180, 0, 30),
  ]);
  const { segments } = computeDelta(file, 0, identityResolvers);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].repoRoot, '/repoA');
  assert.equal(segments[1].repoRoot, '/repoB');
  // repoB gets the increment that landed after the cwd switch: input 80, output 20.
  assert.equal(segments[1].stats.models['gpt-5.2-codex'].token_input, 80);
  assert.equal(segments[1].stats.models['gpt-5.2-codex'].token_output, 20);
});

test('empty transcript yields no segments and a zero cursor', () => {
  const file = writeRollout([]);
  const { segments, nextCursor } = computeDelta(file, 0, identityResolvers);
  assert.equal(segments.length, 0);
  assert.equal(nextCursor, 0);
});

// --- API error detection -------------------------------------------------------------------
// Every shape below is copied from a real rollout on disk (171 files scanned).

const errorRec = (ts, message, info) => ({
  timestamp: ts,
  type: 'event_msg',
  payload: { type: 'error', message, ...(info ? { codex_error_info: info } : {}) },
});

const withPrelude = (...records) => writeRollout([
  meta('/repoA'),
  turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
  ...records,
]);

test('a usage-limit error is reported as a rate limit', () => {
  const file = withPrelude(errorRec(
    '2026-01-01T00:00:02.000Z',
    "Error running remote compact task: You've hit your usage limit. Upgrade to Plus to continue using Codex.",
    'usage_limit_exceeded',
  ));
  const { apiErrorEvents } = computeDelta(file, 0, identityResolvers);
  assert.equal(apiErrorEvents.length, 1);
  assert.equal(apiErrorEvents[0].error, 'rate_limit');
  assert.equal(apiErrorEvents[0].details, 'usage_limit_exceeded');
  assert.match(apiErrorEvents[0].text, /hit your usage limit/);
  assert.equal(apiErrorEvents[0].occurredAt, '2026-01-01T00:00:02.000Z');
});

test('an overloaded-model error is dropped as transient', () => {
  // Codex retries these itself; reporting them buries the durable failures.
  const file = withPrelude(errorRec(
    '2026-01-01T00:00:02.000Z',
    'Selected model is at capacity. Please try a different model.',
    'server_overloaded',
  ));
  const { apiErrorEvents } = computeDelta(file, 0, identityResolvers);
  assert.equal(apiErrorEvents.length, 0);
});

test('an error whose message is an embedded JSON body is unwrapped', () => {
  const file = withPrelude(errorRec(
    '2026-01-01T00:00:02.000Z',
    JSON.stringify({
      type: 'error',
      status: 400,
      error: {
        type: 'invalid_request_error',
        message: "The 'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT account.",
      },
    }),
    'other',
  ));
  const { apiErrorEvents } = computeDelta(file, 0, identityResolvers);
  assert.equal(apiErrorEvents.length, 1);
  assert.equal(apiErrorEvents[0].error, 'unknown');
  assert.equal(apiErrorEvents[0].details, 'invalid_request_error');
  assert.equal(
    apiErrorEvents[0].text,
    "The 'gpt-5.2-codex' model is not supported when using Codex with a ChatGPT account.",
  );
});

test('a 5xx upstream body is dropped as transient', () => {
  const file = withPrelude(errorRec(
    '2026-01-01T00:00:02.000Z',
    JSON.stringify({ type: 'error', status: 503, error: { type: 'server_error', message: 'upstream down' } }),
    'other',
  ));
  assert.equal(computeDelta(file, 0, identityResolvers).apiErrorEvents.length, 0);
});

test('an auth failure and a quota failure are classified apart', () => {
  const file = withPrelude(
    errorRec('2026-01-01T00:01:00.000Z',
      JSON.stringify({ status: 401, error: { type: 'authentication_error', message: 'bad key' } }), 'other'),
    errorRec('2026-01-01T00:02:00.000Z',
      JSON.stringify({ status: 429, error: { type: 'insufficient_quota', message: 'You exceeded your current quota' } }), 'other'),
  );
  const { apiErrorEvents } = computeDelta(file, 0, identityResolvers);
  assert.deepEqual(apiErrorEvents.map((e) => e.error), ['authentication_failed', 'billing_error']);
});

test('an interrupted turn is not an error', () => {
  // turn_aborted{reason:'interrupted'} is the user pressing Esc — 71 local occurrences against
  // 6 real errors. Reporting it would drown the signal.
  const file = withPrelude({
    timestamp: '2026-01-01T00:00:02.000Z',
    type: 'event_msg',
    payload: { type: 'turn_aborted', reason: 'interrupted' },
  });
  assert.equal(computeDelta(file, 0, identityResolvers).apiErrorEvents.length, 0);
});

test('the same failure repeating inside a minute is reported once', () => {
  const body = JSON.stringify({ status: 400, error: { type: 'invalid_request_error', message: 'nope' } });
  const file = withPrelude(
    errorRec('2026-01-01T00:05:01.000Z', body, 'other'),
    errorRec('2026-01-01T00:05:30.000Z', body, 'other'),
    errorRec('2026-01-01T00:05:59.000Z', body, 'other'),
    errorRec('2026-01-01T00:06:02.000Z', body, 'other'), // next minute — a separate row
  );
  const { apiErrorEvents } = computeDelta(file, 0, identityResolvers);
  assert.equal(apiErrorEvents.length, 2);
});

test('errors before the cursor are not re-reported', () => {
  const file = withPrelude(errorRec('2026-01-01T00:00:02.000Z', 'boom', 'usage_limit_exceeded'));
  // Lines 1-3 are the prelude plus the error; a window starting after them sees nothing.
  assert.equal(computeDelta(file, 3, identityResolvers).apiErrorEvents.length, 0);
});

test('a rate-limit window flag on token_count is reported', () => {
  // Unverified shape (null in all 1727 local samples) — handled defensively as opaque text.
  const file = withPrelude({
    timestamp: '2026-01-01T00:00:02.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, total_tokens: 15 } },
      rate_limits: { rate_limit_reached_type: 'primary', plan_type: 'plus' },
    },
  });
  const { apiErrorEvents } = computeDelta(file, 0, identityResolvers);
  assert.equal(apiErrorEvents.length, 1);
  assert.equal(apiErrorEvents[0].error, 'rate_limit');
  assert.equal(apiErrorEvents[0].text, 'primary');
});

test('a null rate_limit_reached_type is not an error', () => {
  const file = withPrelude({
    timestamp: '2026-01-01T00:00:02.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, total_tokens: 15 } },
      rate_limits: { rate_limit_reached_type: null, plan_type: 'plus' },
    },
  });
  assert.equal(computeDelta(file, 0, identityResolvers).apiErrorEvents.length, 0);
});
