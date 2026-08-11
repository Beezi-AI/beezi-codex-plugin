import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { queueDir, stateDir, billingConfigFile, repoMapFile, trackingStateFile } from '../lib/paths.mjs';

// The history import's contract with runCheckpoint: payloads go to the sink and nowhere near the
// live queue, nothing persists (state, agent cursors, billing evidence), errors are buffered, the
// subagent sweep runs without a timeline, and the live tracking gate is explicitly bypassed.

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-bf-'));
  const prev = process.env.BEEZI_CODEX_HOME;
  process.env.BEEZI_CODEX_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_CODEX_HOME;
    else process.env.BEEZI_CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

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
  getAccessToken: async () => 'tok',
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
  assert.ok(!fs.existsSync(queueDir()) || fs.readdirSync(queueDir()).length === 0, 'live queue untouched');
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
  fs.writeFileSync(trackingStateFile(), JSON.stringify({ version: 1, trackingMode: 'backfill_only' }));

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
