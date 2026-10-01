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

// Byte-exact writers. writeRollout always terminates the file with '\n', which is precisely the
// case the torn-record tests below must NOT have.
function writeRaw(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-codex-raw-'));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, text);
  return file;
}

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n');

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
  // G-4-2: the default effort path, pinned on the oldest fixture in the file — this rollout carries
  // no `effort` anywhere, so every token buckets under the literal 'unknown', which is the server's
  // own name for the effort-less bucket (it maps to a NULL effort row with the legacy source_ref).
  assert.deepEqual(Object.keys(m.by_effort), ['unknown']);
  assert.deepEqual(m.by_effort.unknown, {
    token_input: 90, token_output: 30, token_cache_read: 60, token_cache_creation: 0, requests: 2,
  });
});

test('cache writes partition input across efforts and cursor windows without double counting', () => {
  const usage = (ts, input, cached, written, output) => {
    const record = tokens(ts, input, cached, output);
    record.payload.info.total_token_usage.cache_write_input_tokens = written;
    return record;
  };
  const high = turn('/repoA', 'gpt-6-astra', '2026-01-01T00:00:01.000Z');
  high.payload.effort = 'high';
  const medium = turn('/repoA', 'gpt-6-astra', '2026-01-01T00:00:04.000Z');
  medium.payload.effort = 'medium';
  const records = [
    meta('/repoA'), high,
    usage('2026-01-01T00:00:02.000Z', 100, 40, 30, 10),
    usage('2026-01-01T00:00:03.000Z', 100, 40, 30, 10), // duplicate snapshot
    medium,
    usage('2026-01-01T00:00:05.000Z', 180, 60, 70, 30),
  ];
  const file = writeRollout(records);
  const full = computeDelta(file, 0, identityResolvers).segments[0].stats;
  const m = full.models['gpt-6-astra'];
  const first = { token_input: 30, token_output: 10, token_cache_read: 40, token_cache_creation: 30, requests: 1 };
  const second = { token_input: 20, token_output: 20, token_cache_read: 20, token_cache_creation: 40, requests: 1 };
  assert.deepEqual(m, {
    token_input: 50, token_output: 30, token_cache_read: 60, token_cache_creation: 70, requests: 2,
    by_effort: { high: first, medium: second },
  });
  assert.equal(full.token_cache, 130);
  assert.equal(full.token_total, 210); // input + output, with cache tokens counted once
  const resumed = computeDelta(file, 4, identityResolvers).segments[0].stats;
  assert.deepEqual(resumed.models['gpt-6-astra'], { ...second, by_effort: { medium: second } });
  assert.equal(resumed.token_total, 100);
});

test('a request consisting entirely of cache writes still counts as one request', () => {
  const record = tokens('2026-01-01T00:00:02.000Z', 100, 0, 0);
  record.payload.info.total_token_usage.cache_write_input_tokens = 100;
  const file = writeRollout([meta('/repoA'), record]);
  const stats = computeDelta(file, 0, identityResolvers).segments[0].stats;
  assert.equal(stats.models.unknown.token_input, 0);
  assert.equal(stats.models.unknown.token_cache_creation, 100);
  assert.equal(stats.models.unknown.requests, 1);
  assert.equal(stats.token_total, 100);
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

test('a task_complete usage-limit error from Codex 0.154 is reported as a rate limit', () => {
  const terminalError = {
    timestamp: '2026-08-06T20:04:35.739Z',
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: '019fd8ab-9eb4-74f3-b863-0003ecd68a95',
      last_agent_message: null,
      error: {
        message: "You've hit your usage limit. Upgrade to Plus to continue using Codex.",
        codex_error_info: 'usage_limit_exceeded',
      },
      duration_ms: 121917,
    },
  };
  const file = withPrelude(terminalError, terminalError);

  const { apiErrorEvents } = computeDelta(file, 0, identityResolvers);
  assert.deepEqual(apiErrorEvents, [{
    error: 'rate_limit',
    info: 'usage_limit_exceeded',
    details: 'usage_limit_exceeded',
    text: "You've hit your usage limit. Upgrade to Plus to continue using Codex.",
    occurredAt: '2026-08-06T20:04:35.739Z',
    resetsAt: null,
  }], 'duplicate terminal records in the same minute collapse to one portal event');
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

// --- G-1-6: the cursor must not advance over a torn trailing record --------------------------
// A rollout is appended a line at a time, so its last line can be a record the writer has not
// finished. Skipping it (which the parser does) AND counting it in the cursor loses that record's
// metadata and operations for good. Its tokens survive either way — Codex reports totals
// cumulatively, so a later token_count re-states them — which is why these tests assert the
// record's identity, not only its token arithmetic.

const PRELUDE = [
  meta('/repo'),
  turn('/repo', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
  tokens('2026-01-01T00:00:02.000Z', 100, 0, 10),
];

test('a torn trailing record holds the cursor and is billed exactly once once it completes', () => {
  const last = tokens('2026-01-01T00:00:04.000Z', 300, 0, 30);
  const full = JSON.stringify(last);
  const torn = full.slice(0, Math.floor(full.length / 2));
  const file = writeRaw(jsonl(PRELUDE) + '\n' + torn);

  const first = computeDelta(file, 0, identityResolvers);
  assert.equal(first.nextCursor, 3, 'the cursor stops short of the record still being written');
  assert.equal(first.segments[0].toLine, 3);
  assert.equal(first.segments[0].stats.models['gpt-5.2-codex'].token_input, 100);

  // The writer finishes the line.
  fs.appendFileSync(file, full.slice(torn.length) + '\n');
  const second = computeDelta(file, first.nextCursor, identityResolvers);
  assert.equal(second.nextCursor, 4);
  assert.equal(second.segments.length, 1);
  assert.deepEqual([second.segments[0].fromLine, second.segments[0].toLine], [4, 4]);
  // 100 in the first window + 200 here = the cumulative total, so it was billed exactly once.
  assert.equal(second.segments[0].stats.models['gpt-5.2-codex'].token_input, 200);
  assert.equal(second.segments[0].stats.models['gpt-5.2-codex'].requests, 1);
});

test('a malformed but newline-terminated trailing line is passed over, not held', () => {
  // The visible-corruption policy: a COMPLETE bad line is skipped and the cursor moves past it, so
  // one unparseable record can never block the file forever.
  const file = writeRaw(jsonl(PRELUDE) + '\nNOT JSON\n');
  const { segments, nextCursor } = computeDelta(file, 0, identityResolvers);
  assert.equal(nextCursor, 4);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].toLine, 3, 'the bad line belongs to no run');
});

test('a torn line stops holding the cursor the moment anything is appended after it', () => {
  // This is the other half of "cannot block forever": a line is only ever treated as torn while it
  // is the last line and unterminated. One append makes it newline-terminated and therefore
  // complete-but-corrupt, and the cursor moves past it.
  const file = writeRaw(jsonl(PRELUDE) + '\n{"broken":');
  assert.equal(computeDelta(file, 0, identityResolvers).nextCursor, 3);

  fs.appendFileSync(file, '\n' + JSON.stringify(tokens('2026-01-01T00:00:05.000Z', 300, 0, 30)) + '\n');
  const { segments, nextCursor } = computeDelta(file, 3, identityResolvers);
  assert.equal(nextCursor, 5, 'the permanently-bad line 4 is passed over');
  assert.deepEqual([segments[0].fromLine, segments[0].toLine], [5, 5]);
});

test('a valid record with no final newline is billed and passed over', () => {
  // A torn write cannot produce one: the closing brace is the record's last byte, so any prefix of
  // it fails to parse. A complete record simply has not had its newline flushed yet.
  const file = writeRaw(jsonl([...PRELUDE, tokens('2026-01-01T00:00:04.000Z', 300, 0, 30)]));
  const { segments, nextCursor } = computeDelta(file, 0, identityResolvers);
  assert.equal(nextCursor, 4);
  assert.equal(segments[0].toLine, 4);
  assert.equal(segments[0].stats.models['gpt-5.2-codex'].token_input, 300);
});

test('blank and empty tails never hold the cursor', () => {
  const trailingNewlines = writeRaw(jsonl(PRELUDE) + '\n\n\n');
  assert.equal(computeDelta(trailingNewlines, 0, identityResolvers).nextCursor, 3);

  // Whitespace with no newline: records start with '{', so this can never be a torn record.
  const trailingSpaces = writeRaw(jsonl(PRELUDE) + '\n   ');
  assert.equal(computeDelta(trailingSpaces, 0, identityResolvers).nextCursor, 4);

  const empty = writeRaw('');
  const { segments, nextCursor } = computeDelta(empty, 0, identityResolvers);
  assert.equal(nextCursor, 0);
  assert.equal(segments.length, 0);
});

test('a mid-file unparseable line is still skipped AND passed over', () => {
  // Unchanged behaviour, asserted here so the torn-tail rule cannot quietly widen into it: only
  // the LAST line of an unterminated file is ever treated as incomplete.
  const file = writeRaw([
    JSON.stringify(turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z')),
    'NOT JSON',
    JSON.stringify(turn('/repoB', 'gpt-5.2-codex', '2026-01-01T00:00:02.000Z')),
    JSON.stringify(tokens('2026-01-01T00:00:03.000Z', 100, 0, 10)),
  ].join('\n') + '\n');
  const { segments, nextCursor } = computeDelta(file, 0, identityResolvers);
  assert.equal(nextCursor, 4);
  // The repo switch makes the gap visible: line 2 joins neither the run before nor the one after.
  assert.deepEqual(segments.map((s) => [s.fromLine, s.toLine]), [[1, 1], [3, 4]]);
});

// --- G-3-5: the stall guard -----------------------------------------------------------------

test('a cursor beyond the transcript defers without replaying covered lines', () => {
  const file = writeRollout(PRELUDE);
  assert.throws(() => computeDelta(file, 99, identityResolvers), { code: 'CURSOR_MISMATCH' });
});

test('a cursor exactly at the line count re-sends nothing — the guard is strictly >', () => {
  // The steady state after every checkpoint. `>=` here would re-send the whole session each time.
  const file = writeRollout(PRELUDE);
  const { segments, nextCursor } = computeDelta(file, 3, identityResolvers);
  assert.equal(segments.length, 0);
  assert.equal(nextCursor, 3);
});

test('thread_rolled_back is append-only: the cursor advances past it and deltas stay non-negative', () => {
  // The regression guard for the whole G-3-5 revision. A rollback discards conversation, not spend
  // — the transcript keeps growing and token totals keep rising. If a future Codex build ever
  // broke that, this is what would catch it.
  const file = writeRollout([
    ...PRELUDE,
    { timestamp: '2026-01-01T00:00:03.000Z', type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
    turn('/repo', 'gpt-5.2-codex', '2026-01-01T00:00:04.000Z'),
    tokens('2026-01-01T00:00:05.000Z', 300, 0, 30),
  ]);
  const { segments, nextCursor } = computeDelta(file, 0, identityResolvers);
  assert.equal(nextCursor, 6);
  assert.equal(segments.length, 1);
  assert.deepEqual([segments[0].fromLine, segments[0].toLine], [1, 6]);
  const m = segments[0].stats.models['gpt-5.2-codex'];
  assert.equal(m.token_input, 300, 'totals across a rollback are cumulative, never reset');
  assert.equal(m.token_output, 30);
  assert.equal(m.requests, 2);
});

test('a compacted replacement_history does not double-count the records it replays', () => {
  // `compacted` carries prior conversation inline in `replacement_history`. Every parser matches
  // record.payload at the TOP level and never recurses, so the replay is inert — including for the
  // two modern code-change record types (patch_apply_end and item_completed/FileChange), which the
  // original proof of this property predates.
  const nestedApplyPatch = {
    type: 'response_item',
    payload: {
      type: 'custom_tool_call', name: 'apply_patch', call_id: 'nested-1',
      input: '*** Begin Patch\n*** Add File: /repo/nested.ts\n+one\n+two\n*** End Patch',
    },
  };
  const nestedFileChange = {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'FileChange', id: 'nested-2', status: 'completed', changes: { '/repo/other.ts': { type: 'add', content: 'a\nb\nc\n' } } },
    },
  };
  const nestedPatchApplyEnd = {
    type: 'event_msg',
    payload: { type: 'patch_apply_end', call_id: 'nested-3', success: true, changes: { '/repo/third.ts': { type: 'add', content: 'x\n' } } },
  };
  // The positive control shares the fixture on purpose: a top-level edit that MUST be counted. A
  // parser that recursed into replacement_history reports 4 files; one that read nothing at all
  // reports 0. Only "reads the surface, ignores the replay" reports 1.
  const topLevelApplyPatch = {
    timestamp: '2026-01-01T00:00:03.000Z',
    type: 'response_item',
    payload: {
      type: 'custom_tool_call', name: 'apply_patch', call_id: 'real-1',
      input: '*** Begin Patch\n*** Add File: /repo/real.ts\n+x\n+y\n*** End Patch',
    },
  };
  const file = writeRollout([
    ...PRELUDE,
    topLevelApplyPatch,
    {
      timestamp: '2026-01-01T00:00:04.000Z',
      type: 'event_msg',
      payload: {
        type: 'compacted',
        message: 'summary',
        window_number: 2,
        replacement_history: [nestedApplyPatch, nestedFileChange, nestedPatchApplyEnd],
      },
    },
    tokens('2026-01-01T00:00:05.000Z', 300, 0, 30),
  ]);
  const { segments } = computeDelta(file, 0, identityResolvers);
  assert.deepEqual(segments[0].stats.code_changes, {
    files_changed: 1, lines_added: 2, lines_removed: 0, by_extension: { '.ts': 1 },
  });
  assert.equal(segments[0].stats.operations.file.count, 1);
  assert.equal(segments[0].stats.models['gpt-5.2-codex'].token_input, 300);
});

// --- an unparseable timestamp must not poison the segment clock ------------------------------

test('an unparseable timestamp costs its own record from the clock, not the whole duration', () => {
  // `new Date('not-a-date').getTime()` is NaN, and `NaN != null` is TRUE — so without a guard the
  // NaN reaches buildActiveIntervals and every duration derived from the segment's intervals goes
  // non-finite. The tokens still bill; only that record leaves the clock.
  const file = writeRollout([
    meta('/repo'),
    turn('/repo', 'gpt-5.2-codex', '2026-01-01T00:05:00.000Z'),
    tokens('not-a-date', 100, 0, 10),
    tokens('2026-01-01T00:06:00.000Z', 180, 0, 30),
  ]);
  const { segments } = computeDelta(file, 0, identityResolvers);
  assert.equal(segments.length, 1);
  const seg = segments[0];
  assert.ok(Number.isFinite(seg.stats.duration_sec), `duration_sec must be finite, got ${seg.stats.duration_sec}`);
  assert.equal(seg.stats.duration_sec, 60);
  for (const [s, e] of seg.activeIntervals) {
    assert.ok(Number.isFinite(s) && Number.isFinite(e), 'no interval endpoint may be NaN');
  }
  assert.equal(seg.stats.started_at, '2026-01-01T00:00:00.000Z');
  assert.equal(seg.stats.ended_at, '2026-01-01T00:06:00.000Z');
  assert.equal(seg.stats.models['gpt-5.2-codex'].token_input, 180, 'a broken stamp costs the clock, never the tokens');
  assert.equal(seg.stats.models['gpt-5.2-codex'].requests, 2);
});

// ==============================================================================================
// G-4-2 — per-effort token buckets (`models[m].by_effort[e]`).
//
// `by_effort` is declared on SessionReportModelUsageDto (session-report.request.dto.ts:113-115) and
// deep-validated by IsEffortUsageRecord (:56-85): key length 1..50, and every value must carry all
// four token counters as non-negative ints. The server explodes the payload into one priced row per
// (model x effort) — session-report.service.ts:166-180 — so the buckets must be an exact PARTITION
// of the model tally, or the per-bucket prices stop summing to the model's and cost drifts up with
// no error anywhere.
// ==============================================================================================

// turn_context with a reasoning effort. `payload.effort` is the superset source: over every local
// record carrying both it and collaboration_mode.reasoning_effort they agreed 802/802, and `effort`
// is present on 3623 records where `reasoning_effort` is absent.
const turnEffort = (cwd, model, ts, effort) => ({
  timestamp: ts, type: 'turn_context', payload: { cwd, model, effort },
});

test('G-4-2 — an effort on turn_context buckets the model tally under that effort', () => {
  const file = writeRollout([
    meta('/repoA'),
    turnEffort('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z', 'high'),
    tokens('2026-01-01T00:00:02.000Z', 100, 40, 10),
    tokens('2026-01-01T00:00:03.000Z', 150, 60, 30),
  ]);
  const { segments } = computeDelta(file, 0, identityResolvers);
  const m = segments[0].stats.models['gpt-5.2-codex'];
  assert.deepEqual(Object.keys(m.by_effort), ['high']);
  // A single-effort session is the degenerate partition: the one bucket IS the model tally.
  assert.deepEqual(m.by_effort.high, {
    token_input: m.token_input,
    token_output: m.token_output,
    token_cache_read: m.token_cache_read,
    token_cache_creation: m.token_cache_creation,
    requests: m.requests,
  });
  assert.equal(m.by_effort.high.token_input, 90);
  assert.equal(m.by_effort.high.token_output, 30);
  assert.equal(m.by_effort.high.token_cache_read, 60);
});

test('G-4-2 — switching effort mid-session splits into buckets that SUM to the model tally', () => {
  // The partition invariant, asserted as arithmetic rather than by inspection. This is the guard
  // against the silent double-count: accumulating the model bucket and the effort bucket in two
  // separate statements (instead of one loop over both) breaks the sum without raising anything.
  const file = writeRollout([
    meta('/repoA'),
    turnEffort('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z', 'medium'),
    tokens('2026-01-01T00:00:02.000Z', 100, 40, 10),
    turnEffort('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:03.000Z', 'high'),
    tokens('2026-01-01T00:00:04.000Z', 250, 90, 70),
    turnEffort('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:05.000Z', 'medium'),
    tokens('2026-01-01T00:00:06.000Z', 400, 150, 100),
  ]);
  const { segments } = computeDelta(file, 0, identityResolvers);
  const m = segments[0].stats.models['gpt-5.2-codex'];
  assert.deepEqual(Object.keys(m.by_effort).sort(), ['high', 'medium']);

  const summed = Object.values(m.by_effort).reduce((acc, b) => ({
    token_input: acc.token_input + b.token_input,
    token_output: acc.token_output + b.token_output,
    token_cache_read: acc.token_cache_read + b.token_cache_read,
    token_cache_creation: acc.token_cache_creation + b.token_cache_creation,
    requests: acc.requests + b.requests,
  }), { token_input: 0, token_output: 0, token_cache_read: 0, token_cache_creation: 0, requests: 0 });

  assert.deepEqual(summed, {
    token_input: m.token_input,
    token_output: m.token_output,
    token_cache_read: m.token_cache_read,
    token_cache_creation: m.token_cache_creation,
    requests: m.requests,
  });
  // And the split is the real one, not two copies of the whole: medium took requests 1 and 3.
  assert.equal(m.by_effort.medium.requests, 2);
  assert.equal(m.by_effort.high.requests, 1);
  assert.equal(m.requests, 3);
});

test('G-4-2 — an effort declared before the cursor still bills the resumed window', () => {
  // The effort is read ABOVE the pre-window branch, exactly like the model. A resumed window whose
  // turn_context sits before the cursor must not bill its first token_count to 'unknown'.
  const records = [
    meta('/repoA'),
    turnEffort('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z', 'high'), // line 2
    tokens('2026-01-01T00:00:02.000Z', 100, 0, 10), // line 3
    tokens('2026-01-01T00:00:03.000Z', 200, 0, 40), // line 4
  ];
  const { segments } = computeDelta(writeRollout(records), 3, identityResolvers);
  const m = segments[0].stats.models['gpt-5.2-codex'];
  assert.deepEqual(Object.keys(m.by_effort), ['high'], 'the pre-cursor turn_context still sets the effort');
  assert.equal(m.by_effort.high.token_input, 100);
});

test('G-4-2 — an oversized effort key is clamped to 50 chars, and an empty one is ignored', () => {
  // Both are 400-avoidance pins. IsEffortUsageRecord rejects a key of length 0 or > 50, and a 400 on
  // /sessions/report is treated as PERMANENT by flushQueue — the queued segment's tokens, cost, code
  // changes and operations are deleted, not retried.
  const long = 'x'.repeat(200);
  const file = writeRollout([
    meta('/repoA'),
    turnEffort('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z', long),
    tokens('2026-01-01T00:00:02.000Z', 100, 0, 10),
  ]);
  const { segments } = computeDelta(file, 0, identityResolvers);
  const keys = Object.keys(segments[0].stats.models['gpt-5.2-codex'].by_effort);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].length, 50);
  assert.equal(keys[0], 'x'.repeat(50));

  const emptyFile = writeRollout([
    meta('/repoB'),
    turnEffort('/repoB', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z', ''),
    tokens('2026-01-01T00:00:02.000Z', 100, 0, 10),
  ]);
  const empty = computeDelta(emptyFile, 0, identityResolvers);
  assert.deepEqual(
    Object.keys(empty.segments[0].stats.models['gpt-5.2-codex'].by_effort), ['unknown'],
    'an empty effort string falls back to the unknown bucket rather than emitting a zero-length key',
  );
});

test('G-4-2 — every by_effort bucket carries all four counters the DTO requires', () => {
  // SessionReportEffortUsageDto marks only `requests` optional; the four token counters are
  // @IsInt() @Min(0) and a bucket missing one fails validation and 400s the whole segment.
  const file = writeRollout([
    meta('/repoA'),
    turnEffort('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z', 'low'),
    tokens('2026-01-01T00:00:02.000Z', 100, 0, 10),
  ]);
  const { segments } = computeDelta(file, 0, identityResolvers);
  for (const m of Object.values(segments[0].stats.models)) {
    for (const [effort, bucket] of Object.entries(m.by_effort)) {
      assert.ok(effort.length >= 1 && effort.length <= 50, `effort key out of bounds: ${effort}`);
      assert.deepEqual(Object.keys(bucket).sort(), [
        'requests', 'token_cache_creation', 'token_cache_read', 'token_input', 'token_output',
      ]);
      for (const [k, v] of Object.entries(bucket)) {
        assert.ok(Number.isInteger(v) && v >= 0, `${effort}.${k} must be a non-negative int, got ${v}`);
      }
    }
  }
});

test('G-4-2 — by_effort never enters the session totals', () => {
  // summarize() reduces over the NAMED per-model counters, so the sub-buckets are invisible to it.
  // If they were ever summed as siblings the session would report exactly double.
  const file = writeRollout([
    meta('/repoA'),
    turnEffort('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z', 'medium'),
    tokens('2026-01-01T00:00:02.000Z', 100, 40, 10),
    turnEffort('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:03.000Z', 'high'),
    tokens('2026-01-01T00:00:04.000Z', 150, 60, 30),
  ]);
  const { stats } = computeDelta(file, 0, identityResolvers).segments[0];
  // Identical to the effort-less fixture at the top of this file: 90 / 30 / 60, total 180.
  assert.equal(stats.token_input, 90);
  assert.equal(stats.token_output, 30);
  assert.equal(stats.token_cache, 60);
  assert.equal(stats.token_total, 180);
});

// ==============================================================================================
// G-4-4 — context-window OCCUPANCY (context_peak_tokens / context_final_tokens /
// context_final_model, whitelisted at session-report.request.dto.ts:460-474).
//
// Read from `last_token_usage.input_tokens` — ONE request's whole prompt. Not the cumulative
// `total_token_usage` (one local session reached 25 783 494 against a 258 400 window, and the DTO's
// @IsInt() @Min(0) has no upper bound, so it would be stored and charted), and not Claude's additive
// input+cache formula (on Codex `cached_input_tokens` is a SUBSET of `input_tokens`, so adding it
// overflows the window in 14.4% of local observations, peaking at 1.77x).
// ==============================================================================================

// token_count carrying BOTH the cumulative totals and the single-request occupancy reading.
const tokensCtx = (ts, input, cached, output, ctxInput) => ({
  timestamp: ts,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input, cached_input_tokens: cached, output_tokens: output,
        reasoning_output_tokens: 0, total_tokens: input + output,
      },
      last_token_usage: {
        input_tokens: ctxInput, cached_input_tokens: 0, output_tokens: 0,
        reasoning_output_tokens: 0, total_tokens: ctxInput,
      },
      model_context_window: 258400,
    },
  },
});

test('G-4-4 — peak is the high-water mark and final is the last reading', () => {
  const file = writeRollout([
    meta('/repoA'),
    turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
    tokensCtx('2026-01-01T00:00:02.000Z', 100, 0, 10, 100),
    tokensCtx('2026-01-01T00:00:03.000Z', 200, 0, 20, 5000),
    tokensCtx('2026-01-01T00:00:04.000Z', 300, 0, 30, 3000),
  ]);
  const { stats } = computeDelta(file, 0, identityResolvers).segments[0];
  assert.equal(stats.context_peak_tokens, 5000);
  assert.equal(stats.context_final_tokens, 3000);
  assert.equal(stats.context_final_model, 'gpt-5.2-codex');
});

test('G-4-4 — a compaction drops the final reading to 0 without lowering the peak', () => {
  // Occupancy drops to 0 after every compaction it could be measured across locally (7 clean cases,
  // e.g. 234 592 -> 0). The peak is what the session actually reached and must survive it.
  const file = writeRollout([
    meta('/repoA'),
    turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
    tokensCtx('2026-01-01T00:00:02.000Z', 100, 0, 10, 234592),
    { timestamp: '2026-01-01T00:00:03.000Z', type: 'event_msg', payload: { type: 'compacted', message: 'summary', window_number: 2 } },
    tokensCtx('2026-01-01T00:00:04.000Z', 200, 0, 20, 0),
  ]);
  const { stats } = computeDelta(file, 0, identityResolvers).segments[0];
  assert.equal(stats.context_peak_tokens, 234592);
  assert.equal(stats.context_final_tokens, 0);
});

test('G-4-4 — a window with no occupancy reading carries NO context keys at all', () => {
  // Absent, never 0: `0` is a claim that the context was empty and the server stores it as one.
  // Asserted with `in`, because `=== 0` and "absent" are exactly what must stay distinguishable.
  const file = writeRollout([
    meta('/repoA'),
    turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
    tokens('2026-01-01T00:00:02.000Z', 100, 0, 10), // total_token_usage only — no last_token_usage
  ]);
  const { stats } = computeDelta(file, 0, identityResolvers).segments[0];
  assert.ok(!('context_peak_tokens' in stats));
  assert.ok(!('context_final_tokens' in stats));
  assert.ok(!('context_final_model' in stats));
  assert.equal(stats.token_total, 110, 'the tokens still bill');
});

test('G-4-4 — each segment stamps the model ITS reading was taken under', () => {
  // The activeModel-vs-run.contextFinalModel trap: closeRun() fires from the run-switch branch AFTER
  // the model read has advanced activeModel to the record opening the NEXT run. Reading activeModel
  // in closeRun would stamp segment two's model onto segment one's context. Without this test that
  // bug is invisible.
  const file = writeRollout([
    meta('/repoA'),
    turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
    tokensCtx('2026-01-01T00:00:02.000Z', 100, 0, 10, 1000),
    turn('/repoB', 'gpt-5.6-sol', '2026-01-01T00:00:03.000Z'),
    tokensCtx('2026-01-01T00:00:04.000Z', 200, 0, 20, 7000),
  ]);
  const { segments } = computeDelta(file, 0, identityResolvers);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].stats.context_final_model, 'gpt-5.2-codex');
  assert.equal(segments[0].stats.context_final_tokens, 1000);
  assert.equal(segments[1].stats.context_final_model, 'gpt-5.6-sol');
  assert.equal(segments[1].stats.context_final_tokens, 7000);
});

test('G-4-4 — context_final_model is clamped to 100 chars', () => {
  // @IsString() @MaxLength(100) at session-report.request.dto.ts:471-474.
  const long = 'm'.repeat(300);
  const file = writeRollout([
    meta('/repoA'),
    turn('/repoA', long, '2026-01-01T00:00:01.000Z'),
    tokensCtx('2026-01-01T00:00:02.000Z', 100, 0, 10, 1000),
  ]);
  const { stats } = computeDelta(file, 0, identityResolvers).segments[0];
  assert.equal(stats.context_final_model.length, 100);
  assert.equal(stats.context_final_model, 'm'.repeat(100));
});

test('G-4-4 — an occupancy reading on the FIRST line of a window does not crash', () => {
  // The null-`run` pin. `run` is null until the run-creation block, so an occupancy read placed
  // beside the apiError/rateLimit reads (which sit above it precisely because they never touch
  // `run`) would throw here — taking computeDelta down with the cursor unadvanced, the segment
  // unflushed and the rate-limit queue undrained.
  const first = writeRollout([tokensCtx('2026-01-01T00:00:02.000Z', 100, 0, 10, 1234)]);
  let out;
  assert.doesNotThrow(() => { out = computeDelta(first, 0, identityResolvers); });
  assert.equal(out.segments[0].stats.context_final_tokens, 1234);
  assert.equal(out.segments[0].stats.context_final_model, 'unknown');

  // And the mirror case: a window whose first line is a turn_context still computes.
  const viaTurn = writeRollout([
    turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
    tokensCtx('2026-01-01T00:00:02.000Z', 100, 0, 10, 1234),
  ]);
  assert.doesNotThrow(() => computeDelta(viaTurn, 0, identityResolvers));
});

test('G-4-4 — occupancy never enters the billing totals', () => {
  const withCtx = writeRollout([
    meta('/repoA'),
    turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
    tokensCtx('2026-01-01T00:00:02.000Z', 100, 40, 10, 90000),
    tokensCtx('2026-01-01T00:00:03.000Z', 150, 60, 30, 120000),
  ]);
  const withoutCtx = writeRollout([
    meta('/repoA'),
    turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
    tokens('2026-01-01T00:00:02.000Z', 100, 40, 10),
    tokens('2026-01-01T00:00:03.000Z', 150, 60, 30),
  ]);
  const a = computeDelta(withCtx, 0, identityResolvers).segments[0].stats;
  const b = computeDelta(withoutCtx, 0, identityResolvers).segments[0].stats;
  assert.equal(a.token_total, b.token_total);
  assert.equal(a.token_input, b.token_input);
  assert.equal(a.token_output, b.token_output);
  assert.equal(a.token_cache, b.token_cache);
  assert.deepEqual(a.models, b.models, 'occupancy touches no per-model counter');
  assert.equal(a.token_total, 180);
});

// ==============================================================================================
// G-4-8 — the `token_usage_record` canary.
//
// A second, per-request token source that appeared on CLI 0.153 (870 records across 16/201 local
// rollouts) and is entirely unread. Purely additive today — all 16 of those files also carry
// `token_count` — but if a build ever drops `token_count`, totalsFromRecord returns null for every
// line and the plugin reports ZERO tokens with no error anywhere. The canary is deliberately a
// BOOLEAN and not a parser: the two sources describe the same usage, so reading both would
// double-count every token on CLI 0.153+.
// ==============================================================================================

const usageRecord = (ts, ordinal) => ({
  timestamp: ts,
  ordinal,
  type: 'token_usage_record',
  payload: {
    thread_id: 't-1', turn_id: 'turn-1', session_id: 's-1', root_turn_id: 'turn-1',
    response_id: 'resp_0c17',
    usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 },
    turn_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 },
    thread_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 },
  },
});

test('G-4-8 — token_usage_record with NO token_count raises the flag and reports zero tokens', () => {
  const file = writeRollout([
    meta('/repoA'),
    turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
    usageRecord('2026-01-01T00:00:02.000Z', 12),
    usageRecord('2026-01-01T00:00:03.000Z', 13),
  ]);
  const out = computeDelta(file, 0, identityResolvers);
  assert.equal(out.tokenSourceMissing, true);
  // The zero it is warning about — loud instead of silent is the whole point.
  assert.equal(out.segments.length, 1);
  assert.equal(out.segments[0].stats.token_total, 0);
  assert.deepEqual(out.segments[0].stats.models, {}, 'nothing is parsed out of token_usage_record');
});

test('G-4-8 — both sources present: the flag stays down and the tokens are NOT double-counted', () => {
  // This is the shape of every one of the 16 local 0.153.x rollouts. The token_usage_record blocks
  // restate the same usage as the token_count events; if they were parsed the totals would double.
  const withBoth = writeRollout([
    meta('/repoA'),
    turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
    usageRecord('2026-01-01T00:00:02.000Z', 12),
    tokens('2026-01-01T00:00:02.500Z', 100, 40, 10),
    usageRecord('2026-01-01T00:00:03.000Z', 13),
    tokens('2026-01-01T00:00:03.500Z', 150, 60, 30),
  ]);
  const countOnly = writeRollout([
    meta('/repoA'),
    turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
    tokens('2026-01-01T00:00:02.500Z', 100, 40, 10),
    tokens('2026-01-01T00:00:03.500Z', 150, 60, 30),
  ]);
  const both = computeDelta(withBoth, 0, identityResolvers);
  const only = computeDelta(countOnly, 0, identityResolvers);
  assert.equal(both.tokenSourceMissing, false);
  assert.equal(only.tokenSourceMissing, false);
  // Byte-for-byte the same tally: adding token_usage_record lines changes no token anywhere.
  assert.deepEqual(both.segments[0].stats.models, only.segments[0].stats.models);
  assert.equal(both.segments[0].stats.token_total, only.segments[0].stats.token_total);
  assert.equal(both.segments[0].stats.token_total, 180);
});

test('G-4-8 — neither source present leaves the flag down', () => {
  // "No tokens because nothing happened" must not look like "no tokens because the parser went
  // blind". The flag fires only on the second.
  const file = writeRollout([
    meta('/repoA'),
    turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
  ]);
  assert.equal(computeDelta(file, 0, identityResolvers).tokenSourceMissing, false);
});

test('G-4-8 — the canary reads the whole file, not just the window', () => {
  // Whether a build still emits token_count is a fact about the ROLLOUT. A resumed window that
  // happens to contain only token_usage_record lines must not raise the alarm when the prefix
  // already proved the parser can see totals.
  const records = [
    meta('/repoA'),
    turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
    tokens('2026-01-01T00:00:02.000Z', 100, 0, 10), // line 3, pre-cursor
    usageRecord('2026-01-01T00:00:03.000Z', 13), // line 4, in-window
  ];
  assert.equal(computeDelta(writeRollout(records), 3, identityResolvers).tokenSourceMissing, false);
});

test('G-4-8 — a renamed totals block trips the canary, not just a dropped record type', () => {
  // sawTokenCount is driven by totalsFromRecord's own verdict, so the failure being watched for is
  // "the parser found no totals anywhere" — which also covers a token_count whose
  // `total_token_usage` block was renamed or removed.
  const file = writeRollout([
    meta('/repoA'),
    turn('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z'),
    usageRecord('2026-01-01T00:00:02.000Z', 12),
    { timestamp: '2026-01-01T00:00:03.000Z', type: 'event_msg', payload: { type: 'token_count', info: { totals: { input_tokens: 100 } } } },
  ]);
  assert.equal(computeDelta(file, 0, identityResolvers).tokenSourceMissing, true);
});

// ==============================================================================================
// F8 — the reconciliation the whole engine rests on, re-pinned with all three additions live.
// ==============================================================================================

test('F8 — sum of deltas across successive checkpoints still reproduces the cumulative total exactly', () => {
  // Σ Δ over every window == the final cumulative total the platform reported, and the effort
  // buckets are an exact partition of that same sum. by_effort, occupancy and the canary all ride
  // alongside the arithmetic without touching `prev`, `dInput/dCached/dOutput` or `nonCachedInput`.
  const FINAL_INPUT = 400;
  const FINAL_CACHED = 150;
  const FINAL_OUTPUT = 100;
  const records = [
    meta('/repoA'),                                                                         // 1
    turnEffort('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:01.000Z', 'medium'),            // 2
    tokensCtx('2026-01-01T00:00:02.000Z', 100, 40, 10, 100),                                // 3
    usageRecord('2026-01-01T00:00:03.000Z', 12),                                            // 4
    turnEffort('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:04.000Z', 'high'),              // 5
    tokensCtx('2026-01-01T00:00:05.000Z', 250, 90, 70, 5000),                               // 6
    turnEffort('/repoA', 'gpt-5.2-codex', '2026-01-01T00:00:06.000Z', 'low'),               // 7
    tokensCtx('2026-01-01T00:00:07.000Z', FINAL_INPUT, FINAL_CACHED, FINAL_OUTPUT, 3000),   // 8
  ];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-codex-f8-'));
  const file = path.join(dir, 'rollout.jsonl');
  const acc = { token_input: 0, token_output: 0, token_cache_read: 0, requests: 0 };
  const effortAcc = {};
  let cursor = 0;

  // The rollout GROWS between checkpoints, exactly as a live session's does.
  for (const upto of [3, 6, 8]) {
    fs.writeFileSync(file, jsonl(records.slice(0, upto)) + '\n');
    const out = computeDelta(file, cursor, identityResolvers);
    assert.equal(out.tokenSourceMissing, false, 'both sources are present in every window');
    cursor = out.nextCursor;
    for (const s of out.segments) {
      for (const m of Object.values(s.stats.models)) {
        acc.token_input += m.token_input;
        acc.token_output += m.token_output;
        acc.token_cache_read += m.token_cache_read;
        acc.requests += m.requests;
        for (const [e, b] of Object.entries(m.by_effort)) {
          if (!effortAcc[e]) effortAcc[e] = { token_input: 0, token_output: 0, token_cache_read: 0, requests: 0 };
          effortAcc[e].token_input += b.token_input;
          effortAcc[e].token_output += b.token_output;
          effortAcc[e].token_cache_read += b.token_cache_read;
          effortAcc[e].requests += b.requests;
        }
      }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });

  // token_input is billed NET of cache, so the platform's cumulative input is input + cache_read.
  assert.equal(acc.token_input + acc.token_cache_read, FINAL_INPUT, 'Σ Δ input == final cumulative input');
  assert.equal(acc.token_cache_read, FINAL_CACHED, 'Σ Δ cached == final cumulative cached');
  assert.equal(acc.token_output, FINAL_OUTPUT, 'Σ Δ output == final cumulative output');
  assert.equal(acc.requests, 3, 'one request per token_count event, never two');

  // And the effort partition sums back to the same numbers — no bucket is a second accumulation.
  const partition = Object.values(effortAcc).reduce((a, b) => ({
    token_input: a.token_input + b.token_input,
    token_output: a.token_output + b.token_output,
    token_cache_read: a.token_cache_read + b.token_cache_read,
    requests: a.requests + b.requests,
  }), { token_input: 0, token_output: 0, token_cache_read: 0, requests: 0 });
  assert.deepEqual(partition, acc);
  assert.deepEqual(Object.keys(effortAcc).sort(), ['high', 'low', 'medium']);
});

test('MCP attribution survives every checkpoint boundary without duplicating tokens or calls', () => {
  const records = [
    meta('/repoA'), turn('/repoA', 'gpt-6-astra', '2026-01-01T00:00:01.000Z'),
    tokens('2026-01-01T00:00:02.000Z', 100, 0, 10),
    { type: 'response_item', payload: { type: 'function_call', name: 'js', call_id: 'm1', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'm1', output: 'done' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', id: 'm1', server: 'cua_repl', tool: 'js' } } },
    tokens('2026-01-01T00:00:04.000Z', 150, 0, 20),
  ];
  for (let split = 1; split < records.length; split++) {
    const file = writeRollout(records.slice(0, split));
    const first = computeDelta(file, 0, identityResolvers);
    fs.appendFileSync(file, jsonl(records.slice(split)) + '\n');
    const second = computeDelta(file, first.nextCursor, identityResolvers);
    const stats = [...first.segments, ...second.segments].map(s => s.stats);
    assert.equal(stats.reduce((n, s) => n + (s.operations.mcp.by_server.cua_repl?.count || 0), 0), 1, `split ${split}`);
    assert.equal(stats.reduce((n, s) => n + (s.operations.mcp.by_server.unknown?.count || 0), 0), 0);
    assert.equal(stats.reduce((n, s) => n + s.token_total, 0), 170);
    assert.equal(second.nextCursor, records.length);
    assert.equal(computeDelta(file, second.nextCursor, identityResolvers).segments.length, 0);
  }
});

test('server metadata across repo segments names the original call without recounting it', () => {
  const file = writeRollout([
    meta('/repoA'),
    { type: 'response_item', payload: { type: 'function_call', name: 'notion_search', call_id: 'm1', arguments: '{}' } },
    turn('/repoB', 'gpt-6-astra', '2026-01-01T00:00:02.000Z'),
    { type: 'event_msg', payload: { type: 'mcp_tool_call_end', call_id: 'm1', invocation: { server: 'notion', tool: 'search' } } },
  ]);
  const { segments } = computeDelta(file, 0, identityResolvers);
  assert.equal(segments[0].stats.operations.mcp.by_server.notion.count, 1);
  assert.equal(segments[1].stats.operations.mcp.count, 0);
});

test('an unidentified pending call waits for metadata but a terminal turn releases the cursor', () => {
  for (const terminal of ['task_complete', 'turn_aborted']) {
    const file = writeRollout([
      meta('/repoA'),
      { type: 'response_item', payload: { type: 'function_call', name: 'new_tool', call_id: 'm1', arguments: '{}' } },
    ]);
    const first = computeDelta(file, 0, identityResolvers);
    assert.equal(first.nextCursor, 1);
    fs.appendFileSync(file, jsonl([{ type: 'event_msg', payload: { type: terminal } }]) + '\n');
    const second = computeDelta(file, first.nextCursor, identityResolvers);
    assert.equal(second.nextCursor, 3);
    assert.equal(second.segments[0].stats.operations.other.count, 1);
    assert.equal(second.segments[0].stats.operations.mcp.count, 0);
  }
});

test('known agent builtins do not hold a checkpoint waiting for MCP metadata', () => {
  const file = writeRollout([meta('/repoA'), ...['send_message', 'wait_agent', 'spawn_agent', 'list_agents', 'followup_task'].map((name, i) => ({
    type: 'response_item', payload: { type: 'function_call', name, call_id: String(i), arguments: '{}' },
  }))]);
  const out = computeDelta(file, 0, identityResolvers);
  assert.equal(out.nextCursor, 6);
  assert.equal(out.segments[0].stats.operations.other.count, 5);
});

test('MCP discovery without a server argument waits for the server completion', () => {
  const file = writeRollout([meta('/repoA'), {
    type: 'response_item', payload: { type: 'function_call', name: 'list_mcp_resources', call_id: 'r1', arguments: '{}' },
  }]);
  const first = computeDelta(file, 0, identityResolvers);
  assert.equal(first.nextCursor, 1);
  fs.appendFileSync(file, jsonl([{
    type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', id: 'r1', server: 'codex', tool: 'list_mcp_resources' } },
  }]) + '\n');
  const second = computeDelta(file, first.nextCursor, identityResolvers);
  assert.equal(second.segments[0].stats.operations.mcp.by_server.codex.count, 1);
});

// --- resetsAt on usage-limit errors ---------------------------------------------------------

const limitsRec = (ts, limits) => ({
  timestamp: ts, type: 'event_msg', payload: { type: 'token_count', rate_limits: limits },
});
const win = (used, resetsAtSec) => ({ used_percent: used, window_minutes: 300, resets_at: resetsAtSec });
const limitError = (ts) => ({
  timestamp: ts,
  type: 'event_msg',
  payload: {
    type: 'task_complete',
    error: { message: "You've hit your usage limit. try again at 6:25 PM.", codex_error_info: 'usage_limit_exceeded' },
  },
});
const ERR_TS = '2026-01-01T00:00:10.000Z';
const ERR_SEC = Date.parse(ERR_TS) / 1000;
const R = ERR_SEC + 3600;
const iso = (sec) => new Date(sec * 1000).toISOString();
const eventsOf = (file, from = 0) => computeDelta(file, from, identityResolvers).apiErrorEvents;

test('resetsAt comes from the codex block, skipping a later premium block with null windows', () => {
  const file = withPrelude(
    limitsRec('2026-01-01T00:00:05.000Z', { limit_id: 'codex', primary: win(100, R), secondary: win(42, R + 99999) }),
    limitsRec('2026-01-01T00:00:06.000Z', { limit_id: 'premium', primary: null, secondary: null }),
    limitError(ERR_TS),
  );
  assert.equal(eventsOf(file)[0].resetsAt, iso(R));
});

test('resetsAt picks the highest used_percent window (99 beats 42)', () => {
  const file = withPrelude(
    limitsRec('2026-01-01T00:00:05.000Z', { limit_id: 'codex', primary: win(99, R), secondary: win(42, R + 99999) }),
    limitError(ERR_TS),
  );
  assert.equal(eventsOf(file)[0].resetsAt, iso(R));
});

test('resetsAt breaks a used_percent tie with the later reset', () => {
  const file = withPrelude(
    limitsRec('2026-01-01T00:00:05.000Z', { limit_id: 'codex', primary: win(100, R), secondary: win(100, R + 5000) }),
    limitError(ERR_TS),
  );
  assert.equal(eventsOf(file)[0].resetsAt, iso(R + 5000));
});

test('resetsAt is found when the window starts after the token_count', () => {
  const file = withPrelude(
    limitsRec('2026-01-01T00:00:05.000Z', { limit_id: 'codex', primary: win(100, R), secondary: null }),
    limitError(ERR_TS),
  );
  // meta + turn + token_count = 3 lines before the window; the error is line 4.
  assert.equal(eventsOf(file, 3)[0].resetsAt, iso(R));
});

test('resetsAt is null without a preceding token_count', () => {
  assert.equal(eventsOf(withPrelude(limitError(ERR_TS)))[0].resetsAt, null);
});

test('resetsAt is null when the reset is not after the error', () => {
  const file = withPrelude(
    limitsRec('2026-01-01T00:00:05.000Z', { limit_id: 'codex', primary: win(100, ERR_SEC), secondary: null }),
    limitError(ERR_TS),
  );
  assert.equal(eventsOf(file)[0].resetsAt, null);
});

test('a non-limit error carries no resetsAt', () => {
  const file = withPrelude(
    limitsRec('2026-01-01T00:00:05.000Z', { limit_id: 'codex', primary: win(100, R), secondary: null }),
    errorRec(ERR_TS, JSON.stringify({ status: 401, error: { type: 'authentication_error', message: 'nope' } })),
  );
  const [event] = eventsOf(file);
  assert.equal(event.error, 'authentication_failed');
  assert.equal('resetsAt' in event, false);
});
