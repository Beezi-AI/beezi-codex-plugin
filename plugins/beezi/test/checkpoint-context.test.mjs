import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { queueDir } from '../lib/paths.mjs';
import { writeAgent } from '../lib/subagent-state.mjs';
import { computeDelta as realComputeDelta } from '../lib/delta-codex.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// One linked account, injected: from 0.13 on runCheckpoint resolves every account that can produce
// a token and fans the one delta out into each of their queues.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');


// G-4-4, the checkpoint half: context_peak_tokens / context_final_tokens / context_final_model ride
// the main-agent segment and are STRIPPED from a subagent's.
//
// A subagent runs its own context window, so the parent's occupancy is not its own. The server
// already nulls these three on a non-main segment (session-report.service.ts:334-336), which makes
// the strip hygiene rather than correctness — but the payload must never state something the server
// will discard, and the same rule is what keeps the Codex and Claude payloads comparable
// (beezi-claude-plugins/plugins/beezi/lib/checkpoint.mjs:358).
//
// This lives in its own file rather than in test/checkpoint.test.mjs because the fixtures here are
// the only ones in the suite that carry `last_token_usage`, and the payload-key allowlist in
// test/subagent-checkpoint.test.mjs deliberately predates these keys.

const tmpHome = (t) => sandboxHome(t, 'beezi-cpctx-');

const queued = () => fs.readdirSync(queueDir(KEY)).map((f) =>
  JSON.parse(fs.readFileSync(path.join(queueDir(KEY), f), 'utf-8')));

const T0 = Date.parse('2026-08-06T19:41:50.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();

// token_count with both the cumulative totals and the single-request occupancy reading.
const tokenCount = (ts, input, output, ctxInput) => ({
  timestamp: ts,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, total_tokens: input + output },
      last_token_usage: { input_tokens: ctxInput, cached_input_tokens: 0, output_tokens: 0, total_tokens: ctxInput },
      model_context_window: 258400,
    },
  },
});

// A forked subagent rollout — own meta, the parent's replayed meta, a burst, a cliff — whose token
// events carry occupancy readings. Same shape as test/subagent-checkpoint.test.mjs's fixture.
function subagentRollout(home, agentId) {
  const file = path.join(home, `agent-${agentId}.jsonl`);
  const recs = [
    { timestamp: at(0), type: 'session_meta', payload: {
      id: agentId, session_id: 'parent-1', parent_thread_id: 'parent-1',
      thread_source: 'subagent', agent_nickname: 'Darwin', cwd: home,
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1', depth: 1 } } } } },
    { timestamp: at(3), type: 'session_meta', payload: { id: 'parent-1', session_id: 'parent-1', thread_source: 'user', source: 'cli', cwd: home } },
    tokenCount(at(20), 5000, 100, 5000),
    // 4s cliff → the agent's own work starts here.
    { timestamp: at(4000), type: 'turn_context', payload: { cwd: home, model: 'gpt-5.4-mini', effort: 'high' } },
    tokenCount(at(10000), 6000, 150, 61234),
  ];
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

function stubTranscript(home) {
  const p = path.join(home, 'rollout.jsonl');
  fs.writeFileSync(p, JSON.stringify({ timestamp: at(0), type: 'session_meta', payload: { id: 'parent-1', session_id: 'parent-1', thread_source: 'user', cwd: home } }) + '\n');
  return p;
}

// A parent segment whose stats already carry the three context keys, as computeDelta now produces.
const mainSeg = (over = {}) => ({
  repoRoot: '/repo', branch: 'main', fromLine: 1, toLine: 4,
  stats: {
    models: {
      'gpt-5.2-codex': {
        token_input: 10, token_output: 5, token_cache_read: 0, token_cache_creation: 0, requests: 1,
        by_effort: { high: { token_input: 10, token_output: 5, token_cache_read: 0, token_cache_creation: 0, requests: 1 } },
      },
    },
    token_total: 15, token_input: 10, token_output: 5, token_cache: 0,
    duration_sec: 12,
    code_changes: { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} },
    operations: {},
    started_at: at(0), ended_at: at(12000),
    context_peak_tokens: 90000,
    context_final_tokens: 42000,
    context_final_model: 'gpt-5.2-codex',
  },
  ...over,
});

// The parent's delta is stubbed; a subagent rollout runs through the REAL computeDelta, so the
// context keys it strips are ones the parser genuinely produced.
const parentDelta = (segments) => (p, from, resolvers) =>
  (p.includes('agent-')
    ? realComputeDelta(p, from, resolvers)
    : { nextCursor: 4, segments, apiErrorEvents: [] });

const deps = (home, segments, over = {}) => ({
  linkedSessions: async () => [SESSION],
  fetchImpl: async () => { throw new Error('offline'); }, // keep payloads on disk
  resolveTranscript: () => ({ transcriptPath: stubTranscript(home), sessionId: 'parent-1' }),
  computeDelta: parentDelta(segments),
  gitImpl: () => 'https://host/org/repo.git',
  resolveSessionName: () => 'a session',
  ...over,
});

test('a main-agent segment carries all three context keys onto the wire', async (t) => {
  const home = tmpHome(t);
  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home, [mainSeg()]));

  const rows = queued();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].is_subagent, undefined, 'this is the main-agent segment');
  assert.equal(rows[0].context_peak_tokens, 90000);
  assert.equal(rows[0].context_final_tokens, 42000);
  assert.equal(rows[0].context_final_model, 'gpt-5.2-codex');
  // And the effort partition rides inside `models`, where the DTO declares it — never as a
  // top-level key, which would 400 the whole payload and delete the queued segment.
  assert.deepEqual(Object.keys(rows[0].models['gpt-5.2-codex'].by_effort), ['high']);
  assert.equal(rows[0].by_effort, undefined, 'by_effort is never hoisted to the top level');
  assert.equal(rows[0].effort, undefined);
});

test('a subagent segment carries none of the three, even though its parser produced them', async (t) => {
  const home = tmpHome(t);
  writeAgent('parent-1', 'agent-a', {
    agent_type: 'explore_codebase',
    started_at: at(0),
    transcriptPath: subagentRollout(home, 'agent-a'),
  });
  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home, [mainSeg()]));

  const sub = queued().find((p) => p.is_subagent);
  assert.ok(sub, 'the subagent was billed');
  assert.ok(!('context_peak_tokens' in sub), 'stripped, not nulled');
  assert.ok(!('context_final_tokens' in sub));
  assert.ok(!('context_final_model' in sub));
  // The strip must take nothing else with it — the subagent still bills its own tokens and clock.
  assert.ok(sub.token_total > 0);
  assert.ok(sub.models && Object.keys(sub.models).length > 0);
  assert.equal(sub.agent_id, 'agent-a');

  // The parent, enqueued through the same helper in the same run, keeps its own.
  const main = queued().find((p) => !p.is_subagent);
  assert.equal(main.context_final_tokens, 42000);
});

test('the strip is keyed on is_subagent, not on the absence of the keys', async (t) => {
  // A subagent whose parser DID produce occupancy is the only case that proves the strip runs; a
  // fixture without last_token_usage would pass vacuously. Assert the parser's own output first.
  const home = tmpHome(t);
  const rollout = subagentRollout(home, 'agent-b');
  const { segments } = realComputeDelta(rollout, 0, { repoRootOf: (d) => d, branchAt: () => 'main' });
  const withContext = segments.filter((s) => 'context_final_tokens' in s.stats);
  assert.ok(withContext.length > 0, 'the fixture really does produce context keys before the strip');
  assert.equal(withContext[withContext.length - 1].stats.context_final_tokens, 61234);
});
