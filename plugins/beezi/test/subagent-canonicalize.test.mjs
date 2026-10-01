import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeAgents, mergeAgentRecords } from '../lib/subagent-codex.mjs';

// G-7-2. The checkpoint's agent dictionary is keyed from TWO independent sources: the rollout sweep
// keys by the rollout's own thread id, a hook sidecar keys by the hook's `agent_id`. Codex documents
// `agent_id` only as "Identifier for the subagent" — the schema in the shipped binary is a bare
// {"type":"string"} — and live data holds two other plausible values for it (`agent_path`, e.g.
// `/root/api_domain`, and the spawn tool's `call_id`). When the two strings disagree the SAME rollout
// file arrives under two keys, each with its own cursor and its own segment id, and the server
// upserts on `segmentId::model` — so it cannot collapse them and the tokens are billed twice.
//
// canonicalizeAgents is the guard: it resolves the dictionary to one entry per rollout FILE before
// anything is billed, keyed by the id the rollout states about itself.

// A stand-in for inspectSubagentRollout: maps a path to what that file says its own thread id is.
const inspector = (byPath) => (p) => {
  if (!(p in byPath)) return null;
  const own = byPath[p];
  return { forkBoundaryLine: 7, ownThreadId: own, parentThreadId: 'parent-1', agentNickname: 'Darwin', spawnDepth: 1 };
};

const at = (ms) => new Date(Date.parse('2026-08-06T19:41:50.000Z') + ms).toISOString();

test('one rollout reached by two keys is billed once, under the id the rollout states', () => {
  // The measured HEAD failure: sidecar key `/root/api_domain` (a real Codex agent_path) and swept
  // key `thread-x` naming one file yields two segments — `parent-1:thread-x:4-5` and
  // `parent-1:/root/api_domain:4-5` — each billing the same 1,000 input tokens.
  const file = '/sessions/agent-x.jsonl';
  const out = canonicalizeAgents([
    ['thread-x', { agent_id: 'thread-x', transcriptPath: file }],                                  // swept
    ['/root/api_domain', { agent_id: '/root/api_domain', agent_type: 'explore', started_at: at(0), transcriptPath: file }], // sidecar
  ], inspector({ [file]: 'thread-x' }));

  assert.equal(out.length, 1, 'billed once, not once per key');
  assert.equal(out[0].agentId, 'thread-x', 'the rollout own id is canonical, not the hook string');
  assert.equal(out[0].rolloutPath, file);
  assert.equal(out[0].record.agent_type, 'explore', 'the hook-only field is folded in, not dropped');
  assert.equal(out[0].record.started_at, at(0), 'and so is the hook-only start time');
});

test('the sidecar folds in even when it is the entry that sorts first', () => {
  // The caller sorts by started_at, so a sidecar (which has one) can precede the swept entry (which
  // does not) as easily as follow it. Either order must yield one entry with both halves.
  const file = '/sessions/agent-x.jsonl';
  const out = canonicalizeAgents([
    ['/root/api_domain', { agent_type: 'explore', started_at: at(0), cursor: 9, transcriptPath: file }],
    ['thread-x', { transcriptPath: file }],
  ], inspector({ [file]: 'thread-x' }));

  assert.equal(out.length, 1);
  assert.equal(out[0].agentId, 'thread-x');
  assert.equal(out[0].record.agent_type, 'explore');
  assert.equal(out[0].record.cursor, 9, 'the stored cursor survives, so the agent is not re-billed from the fork boundary');
});

test('two cursors for one file resolve to the higher one', () => {
  // One of the two already covers lines the other does not. Re-billing is the exact failure this
  // guard exists to prevent, so when they disagree the conservative direction is to skip lines.
  const file = '/sessions/agent-x.jsonl';
  const out = canonicalizeAgents([
    ['thread-x', { cursor: 4, transcriptPath: file }],
    ['/root/api_domain', { cursor: 12, transcriptPath: file }],
  ], inspector({ [file]: 'thread-x' }));

  assert.equal(out.length, 1);
  assert.equal(out[0].record.cursor, 12);
});

test('two different files claiming one thread id fail closed — the first is billed, the second dropped', () => {
  // Here no correct answer is available, so this copies forkPrefixBoundary's precedent rather than
  // guessing. Billing both would double-count under one id; picking by guess could bill the wrong
  // file. This branch is also what stops two GENUINELY different agents merging into one.
  const a = '/sessions/agent-a.jsonl';
  const b = '/sessions/agent-b.jsonl';
  const out = canonicalizeAgents([
    ['key-1', { transcriptPath: a }],
    ['key-2', { transcriptPath: b }],
  ], inspector({ [a]: 'thread-x', [b]: 'thread-x' }));

  assert.equal(out.length, 1);
  assert.equal(out[0].rolloutPath, a, 'the first entry in billing order wins');
});

test('two genuinely different agents are never merged', () => {
  // The mirror of the bug being fixed: canonicalizing onto a shared key would under-bill one of them.
  const a = '/sessions/agent-a.jsonl';
  const b = '/sessions/agent-b.jsonl';
  const out = canonicalizeAgents([
    ['agent-a', { transcriptPath: a }],
    ['agent-b', { transcriptPath: b }],
  ], inspector({ [a]: 'thread-a', [b]: 'thread-b' }));

  assert.deepEqual(out.map((e) => e.agentId), ['thread-a', 'thread-b']);
});

test('input order is preserved exactly — never re-sorted', () => {
  // The caller's wall-clock coverage union and its segment ids both depend on a reproducible billing
  // order, which it establishes by sorting before it calls here. Re-ordering would move it.
  const files = ['/s/c.jsonl', '/s/a.jsonl', '/s/b.jsonl'];
  const own = { '/s/c.jsonl': 'thread-c', '/s/a.jsonl': 'thread-a', '/s/b.jsonl': 'thread-b' };
  const out = canonicalizeAgents(files.map((f) => [own[f], { transcriptPath: f }]), inspector(own));
  assert.deepEqual(out.map((e) => e.agentId), ['thread-c', 'thread-a', 'thread-b']);
});

test('a rollout that states no id of its own keeps the dictionary key, untrusted or not', () => {
  // Skipping here would lose a real agent to defend against a duplicate that cannot occur: with no
  // own id there is no second key to collide with. The key stays UNTRUSTED on this path — it came
  // off a hook payload and still reaches a segment id and therefore a queue filename, so the
  // caller's path-safety guards remain load-bearing exactly here.
  const file = '/sessions/agent-nameless.jsonl';
  const evil = '../../../../evil';
  const out = canonicalizeAgents([
    [evil, { started_at: at(0), transcriptPath: file }],
  ], () => ({ forkBoundaryLine: 0, ownThreadId: null, parentThreadId: 'parent-1', agentNickname: null, spawnDepth: null }));

  assert.equal(out.length, 1, 'an agent with no own id is still billed');
  assert.equal(out[0].agentId, evil, 'the raw key survives, so safeFileName/segment scoping still has to hold');
  assert.equal(out[0].rolloutPath, file);
});

test('an entry with no transcript path, or an unreadable one, is skipped', () => {
  const file = '/sessions/agent-x.jsonl';
  const out = canonicalizeAgents([
    ['no-path', { started_at: at(0) }],                       // SubagentStart fired, Stop never did
    ['blank-path', { transcriptPath: '' }],
    ['not-a-subagent', { transcriptPath: '/sessions/plain.jsonl' }], // inspect returns null
    ['thread-x', { transcriptPath: file }],
  ], inspector({ [file]: 'thread-x' }));

  assert.deepEqual(out.map((e) => e.agentId), ['thread-x']);
});

test('an inspector that throws drops that entry and never the whole sweep', () => {
  const file = '/sessions/agent-x.jsonl';
  const out = canonicalizeAgents([
    ['boom', { transcriptPath: '/sessions/boom.jsonl' }],
    ['thread-x', { transcriptPath: file }],
  ], (p) => {
    if (p.indexOf('boom') !== -1) throw new Error('unreadable');
    return { forkBoundaryLine: 0, ownThreadId: 'thread-x', parentThreadId: 'parent-1', agentNickname: null, spawnDepth: 1 };
  });

  assert.deepEqual(out.map((e) => e.agentId), ['thread-x']);
});

test('a malformed dictionary yields nothing rather than throwing', () => {
  assert.deepEqual(canonicalizeAgents(null, () => null), []);
  assert.deepEqual(canonicalizeAgents([], () => null), []);
  assert.deepEqual(canonicalizeAgents([undefined, ['k', null], ['k2', {}]], () => null), []);
});

test('mergeAgentRecords keeps the defined value of each field and never erases one', () => {
  const merged = mergeAgentRecords(
    { agent_id: 'thread-x', transcriptPath: '/s/a.jsonl', agent_type: null },
    { agent_id: '/root/api_domain', agent_type: 'explore', started_at: at(0), stopped_at: undefined, model: null },
  );
  assert.equal(merged.agent_id, 'thread-x', 'the first record wins where both are defined');
  assert.equal(merged.agent_type, 'explore', 'a null placeholder is filled, not kept');
  assert.equal(merged.started_at, at(0));
  assert.equal('stopped_at' in merged, false, 'undefined never becomes a key');
  assert.equal('model' in merged, false, 'and neither does null');
  assert.equal(merged.transcriptPath, '/s/a.jsonl');
});

test('mergeAgentRecords takes the higher cursor, in either direction', () => {
  assert.equal(mergeAgentRecords({ cursor: 4 }, { cursor: 12 }).cursor, 12);
  assert.equal(mergeAgentRecords({ cursor: 12 }, { cursor: 4 }).cursor, 12);
  assert.equal(mergeAgentRecords({}, { cursor: 4 }).cursor, 4);
  assert.equal(mergeAgentRecords({ cursor: 4 }, { cursor: 'nope' }).cursor, 4, 'a non-integer never displaces a real cursor');
  assert.equal(mergeAgentRecords(null, null).cursor, undefined);
});

// ── G-7-3: the display name when the hooks never ran ─────────────────────────────────────────
//
// `agent_type` is written only by the SubagentStart/Stop hooks, and Codex will not run a hook the
// user has not trusted through /hooks — the platform's most common state. So the ordinary case is
// no sidecar at all and an agent that reaches the server labelled `null`. The rollout's own
// `agent_path` is what Codex records about the agent's role when nobody else does.

const withPath = (agentPath) => () => ({
  forkBoundaryLine: 0, ownThreadId: 'thread-x', parentThreadId: 'parent-1', agentNickname: 'Darwin',
  agentPath, spawnDepth: 1,
});

const SWEPT = '/sessions/agent-x.jsonl';

test('an agent found only by the sweep takes its role from the rollout it wrote itself', () => {
  const out = canonicalizeAgents(
    [['thread-x', { agent_id: 'thread-x', transcriptPath: SWEPT }]],
    withPath('/root/api_domain'),
  );

  assert.equal(out.length, 1);
  assert.equal(out[0].record.agent_type, 'api_domain', 'the label the hooks would have supplied');
});

test('a hook-supplied agent_type always beats the derived one, in either arrival order', () => {
  // Derivation happens after every fold, so the real value cannot be shadowed by a derived one that
  // mergeAgentRecords would then see as already filled.
  const sidecarFirst = canonicalizeAgents([
    ['/root/api_domain', { agent_type: 'explore', started_at: at(0), transcriptPath: SWEPT }],
    ['thread-x', { transcriptPath: SWEPT }],
  ], withPath('/root/api_domain'));
  assert.equal(sidecarFirst[0].record.agent_type, 'explore');

  const sweptFirst = canonicalizeAgents([
    ['thread-x', { transcriptPath: SWEPT }],
    ['/root/api_domain', { agent_type: 'explore', started_at: at(0), transcriptPath: SWEPT }],
  ], withPath('/root/api_domain'));
  assert.equal(sweptFirst[0].record.agent_type, 'explore');
});

test('a rollout with no agent_path keeps the null it has today', () => {
  // The oldest format carries neither a nickname nor a path. Derived, never invented.
  const out = canonicalizeAgents(
    [['thread-x', { transcriptPath: SWEPT }]],
    withPath(null),
  );

  assert.equal(out.length, 1);
  assert.ok(!out[0].record.agent_type, 'nothing is made up to fill the field');
});

test('deriving a role does not write into the caller\'s agent dictionary', () => {
  // The same map ingestSubagents hands to the timeline builder is the one passed in here.
  // Enriching what billing reads must not quietly rewrite it.
  const record = { agent_id: 'thread-x', transcriptPath: SWEPT };

  const out = canonicalizeAgents([['thread-x', record]], withPath('/root/api_domain'));

  assert.equal(out[0].record.agent_type, 'api_domain');
  assert.equal(record.agent_type, undefined, 'the caller\'s own record is untouched');
});
