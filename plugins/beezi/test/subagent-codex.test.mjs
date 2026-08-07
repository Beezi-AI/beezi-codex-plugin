import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  forkPrefixBoundary,
  subagentIdentityFrom,
  inspectSubagentRollout,
  MAX_FORK_PREFIX_RECORDS,
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
  assert.equal(id.agentNickname, 'Darwin');
  assert.equal(id.spawnDepth, 1);
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
