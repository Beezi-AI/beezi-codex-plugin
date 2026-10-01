import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addAccount, linkedSessions } from '../lib/accounts.mjs';
import { setCredentials } from '../lib/credentials.mjs';
import { writeTrackingState, readTrackingState, TrackingMode } from '../lib/tracking.mjs';
import { enqueue, flushQueue, runCheckpoint, reconcileSession } from '../lib/checkpoint.mjs';
import { queueDir, beeziCodexHome } from '../lib/paths.mjs';
import { makeHome, fakeKeyring, fakeCredMan, credentialBlob, accountSession } from '../tools/account-fixtures.mjs';

// The fan-out: one piece of work, reported to every linked account, and every failure costing the
// account that had it and nobody else.
//
// The assertions here are the reason the whole sweep exists. A missed call site does not throw and
// does not log — it silently reports to one account and not the other — so each case names both
// queues and checks the one that should NOT have changed as carefully as the one that should.

const KEY_A = 'a1b2c3d4';
const KEY_B = '99887766';

const listing = (key) => (fs.existsSync(queueDir(key)) ? fs.readdirSync(queueDir(key)).sort() : []);

// The environment guard is INJECTED for the same reason test/account-session.test.mjs injects it:
// checkEnvironment() reaches the credential store with the REAL runner, so against a fake keyring
// it cannot read the entry just written, classifies the root as unverifiable, and blocks every
// account with 'environment-blocked'. That guard has its own tests; what is under test here is
// which account a payload, a bearer and a verdict belong to.
const store = (run, platform = 'darwin') => ({ run, platform, checkEnvironment: () => ({ status: 'ok' }) });

async function twoAccounts(t, deps_) {
  makeHome(t);
  const deps = deps_ || store(fakeKeyring().run);
  for (const key of [KEY_A, KEY_B]) {
    await setCredentials(key, credentialBlob({ client_id: `c-${key}` }), deps);
    await addAccount({
      key, email: `${key}@example.com`, name: key,
      tenantId: `t-${key}`, tenantName: `W-${key}`, clientId: `c-${key}`,
    });
    writeTrackingState(key, { trackingMode: TrackingMode.LIVE });
  }
  return deps;
}

test('1. one payload is enqueued into every allowed account', async (t) => {
  await twoAccounts(t);
  await enqueue([KEY_A, KEY_B], { segmentId: 'seg-1', tokens: 10 });

  assert.deepEqual(listing(KEY_A), ['seg-1.json']);
  assert.deepEqual(listing(KEY_B), ['seg-1.json']);
});

test('2. an account whose policy darkens tracking gets nothing enqueued', async (t) => {
  await twoAccounts(t);
  writeTrackingState(KEY_B, { trackingMode: TrackingMode.DISABLED });

  await enqueue([KEY_A], { segmentId: 'seg-1', tokens: 10 });

  assert.deepEqual(listing(KEY_A), ['seg-1.json']);
  assert.equal(listing(KEY_B).length, 0);
});

// A tenant that has not connected this repo answers 404 forever. It must cost that account only.
test('3. a 404 for one account leaves the other queue intact', async (t) => {
  await twoAccounts(t);
  await enqueue([KEY_A, KEY_B], { segmentId: 'seg-1', tokens: 10 });
  const fetchImpl = async (url, init) => {
    const ok = init.headers['X-Beezi-Client'] === `c-${KEY_A}`;
    return { ok, status: ok ? 200 : 404, json: async () => ({}) };
  };

  await flushQueue(KEY_A, { token: 'tk', clientId: `c-${KEY_A}` }, { fetchImpl });
  await flushQueue(KEY_B, { token: 'tk', clientId: `c-${KEY_B}` }, { fetchImpl });

  assert.deepEqual(listing(KEY_A), [], 'the 200 account drained');
  assert.deepEqual(listing(KEY_B), ['seg-1.json'], 'the 404 account kept its payload');
});

// A 403 TRACKING_DISABLED is the server darkening ONE tenant, not the machine.
test('4. a 403 darkens only the account that got it', async (t) => {
  await twoAccounts(t);
  await enqueue([KEY_A, KEY_B], { segmentId: 'seg-1', tokens: 10 });
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ code: 'TRACKING_DISABLED' }) });

  await flushQueue(KEY_B, { token: 'tk', clientId: `c-${KEY_B}` }, { fetchImpl });

  assert.equal(readTrackingState(KEY_A).trackingMode, TrackingMode.LIVE);
  assert.notEqual(readTrackingState(KEY_B).trackingMode, TrackingMode.LIVE);
});

// ── the gate itself, not a caller's idea of it ───────────────────────────────────────────────
//
// Cases 1 and 2 hand `enqueue` an allowed set that the test computed. This one makes runCheckpoint
// compute it: the delta is read once and only the accounts whose policy still permits live
// tracking receive it. That is the decision a missed call site would get wrong.

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

function rollout(dir) {
  const file = path.join(dir, 'rollout.jsonl');
  const rows = [
    { type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: SESSION_ID, cwd: dir } },
    { type: 'turn_context', timestamp: '2026-01-01T00:00:01Z', payload: { cwd: dir, model: 'gpt-5.2-codex' } },
    {
      type: 'event_msg',
      timestamp: '2026-01-01T00:00:02Z',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cached_input_tokens: 0 } },
      },
    },
  ];
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return file;
}

function checkpointDeps(dir, sessions) {
  return {
    linkedSessions: async () => sessions,
    env: {},
    gitImpl: () => null,
    resolveTranscript: () => ({ sessionId: SESSION_ID, transcriptPath: rollout(dir) }),
    readAgents: () => ({}),
    findSubagentRollouts: () => [],
  };
}

test('5. runCheckpoint itself excludes the dark account and bills the live one', async (t) => {
  const dir = await twoAccounts(t).then(() => process.env.BEEZI_CODEX_HOME);
  writeTrackingState(KEY_B, { trackingMode: TrackingMode.DISABLED });
  const sessions = [
    { key: KEY_A, clientId: `c-${KEY_A}`, token: 'tk-a' },
    { key: KEY_B, clientId: `c-${KEY_B}`, token: 'tk-b' },
  ];

  const result = await runCheckpoint(
    { session_id: SESSION_ID, cwd: dir },
    checkpointDeps(dir, sessions),
    { skipFlush: true, drainRateLimits: false },
  );

  assert.equal(result.outcome, 'committed');
  assert.equal(listing(KEY_A).length, 1, 'the live account was billed');
  assert.equal(listing(KEY_B).length, 0, 'the dark account received nothing');
});

test('6. every account dark gates the whole checkpoint, and nothing is queued anywhere', async (t) => {
  const dir = await twoAccounts(t).then(() => process.env.BEEZI_CODEX_HOME);
  for (const key of [KEY_A, KEY_B]) writeTrackingState(key, { trackingMode: TrackingMode.DISABLED });
  const sessions = [
    { key: KEY_A, clientId: `c-${KEY_A}`, token: 'tk-a' },
    { key: KEY_B, clientId: `c-${KEY_B}`, token: 'tk-b' },
  ];

  const result = await runCheckpoint(
    { session_id: SESSION_ID, cwd: dir },
    checkpointDeps(dir, sessions),
    { skipFlush: true, drainRateLimits: false },
  );

  assert.equal(result.gated, true);
  assert.equal(listing(KEY_A).length, 0);
  assert.equal(listing(KEY_B).length, 0);
});

// ── the same fan-out on the Windows keyspace ─────────────────────────────────────────────────
//
// fakeCredMan, not fakeKeyring: a generic Windows credential is identified by TargetName alone,
// and CredRead never sees UserName. An account key that reached only the UserName would pass every
// darwin case above and still have both accounts sharing one entry — which is how each account's
// queue would end up draining under whichever bearer was written last.

test('7. on Windows each account drains its own queue under its own bearer', async (t) => {
  const credman = fakeCredMan();
  const windows = store(credman.run, 'win32');
  await twoAccounts(t, windows);
  await enqueue([KEY_A, KEY_B], { segmentId: 'seg-1', tokens: 10 });

  const sessions = await linkedSessions(windows);
  assert.equal(sessions.length, 2, 'both Windows entries resolved');

  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ auth: init.headers.Authorization, client: init.headers['X-Beezi-Client'] });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  for (const session of sessions) await flushQueue(session.key, session, { fetchImpl });

  assert.deepEqual(listing(KEY_A), [], 'account A drained');
  assert.deepEqual(listing(KEY_B), [], 'account B drained');
  assert.deepEqual(
    seen.map((one) => one.client).sort(),
    [`c-${KEY_A}`, `c-${KEY_B}`].sort(),
    'each report carried its own account client id, never one shared entry twice',
  );
});

// ── reconcileSession: the boundary question is only about the accounts that REPORT ────────────
//
// It is handed the linked sessions and asks "does the server already hold everything this machine
// built for this session". A DARK account cannot answer that question and must not be asked it: it
// receives no payloads (case 2 above), so its queue is held rather than drained and `flushQueue`
// reports `trackingDisabled` unconditionally — which, read as "not drained", lets one dark
// workspace stop the live one beside it from ever being established.

const txFile = (id) => path.join(beeziCodexHome(), 'checkpoint-transactions', `${id}.json`);

test('8. a dark sibling does not defer the live account\'s reconciliation', async (t) => {
  await twoAccounts(t);
  writeTrackingState(KEY_B, { trackingMode: TrackingMode.DISABLED });

  let reported = null;
  const result = await reconcileSession(
    'sess-1',
    [accountSession(KEY_A), accountSession(KEY_B)],
    async (_handle, reporting) => { reported = reporting.map((one) => one.key); return { outcome: 'committed' }; },
    {},
  );

  assert.equal(result.outcome, 'committed', 'a dark tenant must not veto the live one');
  assert.deepEqual(reported, [KEY_A], 'and the callback is handed only the accounts that report');
});

test('9. a resumed transaction is enqueued into the live account only', async (t) => {
  await twoAccounts(t);
  writeTrackingState(KEY_B, { trackingMode: TrackingMode.DISABLED });
  fs.mkdirSync(path.dirname(txFile('sess-1')), { recursive: true });
  fs.writeFileSync(txFile('sess-1'), JSON.stringify({
    version: 1,
    sessionId: 'sess-1',
    payloads: [{ segmentId: 'seg-1', sessionId: 'sess-1', tokens: 10 }],
    children: [],
    state: { cursor: 4 },
  }));

  const result = await reconcileSession(
    'sess-1', [accountSession(KEY_A), accountSession(KEY_B)], async () => ({ outcome: 'committed' }), {},
  );

  assert.equal(result.reason, 'transaction-resumed');
  assert.deepEqual(listing(KEY_A), ['seg-1.json']);
  assert.deepEqual(listing(KEY_B), [], 'a dark account receives nothing — resumed or not');
});

// A 404 keeps the payload (case 3). It must not also freeze this session's establishment: a server
// with no report route holds no coverage for those segments to be stale against, and on an active
// machine the live account keeps writing fresh queue files, so the 14-day expiry never arrives.
test('10. a route-absent 404 keeps the payload without blocking reconciliation', async (t) => {
  await twoAccounts(t);
  await enqueue([KEY_A], { segmentId: 'seg-1', tokens: 10 });
  let ran = false;

  const result = await reconcileSession(
    'sess-1', [accountSession(KEY_A)], async () => { ran = true; return { outcome: 'committed' }; },
    { fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) },
  );

  assert.equal(ran, true, 'a missing route is not a reason to stop reconciling forever');
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(listing(KEY_A), ['seg-1.json'], 'and the payload is still kept for retry');
});

// The control: without it, case 10 would pass just as happily if the gate had been deleted.
test('11. a server error still blocks reconciliation', async (t) => {
  await twoAccounts(t);
  await enqueue([KEY_A], { segmentId: 'seg-1', tokens: 10 });
  let ran = false;

  const result = await reconcileSession(
    'sess-1', [accountSession(KEY_A)], async () => { ran = true; return { outcome: 'committed' }; },
    { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) },
  );

  assert.equal(ran, false, 'an undelivered report means coverage cannot be trusted');
  assert.equal(result.reason, 'pending-not-drained');
});
