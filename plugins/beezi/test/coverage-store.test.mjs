import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  fetchCoverage,
  loadCoverageCheckpoints,
  saveCoverageCheckpoints,
  recordCoverageCheckpoint,
  checkpointLineFor,
  coverageFile,
  currentBinding,
  decideReplay,
  childSweepAllowed,
  ReplayDecision,
  DeferReason,
  MAX_COVERAGE_IDS,
} from '../lib/session-coverage.mjs';
import { stateDir, queueDir } from '../lib/paths.mjs';
import { pruneStale } from '../lib/prune.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import { linkAccount, accountSession, TEST_KEY } from '../tools/account-fixtures.mjs';

// The coverage record is PER ACCOUNT: the prefix it stores is one server's idea of what this
// machine delivered to THAT tenant, and two linked workspaces answer differently.
const KEY = TEST_KEY;
const SESSION = accountSession(KEY, 'tok');

// G-3-3 / R2. Three separate contracts live in this module and each one is a place a naive
// implementation double-bills the user:
//   1. fetchCoverage: null means "could not ask", never "the server has nothing".
//   2. the durable checkpoint store: bound to identity + environment + API, and outside the two
//      directories prune.mjs sweeps.
//   3. decideReplay: a coverage answer of 0 is AMBIGUOUS, because the server's number is a
//      contiguous prefix and stored rows can sit past a gap.

const tmpHome = (t) => {
  const dir = sandboxHome(t, 'beezi-cov-');
  linkAccount(dir, KEY);
  return dir;
};

const ok = (body) => ({ status: 200, json: async () => body });

function recordingPost(responder) {
  const calls = [];
  const impl = async (url, token, body, deps) => {
    calls.push({ url, token, body, deps });
    return responder(calls.length - 1, body);
  };
  return { impl, calls };
}

// ─── 1. fetchCoverage: unavailable is not zero ───────────────────────────────────────────────

test('coverage — a 2xx in the documented shape becomes a Map of stored prefixes', async () => {
  const post = recordingPost(() => ok({ coverage: { s1: 120, s2: 0 } }));
  const map = await fetchCoverage(['s1', 's2'], SESSION, { postJsonImpl: post.impl });
  assert.ok(map instanceof Map);
  assert.equal(map.get('s1'), 120);
  // A requested id the server reports as zero is simply absent: presence of the MAP is the
  // availability signal, and absence of an ID inside it is a confirmed zero.
  assert.equal(map.has('s2'), false);
});

test('coverage — an id absent from a valid 2xx body is a CONFIRMED ZERO, not unavailable', async () => {
  const post = recordingPost(() => ok({ coverage: {} }));
  const map = await fetchCoverage(['s1'], SESSION, { postJsonImpl: post.impl });
  assert.notEqual(map, null, 'an empty-but-present table must not read as unavailable');
  assert.equal(map.size, 0);
  // And that is what makes a from-zero replay legal for it.
  const verdict = decideReplay('s1', { coverage: map, checkpointLine: null, localCursor: 0 });
  assert.equal(verdict.decision, ReplayDecision.REPLAY);
  assert.equal(verdict.startCursor, 0);
});

test('coverage — a transport throw returns null, never an empty Map', async () => {
  const map = await fetchCoverage(['s1'], SESSION, {
    postJsonImpl: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(map, null);
});

test('coverage — a non-2xx returns null', async () => {
  const map = await fetchCoverage(['s1'], SESSION, { postJsonImpl: async () => ({ status: 500, json: async () => ({}) }) });
  assert.equal(map, null);
});

test('coverage — an unparseable body returns null', async () => {
  const map = await fetchCoverage(['s1'], SESSION, {
    postJsonImpl: async () => ({ status: 200, json: async () => { throw new SyntaxError('bad json'); } }),
  });
  assert.equal(map, null);
});

test('coverage — a 2xx without the documented coverage key returns null (older server)', async () => {
  for (const body of [{}, { ok: true }, { coverage: null }, { coverage: [] }, { coverage: 'nope' }]) {
    const map = await fetchCoverage(['s1'], SESSION, { postJsonImpl: async () => ok(body) });
    assert.equal(map, null, `body ${JSON.stringify(body)} must be unavailable`);
  }
});

test('coverage — a line count we do not understand makes the run unavailable, not zero', async () => {
  for (const value of ['12', -1, 1.5, {}, true]) {
    const map = await fetchCoverage(['s1'], SESSION, { postJsonImpl: async () => ok({ coverage: { s1: value } }) });
    assert.equal(map, null, `value ${JSON.stringify(value)} must be unavailable`);
  }
});

test('coverage — 201 ids are asked in two batches', async () => {
  const ids = Array.from({ length: MAX_COVERAGE_IDS + 1 }, (_, i) => `s${i}`);
  const post = recordingPost(() => ok({ coverage: {} }));
  const map = await fetchCoverage(ids, SESSION, { postJsonImpl: post.impl });
  assert.notEqual(map, null);
  assert.equal(post.calls.length, 2);
  assert.equal(post.calls[0].body.sessionIds.length, MAX_COVERAGE_IDS);
  assert.equal(post.calls[1].body.sessionIds.length, 1);
});

test('coverage — a failure in the SECOND batch makes the whole run unavailable', async () => {
  const ids = Array.from({ length: MAX_COVERAGE_IDS + 1 }, (_, i) => `s${i}`);
  const post = recordingPost((n) => (n === 0 ? ok({ coverage: { s0: 5 } }) : { status: 503, json: async () => ({}) }));
  const map = await fetchCoverage(ids, SESSION, { postJsonImpl: post.impl });
  assert.equal(map, null, 'availability is a run-level fact — a half-known map must never escape');
});

test('coverage — no ids asks nothing and is trivially available', async () => {
  const post = recordingPost(() => ok({ coverage: {} }));
  const map = await fetchCoverage([], SESSION, { postJsonImpl: post.impl });
  assert.equal(post.calls.length, 0);
  assert.equal(map.size, 0);
});

// ─── 2. The durable checkpoint store ─────────────────────────────────────────────────────────

test('checkpoints — survive the prune that sweeps state/ and queue/', (t) => {
  const home = tmpHome(t);
  const binding = currentBinding('machine-a');
  const record = loadCoverageCheckpoints(KEY, binding);
  recordCoverageCheckpoint(record, 's1', 900);
  assert.equal(saveCoverageCheckpoints(KEY, record), true);

  // Populate the two directories prune.mjs actually sweeps, then age everything well past the
  // 14-day window and prune. This is R2's "session cursors expire after 14 days" made concrete.
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.mkdirSync(queueDir(KEY), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), 's1.json'), JSON.stringify({ cursor: 900 }));
  fs.writeFileSync(path.join(queueDir(KEY), 's1_1-9.json'), '{}');
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(stateDir(), 's1.json'), old, old);
  fs.utimesSync(path.join(queueDir(KEY), 's1_1-9.json'), old, old);
  pruneStale();

  assert.equal(fs.existsSync(path.join(stateDir(), 's1.json')), false, 'the cursor is gone');
  assert.equal(fs.existsSync(coverageFile(KEY)), true, 'the coverage checkpoint is not');
  assert.equal(checkpointLineFor(loadCoverageCheckpoints(KEY, binding), 's1'), 900);
  // REWRITTEN for the keyed layout: the record moved from the data root into the account
  // directory. The property is unchanged — it is outside state/ and every account's queue/, the
  // only trees prune.mjs sweeps — and it is now also proof that two accounts cannot share one.
  assert.equal(path.dirname(coverageFile(KEY)), path.join(home, 'accounts', KEY));
  assert.notEqual(coverageFile(KEY), coverageFile('99887766'));
});

test('checkpoints — a different machine identity discards the record rather than trusting it', (t) => {
  tmpHome(t);
  const record = loadCoverageCheckpoints(KEY, currentBinding('machine-a'));
  recordCoverageCheckpoint(record, 's1', 900);
  saveCoverageCheckpoints(KEY, record);
  const other = loadCoverageCheckpoints(KEY, currentBinding('machine-b'));
  assert.equal(checkpointLineFor(other, 's1'), null);
  assert.equal(other.identity, 'machine-b');
});

test('checkpoints — a different environment or API base discards the record', (t) => {
  tmpHome(t);
  const binding = currentBinding('machine-a');
  const record = loadCoverageCheckpoints(KEY, binding);
  recordCoverageCheckpoint(record, 's1', 900);
  saveCoverageCheckpoints(KEY, record);
  assert.equal(checkpointLineFor(loadCoverageCheckpoints(KEY, { ...binding, environment: 'staging' }), 's1'), null);
  assert.equal(checkpointLineFor(loadCoverageCheckpoints(KEY, { ...binding, apiBase: 'https://elsewhere/api' }), 's1'), null);
  assert.equal(checkpointLineFor(loadCoverageCheckpoints(KEY, binding), 's1'), 900, 'the matching binding still reads');
});

test('checkpoints — never walk backwards', (t) => {
  tmpHome(t);
  const record = loadCoverageCheckpoints(KEY, currentBinding('m'));
  recordCoverageCheckpoint(record, 's1', 900);
  recordCoverageCheckpoint(record, 's1', 400);
  assert.equal(checkpointLineFor(record, 's1'), 900);
  recordCoverageCheckpoint(record, 's1', 1200);
  assert.equal(checkpointLineFor(record, 's1'), 1200);
});

test('checkpoints — a corrupt file reads as empty instead of throwing', (t) => {
  tmpHome(t);
  fs.writeFileSync(coverageFile(KEY), '{ not json');
  const record = loadCoverageCheckpoints(KEY, currentBinding('m'));
  assert.deepEqual(record.sessions, {});
});

// ─── 3. decideReplay ─────────────────────────────────────────────────────────────────────────

const cov = (pairs) => new Map(Object.entries(pairs));

test('decide — unavailable coverage defers, and NEVER falls back to a scan from zero', () => {
  for (const facts of [
    { coverage: null, checkpointLine: null, localCursor: 0 },
    { coverage: null, checkpointLine: 500, localCursor: 0 },
    { coverage: null, checkpointLine: null, localCursor: 700 },
  ]) {
    const verdict = decideReplay('s1', facts);
    assert.equal(verdict.decision, ReplayDecision.DEFER);
    assert.equal(verdict.reason, DeferReason.UNAVAILABLE);
    assert.equal(verdict.startCursor, null);
  }
});

test('decide — a known prefix becomes the start line, overriding a LARGER local cursor', () => {
  const verdict = decideReplay('s1', { coverage: cov({ s1: 120 }), checkpointLine: null, localCursor: 9999 });
  assert.equal(verdict.decision, ReplayDecision.REPLAY);
  assert.equal(verdict.startCursor, 120, 'the server is the authority on what actually landed');
});

test('decide — coverage 0 with nothing else known replays from zero (untrusted hooks)', () => {
  const verdict = decideReplay('s1', { coverage: cov({}), checkpointLine: null, localCursor: 0, ledgerDelivered: false });
  assert.equal(verdict.decision, ReplayDecision.REPLAY);
  assert.equal(verdict.startCursor, 0);
});

test('decide — coverage 0 against a local cursor is a GAP, not a from-zero replay', () => {
  // Hooks trusted midway: lines 200-500 are stored, the prefix from line 1 is still empty, so the
  // server answers 0 while real rows exist. Replaying from 0 would double-count them.
  const verdict = decideReplay('s1', { coverage: cov({}), checkpointLine: null, localCursor: 500 });
  assert.equal(verdict.decision, ReplayDecision.DEFER);
  assert.equal(verdict.reason, DeferReason.GAP);
});

test('decide — coverage 0 against our own delivery checkpoint is a GAP', () => {
  const verdict = decideReplay('s1', { coverage: cov({}), checkpointLine: 800, localCursor: 0 });
  assert.equal(verdict.decision, ReplayDecision.DEFER);
  assert.equal(verdict.reason, DeferReason.GAP);
});

test('decide — coverage 0 against a DELIVERED ledger entry is a GAP', () => {
  const verdict = decideReplay('s1', { coverage: cov({}), checkpointLine: null, localCursor: 0, ledgerDelivered: true });
  assert.equal(verdict.decision, ReplayDecision.DEFER);
  assert.equal(verdict.reason, DeferReason.GAP);
});

test('decide — a prefix behind our own confirmed delivery is a GAP', () => {
  const verdict = decideReplay('s1', { coverage: cov({ s1: 300 }), checkpointLine: 900, localCursor: 0 });
  assert.equal(verdict.decision, ReplayDecision.DEFER);
  assert.equal(verdict.reason, DeferReason.GAP);
});

test('decide — a prefix at or beyond our confirmed delivery replays from the prefix', () => {
  assert.equal(decideReplay('s1', { coverage: cov({ s1: 900 }), checkpointLine: 900 }).startCursor, 900);
  assert.equal(decideReplay('s1', { coverage: cov({ s1: 1200 }), checkpointLine: 900 }).startCursor, 1200);
});

test('child repair policy — children ride only a whole-session replay from zero', () => {
  assert.equal(childSweepAllowed(0), false);
  assert.equal(childSweepAllowed(1), false);
  assert.equal(childSweepAllowed(900), false);
});
