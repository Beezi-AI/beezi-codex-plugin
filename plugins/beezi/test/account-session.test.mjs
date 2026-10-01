import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { linkedSessions, addAccount, AccountStatus, getAccount } from '../lib/accounts.mjs';
import { getAuthentication, getAccessToken } from '../lib/token.mjs';
import { machineHeaders } from '../lib/machine-identity.mjs';
import { postJson } from '../lib/http.mjs';
import { setCredentials } from '../lib/credentials.mjs';
import { accountsIndexFile } from '../lib/paths.mjs';
import { acquireLock, sharedLock, forgetHeldLocks } from '../lib/single-instance-lock.mjs';
import { DIAGNOSTIC_CODES } from '../lib/diagnostics.mjs';
import { makeHome, fakeKeyring, fakeCredMan, credentialBlob } from '../tools/account-fixtures.mjs';

const row = (key, over = {}) => ({
  key, email: `${key}@example.com`, name: key, tenantId: `t-${key}`,
  tenantName: `W-${key}`, clientId: `c-${key}`, ...over,
});

const KEY_A = 'a1b2c3d4';
const KEY_B = '99887766';

// An expired blob is what forces getAuthentication down the lock-taking refresh path; a fresh one
// answers before any lock is acquired, which is the difference tests 8 and 9 below turn on.
const expired = (over = {}) => credentialBlob({ expires_at: Date.now() - 60_000, ...over });

// The environment guard is INJECTED, as it is in test/review-auth-regressions.test.mjs, and it has
// to be. checkEnvironment() reaches the credential store through lib/env-migration.mjs with the
// REAL runner — `deps` never reaches it — so against a fake keyring it cannot read the entry it
// just wrote, classifies the root as unverifiable and blocks every account with
// 'environment-blocked'. That is the guard's own contract and it has its own tests; what is under
// test here is which account a token and a client id belong to.
const store = (run, platform = 'darwin') => ({
  run, platform, checkEnvironment: () => ({ status: 'ok' }),
});

test('1. every linked account yields a session carrying its own client id', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  const deps = store(ring.run);
  await setCredentials(KEY_A, credentialBlob({ client_id: `c-${KEY_A}` }), deps);
  await setCredentials(KEY_B, credentialBlob({ client_id: `c-${KEY_B}` }), deps);
  await addAccount(row(KEY_A));
  await addAccount(row(KEY_B));

  const sessions = await linkedSessions(deps);

  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((s) => s.clientId).sort(), [`c-${KEY_B}`, `c-${KEY_A}`].sort());
  assert.ok(sessions.every((s) => typeof s.token === 'string' && s.token.length > 0));
});

test('2. a revoked account produces no session', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  const deps = store(ring.run);
  await setCredentials(KEY_A, credentialBlob(), deps);
  await addAccount(row(KEY_A, { status: AccountStatus.REVOKED }));

  assert.deepEqual(await linkedSessions(deps), []);
});

// A transient failure must cost one account, not the hook.
test('3. an account whose token cannot be produced is dropped, not thrown', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  const deps = store(ring.run);
  await setCredentials(KEY_A, credentialBlob(), deps);
  await addAccount(row(KEY_A));
  await addAccount(row(KEY_B));            // in the index, no credentials at all

  const sessions = await linkedSessions(deps);

  assert.deepEqual(sessions.map((s) => s.key), [KEY_A]);
});

test('4. machineHeaders takes the client id explicitly', () => {
  assert.equal(machineHeaders('c-1')['X-Beezi-Client'], 'c-1');
  assert.equal(machineHeaders(null)['X-Beezi-Client'], undefined);
  assert.equal(machineHeaders('c-1')['X-Beezi-Agent'], 'codex');
});

// No argument at all is the shape every un-swept call site still has. It must not resurrect a
// module-global id — there is none any more — and it must not throw either: the header is
// bookkeeping, and a missing client id degrades to an unattributed machine rather than a dead hook.
test('4b. machineHeaders with no argument omits the header rather than inventing one', () => {
  const headers = machineHeaders();
  assert.equal(Object.prototype.hasOwnProperty.call(headers, 'X-Beezi-Client'), false);
  assert.equal(headers['X-Beezi-Agent'], 'codex');
  assert.equal(typeof headers['X-Beezi-Host'], 'string');
});

// A missed call site must fail loudly rather than post with no client header.
test('5. postJson refuses a bare token string', async () => {
  await assert.rejects(
    () => postJson('https://example.invalid/x', 'raw-token', {}, { fetchImpl: async () => ({ ok: true, status: 200 }) }),
    TypeError,
  );
});

test('6. postJson derives the bearer and client header from the session', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => { seen = init; return { ok: true, status: 200 }; };
  await postJson('https://example.invalid/x', { token: 'tk', clientId: 'c-9' }, { a: 1 }, { fetchImpl });
  assert.equal(seen.headers.Authorization, 'Bearer tk');
  assert.equal(seen.headers['X-Beezi-Client'], 'c-9');
});

// ── the Windows keyspace ────────────────────────────────────────────────────────────────────────
//
// fakeKeyring models the store as a (service, account) map, which is faithful to `security` and
// `secret-tool` and exactly the wrong keyspace for the Windows Credential Manager: a generic
// credential is identified by TargetName + Type, and CredRead/CredDelete never see UserName. That
// mismatch is what hid a real cross-account defect in Task 3, so every account-keying assertion
// gets a win32 twin.
test('7. the same fan-out keys per account on the Windows Credential Manager', async (t) => {
  makeHome(t);
  const credman = fakeCredMan();
  const deps = store(credman.run, 'win32');
  await setCredentials(KEY_A, credentialBlob({ client_id: `c-${KEY_A}`, access_token: 'at-a' }), deps);
  await setCredentials(KEY_B, credentialBlob({ client_id: `c-${KEY_B}`, access_token: 'at-b' }), deps);
  await addAccount(row(KEY_A));
  await addAccount(row(KEY_B));

  const sessions = await linkedSessions(deps);
  const byKey = new Map(sessions.map((s) => [s.key, s]));

  assert.equal(sessions.length, 2);
  // The point of the twin: one account's target must not answer the other's read.
  assert.equal(byKey.get(KEY_A).token, 'at-a');
  assert.equal(byKey.get(KEY_B).token, 'at-b');
  assert.equal(byKey.get(KEY_A).clientId, `c-${KEY_A}`);
  assert.equal(byKey.get(KEY_B).clientId, `c-${KEY_B}`);
});

// ── the lock-order trap ─────────────────────────────────────────────────────────────────────────
//
// THE TEST THE SPEC NEVER HAD. getAuthentication takes sharedLock('token-refresh-<key>') — rank 3
// — whenever a token needs renewing, and lib/single-instance-lock.mjs refuses a rank-3 lock while
// THIS process already holds another rank-3 lock under a different name. Resolve two expiring
// accounts with one Promise.all and the second acquire is refused 'lock-order'; getAuthentication
// reads every refusal as "someone else is refreshing" and answers 'refreshing', so that account is
// dropped and SILENTLY STOPS REPORTING. Nothing in the suite noticed, because every earlier test
// has at most one account whose token is stale.
test('8. two accounts expiring in the same tick both get a session', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  const refreshed = [];
  const deps = {
    ...store(ring.run),
    sleep: async () => {},
    refreshTokens: async ({ clientId }) => {
      refreshed.push(clientId);
      return { tokens: { access_token: `fresh-${clientId}`, expires_in: 3600 } };
    },
  };
  await setCredentials(KEY_A, expired({ client_id: `c-${KEY_A}` }), deps);
  await setCredentials(KEY_B, expired({ client_id: `c-${KEY_B}` }), deps);
  await addAccount(row(KEY_A));
  await addAccount(row(KEY_B));

  const sessions = await linkedSessions(deps);

  assert.equal(sessions.length, 2, 'neither account was dropped by a lock-order refusal');
  assert.deepEqual(sessions.map((s) => s.token).sort(), [`fresh-c-${KEY_A}`, `fresh-c-${KEY_B}`].sort());
  assert.deepEqual(refreshed.sort(), [`c-${KEY_A}`, `c-${KEY_B}`].sort(), 'both really refreshed');
});

// ── revoke happens after the lock is released ───────────────────────────────────────────────────
//
// The plan put updateAccount inside the refresh lock wrapped in a try/catch. Rank 3 taking rank 3
// under a different name is refused outright, so that write would have been swallowed on every
// invalid grant: the account stays 'linked', every hook retries a grant the server has already
// rejected, and /beezi:me never tells the user to sign in again. The real updateAccount and a real
// read of accounts.json are what make this test bite — an injected updateAccount would pass with
// the write still inside the lock.
test('9. an invalid grant leaves status "revoked" in accounts.json', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  const deps = { ...store(ring.run), refreshTokens: async () => ({ invalidGrant: true }) };
  await setCredentials(KEY_A, expired({ client_id: `c-${KEY_A}` }), deps);
  await addAccount(row(KEY_A));

  const auth = await getAuthentication(KEY_A, deps);

  assert.equal(auth.state, 'reauth_required');
  assert.equal(auth.reason, 'invalid-grant');

  const onDisk = JSON.parse(fs.readFileSync(accountsIndexFile(), 'utf-8'));
  const stored = onDisk.accounts.find((a) => a.key === KEY_A);
  assert.equal(stored.status, AccountStatus.REVOKED, 'the index write actually landed on disk');
  // Revoked, not removed: the row survives so a re-login as the same email re-arms this key in
  // place, keeping its linkedAt and its ledger.
  assert.equal(stored.email, `${KEY_A}@example.com`);
  assert.equal((await getAccount(KEY_A)).status, AccountStatus.REVOKED);
});

// The other half of the same contract, and the reason the flag cannot be set before deleteCreds
// resolves: a logout or a newer login that wins the race makes the delete throw
// CREDENTIALS_SUPERSEDED, and revoking then would mark THAT login dead.
test('10. a superseded delete does not revoke the login that superseded it', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  const deps = {
    ...store(ring.run),
    refreshTokens: async () => {
      // A newer login commits while the refresh is in flight, moving the revision on.
      await setCredentials(KEY_A, credentialBlob({ client_id: 'c-new', access_token: 'new-login' }),
        store(ring.run));
      return { invalidGrant: true };
    },
  };
  await setCredentials(KEY_A, expired({ client_id: `c-${KEY_A}` }), deps);
  await addAccount(row(KEY_A));

  await getAuthentication(KEY_A, deps);

  assert.equal((await getAccount(KEY_A)).status, AccountStatus.LINKED,
    'the account that just logged in is still linked');
});

// ── when the revoke write itself fails ──────────────────────────────────────────────────────────
//
// deleteCreds has ALREADY COMMITTED by the time the index write runs, so the next hook's getCreds
// returns null and getAuthentication answers unlinked/no-credentials — it never meets the invalid
// grant again. A dropped write is therefore permanent: a 'linked' row with no credentials behind
// it, skipped by linkedSessions forever and never explained by /beezi:me. Neither of the two ways
// that write can fail had a test, which is how "contention is self-healing" got written into a
// comment as if it had been reasoned.
//
// HOW THE BLOCKER WORKS. Holding sharedLock('accounts-index') in this process would also make
// getAuthentication's own rank-3 refresh lock refusable (different name, same rank), so the call
// would answer 'refreshing' and never reach the revoke at all. forgetHeldLocks() clears only this
// process's lock-ORDER bookkeeping and leaves the lock FILE in place — so the index stays blocked
// while the refresh lock is still takeable, which is exactly the situation under test.
const blockIndex = () => {
  const blocker = acquireLock(sharedLock('accounts-index'), {});
  assert.equal(blocker.ok, true, 'the test could not take the lock it means to block with');
  forgetHeldLocks();
  return blocker;
};

test('11. a contended index write is retried until the revoke lands', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  await setCredentials(KEY_A, expired({ client_id: `c-${KEY_A}` }), store(ring.run));
  await addAccount(row(KEY_A));

  const blocker = blockIndex();
  let refusedOnce = false;
  const deps = {
    ...store(ring.run),
    refreshTokens: async () => ({ invalidGrant: true }),
    // The first attempt loses; the holder goes away before the second. withLock is immediate-fail,
    // so without a retry the write is simply dropped.
    sleep: async () => { if (!refusedOnce) { refusedOnce = true; blocker.handle.release(); } },
  };

  const auth = await getAuthentication(KEY_A, deps);

  assert.equal(auth.state, 'reauth_required');
  assert.equal(refusedOnce, true, 'the first attempt really was refused');
  const stored = JSON.parse(fs.readFileSync(accountsIndexFile(), 'utf-8'))
    .accounts.find((a) => a.key === KEY_A);
  assert.equal(stored.status, AccountStatus.REVOKED, 'the retry landed the write the first attempt lost');
});

test('12. an index write that never lands still reports reauth_required, and says so', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  await setCredentials(KEY_A, expired({ client_id: `c-${KEY_A}` }), store(ring.run));
  await addAccount(row(KEY_A));

  const blocker = blockIndex();
  t.after(() => blocker.handle.release());
  const issues = [];
  const deps = {
    ...store(ring.run),
    refreshTokens: async () => ({ invalidGrant: true }),
    sleep: async () => {},
    recordIssue: (issue) => { issues.push(issue); return true; },
  };

  const auth = await getAuthentication(KEY_A, deps);

  // The verdict is the caller's answer and a failed bookkeeping write must not replace it — nor
  // turn into an exception, which would break getAccessToken's string|null contract.
  assert.equal(auth.state, 'reauth_required');
  assert.equal(auth.reason, 'invalid-grant');
  assert.deepEqual(issues.map((i) => i.code), [DIAGNOSTIC_CODES.STATE_WRITE_FAILED],
    'the unrecoverable row is reported rather than dropped in silence');
  // The honest residue: the row IS stranded. The diagnostic is what makes it findable.
  const stored = JSON.parse(fs.readFileSync(accountsIndexFile(), 'utf-8'))
    .accounts.find((a) => a.key === KEY_A);
  assert.equal(stored.status, AccountStatus.LINKED);
});

// getAccessToken projects onto string|null. A failed revoke must not make it throw.
test('13. getAccessToken still answers null when the revoke write fails', async (t) => {
  makeHome(t);
  const ring = fakeKeyring();
  await setCredentials(KEY_A, expired({ client_id: `c-${KEY_A}` }), store(ring.run));
  await addAccount(row(KEY_A));
  const blocker = blockIndex();
  t.after(() => blocker.handle.release());

  const token = await getAccessToken(KEY_A, {
    ...store(ring.run),
    refreshTokens: async () => ({ invalidGrant: true }),
    sleep: async () => {},
    recordIssue: () => true,
  });

  assert.equal(token, null);
});
