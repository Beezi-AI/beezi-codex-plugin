import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { queueDir, stateDir } from '../lib/paths.mjs';
import { writeAgent, readAgents, agentDir } from '../lib/subagent-state.mjs';
import { computeDelta as realComputeDelta } from '../lib/delta-codex.mjs';

// The subagent half of the checkpoint: which rollouts get billed, under what segment ids, with which
// identity fields, and how their wall clock is reconciled with the parent's.

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-sac-'));
  const prev = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const queued = () => fs.readdirSync(queueDir()).map((f) =>
  JSON.parse(fs.readFileSync(path.join(queueDir(), f), 'utf-8')));

const T0 = Date.parse('2026-08-06T19:41:50.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();

// A minimal but real forked subagent rollout: own meta, parent's replayed meta, a burst, a cliff.
function subagentRollout(home, agentId, { nickname = 'Darwin', depth = 1, startMs = 0 } = {}) {
  const file = path.join(home, `agent-${agentId}.jsonl`);
  const recs = [
    { timestamp: at(startMs), type: 'session_meta', payload: {
      id: agentId, session_id: 'parent-1', parent_thread_id: 'parent-1',
      thread_source: 'subagent', agent_nickname: nickname, cwd: home,
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1', depth } } } } },
    { timestamp: at(startMs + 3), type: 'session_meta', payload: { id: 'parent-1', session_id: 'parent-1', thread_source: 'user', source: 'cli', cwd: home } },
    { timestamp: at(startMs + 20), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 100 } } } },
    // 4s cliff → the agent's own work starts here.
    { timestamp: at(startMs + 4000), type: 'turn_context', payload: { cwd: home, model: 'gpt-5.4-mini' } },
    { timestamp: at(startMs + 10000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 6000, cached_input_tokens: 0, output_tokens: 150 } } } },
  ];
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

function stubTranscript(home) {
  const p = path.join(home, 'rollout.jsonl');
  fs.writeFileSync(p, JSON.stringify({ timestamp: at(0), type: 'session_meta', payload: { id: 'parent-1', session_id: 'parent-1', thread_source: 'user', cwd: home } }) + '\n');
  return p;
}

const seg = (over = {}) => ({
  repoRoot: '/repo', branch: 'main', fromLine: 1, toLine: 4,
  stats: {
    models: { 'gpt-5.4-mini': { token_input: 10, token_output: 5, token_cache_read: 0, token_cache_creation: 0, requests: 1 } },
    token_total: 15, token_input: 10, token_output: 5, token_cache: 0,
    duration_sec: 12,
    code_changes: { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} },
    operations: {},
    started_at: at(0), ended_at: at(12000),
  },
  ...over,
});

// The parent's delta is stubbed (its parsing has its own suite), but a subagent rollout runs through
// the REAL computeDelta — the fork boundary only means anything if the numbers it produces are real.
const parentDelta = (segments = [seg()]) => (p, from, resolvers) =>
  (p.includes('agent-')
    ? realComputeDelta(p, from, resolvers)
    : { nextCursor: 4, segments, apiErrorEvents: [] });

const deps = (home, over = {}) => ({
  getAccessToken: async () => 'tok',
  fetchImpl: async () => { throw new Error('offline'); }, // keep payloads on disk
  resolveTranscript: () => ({ transcriptPath: stubTranscript(home), sessionId: 'parent-1' }),
  computeDelta: parentDelta(),
  gitImpl: () => 'https://host/org/repo.git',
  resolveSessionName: () => 'a session',
  ...over,
});

test('a recorded subagent is billed to its parent session', async (t) => {
  const home = tmpHome(t);
  writeAgent('parent-1', 'agent-a', {
    agent_type: 'explore_codebase',
    started_at: at(0),
    transcriptPath: subagentRollout(home, 'agent-a'),
  });

  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home));

  const sub = queued().find((p) => p.is_subagent);
  assert.ok(sub, 'a subagent segment was enqueued');
  assert.equal(sub.sessionId, 'parent-1', 'billed to the PARENT session, not its own thread');
  assert.equal(sub.agent_id, 'agent-a');
  assert.equal(sub.agent_type, 'explore_codebase', 'only the hook payload carries this');
  assert.equal(sub.agent_name, 'Darwin', 'the nickname comes off the rollout');
  assert.equal(sub.spawn_depth, 1);
  assert.match(sub.segmentId, /^parent-1:agent-a:/, 'the segment id is scoped by agent');
});

test('the replayed fork prefix is not billed to the agent', async (t) => {
  const home = tmpHome(t);
  writeAgent('parent-1', 'agent-a', { started_at: at(0), transcriptPath: subagentRollout(home, 'agent-a') });
  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home));

  const sub = queued().find((p) => p.is_subagent);
  // The prefix carries a replayed cumulative total of 5000/0/100. Billing from line 0 would charge
  // all of it to the agent; from the boundary only the 1000-input / 50-output delta is its own.
  assert.equal(sub.token_input, 1000);
  assert.equal(sub.token_output, 50);
});

test('two agents with identical line windows get distinct segment ids', async (t) => {
  const home = tmpHome(t);
  // The server's idempotency key is `segmentId::model` and does NOT include agent_id. Both agents
  // start at their own fork boundary, so their line windows coincide — without the agent scope the
  // second silently overwrites the first.
  writeAgent('parent-1', 'agent-a', { started_at: at(0), transcriptPath: subagentRollout(home, 'agent-a', { nickname: 'Turing' }) });
  writeAgent('parent-1', 'agent-b', { started_at: at(1), transcriptPath: subagentRollout(home, 'agent-b', { nickname: 'Euler' }) });

  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home));

  const subs = queued().filter((p) => p.is_subagent);
  assert.equal(subs.length, 2);
  const ids = new Set(subs.map((p) => p.segmentId));
  assert.equal(ids.size, 2, 'distinct segment ids');
  assert.equal(new Set(subs.map((p) => p.from_line + '-' + p.to_line)).size, 1, 'their line windows really do coincide');
});

test('a subagent payload carries no key the server would reject', async (t) => {
  const home = tmpHome(t);
  writeAgent('parent-1', 'agent-a', { started_at: at(0), transcriptPath: subagentRollout(home, 'agent-a') });
  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home));

  // The server runs forbidNonWhitelisted, and flushQueue treats the resulting 400 as permanent and
  // DELETES the file. An extra key here destroys data rather than retrying it — `activeIntervals`
  // rides alongside seg.stats precisely so it cannot leak in.
  const allowed = new Set([
    'segmentId', 'sessionId', 'remote', 'branch', 'from_line', 'to_line',
    'billing_source', 'subscription_type', 'rate_limit_tier', 'subscription_plan', 'third_party_provider',
    'session_name', 'timezone',
    'is_subagent', 'agent_id', 'agent_type', 'agent_name', 'spawn_depth',
    'models', 'token_total', 'token_input', 'token_output', 'token_cache',
    'duration_sec', 'code_changes', 'operations', 'started_at', 'ended_at',
  ]);
  for (const payload of queued()) {
    for (const key of Object.keys(payload)) {
      assert.ok(allowed.has(key), `unexpected payload key: ${key}`);
    }
  }
});

test('an agent whose fork prefix cannot be delimited is skipped, not billed from zero', async (t) => {
  const home = tmpHome(t);
  // Two session_meta records (so it IS a fork) and a replay burst that never ends. Billing this from
  // line 0 would charge the parent's whole replayed history to the agent.
  const file = path.join(home, 'agent-runaway.jsonl');
  const recs = [
    { timestamp: at(0), type: 'session_meta', payload: { id: 'agent-r', session_id: 'parent-1', parent_thread_id: 'parent-1', thread_source: 'subagent', cwd: home } },
    { timestamp: at(1), type: 'session_meta', payload: { id: 'parent-1', session_id: 'parent-1', thread_source: 'user', cwd: home } },
  ];
  for (let i = 0; i < 90; i++) {
    recs.push({ timestamp: at(2 + i), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10000 * (i + 1), cached_input_tokens: 0, output_tokens: i } } } });
  }
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeAgent('parent-1', 'agent-r', { started_at: at(0), transcriptPath: file });

  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home));

  assert.equal(queued().filter((p) => p.is_subagent).length, 0, 'nothing billed for it');
  assert.ok(queued().some((p) => !p.is_subagent), 'the parent still reports normally');
});

test('a second checkpoint does not re-bill an agent already counted', async (t) => {
  const home = tmpHome(t);
  const file = subagentRollout(home, 'agent-a');
  writeAgent('parent-1', 'agent-a', { started_at: at(0), transcriptPath: file });

  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home));
  const first = queued().filter((p) => p.is_subagent).length;
  assert.equal(first, 1);
  assert.ok(Number.isInteger(readAgents('parent-1')['agent-a'].cursor), 'the cursor was persisted');

  fs.rmSync(queueDir(), { recursive: true, force: true });
  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home, {
    computeDelta: () => ({ nextCursor: 4, segments: [], apiErrorEvents: [] }),
  }));
  const again = fs.existsSync(queueDir()) ? queued().filter((p) => p.is_subagent).length : 0;
  assert.equal(again, 0, 'no new subagent work the second time round');
});

test('an agent with no recorded transcript is ignored, not guessed at', async (t) => {
  const home = tmpHome(t);
  writeAgent('parent-1', 'agent-a', { started_at: at(0) }); // SubagentStart fired, Stop never did
  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home));
  assert.equal(queued().filter((p) => p.is_subagent).length, 0);
});

test('wall clock is unioned with the parent, not summed', async (t) => {
  const home = tmpHome(t);
  writeAgent('parent-1', 'agent-a', { started_at: at(0), transcriptPath: subagentRollout(home, 'agent-a') });

  // The parent's segment overlaps the agent's window exactly — which is what really happens, since
  // the parent sits blocked in wait_agent for the whole fan-out.
  const overlapping = seg({ activeIntervals: [[T0 + 4000, T0 + 10000]] });
  overlapping.stats.duration_sec = 6;

  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home, {
    computeDelta: parentDelta([overlapping]),
  }));

  const sub = queued().find((p) => p.is_subagent);
  const main = queued().find((p) => !p.is_subagent);
  assert.equal(sub.duration_sec, 6, 'the agent claims the seconds it was working');
  assert.equal(main.duration_sec, 0, 'the parent bills only the residual, having been blocked');
});

test('the sweep finds an agent no hook ever recorded', async (t) => {
  const home = tmpHome(t);
  // The untrusted-hooks and `track` case: no sidecar exists, so the rollout tree is the only source.
  const sessions = path.join(home, 'sessions', '2026', '08', '06');
  fs.mkdirSync(sessions, { recursive: true });
  const rollout = subagentRollout(home, 'agent-swept');
  const moved = path.join(sessions, 'rollout-2026-08-06T19-41-50-agent-swept.jsonl');
  fs.renameSync(rollout, moved);

  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home, {
    findSubagentRollouts: () => [{ agentId: 'agent-swept', path: moved }],
  }), { emitTimeline: true });

  const sub = queued().find((p) => p.is_subagent);
  assert.ok(sub, 'billed with no sidecar at all');
  assert.equal(sub.agent_id, 'agent-swept');
  assert.equal(sub.agent_type, null, 'agent_type is hook-only, so it is honestly null here');
  assert.equal(sub.agent_name, 'Darwin', 'the nickname is still recoverable from the rollout');
});

test('the sweep only runs at turn ends, not on every tool call', async (t) => {
  const home = tmpHome(t);
  let swept = 0;
  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home, {
    findSubagentRollouts: () => { swept += 1; return []; },
  }));
  assert.equal(swept, 0, 'PostToolUse must not walk the rollout tree');

  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home, {
    findSubagentRollouts: () => { swept += 1; return []; },
  }), { emitTimeline: true });
  assert.equal(swept, 1);
});

test('agent sidecars are isolated — a fan-out cannot lose one', async (t) => {
  tmpHome(t);
  // Every SubagentStart fires its own process within milliseconds of its siblings. One file each is
  // what makes that safe; a shared map would keep only the last writer's record.
  for (const id of ['a', 'b', 'c', 'd']) writeAgent('parent-1', `agent-${id}`, { started_at: at(0), agent_type: `t-${id}` });
  const agents = readAgents('parent-1');
  assert.deepEqual(Object.keys(agents).sort(), ['agent-a', 'agent-b', 'agent-c', 'agent-d']);
  assert.equal(agents['agent-c'].agent_type, 't-c');
});

test('an agent id from a hook payload cannot escape the state directory', async (t) => {
  const home = tmpHome(t);
  // agent_id and session_id arrive on a hook payload and are used as path components.
  for (const evil of ['../../../evil', '..\\..\\evil', 'a/b', '..']) {
    writeAgent('parent-1', evil, { started_at: at(0) });
  }
  const dir = agentDir('parent-1');
  for (const file of fs.readdirSync(dir)) {
    const resolved = path.resolve(dir, file);
    assert.equal(path.dirname(resolved), path.resolve(dir), `${file} stayed inside the agent dir`);
  }
  assert.ok(fs.existsSync(path.join(stateDir(), 'parent-1.agents')));
  assert.ok(!fs.existsSync(path.join(home, 'evil.json')));
  assert.ok(!fs.existsSync(path.join(stateDir(), 'evil.json')));
});

test('an agent id from a hook payload cannot escape the queue directory either', async (t) => {
  const home = tmpHome(t);
  // agent_id reaches the queue filename through segmentId, which is a second path built from
  // untrusted input — the state directory is not the only place it lands.
  const evil = '../../../../evil';
  writeAgent('parent-1', evil, { started_at: at(0), transcriptPath: subagentRollout(home, 'agent-a') });
  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home));

  for (const file of fs.readdirSync(queueDir())) {
    const resolved = path.resolve(queueDir(), file);
    assert.equal(path.dirname(resolved), path.resolve(queueDir()), `${file} stayed in the queue dir`);
  }
  assert.ok(!fs.existsSync(path.join(home, 'evil.json')));
});
