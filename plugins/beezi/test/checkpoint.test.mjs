import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { queueDir, stateDir } from '../lib/paths.mjs';

// The report payload itself: what gets enqueued, under which remote and segment id, and how a
// session rename is pushed after the fact. computeDelta is injected — the transcript parsing has
// its own suite — so these assertions are about the checkpoint's own contract with the server.

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-cp-'));
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
const readState = (id) => JSON.parse(fs.readFileSync(path.join(stateDir(), `${id}.json`), 'utf-8'));
const writeState = (id, state) => {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), `${id}.json`), JSON.stringify(state));
};

function stubTranscript(home) {
  const p = path.join(home, 'rollout.jsonl');
  fs.writeFileSync(p, '\n');
  return p;
}

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
  fetchImpl: async () => { throw new Error('offline'); }, // keep payloads on disk
  resolveTranscript: () => ({ transcriptPath: stubTranscript(home), sessionId: 's1' }),
  computeDelta: () => ({ nextCursor: 4, segments, apiErrorEvents: [] }),
  gitImpl: () => 'https://host/org/repo.git',
  ...over,
});

test('an unlinked machine enqueues nothing and never parses a transcript', async (t) => {
  const home = tmpHome(t);
  let parsed = false;
  const { enqueued, flush } = await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], {
      getAccessToken: async () => null,
      computeDelta: () => { parsed = true; return { nextCursor: 4, segments: [], apiErrorEvents: [] }; },
    }),
  );
  assert.equal(enqueued, 0);
  assert.equal(flush, null);
  assert.equal(parsed, false);
  assert.ok(!fs.existsSync(path.join(stateDir(), 's1.json')), 'no state is written either');
});

test('an unresolvable transcript is a no-op', async (t) => {
  const home = tmpHome(t);
  const { enqueued } = await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], { resolveTranscript: () => null }),
  );
  assert.equal(enqueued, 0);
});

test('a segment is enqueued with its repo, branch, line window and token stats', async (t) => {
  const home = tmpHome(t);
  const { enqueued } = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg()]));

  assert.equal(enqueued, 1);
  const [p] = queued();
  assert.equal(p.segmentId, 's1:1-4');
  assert.equal(p.sessionId, 's1');
  assert.equal(p.remote, 'https://host/org/repo.git');
  assert.equal(p.branch, 'main');
  assert.equal(p.from_line, 1);
  assert.equal(p.to_line, 4);
  assert.equal(p.token_total, 15);
  assert.equal(p.duration_sec, 12);
  assert.ok(typeof p.timezone === 'string' && p.timezone.length > 0, 'the machine timezone rides along');
});

test('embedded credentials are stripped from the reported remote', async (t) => {
  const home = tmpHome(t);
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], { gitImpl: () => 'https://user:pat@host/org/repo.git' }),
  );
  assert.equal(queued()[0].remote, 'https://host/org/repo.git');
});

test('a segment with neither tokens nor duration is not reported', async (t) => {
  const home = tmpHome(t);
  const empty = seg({ stats: { ...seg().stats, token_total: 0, duration_sec: 0 } });
  const { enqueued } = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [empty]));
  assert.equal(enqueued, 0);
});

test('a segment with duration but no tokens is still reported', async (t) => {
  const home = tmpHome(t);
  const idle = seg({ stats: { ...seg().stats, token_total: 0, duration_sec: 30 } });
  const { enqueued } = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [idle]));
  assert.equal(enqueued, 1);
});

test('two repos in one window produce two distinctly-attributed segments', async (t) => {
  const home = tmpHome(t);
  const remotes = { '/repoA': 'https://host/org/a.git', '/repoB': 'https://host/org/b.git' };
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [
      seg({ repoRoot: '/repoA', fromLine: 1, toLine: 2 }),
      seg({ repoRoot: '/repoB', fromLine: 3, toLine: 4 }),
    ], {
      gitImpl: (args, dir) => remotes[dir] ?? (() => { throw new Error('no origin'); })(),
    }),
  );
  const byId = Object.fromEntries(queued().map((p) => [p.segmentId, p.remote]));
  assert.equal(byId['s1:1-2'], 'https://host/org/a.git');
  assert.equal(byId['s1:3-4'], 'https://host/org/b.git');
});

test('a repo whose origin cannot be resolved reports under a local: remote', async (t) => {
  const home = tmpHome(t);
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg({ repoRoot: '/work/scratch-pad' })], {
      gitImpl: () => { throw new Error('fatal: not a git repository'); },
    }),
  );
  assert.equal(queued()[0].remote, 'local:scratch-pad');
});

test('a segment with no repoRoot at all falls back to the session cwd', async (t) => {
  const home = tmpHome(t);
  await runCheckpoint(
    { session_id: 's1', cwd: '/work/from-cwd' },
    deps(home, [seg({ repoRoot: null })], {
      gitImpl: () => { throw new Error('fatal: not a git repository'); },
    }),
  );
  assert.equal(queued()[0].remote, 'local:from-cwd');
});

test('the cursor advances so the next window starts where this one ended', async (t) => {
  const home = tmpHome(t);
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg()]));
  assert.equal(readState('s1').cursor, 4);
});

test('a later rename replays the anchor segment rather than re-billing', async (t) => {
  const home = tmpHome(t);
  // First checkpoint bills the work and remembers the payload as the anchor.
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], { resolveSessionName: () => 'first title' }),
  );
  const afterFirst = readState('s1');
  assert.ok(afterFirst.anchor, 'an anchor was recorded');
  assert.equal(afterFirst.sentSessionName, 'first title');
  assert.equal(queued()[0].session_name, 'first title');

  // Second checkpoint: no new segments, but Codex has retitled the thread.
  const { enqueued } = await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [], {
      computeDelta: () => ({ nextCursor: 4, segments: [], apiErrorEvents: [] }),
      resolveSessionName: () => 'renamed after the fact',
    }),
  );

  assert.equal(enqueued, 0, 'a rename is not new billable work');
  const replay = queued().find((p) => p.session_name === 'renamed after the fact');
  assert.ok(replay, 'the anchor was replayed carrying the corrected name');
  assert.equal(replay.segmentId, afterFirst.anchor.segmentId, 'same segment id — the server upserts');
  assert.equal(replay.token_total, afterFirst.anchor.token_total, 'tokens are unchanged by a rename');
  assert.equal(readState('s1').sentSessionName, 'renamed after the fact');
});

test('a stored session name captured by an older resolver is purged, not re-sent', async (t) => {
  const home = tmpHome(t);
  // What machines actually have on disk: an injected context block captured as the name before the
  // resolver refused those. Left alone it rides every future report and keeps leaking the path.
  const leaked = '<environment_context> <cwd>C:\\Users\\Someone\\proj</cwd>';
  writeState('s1', { cursor: 0, sentSessionName: leaked, anchor: null });

  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], { resolveSessionName: () => null }),
  );

  assert.equal(queued()[0].session_name, null, 'the leaked name is not sent again');
  assert.equal(readState('s1').sentSessionName, null, 'and it is cleared from state');
});

test('a stored session name that is still valid survives a failed resolution', async (t) => {
  const home = tmpHome(t);
  writeState('s1', { cursor: 0, sentSessionName: 'Refactor the checkout flow', anchor: null });

  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], { resolveSessionName: () => null }),
  );

  assert.equal(queued()[0].session_name, 'Refactor the checkout flow');
  assert.equal(readState('s1').sentSessionName, 'Refactor the checkout flow');
});

test('an unchanged session name does not replay the anchor every turn', async (t) => {
  const home = tmpHome(t);
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], { resolveSessionName: () => 'steady title' }),
  );
  const before = fs.readdirSync(queueDir()).length;

  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [], {
      computeDelta: () => ({ nextCursor: 4, segments: [], apiErrorEvents: [] }),
      resolveSessionName: () => 'steady title',
    }),
  );
  assert.equal(fs.readdirSync(queueDir()).length, before, 'nothing re-queued');
});

test('a segment whose payload cannot be written does not stall the ones after it', async (t) => {
  const home = tmpHome(t);
  // A circular stats object makes JSON.stringify throw inside enqueue for this segment only.
  const poison = seg({ fromLine: 1, toLine: 2 });
  poison.stats = { ...poison.stats };
  poison.stats.self = poison.stats;
  const good = seg({ fromLine: 3, toLine: 4 });

  const { enqueued } = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [poison, good]));

  assert.equal(enqueued, 1, 'the healthy segment still landed');
  assert.deepEqual(queued().map((p) => p.segmentId), ['s1:3-4']);
  // Critical: the cursor must still advance, or every later checkpoint re-processes this window
  // forever and the poison segment fails again each time.
  assert.equal(readState('s1').cursor, 4);
});
