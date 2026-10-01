import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { queueDir, stateDir } from '../lib/paths.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// One linked account, injected: from 0.13 on runCheckpoint resolves every account that can produce
// a token and fans the one delta out into each of their queues.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');


// The report payload itself: what gets enqueued, under which remote and segment id, and how a
// session rename is pushed after the fact. computeDelta is injected — the transcript parsing has
// its own suite — so these assertions are about the checkpoint's own contract with the server.

const tmpHome = (t) => sandboxHome(t, 'beezi-cp-');

const queued = () => fs.readdirSync(queueDir(KEY)).map((f) =>
  JSON.parse(fs.readFileSync(path.join(queueDir(KEY), f), 'utf-8')));
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
  linkedSessions: async () => [SESSION],
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
      linkedSessions: async () => [],
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

test("a 'committed' result carries none of the not-checkpointed flags", async (t) => {
  const home = tmpHome(t);
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg()]));

  assert.equal(result.outcome, 'committed');
  assert.equal(result.enqueued, 1);
  // Three of the flags are top-level on the result...
  assert.ok(!result.gated, 'gated');
  assert.ok(!result.lockSkipped, 'lockSkipped');
  assert.ok(!result.unnamedSession, 'unnamedSession');
  // ...and three live under `skipped`, which the committed return spreads verbatim.
  assert.ok(!result.skipped.deltaFailed, 'deltaFailed');
  assert.ok(!result.skipped.rateLimitDeferred, 'rateLimitDeferred');
  assert.ok(!result.skipped.emitFailed, 'emitFailed');
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

test('a stored session name with a path buried in it is redacted, not re-sent raw', async (t) => {
  const home = tmpHome(t);
  // The residue of the index leak: an older resolver returned session_index thread_name verbatim,
  // so machines carry the raw opening prompt in state. It is not shaped like injected context and
  // it is not path-ONLY, so the safety gate alone lets it through — only redaction catches it.
  writeState('s1', {
    cursor: 0,
    sentSessionName: 'why does C:\\Users\\Someone\\app\\main.ts crash',
    anchor: null,
  });

  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], { resolveSessionName: () => null }),
  );

  const sent = queued()[0].session_name;
  assert.ok(sent, 'the usable half of the name survives');
  assert.ok(!sent.includes('C:\\Users\\'), `no windows home path: ${sent}`);
  assert.match(sent, /why does .* crash/);
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
  const before = fs.readdirSync(queueDir(KEY)).length;

  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [], {
      computeDelta: () => ({ nextCursor: 4, segments: [], apiErrorEvents: [] }),
      resolveSessionName: () => 'steady title',
    }),
  );
  assert.equal(fs.readdirSync(queueDir(KEY)).length, before, 'nothing re-queued');
});

test('an unserializable transaction publishes nothing and preserves the cursor', async (t) => {
  const home = tmpHome(t);
  const poison = seg({ fromLine: 1, toLine: 2 });
  poison.stats.self = poison.stats;
  const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [poison, seg()]));
  assert.equal(result.outcome, 'failed');
  assert.equal(result.enqueued, 0);
  assert.equal(fs.existsSync(path.join(stateDir(), 's1.json')), false);
});

// ─── rate-limit drain wiring ──────────────────────────────────────────────────────────────────

// The drain is gated to turn ends: on the frequent PostToolUse path it would be one request per
// tool call describing a number that only moves once a turn.
test('a mid-turn checkpoint records rate-limit rows without posting them', async (t) => {
  const home = tmpHome(t);
  let drains = 0;
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], { drainRateLimitSnapshots: async () => { drains += 1; return { posted: 0 }; } }),
  );
  assert.equal(drains, 0);
});

// The gate scripts/stop.mjs actually goes through. It is a separate `if` from the timeline block,
// so it can drift from it: a drain that silently stops firing here loses every row on the one path
// that ships them on a real turn end.
test('a turn-end checkpoint drains alongside the timeline post', async (t) => {
  const home = tmpHome(t);
  let drains = 0;
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], { drainRateLimitSnapshots: async () => { drains += 1; return { posted: 0 }; } }),
    { emitTimeline: true },
  );
  assert.equal(drains, 1);
});

// `/beezi:track` is a turn end in every sense that matters. Without its own opt-in it queued rows
// and never shipped them — the one path with no budget to protect was the one that skipped.
test('the manual track path drains queued rows without emitting a timeline', async (t) => {
  const home = tmpHome(t);
  let drains = 0;
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], { drainRateLimitSnapshots: async () => { drains += 1; return { posted: 0 }; } }),
    { drainRateLimits: true },
  );
  assert.equal(drains, 1);
});

// A per-request cap alone bounds one row, not the loop: 40 queued rows × 3s runs minutes past the
// hook kill, taking the state write and the segment flush below it down too.
test('the drain is handed the hook deadline, not just a per-request timeout', async (t) => {
  const home = tmpHome(t);
  let opts = null;
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], {
      now: () => 1_000_000,
      drainRateLimitSnapshots: async (_key, _session, o) => { opts = o; return { posted: 0 }; },
    }),
    { drainRateLimits: true, budgetMs: 5000 },
  );
  assert.equal(opts.deadline, 1_005_000);
  assert.equal(typeof opts.now, 'function', 'the drain reads the same clock the budget was set on');
  assert.equal(opts.timeoutMs, 3000, 'the per-request cap still rides along');
});

test('an unbudgeted drain is given no deadline at all', async (t) => {
  const home = tmpHome(t);
  let opts = null;
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], { drainRateLimitSnapshots: async (_key, _session, o) => { opts = o; return { posted: 0 }; } }),
    { drainRateLimits: true },
  );
  assert.equal('deadline' in opts, false, 'the CLI path drains the whole queue');
});

// ── G-6-2 ── `branch` is a required field with a 255-char server cap
// (session-report.request.dto.ts:276-279). One over-long field 400s the whole request, and
// flushQueue treats a 400 as permanent: it deletes that queue file and continues. So an unclamped
// branch does not merely fail to upload — it loses the segment. `agent_id`, `agent_type` and
// `agent_name` were already sliced inline; branch was simply missed.
test('an over-long branch is truncated to the server cap, not dropped or emptied', async (t) => {
  const home = tmpHome(t);
  const branch = `feat/${'x'.repeat(300)}`;
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg({ branch })]));
  const [payload] = queued();
  assert.equal(payload.branch.length, 255);
  assert.equal(payload.branch, branch.slice(0, 255));
  assert.ok(payload.branch.startsWith('feat/'), 'a required field must stay recognisable');
});

test('a branch inside the cap is passed through byte for byte', async (t) => {
  const home = tmpHome(t);
  const branch = 'x'.repeat(255);
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg({ branch })]));
  assert.equal(queued()[0].branch, branch, 'no off-by-one at the boundary');
  assert.equal(queued()[0].remote, 'https://host/org/repo.git', 'remote stays unclamped');
});

// ── G-10-1 (L1/L3) ── billing resolution reads the host environment and the real
// ~/.codex/auth.json unless BOTH seams are threaded. Dropped, a caller that injected every other
// resolver still bills off whatever machine the process happens to be running on.
test('the injected env decides billing_source, not the host environment', async (t) => {
  const home = tmpHome(t);
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], {
      env: { OPENAI_API_KEY: 'sk-injected' },
      readCodexAuthSignals: () => { throw new Error('auth.json must not be consulted'); },
    }),
  );
  assert.equal(queued()[0].billing_source, 'openai_api_key');
});

test('the injected auth signals answer step 4 of the ladder in place of the real auth.json', async (t) => {
  const home = tmpHome(t);
  let reads = 0;
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], {
      env: {},
      readCodexAuthSignals: () => { reads += 1; return { authMode: 'chatgpt', hasStoredApiKey: false }; },
    }),
  );
  assert.equal(reads, 1, 'the injected reader is the one that ran');
  assert.equal(queued()[0].billing_source, 'subscription');
});

// resolveSource takes `now` as an EPOCH (billing-config.mjs:98) while this file's clock is a
// FUNCTION. Handing the function straight through would make every evidence-freshness comparison
// NaN and silently discard a stamp that is only hours old.
test('the checkpoint clock reaches the evidence window as a number', async (t) => {
  const home = tmpHome(t);
  const fresh = new Date('2026-01-01T00:00:00.000Z');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'billing.json'),
    JSON.stringify({ version: 1, apiKeyEvidenceAt: fresh.toISOString() }),
  );
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], {
      env: {},
      now: () => fresh.getTime() + 60_000,
      readCodexAuthSignals: () => ({ authMode: 'chatgpt', hasStoredApiKey: false }),
    }),
  );
  assert.equal(
    queued()[0].billing_source,
    'openai_api_key',
    'an hour-old api-key stamp outranks the chatgpt sign-in on disk',
  );
});

// ─── session identity (G-3-1) ───────────────────────────────────────────────
//
// Every durable key here is derived from one string: the state file `state/<id>.json`, the
// `segmentId`, the queue filename that segmentId becomes, and the `sessionId` on the wire. A null
// one makes `state/null.json` — ONE file shared by every id-less session on the machine, whose
// cursor and anchor they clobber for each other — and a phantom session literally named "null" that
// accretes segments from unrelated sessions forever.

test('a session that cannot be named is refused before it writes anything', async (t) => {
  const home = tmpHome(t);
  const result = await runCheckpoint(
    { session_id: null, cwd: home },
    deps(home, [seg()], { resolveTranscript: () => ({ transcriptPath: stubTranscript(home), sessionId: null }) }),
  );

  assert.equal(result.unnamedSession, true, 'reported as a refusal, not as a silent empty result');
  assert.equal(result.enqueued, 0);
  assert.ok(!fs.existsSync(path.join(stateDir(), 'null.json')), 'no state/null.json for the next session to inherit');
  assert.equal(fs.existsSync(queueDir(KEY)) ? fs.readdirSync(queueDir(KEY)).length : 0, 0, 'and no queue/null_*.json either');
});

test('a reserved-word session id is refused too, not treated as a name', async (t) => {
  const home = tmpHome(t);
  // `${undefined}` interpolates to the STRING "undefined", which passes every character check and
  // reads as a perfectly valid id all the way to the server. It is rejected by name.
  const result = await runCheckpoint(
    { session_id: 'undefined', cwd: home },
    deps(home, [seg()], { resolveTranscript: () => ({ transcriptPath: stubTranscript(home), sessionId: 'undefined' }) }),
  );

  assert.equal(result.unnamedSession, true);
  assert.ok(!fs.existsSync(path.join(stateDir(), 'undefined.json')));
});

test('the resolver names the session when the hook could not', async (t) => {
  const home = tmpHome(t);
  // A hook that carries `transcript_path` but no usable `session_id`: the rollout knows its own id,
  // and resolveCodexTranscript answers with it. Adopting it is what keeps this off the null path.
  await runCheckpoint(
    { session_id: null, cwd: home },
    deps(home, [seg()], { resolveTranscript: () => ({ transcriptPath: stubTranscript(home), sessionId: 's9' }) }),
  );

  const [p] = queued();
  assert.equal(p.sessionId, 's9');
  assert.equal(p.segmentId, 's9:1-4', 'the segment id is scoped by the resolved id');
  assert.equal(readState('s9').cursor, 4, 'and the state file is named for it');
});

test('a usable hook session id outranks the resolver, which matches on cwd alone', async (t) => {
  const home = tmpHome(t);
  // findRolloutBySessionState keys on `cwd` only, so the resolver can answer with a PREVIOUS
  // session that ran in this directory. Preferring that over a good hook id would bill this
  // session's segments, state file and wire id under the older session — a cross-session
  // mis-attribution strictly worse than the bug being closed. Order matters; pin it.
  await runCheckpoint(
    { session_id: 's1', cwd: home },
    deps(home, [seg()], { resolveTranscript: () => ({ transcriptPath: stubTranscript(home), sessionId: 'an-older-session' }) }),
  );

  assert.equal(queued()[0].sessionId, 's1');
  assert.ok(fs.existsSync(path.join(stateDir(), 's1.json')));
  assert.ok(!fs.existsSync(path.join(stateDir(), 'an-older-session.json')));
});

test('the session id is recorded inside the state file, not only as its name', async (t) => {
  const home = tmpHome(t);
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg()]));

  // findRolloutBySessionState prefers the recorded id over the filename precisely so a state file
  // can never answer with whatever string it happens to be named. That read side is a no-op until
  // this write lands.
  assert.equal(readState('s1').sessionId, 's1');
  assert.equal(readState('s1').cwd, home, 'alongside the cwd mapping it already kept');
});

// ─── project-instruction observation ────────────────────────────────────────
//
// Root AGENTS instructions are a per-repo floor on what a turn costs before the user types anything.
// The established `claude_md_lines` field carries the selected source's count, while the explicit
// status distinguishes an absent file from a probe that could not make a trustworthy observation.
// The API's strict whitelist must accept that new key before this collector is released.

// A repo root the resolvers will actually hand back, so seg.repoRoot names a real directory.
const withRepo = (home, body) => {
  const root = path.join(home, 'repo');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  if (body !== null) fs.writeFileSync(path.join(root, 'AGENTS.md'), body);
  return root;
};

test('a non-empty root override is the reported instruction source', async (t) => {
  const home = tmpHome(t);
  const root = withRepo(home, 'fallback\nrules\n');
  fs.writeFileSync(path.join(root, 'AGENTS.override.md'), 'override\n');

  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg({ repoRoot: root })]));

  assert.equal(queued()[0].project_instructions_status, 'present');
  assert.equal(queued()[0].claude_md_lines, 1, 'the higher-precedence override supplies the legacy count');
});

test('a repo with standing instructions reports their size', async (t) => {
  const home = tmpHome(t);
  const root = withRepo(home, '# Rules\nalways\nnever\n');
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg({ repoRoot: root })]));
  assert.equal(queued()[0].project_instructions_status, 'present');
  assert.equal(queued()[0].claude_md_lines, 3);
});

test('CRLF and a final unterminated line preserve the measured line count', async (t) => {
  const home = tmpHome(t);
  const root = withRepo(home, '# Rules\r\nalways\r\nnever');
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg({ repoRoot: root })]));
  assert.equal(queued()[0].claude_md_lines, 3, 'wc -l semantics, not a naive split');
});

test('an empty AGENTS.md is zero lines, which is a real answer', async (t) => {
  const home = tmpHome(t);
  const root = withRepo(home, '');
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg({ repoRoot: root })]));
  assert.equal(queued()[0].project_instructions_status, 'present');
  assert.equal(queued()[0].claude_md_lines, 0);
});

test('an empty override yields to a non-empty AGENTS.md', async (t) => {
  const home = tmpHome(t);
  const root = withRepo(home, 'fallback\nrules\n');
  fs.writeFileSync(path.join(root, 'AGENTS.override.md'), '');

  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg({ repoRoot: root })]));

  assert.equal(queued()[0].project_instructions_status, 'present');
  assert.equal(queued()[0].claude_md_lines, 2);
});

test('an empty override still counts as present when AGENTS.md is absent', async (t) => {
  const home = tmpHome(t);
  const root = withRepo(home, null);
  fs.writeFileSync(path.join(root, 'AGENTS.override.md'), '');

  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg({ repoRoot: root })]));

  assert.equal(queued()[0].project_instructions_status, 'present');
  assert.equal(queued()[0].claude_md_lines, 0);
});

test('a repo with neither root instruction file reports missing without a count', async (t) => {
  const home = tmpHome(t);
  const root = withRepo(home, null);
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg({ repoRoot: root })]));
  assert.equal(queued()[0].project_instructions_status, 'missing');
  assert.equal('claude_md_lines' in queued()[0], false);
});

test('a directory that is not a repository reports unknown rather than missing', async (t) => {
  const home = tmpHome(t);
  const root = path.join(home, 'not-a-repo');
  fs.mkdirSync(root);

  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg({ repoRoot: root })]));

  assert.equal(queued()[0].project_instructions_status, 'unknown');
  assert.equal('claude_md_lines' in queued()[0], false);
});

test('nested, global, and custom instruction files do not turn a missing root probe into present', async (t) => {
  const home = tmpHome(t);
  const root = withRepo(home, null);
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'AGENTS.md'), 'nested\n');
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'AGENTS.md'), 'global\n');
  fs.writeFileSync(path.join(root, 'PROJECT.md'), 'custom\n');

  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg({ repoRoot: root })]));

  assert.equal(queued()[0].project_instructions_status, 'missing');
  assert.equal('claude_md_lines' in queued()[0], false);
});

test('an unreadable higher-precedence candidate reports unknown without falling back', async (t) => {
  const home = tmpHome(t);
  const root = withRepo(home, 'fallback\n');
  const override = path.join(root, 'AGENTS.override.md');
  const realRead = fs.readFileSync;
  fs.readFileSync = function patched(p, ...rest) {
    if (p === override) {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    }
    return realRead.call(this, p, ...rest);
  };
  t.after(() => { fs.readFileSync = realRead; });

  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg({ repoRoot: root })]));

  assert.equal(queued()[0].project_instructions_status, 'unknown');
  assert.equal('claude_md_lines' in queued()[0], false);
});

test('each repo in a multi-repo window describes its own standing instructions', async (t) => {
  const home = tmpHome(t);
  const a = withRepo(home, 'one\ntwo\n');
  const b = path.join(home, 'repo-b');
  fs.mkdirSync(b, { recursive: true });
  fs.mkdirSync(path.join(b, '.git'));
  fs.writeFileSync(path.join(b, 'AGENTS.md'), 'only\n');

  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [
    seg({ repoRoot: a, fromLine: 1, toLine: 2 }),
    seg({ repoRoot: b, fromLine: 3, toLine: 4 }),
  ]));

  const byRoot = Object.fromEntries(queued().map((p) => [p.segmentId, p.claude_md_lines]));
  assert.deepEqual(byRoot, { 's1:1-2': 2, 's1:3-4': 1 });
});

test('the root instruction candidates of one repo are probed once, not once per segment', async (t) => {
  const home = tmpHome(t);
  const root = withRepo(home, 'one\n');
  const candidates = new Set([
    path.join(root, 'AGENTS.override.md'),
    path.join(root, 'AGENTS.md'),
  ]);
  const reads = new Map();
  const realRead = fs.readFileSync;
  fs.readFileSync = function patched(p, ...rest) {
    if (candidates.has(p)) reads.set(p, (reads.get(p) || 0) + 1);
    return realRead.call(this, p, ...rest);
  };
  t.after(() => { fs.readFileSync = realRead; });

  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [
    seg({ repoRoot: root, fromLine: 1, toLine: 2 }),
    seg({ repoRoot: root, fromLine: 3, toLine: 4 }),
    seg({ repoRoot: root, fromLine: 5, toLine: 6 }),
  ]));

  assert.equal(queued().length, 3);
  assert.deepEqual([...reads.values()], [1, 1], 'each candidate is opened once per repo root');
});

test('a segment with a null repoRoot reports unknown without a count and is billed normally', async (t) => {
  const home = tmpHome(t);
  // The probe is read outside the per-segment try/catch, so no root must become an observation
  // instead of throwing and aborting the whole window with the cursor unadvanced.
  await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg({ repoRoot: null })]));

  assert.equal(queued().length, 1);
  assert.equal(queued()[0].project_instructions_status, 'unknown');
  assert.equal('claude_md_lines' in queued()[0], false, 'no repo, so no repo attribute');
  assert.equal(readState('s1').cursor, 4);
});

for (const failure of ['queue', 'state']) {
  test(`durable transaction resumes exact payloads after ${failure} failure and transcript growth`, async t => {
    const home = tmpHome(t);
    const root = withRepo(home, 'captured\n');
    const published = [];
    let writes = 0;
    const first = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [
      seg({ repoRoot: root, fromLine: 1, toLine: 2 }),
      seg({ repoRoot: root, fromLine: 3, toLine: 4 }),
    ], failure === 'state' ? { saveState: () => { throw new Error('disk full'); } } : {}), {
      skipFlush: true, sink: payload => {
        writes += 1;
        if (failure === 'queue' && writes === 2) throw new Error('disk full');
        published.push(payload);
      },
    });
    assert.equal(first.outcome, 'failed');
    assert.equal(fs.existsSync(path.join(stateDir(), 's1.json')), false);
    const tx = JSON.parse(fs.readFileSync(path.join(home, 'checkpoint-transactions', 's1.json')));
    assert.equal(tx.payloads[0].project_instructions_status, 'present');
    assert.equal(tx.payloads[0].claude_md_lines, 1);
    fs.writeFileSync(path.join(root, 'AGENTS.override.md'), 'new\ncurrent\ncontent\n');
    const resumed = [];
    const result = await runCheckpoint({ session_id: 's1', cwd: home }, deps(home, [seg({ toLine: 99 })], {
      computeDelta: () => { throw new Error('must resume before reading newer transcript data'); },
    }), { skipFlush: true, sink: payload => resumed.push(payload) });
    assert.equal(result.outcome, 'committed');
    assert.equal(result.reason, 'resumed');
    assert.deepEqual(resumed, tx.payloads);
    assert.equal(readState('s1').cursor, 4);
    const delivered = new Map([...published, ...resumed].map(payload => [payload.segmentId, payload]));
    assert.equal([...delivered.values()].reduce((sum, payload) => sum + payload.token_total, 0), 30);
  });
}
