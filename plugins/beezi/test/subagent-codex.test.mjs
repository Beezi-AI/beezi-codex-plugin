import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  forkPrefixBoundary,
  subagentIdentityFrom,
  inspectSubagentRollout,
  findSubagentRollouts,
  MAX_FORK_PREFIX_RECORDS,
  agentRoleFromPath,
} from '../lib/subagent-codex.mjs';

// Fixtures mirror the four subagent rollout shapes actually present in a local ~/.codex corpus, plus
// the long-replay format the repo's own parity notes describe. The boundary numbers here are the
// ones the real files produce.

const T0 = Date.parse('2026-08-06T19:41:50.274Z');
const at = (ms) => new Date(T0 + ms).toISOString();

const subMeta = (over = {}) => ({
  timestamp: at(0),
  type: 'session_meta',
  payload: {
    id: '019fd898-a3c9-7542-86d6-2105a86838c2',
    session_id: '019fd897-9320-7c20-9585-8fa3fff07bf7',
    parent_thread_id: '019fd897-9320-7c20-9585-8fa3fff07bf7',
    forked_from_id: '019fd897-9320-7c20-9585-8fa3fff07bf7',
    thread_source: 'subagent',
    agent_nickname: 'Darwin',
    cwd: 'C:\\repo',
    source: { subagent: { thread_spawn: { parent_thread_id: '019fd897-9320-7c20-9585-8fa3fff07bf7', depth: 1, agent_nickname: 'Darwin', agent_role: null } } },
    ...over,
  },
});

const parentMeta = (ms = 3) => ({
  timestamp: at(ms),
  type: 'session_meta',
  payload: {
    id: '019fd897-9320-7c20-9585-8fa3fff07bf7',
    session_id: '019fd897-9320-7c20-9585-8fa3fff07bf7',
    thread_source: 'user',
    source: 'cli',
    cwd: 'C:\\repo',
  },
});

const tokenCount = (ms, input, cached, output) => ({
  timestamp: at(ms),
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } },
});

const evt = (ms, type) => ({ timestamp: at(ms), type: 'event_msg', payload: { type } });

// The current (Aug-2026) format: own meta, parent's replayed meta, a burst of replayed records
// inside ~100ms, then a multi-second gap to the agent's own work.
function currentFork() {
  return [
    subMeta(),
    parentMeta(3),
    evt(5, 'task_started'),
    tokenCount(20, 14363, 3456, 249),
    tokenCount(40, 31147, 17152, 377),
    tokenCount(60, 51165, 33408, 895),
    evt(93, 'thread_settings_applied'),
    // 4.1s later: the agent's own work begins.
    { timestamp: at(4146), type: 'event_msg', payload: { type: 'task_started' } },
    tokenCount(6000, 65624, 47616, 1571),
  ];
}

function writeRollout(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-sub-'));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

test('the current fork format is delimited at the timestamp cliff', () => {
  assert.equal(forkPrefixBoundary(currentFork()), 7, 'the first record after the burst');
});

test('an older single-meta subagent is billed whole', () => {
  // The May-2026 and Jul-2026 shapes: one session_meta, no replayed token_counts. A bare timestamp
  // cliff returns 2 / 7 / 8 here and swallows real content — the meta count is what stops it.
  const records = [
    subMeta({ source: { subagent: 'review' }, parent_thread_id: undefined, forked_from_id: undefined }),
    evt(1, 'task_started'),
    { timestamp: at(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do the thing' }] } },
    tokenCount(9000, 100, 0, 10),
  ];
  assert.equal(forkPrefixBoundary(records), 0);
});

test('an ordinary session is not a subagent and is billed whole', () => {
  const records = [parentMeta(0), evt(1, 'task_started'), tokenCount(500, 10, 0, 1)];
  assert.equal(subagentIdentityFrom(records), null);
  assert.equal(forkPrefixBoundary(records), 0);
});

test('a fork whose replay never ends is refused, NOT billed from zero', () => {
  // The format the repo's parity notes describe: the parent's ENTIRE history replayed into the child
  // (~99.8% of the file, a 91x inflation in ccusage). It carries two session_meta records, so it
  // reaches the cliff search — and never finds one inside the cap.
  //
  // Falling back to 0 here would bill the parent's whole history again. This is the one case where
  // guessing corrupts the numbers rather than merely missing some, so it must fail closed.
  const records = [subMeta(), parentMeta(3)];
  for (let i = 0; i < MAX_FORK_PREFIX_RECORDS + 20; i++) {
    records.push(tokenCount(5 + i, 1000 * (i + 1), 0, i));
  }
  assert.equal(forkPrefixBoundary(records), null, 'no boundary is offered — the caller must skip the file');
});

test('a fork with an unreadable leading timestamp is refused', () => {
  const records = currentFork();
  records[0] = { ...records[0], timestamp: 'not-a-date' };
  assert.equal(forkPrefixBoundary(records), null);
});

test('a replayed parent meta anywhere but index 1 is not the shape we know', () => {
  const records = currentFork();
  const [own, parent, ...rest] = records;
  assert.equal(forkPrefixBoundary([own, rest[0], parent, ...rest.slice(1)]), 0);
});

test('too few records to judge is billed whole', () => {
  assert.equal(forkPrefixBoundary([subMeta()]), 0);
  assert.equal(forkPrefixBoundary([]), 0);
  assert.equal(forkPrefixBoundary(null), 0);
});

test('identity carries the parent link, nickname and spawn depth', () => {
  const id = subagentIdentityFrom(currentFork());
  assert.equal(id.ownThreadId, '019fd898-a3c9-7542-86d6-2105a86838c2');
  assert.equal(id.parentThreadId, '019fd897-9320-7c20-9585-8fa3fff07bf7');
  assert.equal(id.rootSessionId, '019fd897-9320-7c20-9585-8fa3fff07bf7');
  assert.equal(id.agentNickname, 'Darwin');
  assert.equal(id.spawnDepth, 1);
});

test('a grandchild agent is attributed to the session, not lost with its parent', () => {
  // A depth-2 rollout's parent_thread_id is ANOTHER AGENT. Only session_id still names the session
  // that has to bill it. Measured on real data: one such agent, 643,486 tokens, dropped.
  const id = subagentIdentityFrom([subMeta({
    id: 'agent-grandchild',
    session_id: 'root-session',
    parent_thread_id: 'agent-parent',
    forked_from_id: 'agent-parent',
    source: { subagent: { thread_spawn: { parent_thread_id: 'agent-parent', depth: 2 } } },
  })]);
  assert.equal(id.parentThreadId, 'agent-parent');
  assert.equal(id.rootSessionId, 'root-session', 'the root link the parent-only filter never read');
  assert.equal(id.spawnDepth, 2);
});

test('the parent link survives a format that only differs by session_id', () => {
  // The oldest shape carries no parent_thread_id; on a subagent, session_id holds the parent's id
  // while `id` is the agent's own, so the two differing IS the link.
  const id = subagentIdentityFrom([subMeta({
    parent_thread_id: undefined,
    forked_from_id: undefined,
    source: { subagent: { other: 'guardian' } },
  })]);
  assert.equal(id.parentThreadId, '019fd897-9320-7c20-9585-8fa3fff07bf7');
});

test('a rollout with no parent link at all still reports as a subagent', () => {
  const id = subagentIdentityFrom([subMeta({
    session_id: '019fd898-a3c9-7542-86d6-2105a86838c2', // equals `id`
    parent_thread_id: undefined,
    forked_from_id: undefined,
    source: { subagent: 'review' },
    agent_nickname: undefined,
  })]);
  assert.equal(id.parentThreadId, null, 'unattributable, but not misattributed');
  assert.equal(id.rootSessionId, null, 'session_id merely repeats `id`, so it links to nothing');
  assert.equal(id.agentNickname, null);
});

test('inspectSubagentRollout reads a file end to end', () => {
  const r = inspectSubagentRollout(writeRollout(currentFork()));
  assert.equal(r.forkBoundaryLine, 7);
  assert.equal(r.agentNickname, 'Darwin');
  assert.equal(r.parentThreadId, '019fd897-9320-7c20-9585-8fa3fff07bf7');
});

test('inspectSubagentRollout reports an unreadable or empty file as null', () => {
  assert.equal(inspectSubagentRollout(path.join(os.tmpdir(), 'beezi-nope-does-not-exist.jsonl')), null);
  assert.equal(inspectSubagentRollout(writeRollout([])), null);
});

test('the boundary is exactly the cursor computeDelta needs to drop the replay', async () => {
  // The whole point, end to end: computeDelta's pre-window branch walks the replayed token_counts to
  // advance its baseline, so passing the boundary as `fromLine` bills only the agent's own spend.
  const { computeDelta } = await import('../lib/delta-codex.mjs');
  const file = writeRollout(currentFork());
  const { forkBoundaryLine } = inspectSubagentRollout(file);

  const whole = computeDelta(file, 0, {});
  const own = computeDelta(file, forkBoundaryLine, {});
  const sum = (d) => d.segments.reduce((a, s) => a + s.stats.token_total, 0);

  // From zero the parent's replayed history is billed to the agent; from the boundary only the
  // 65624-51165 = 14459 input delta (plus its output/cache split) is.
  assert.equal(sum(whole), 65624 + 1571);
  assert.equal(sum(own), (65624 - 51165) + (1571 - 895));
});

// ── findSubagentRollouts: which rollouts a session claims, and what bounds the walk ──────────────
//
// Every case here passes an explicit `sessionsDir`, so codexSessionsDir() is never called and the
// real ~/.codex/sessions is never read.

function sessionsTree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-sweep-'));
}

// One rollout file in the date tree, containing only its session_meta — which is all the sweep
// reads (maxRecords: 1).
function rolloutIn(dir, name, payload) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-08-06T19-41-50-${name}.jsonl`);
  fs.writeFileSync(file, JSON.stringify(subMeta(payload)) + '\n');
  return file;
}

const dated = (root) => path.join(root, '2026', '08', '06');

test('the sweep claims a grandchild whose parent is another agent', () => {
  // Measured on real data: root 01a07b74 spawned Erdos and Ohm (depth 1), Erdos spawned Anscombe
  // (depth 2). The parent-only filter returned the two depth-1 agents and dropped Anscombe's
  // 643,486 tokens — 18.3% of that session's subagent usage. Anscombe's session_id IS the root.
  const root = sessionsTree();
  const dir = dated(root);
  const child = rolloutIn(dir, 'erdos', {
    id: 'agent-erdos', session_id: 'root-session', parent_thread_id: 'root-session',
    forked_from_id: 'root-session',
    source: { subagent: { thread_spawn: { parent_thread_id: 'root-session', depth: 1 } } },
  });
  const grandchild = rolloutIn(dir, 'anscombe', {
    id: 'agent-anscombe', session_id: 'root-session', parent_thread_id: 'agent-erdos',
    forked_from_id: 'agent-erdos',
    source: { subagent: { thread_spawn: { parent_thread_id: 'agent-erdos', depth: 2 } } },
  });

  const found = findSubagentRollouts('root-session', { sessionsDir: root });
  assert.deepEqual(
    found.map((f) => f.agentId).sort(),
    ['agent-anscombe', 'agent-erdos'],
    'the grandchild is billed to the root session, not lost with its parent',
  );
  const paths = found.map((f) => f.path).sort();
  assert.deepEqual(paths, [child, grandchild].sort());
});

test('another session\'s agent is still rejected', () => {
  // The risk of widening the filter: attaching a rollout to a session that did not spawn it. Both
  // links are checked against THIS session id and nothing else.
  const root = sessionsTree();
  rolloutIn(dated(root), 'stranger', {
    id: 'agent-stranger', session_id: 'other-session', parent_thread_id: 'other-session',
    forked_from_id: 'other-session',
    source: { subagent: { thread_spawn: { parent_thread_id: 'other-session', depth: 1 } } },
  });
  rolloutIn(dated(root), 'stranger-deep', {
    id: 'agent-stranger-deep', session_id: 'other-session', parent_thread_id: 'agent-stranger',
    forked_from_id: 'agent-stranger',
    source: { subagent: { thread_spawn: { parent_thread_id: 'agent-stranger', depth: 2 } } },
  });

  assert.deepEqual(findSubagentRollouts('root-session', { sessionsDir: root }), []);
  assert.equal(findSubagentRollouts('other-session', { sessionsDir: root }).length, 2);
});

test('an ordinary rollout is never claimed, however the ids line up', () => {
  const root = sessionsTree();
  const dir = dated(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-2026-08-06T19-41-50-plain.jsonl');
  fs.writeFileSync(file, JSON.stringify(parentMeta(0)) + '\n');
  assert.deepEqual(findSubagentRollouts('019fd897-9320-7c20-9585-8fa3fff07bf7', { sessionsDir: root }), [],
    'the thread_source gate holds: no thread_source:subagent, no claim');
});

test('a rollout that names itself as its own ancestor is not billed as its own subagent', () => {
  // The one cycle the flat scan can actually meet: a file whose own id IS the session id. The
  // session's rollout is already billed as the parent, so claiming it here would bill one file
  // twice under two segment scopes.
  const root = sessionsTree();
  rolloutIn(dated(root), 'selfie', {
    id: 'root-session', session_id: 'root-session', parent_thread_id: 'root-session',
    forked_from_id: 'root-session',
    source: { subagent: { thread_spawn: { parent_thread_id: 'root-session', depth: 1 } } },
  });
  assert.deepEqual(findSubagentRollouts('root-session', { sessionsDir: root }), []);
});

test('a mutual parent pair terminates and is attributed to neither', () => {
  // A says B spawned it, B says A spawned it. No parent->child edge is ever followed, so this is a
  // single pass over two files, not a traversal: it terminates by construction.
  const root = sessionsTree();
  rolloutIn(dated(root), 'a', {
    id: 'agent-a', session_id: 'agent-b', parent_thread_id: 'agent-b', forked_from_id: 'agent-b',
    source: { subagent: { thread_spawn: { parent_thread_id: 'agent-b', depth: 1 } } },
  });
  rolloutIn(dated(root), 'b', {
    id: 'agent-b', session_id: 'agent-a', parent_thread_id: 'agent-a', forked_from_id: 'agent-a',
    source: { subagent: { thread_spawn: { parent_thread_id: 'agent-a', depth: 1 } } },
  });
  assert.deepEqual(findSubagentRollouts('root-session', { sessionsDir: root }), [],
    'a cycle among strangers attaches to nobody');
  assert.deepEqual(findSubagentRollouts('agent-a', { sessionsDir: root }).map((f) => f.agentId), ['agent-b'],
    'and the session in the cycle claims only the other file, never its own');
});

test('the read budget bounds the sweep whatever the spawn depth', () => {
  // maxReads counts files OPENED, and the widened filter changes which files are KEPT, not how many
  // are read. A sweep runs inside a hook budget, so this bound is the one that matters.
  const root = sessionsTree();
  for (let i = 0; i < 6; i++) {
    rolloutIn(dated(root), `deep-${i}`, {
      id: `agent-${i}`, session_id: 'root-session', parent_thread_id: `agent-${i - 1}`,
      forked_from_id: `agent-${i - 1}`,
      source: { subagent: { thread_spawn: { parent_thread_id: `agent-${i - 1}`, depth: i + 1 } } },
    });
  }
  assert.equal(findSubagentRollouts('root-session', { sessionsDir: root }).length, 6,
    'a chain six deep is found in one pass — spawn depth costs no extra reads');
  assert.equal(findSubagentRollouts('root-session', { sessionsDir: root, maxReads: 2 }).length, 2,
    'and the budget still caps the files opened');
});

test('directory recursion stops at four levels', () => {
  const root = sessionsTree();
  const payload = (id) => ({
    id, session_id: 'root-session', parent_thread_id: 'agent-mid', forked_from_id: 'agent-mid',
    source: { subagent: { thread_spawn: { parent_thread_id: 'agent-mid', depth: 2 } } },
  });
  rolloutIn(path.join(root, 'a', 'b', 'c', 'd'), 'shallow', payload('agent-shallow'));
  rolloutIn(path.join(root, 'a', 'b', 'c', 'd', 'e'), 'buried', payload('agent-buried'));

  assert.deepEqual(findSubagentRollouts('root-session', { sessionsDir: root }).map((f) => f.agentId),
    ['agent-shallow'], 'depth 5 is past the cap and is never opened');
});

test('a rollout older than the session is not opened at all', () => {
  const root = sessionsTree();
  const stale = rolloutIn(dated(root), 'stale', {
    id: 'agent-stale', session_id: 'root-session', parent_thread_id: 'agent-mid',
    forked_from_id: 'agent-mid',
    source: { subagent: { thread_spawn: { parent_thread_id: 'agent-mid', depth: 2 } } },
  });
  const old = Date.now() - 60 * 60 * 1000;
  fs.utimesSync(stale, new Date(old), new Date(old));
  assert.deepEqual(findSubagentRollouts('root-session', { sessionsDir: root, sinceMs: Date.now() - 1000 }), [],
    'the mtime gate rejects a grandchild too — it is checked before any read');
});

// ── G-7-3: the agent's role, from the rollout, when no hook ever ran ─────────────────────────

test('identity carries the agent role path, top level or from thread_spawn', () => {
  const top = subagentIdentityFrom([subMeta({ agent_path: '/root/api_domain' })]);
  assert.equal(top.agentPath, '/root/api_domain');

  // Same value, second home. The modern format writes both; a rollout carrying only the spawn copy
  // must not lose its role for want of looking there.
  const nested = subagentIdentityFrom([subMeta({
    source: { subagent: { thread_spawn: { parent_thread_id: 'p', depth: 1, agent_path: '/root/web_ui' } } },
  })]);
  assert.equal(nested.agentPath, '/root/web_ui');

  assert.equal(subagentIdentityFrom(currentFork()).agentPath, null, 'and a rollout with no path says so');
});

test('an agent role is the last segment of its path, or nothing at all', () => {
  assert.equal(agentRoleFromPath('/root/api_domain'), 'api_domain');
  assert.equal(agentRoleFromPath('/root/api_domain/entities_migration'), 'entities_migration', 'a nested agent names itself, not its parent');
  assert.equal(agentRoleFromPath('root'), 'root');
  assert.equal(agentRoleFromPath('/root/api_domain/'), 'api_domain', 'a trailing separator is not a segment');
  // The paths are Codex-internal and slash-shaped, but nothing in the format promises a separator.
  assert.equal(agentRoleFromPath('\\root\\web_ui'), 'web_ui');
  // Every shape with no segment to take yields null rather than a mangled label: the field is
  // cosmetic, so being wrong about it is strictly worse than leaving it as it is today.
  assert.equal(agentRoleFromPath('/'), null);
  assert.equal(agentRoleFromPath(''), null);
  assert.equal(agentRoleFromPath(null), null);
  assert.equal(agentRoleFromPath(undefined), null);
  assert.equal(agentRoleFromPath(42), null);
  assert.equal(agentRoleFromPath(`/root/${'x'.repeat(150)}`).length, 100, 'clamped to the width the wire field takes');
});
