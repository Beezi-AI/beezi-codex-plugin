import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { queueDir, stateDir } from '../lib/paths.mjs';
import { writeAgent, readAgents, agentDir } from '../lib/subagent-state.mjs';
import { computeDelta as realComputeDelta } from '../lib/delta-codex.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// One linked account, injected: from 0.13 on runCheckpoint resolves every account that can produce
// a token and fans the one delta out into each of their queues.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');


// The subagent half of the checkpoint: which rollouts get billed, under what segment ids, with which
// identity fields, and how their wall clock is reconciled with the parent's.

const tmpHome = (t) => sandboxHome(t, 'beezi-sac-');

const queued = () => fs.readdirSync(queueDir(KEY)).map((f) =>
  JSON.parse(fs.readFileSync(path.join(queueDir(KEY), f), 'utf-8')));

const T0 = Date.parse('2026-08-06T19:41:50.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();

// A minimal but real forked subagent rollout: own meta, parent's replayed meta, a burst, a cliff.
//
// `parentThreadId` is the SPAWNER — another agent once the depth is 2 — while `rootSessionId` is the
// session that owns the whole spawn tree and therefore bills it; they coincide only at depth 1.
// `name` overrides the filename so two rollouts can claim one thread id (the fail-closed case). It
// must still contain `agent-`, which is how the parentDelta seam below routes a file to the REAL
// computeDelta rather than to the parent's stub.
function subagentRollout(home, agentId, {
  nickname = 'Darwin',
  depth = 1,
  startMs = 0,
  parentThreadId = 'parent-1',
  rootSessionId = 'parent-1',
  name = null,
} = {}) {
  const file = path.join(home, name || `agent-${agentId}.jsonl`);
  const recs = [
    { timestamp: at(startMs), type: 'session_meta', payload: {
      id: agentId, session_id: rootSessionId, parent_thread_id: parentThreadId,
      thread_source: 'subagent', agent_nickname: nickname, cwd: home,
      source: { subagent: { thread_spawn: { parent_thread_id: parentThreadId, depth } } } } },
    { timestamp: at(startMs + 3), type: 'session_meta', payload: { id: parentThreadId, session_id: rootSessionId, thread_source: 'user', source: 'cli', cwd: home } },
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
  linkedSessions: async () => [SESSION],
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

test('parent and subagent segments use their own repo instruction observations', async (t) => {
  const home = tmpHome(t);
  const parentRoot = path.join(home, 'parent-repo');
  const childRoot = path.join(home, 'child-repo');
  fs.mkdirSync(parentRoot);
  fs.mkdirSync(childRoot);
  fs.mkdirSync(path.join(parentRoot, '.git'));
  fs.mkdirSync(path.join(childRoot, '.git'));
  fs.writeFileSync(path.join(parentRoot, 'AGENTS.md'), 'parent\nrules\n');
  fs.writeFileSync(path.join(childRoot, 'AGENTS.override.md'), 'child\n');
  const childPath = subagentRollout(home, 'agent-a');
  writeAgent('parent-1', 'agent-a', { started_at: at(0), transcriptPath: childPath });

  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home, {
    computeDelta: (p) => ({
      nextCursor: 5,
      segments: [seg({
        repoRoot: p === childPath ? childRoot : parentRoot,
        fromLine: p === childPath ? 4 : 1,
        toLine: 5,
      })],
      apiErrorEvents: [],
    }),
  }));

  const child = queued().find((p) => p.is_subagent);
  const parent = queued().find((p) => !p.is_subagent);
  assert.equal(child.project_instructions_status, 'present');
  assert.equal(child.claude_md_lines, 1);
  assert.equal(parent.project_instructions_status, 'present');
  assert.equal(parent.claude_md_lines, 2);
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
    'session_name', 'timezone', 'claude_md_lines', 'project_instructions_status',
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

  fs.rmSync(queueDir(KEY), { recursive: true, force: true });
  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home, {
    computeDelta: () => ({ nextCursor: 4, segments: [], apiErrorEvents: [] }),
  }));
  const again = fs.existsSync(queueDir(KEY)) ? queued().filter((p) => p.is_subagent).length : 0;
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

// ─── canonical agent identity (G-7-2) ───────────────────────────────────────
//
// The agent dictionary is keyed from two independent sources: the sweep keys by the rollout's own
// thread id, a hook sidecar by the hook's `agent_id`. Codex documents `agent_id` only as "Identifier
// for the subagent" — not the thread id — so the two can disagree about ONE file. Two keys mean two
// cursors and two non-colliding segment ids, and the server upserts on `segmentId::model`, so it
// cannot collapse them: the same tokens are billed twice, per agent, on every fan-out.

test('a rollout reached by both a sidecar and the sweep is billed once', async (t) => {
  const home = tmpHome(t);
  // The ordinary case: the hook's agent_id and the rollout's own id are the same string, so the
  // sidecar entry and the swept entry are one entry. Nothing asserted this before.
  const file = subagentRollout(home, 'agent-a'); // payload.id === 'agent-a'
  writeAgent('parent-1', 'agent-a', { agent_type: 'explore', started_at: at(0), transcriptPath: file });

  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home, {
    findSubagentRollouts: () => [{ agentId: 'agent-a', path: file }],
  }), { emitTimeline: true });

  const subs = queued().filter((p) => p.is_subagent);
  assert.equal(subs.length, 1, 'one rollout, one segment');
  assert.equal(subs[0].agent_id, 'agent-a');
  assert.equal(subs[0].agent_type, 'explore', 'the hook-only field survives');
});

test('a divergent hook agent_id does not bill the same rollout twice', async (t) => {
  const home = tmpHome(t);
  // If a build ever sends an agent_path, a spawn counter or a tool-call id, the sidecar key and the
  // swept key name the SAME file. `/root/api_domain` is a real observed Codex agent_path.
  const file = subagentRollout(home, 'thread-x'); // the rollout says it is 'thread-x'
  writeAgent('parent-1', '/root/api_domain', { agent_type: 'explore', started_at: at(0), transcriptPath: file });

  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home, {
    findSubagentRollouts: () => [{ agentId: 'thread-x', path: file }],
  }), { emitTimeline: true });

  const subs = queued().filter((p) => p.is_subagent);
  assert.equal(subs.length, 1, 'billed once, not once per key');
  assert.equal(subs[0].agent_id, 'thread-x', 'the rollout own id is canonical, not the hook string');
  assert.equal(subs[0].agent_type, 'explore', 'the hook-only field is folded in, not dropped');
  assert.equal(new Set(subs.map((p) => p.segmentId)).size, 1);
});

test('two different files claiming one thread id are billed once, not merged', async (t) => {
  const home = tmpHome(t);
  // No correct answer is available here, so this fails closed exactly as forkPrefixBoundary does:
  // bill the first, drop the second. Billing both would double-count under one id; picking by guess
  // could bill the wrong file. This branch is what stops the guard merging two genuinely different
  // agents into one — the mirror of the bug it exists to fix.
  const first = subagentRollout(home, 'thread-x', { nickname: 'Turing', name: 'agent-first.jsonl' });
  const second = subagentRollout(home, 'thread-x', { nickname: 'Euler', name: 'agent-second.jsonl' });
  writeAgent('parent-1', 'key-a', { started_at: at(0), transcriptPath: first });
  writeAgent('parent-1', 'key-b', { started_at: at(1), transcriptPath: second });

  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home));

  const subs = queued().filter((p) => p.is_subagent);
  assert.equal(subs.length, 1, 'one thread id, one segment');
  assert.equal(subs[0].agent_id, 'thread-x');
  assert.equal(subs[0].agent_name, 'Turing', 'the first file in billing order wins');
});

test('a rollout that states no id of its own still bills under the dictionary key', async (t) => {
  const home = tmpHome(t);
  // With no own id there is no second key to collide with, so canonicalizing must not turn an
  // unknown id into a DROPPED agent. The key stays untrusted hook input on this path — it still
  // reaches a segmentId and therefore a queue filename — so the escape guard is asserted here too:
  // it is the only route left by which a hook string can reach a path component.
  const file = path.join(home, 'agent-anon.jsonl');
  const recs = [
    { timestamp: at(0), type: 'session_meta', payload: {
      session_id: 'parent-1', parent_thread_id: 'parent-1', thread_source: 'subagent',
      agent_nickname: 'Noether', cwd: home } },
    { timestamp: at(3), type: 'session_meta', payload: { id: 'parent-1', session_id: 'parent-1', thread_source: 'user', cwd: home } },
    { timestamp: at(20), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 0, output_tokens: 100 } } } },
    { timestamp: at(4000), type: 'turn_context', payload: { cwd: home, model: 'gpt-5.4-mini' } },
    { timestamp: at(10000), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 6000, cached_input_tokens: 0, output_tokens: 150 } } } },
  ];
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const evil = '../../../../evil';
  writeAgent('parent-1', evil, { started_at: at(0), transcriptPath: file });

  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home));

  const sub = queued().find((p) => p.is_subagent);
  assert.ok(sub, 'the agent is still billed, not dropped for lacking an id');
  assert.equal(sub.agent_id, evil, 'it falls back to the dictionary key');
  for (const file2 of fs.readdirSync(queueDir(KEY))) {
    const resolved = path.resolve(queueDir(KEY), file2);
    assert.equal(path.dirname(resolved), path.resolve(queueDir(KEY)), `${file2} stayed in the queue dir`);
  }
  assert.ok(!fs.existsSync(path.join(home, 'evil.json')));
});

test('a depth-2 agent bills to the root session, not to the agent that spawned it', async (t) => {
  const home = tmpHome(t);
  // A grandchild's parent_thread_id is ANOTHER AGENT's thread id; only session_id names the session
  // that owns the tree. The sidecar route is exercised here — subagent-nested-billing covers the
  // sweep's discovery filter — because both must agree on where the tokens land.
  const file = subagentRollout(home, 'agent-deep', {
    nickname: 'Anscombe', depth: 2, parentThreadId: 'agent-mid', rootSessionId: 'parent-1',
  });
  writeAgent('parent-1', 'agent-deep', { started_at: at(0), transcriptPath: file });

  await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home));

  const sub = queued().find((p) => p.is_subagent);
  assert.ok(sub, 'a grandchild is billed like any other agent');
  assert.equal(sub.sessionId, 'parent-1', 'billed to the ROOT session, not to its spawner');
  assert.equal(sub.spawn_depth, 2);
  assert.equal(sub.agent_name, 'Anscombe');
  assert.equal(sub.token_input, 1000, 'and the replayed prefix is still excluded at depth 2');
  assert.match(sub.segmentId, /^parent-1:agent-deep:/);
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

  // Canonicalization now replaces this key with the id the rollout states about itself, so the evil
  // string never reaches a segment id on THIS path. Pinned so the two tests cannot silently
  // contradict each other; the residual untrusted-key path is covered by the no-own-id case above.
  assert.equal(queued().find((p) => p.is_subagent).agent_id, 'agent-a');

  for (const file of fs.readdirSync(queueDir(KEY))) {
    const resolved = path.resolve(queueDir(KEY), file);
    assert.equal(path.dirname(resolved), path.resolve(queueDir(KEY)), `${file} stayed in the queue dir`);
  }
  assert.ok(!fs.existsSync(path.join(home, 'evil.json')));
});


test('a child cursor write failure resumes the immutable parent and child transaction', async t => {
  const home = tmpHome(t);
  writeAgent('parent-1', 'agent-a', { transcriptPath: subagentRollout(home, 'agent-a') });
  const sent = [];
  const first = await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home, {
    writeAgent: () => { throw new Error('child state write denied'); },
  }), { skipFlush: true, sink: p => sent.push(p) });
  assert.equal(first.outcome, 'failed');
  assert.equal(fs.existsSync(path.join(stateDir(), 'parent-1.json')), false);
  const retry = [];
  const second = await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home, {
    computeDelta: () => { throw new Error('new transcript data must wait'); },
  }), { skipFlush: true, sink: p => retry.push(p) });
  assert.equal(second.outcome, 'committed');
  assert.deepEqual(retry, sent);
  assert.equal(second.committedBoundaries.children.length, 1);
});

test('a zero parent prefix never authorizes ambiguous child history', async t => {
  const home = tmpHome(t);
  writeAgent('parent-1', 'agent-a', { transcriptPath: subagentRollout(home, 'agent-a') });
  const sent = [];
  const result = await runCheckpoint({ session_id: 'parent-1', cwd: home }, deps(home), {
    skipFlush: true, startCursor: 0, recovery: true, sink: p => sent.push(p),
  });
  assert.equal(result.outcome, 'deferred');
  assert.equal(result.reason, 'child-coverage-unavailable');
  assert.equal(sent.some(p => p.is_subagent), false);
});
