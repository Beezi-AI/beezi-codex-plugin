import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { queueDir, stateDir, billingConfigFile, repoMapFile, trackingStateFile } from '../lib/paths.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// One linked account, injected: from 0.13 on runCheckpoint resolves every account that can produce
// a token and fans the one delta out into each of their queues.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');


// The history import's contract with runCheckpoint: payloads go to the sink and nowhere near the
// live queue, nothing persists (state, agent cursors, billing evidence), errors are buffered, the
// subagent sweep runs without a timeline, and the live tracking gate is explicitly bypassed.

const tmpHome = (t) => sandboxHome(t, 'beezi-bf-');

function stubTranscript(home) {
  const p = path.join(home, 'rollout.jsonl');
  fs.writeFileSync(p, '\n');
  return p;
}

const writeState = (id, state) => {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), `${id}.json`), JSON.stringify(state));
};

const seg = (over = {}) => ({
  repoRoot: '/repo',
  branch: 'main',
  fromLine: 1,
  toLine: 4,
  stats: {
    models: { 'gpt-5.2-codex': { token_input: 10, token_output: 5, token_cache_read: 0, token_cache_creation: 0, requests: 1 } },
    token_total: 15, token_input: 10, token_output: 5, token_cache: 0,
    duration_sec: 12,
    code_changes: { files_changed: 0, lines_added: 0, lines_removed: 0, by_extension: {} },
    operations: {},
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: '2026-01-01T00:00:12.000Z',
  },
  ...over,
});

const deps = (home, segments, over = {}) => ({
  linkedSessions: async () => [SESSION],
  fetchImpl: async () => { throw new Error('no HTTP in a backfill checkpoint'); },
  resolveTranscript: () => ({ transcriptPath: stubTranscript(home), sessionId: 's1' }),
  computeDelta: () => ({ nextCursor: 4, segments, apiErrorEvents: [] }),
  gitImpl: () => 'https://host/org/repo.git',
  ...over,
});

const backfillOptions = (over = {}) => ({
  sink: over.sink,
  skipFlush: true,
  collectSessionErrors: true,
  persistState: false,
  sweepSubagents: true,
  skipLiveTrackingGate: true,
  ...over,
});

test('payloads go to the sink; the live queue never sees them and no flush runs', async (t) => {
  const home = tmpHome(t);
  const sunk = [];
  let fetched = 0;
  const result = await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], { fetchImpl: async () => { fetched += 1; throw new Error('x'); } }),
    backfillOptions({ sink: (p) => sunk.push(p) }),
  );

  assert.equal(result.enqueued, 1);
  assert.equal(result.flush, null, 'skipFlush: the import owns delivery');
  assert.equal(fetched, 0, 'no HTTP at all from the checkpoint');
  assert.equal(sunk.length, 1);
  assert.equal(sunk[0].segmentId, 's1:1-4');
  assert.ok(!fs.existsSync(queueDir(KEY)) || fs.readdirSync(queueDir(KEY)).length === 0, 'live queue untouched');
});

test('persistState:false writes no session state and ignores a live cursor', async (t) => {
  const home = tmpHome(t);
  // A dark-tenant relic: the live hooks advanced the cursor while the server dropped everything.
  writeState('s1', { cursor: 2, pendingErrors: [{ error: 'rate_limit' }], updatedAt: 'x' });
  const before = fs.readFileSync(path.join(stateDir(), 's1.json'), 'utf-8');
  let deltaFrom = null;
  const sunk = [];
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], {
      computeDelta: (_p, fromLine) => { deltaFrom = fromLine; return { nextCursor: 4, segments: [seg()], apiErrorEvents: [] }; },
    }),
    backfillOptions({ sink: (p) => sunk.push(p) }),
  );

  assert.equal(deltaFrom, 0, 'the whole file is billed, not the tail past a corrupt cursor');
  assert.equal(fs.readFileSync(path.join(stateDir(), 's1.json'), 'utf-8'), before, 'state file untouched');
});

test('historical parent and subagent payloads collect current instructions from their own roots', async (t) => {
  const home = tmpHome(t);
  const parentRoot = path.join(home, 'parent-repo');
  const childRoot = path.join(home, 'child-repo');
  fs.mkdirSync(parentRoot);
  fs.mkdirSync(childRoot);
  fs.mkdirSync(path.join(parentRoot, '.git'));
  fs.mkdirSync(path.join(childRoot, '.git'));
  fs.writeFileSync(path.join(parentRoot, 'AGENTS.md'), 'today\nparent\n');
  fs.writeFileSync(path.join(childRoot, 'AGENTS.override.md'), 'today\nchild\noverride\n');
  const childPath = path.join(home, 'child.jsonl');
  fs.writeFileSync(childPath, '\n');
  const sunk = [];

  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg({ repoRoot: parentRoot })], {
      computeDelta: (p) => ({
        nextCursor: 4,
        segments: [seg({ repoRoot: p === childPath ? childRoot : parentRoot })],
        apiErrorEvents: [],
      }),
      readAgents: () => ({ a1: { agent_id: 'a1', transcriptPath: childPath } }),
      inspectSubagentRollout: () => ({
        forkBoundaryLine: 0,
        agentNickname: 'Darwin',
        spawnDepth: 1,
        ownThreadId: 'a1',
        parentThreadId: 's1',
      }),
    }),
    backfillOptions({ sink: (p) => sunk.push(p) }),
  );

  assert.equal(sunk.length, 2, 'one child and one parent payload');
  assert.deepEqual(
    sunk.map((payload) => ({
      subagent: payload.is_subagent === true,
      status: payload.project_instructions_status,
      lines: payload.claude_md_lines,
    })).sort((a, b) => Number(a.subagent) - Number(b.subagent)),
    [
      { subagent: false, status: 'present', lines: 2 },
      { subagent: true, status: 'present', lines: 3 },
    ],
  );
});

for (const fixture of [
  { name: 'empty current file', file: '', status: 'present', lines: 0 },
  { name: 'missing current file', status: 'missing' },
  { name: 'unavailable repository', unavailable: true, status: 'unknown' },
]) {
  test(`historical instruction collection reports ${fixture.name}`, async (t) => {
    const home = tmpHome(t);
    const root = path.join(home, 'repo');
    if (!fixture.unavailable) {
      fs.mkdirSync(root);
      fs.mkdirSync(path.join(root, '.git'));
      if (fixture.file !== undefined) fs.writeFileSync(path.join(root, 'AGENTS.md'), fixture.file);
    }
    const sunk = [];
    await runCheckpoint(
      { session_id: 's1', cwd: home },
      deps(home, [seg({ repoRoot: root })]),
      backfillOptions({ sink: (payload) => sunk.push(payload) }),
    );
    assert.equal(sunk.length, 1);
    assert.equal(sunk[0].project_instructions_status, fixture.status);
    assert.equal(sunk[0].claude_md_lines, fixture.lines);
    assert.equal('claude_md_lines' in sunk[0], fixture.lines !== undefined);
  });
}

// G-3-3. lib/session-audit.mjs threads `startCursor` into every runCheckpoint call: 0 for the
// one-time import, and the server's confirmed contiguous prefix for a coverage-driven replay.
// This pins the half that must NOT move — the import's from-zero read is identical whether the
// option is present as 0 or absent — so the engine-side override can land without silently
// re-scoping the import. The non-zero half is asserted against the audit's own overlap ban in
// test/coverage-reconciliation.test.mjs, which refuses to send a replay that starts at or below
// the boundary it asked for.
test('startCursor: 0 reads exactly like omitting it — the import is still a whole-file read', async (t) => {
  const home = tmpHome(t);
  writeState('s1', { cursor: 2, updatedAt: 'x' });
  const seen = [];
  const run = (options) => runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], {
      computeDelta: (_p, fromLine) => { seen.push(fromLine); return { nextCursor: 4, segments: [seg()], apiErrorEvents: [] }; },
    }),
    backfillOptions(options),
  );

  const withoutOption = [];
  await run({ sink: (p) => withoutOption.push(p) });
  const withZero = [];
  await run({ sink: (p) => withZero.push(p), startCursor: 0 });

  assert.deepEqual(seen, [0, 0], 'a stored cursor is ignored either way');
  assert.deepEqual(withZero.map((p) => p.segmentId), withoutOption.map((p) => p.segmentId));
  assert.equal(fs.readFileSync(path.join(stateDir(), 's1.json'), 'utf-8').includes('"cursor":2'), true, 'state untouched');
});

// The other half, against the real engine rather than a runCheckpoint double. Every assertion in
// test/coverage-reconciliation.test.mjs about a non-zero boundary is made against a stub, so
// without this the override could be absent and that whole file would still be green.
test('a non-zero startCursor overrides the stored cursor, and takes coveredIntervals with it', async (t) => {
  const home = tmpHome(t);
  // A local cursor that disagrees with the server in BOTH directions matters: 2 is behind the
  // server's 120, and the intervals below it were billed for lines the server never received.
  writeState('s1', { cursor: 2, updatedAt: 'x', coveredIntervals: [[1000, 2000]] });
  const seen = [];
  const sunk = [];
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], {
      computeDelta: (_p, fromLine) => { seen.push(fromLine); return { nextCursor: 130, segments: [seg()], apiErrorEvents: [] }; },
    }),
    backfillOptions({ sink: (p) => sunk.push(p), startCursor: 120 }),
  );

  assert.deepEqual(seen, [120], 'the server line wins over the stored cursor, not the larger of the two');
  assert.equal(sunk.length, 1);
  assert.equal(
    fs.readFileSync(path.join(stateDir(), 's1.json'), 'utf-8').includes('"cursor":2'),
    true,
    'the import still never writes state back',
  );
});

test('collectSessionErrors buffers error payloads instead of POSTing them', async (t) => {
  const home = tmpHome(t);
  const sunk = [];
  const result = await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], {
      computeDelta: () => ({
        nextCursor: 4,
        segments: [seg()],
        apiErrorEvents: [{ error: 'rate_limit', text: 'slow down', occurredAt: '2026-01-01T00:00:05.000Z' }],
      }),
    }),
    backfillOptions({ sink: (p) => sunk.push(p) }),
  );

  assert.equal(result.sessionErrors.length, 1);
  assert.deepEqual(result.sessionErrors[0], {
    sessionId: 's1',
    error: 'rate_limit',
    errorDetails: null,
    lastAssistantMessage: 'slow down',
    occurredAt: '2026-01-01T00:00:05.000Z',
  });
});

test('historical billing evidence is never persisted, but the repo-map still learns', async (t) => {
  const home = tmpHome(t);
  const sunk = [];
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], {
      computeDelta: () => ({
        nextCursor: 4,
        segments: [seg()],
        // Would flip billing_source to api_key if it were persisted.
        apiErrorEvents: [{ error: 'billing_error', details: 'insufficient_quota', text: 'quota' }],
      }),
    }),
    backfillOptions({ sink: (p) => sunk.push(p) }),
  );

  assert.ok(!fs.existsSync(billingConfigFile()), 'a months-old quota error must not stamp today\'s billing');
  assert.ok(fs.existsSync(repoMapFile()), 'the machine-global dir→origin cache still learns from history');
});

test('sweepSubagents finds children without emitTimeline, bills them through the sink, writes no cursor', async (t) => {
  const home = tmpHome(t);
  const childPath = path.join(home, 'child.jsonl');
  fs.writeFileSync(childPath, '\n');
  const sunk = [];
  const agentWrites = [];
  let swept = 0;
  const result = await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], {
      computeDelta: (p) => ({
        nextCursor: 4,
        segments: [seg(p === childPath ? { fromLine: 2, toLine: 9 } : {})],
        apiErrorEvents: [],
      }),
      readAgents: () => ({}),
      writeAgent: (...args) => agentWrites.push(args),
      rolloutStartedAt: () => 1_000,
      findSubagentRollouts: (sessionId) => { swept += 1; return sessionId === 's1' ? [{ agentId: 'a1', path: childPath }] : []; },
      inspectSubagentRollout: () => ({ forkBoundaryLine: 2, agentNickname: 'Darwin', spawnDepth: 1, ownThreadId: 'a1', parentThreadId: 's1' }),
    }),
    backfillOptions({ sink: (p) => sunk.push(p) }),
  );

  assert.equal(swept, 1, 'the sweep ran despite emitTimeline being off');
  const child = sunk.find((p) => p.is_subagent);
  assert.ok(child, 'the swept child was billed');
  assert.equal(child.segmentId, 's1:a1:2-9');
  assert.equal(child.agent_name, 'Darwin');
  assert.equal(agentWrites.length, 0, 'no sidecar cursor writes in backfill mode');
  assert.deepEqual(Object.keys(result.agents), ['a1'], 'the merged agent map is returned for the timeline');
});

test('the live tracking gate blocks a dark-mode checkpoint unless explicitly skipped', async (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(path.dirname(trackingStateFile(KEY)), { recursive: true });
  fs.writeFileSync(trackingStateFile(KEY), JSON.stringify({ version: 1, trackingMode: 'backfill_only' }));

  const gated = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg()]));
  assert.equal(gated.gated, true);
  assert.equal(gated.enqueued, 0);

  const sunk = [];
  const skipped = await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()]),
    backfillOptions({ sink: (p) => sunk.push(p) }),
  );
  assert.notEqual(skipped.gated, true);
  assert.equal(sunk.length, 1, 'the import runs while the gate is closed');
});
