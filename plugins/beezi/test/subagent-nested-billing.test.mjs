import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { queueDir } from '../lib/paths.mjs';
import { findSubagentRollouts } from '../lib/subagent-codex.mjs';
import { computeDelta as realComputeDelta } from '../lib/delta-codex.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// One linked account, injected: from 0.13 on runCheckpoint resolves every account that can produce
// a token and fans the one delta out into each of their queues.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');


// G-7-1, end to end: a subagent spawned by ANOTHER SUBAGENT reaches the queue.
//
// The unit coverage in subagent-codex.test.mjs proves the discovery filter returns the grandchild;
// this proves the whole path — real sweep, real fork-boundary, real delta — actually bills it, with
// the tokens attributed to the root session and `spawn_depth: 2` on the wire.
//
// Measured on session 01a07b74 before the fix: Erdos (depth 1) and Ohm (depth 1) were billed,
// Anscombe (depth 2, spawned by Erdos) was not — 643,486 of 3,518,791 subagent tokens, 18.3%,
// silently dropped, because its parent_thread_id is Erdos's thread id and never the session's.
//
// The sessions tree here is written under a per-test temp home and passed to the sweep explicitly,
// so the real ~/.codex/sessions is never read.

const tmpHome = (t) => sandboxHome(t, 'beezi-nest-');

const queued = () => fs.readdirSync(queueDir(KEY)).map((f) =>
  JSON.parse(fs.readFileSync(path.join(queueDir(KEY), f), 'utf-8')));

const T0 = Date.parse('2026-08-06T19:41:50.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();

// A real forked subagent rollout: own meta, the parent's replayed meta, a burst, a cliff, then
// 1,000 input / 50 output tokens of its own. `parentThreadId` is the SPAWNER (another agent at
// depth 2); `rootSessionId` is the session that owns the whole tree.
function subagentRollout(dir, fileName, { id, nickname, depth, parentThreadId, rootSessionId }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  const recs = [
    { timestamp: at(0), type: 'session_meta', payload: {
      id, session_id: rootSessionId, parent_thread_id: parentThreadId, forked_from_id: parentThreadId,
      thread_source: 'subagent', agent_nickname: nickname, cwd: dir,
      source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId, depth } } } } },
    { timestamp: at(3), type: 'session_meta', payload: { id: 'parent-1', session_id: 'parent-1', thread_source: 'user', source: 'cli', cwd: dir } },
    { timestamp: at(20), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 100 } } } },
    { timestamp: at(4000), type: 'turn_context', payload: { cwd: dir, model: 'gpt-5.4-mini' } },
    { timestamp: at(10000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 6000, cached_input_tokens: 0, output_tokens: 150 } } } },
  ];
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

function stubTranscript(home) {
  const p = path.join(home, 'rollout.jsonl');
  fs.writeFileSync(p, JSON.stringify({ timestamp: at(0), type: 'session_meta', payload: { id: 'parent-1', session_id: 'parent-1', thread_source: 'user', cwd: home } }) + '\n');
  return p;
}

const parentSeg = () => ({
  repoRoot: '/repo', branch: 'main', fromLine: 1, toLine: 4,
  stats: {
    models: { 'gpt-5.4-mini': { token_input: 10, token_output: 5, token_cache_read: 0, token_cache_creation: 0, requests: 1 } },
    token_total: 15, token_input: 10, token_output: 5, token_cache: 0, duration_sec: 12,
    code_changes: { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} },
    operations: {}, started_at: at(0), ended_at: at(12000),
  },
});

// The parent's delta is stubbed; every agent rollout runs through the REAL computeDelta, because the
// point of the fix is the numbers the grandchild produces, not merely that it was listed.
const deps = (home, over = {}) => ({
  linkedSessions: async () => [SESSION],
  fetchImpl: async () => { throw new Error('offline'); }, // keep the payloads on disk
  resolveTranscript: () => ({ transcriptPath: stubTranscript(home), sessionId: 'parent-1' }),
  computeDelta: (p, from, resolvers) => (p.indexOf('rollout-2026') === -1
    ? { nextCursor: 4, segments: [parentSeg()], apiErrorEvents: [] }
    : realComputeDelta(p, from, resolvers)),
  gitImpl: () => 'https://host/org/repo.git',
  resolveSessionName: () => 'a session',
  ...over,
});

test('a subagent spawned by another subagent is billed to the root session', async (t) => {
  const home = tmpHome(t);
  const sessions = path.join(home, 'sessions', '2026', '08', '06');
  subagentRollout(sessions, 'rollout-2026-08-06T19-41-50-erdos.jsonl', {
    id: 'agent-erdos', nickname: 'Erdos', depth: 1, parentThreadId: 'parent-1', rootSessionId: 'parent-1',
  });
  subagentRollout(sessions, 'rollout-2026-08-06T19-41-50-anscombe.jsonl', {
    // The depth-2 agent: its parent is ANOTHER AGENT, so the parent-only filter never matched it.
    id: 'agent-anscombe', nickname: 'Anscombe', depth: 2, parentThreadId: 'agent-erdos', rootSessionId: 'parent-1',
  });

  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home, {
    findSubagentRollouts: (sid, opts) => findSubagentRollouts(sid, { ...opts, sessionsDir: sessions, sinceMs: null }),
  }), { emitTimeline: true });

  const subs = queued().filter((p) => p.is_subagent);
  assert.equal(subs.length, 2, 'the grandchild is billed, not dropped with its parent');

  const deep = subs.find((p) => p.agent_id === 'agent-anscombe');
  assert.ok(deep, 'the depth-2 agent reached the queue');
  assert.equal(deep.sessionId, 'parent-1', 'billed to the ROOT session — the only session that can bill it');
  assert.equal(deep.spawn_depth, 2, 'and it reports its real depth, with no wire change');
  assert.equal(deep.agent_name, 'Anscombe');
  assert.equal(deep.token_input, 1000, 'the replayed fork prefix is still excluded at depth 2');
  assert.equal(deep.token_output, 50);

  const ids = new Set(subs.map((p) => p.segmentId));
  assert.equal(ids.size, 2, 'parent and grandchild get distinct segment ids, so neither overwrites the other');
});

test('a nested agent of another session is not billed here', async (t) => {
  const home = tmpHome(t);
  const sessions = path.join(home, 'sessions', '2026', '08', '06');
  subagentRollout(sessions, 'rollout-2026-08-06T19-41-50-stranger.jsonl', {
    // Same shape, different tree: neither link names this session.
    id: 'agent-stranger', nickname: 'Gauss', depth: 2, parentThreadId: 'agent-other', rootSessionId: 'other-session',
  });

  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home, {
    findSubagentRollouts: (sid, opts) => findSubagentRollouts(sid, { ...opts, sessionsDir: sessions, sinceMs: null }),
  }), { emitTimeline: true });

  assert.equal(queued().filter((p) => p.is_subagent).length, 0, 'widening the filter must not steal another session\'s tokens');
  assert.ok(queued().some((p) => !p.is_subagent), 'the parent still reports normally');
});
