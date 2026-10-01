import { acquireLock, sharedLock } from '../lib/single-instance-lock.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAccessToken, getAuthentication } from '../lib/token.mjs';
import { tmpHome as sandboxHome } from '../tools/suite-fixtures.mjs';
import {
  DIAGNOSTIC_CODES,
  diagnosticsDir,
  diagnosticsConsentFile,
  grantConsent,
} from '../lib/diagnostics.mjs';

const tmpHome = (t) => sandboxHome(t, 'token-');

// Every credential call is keyed from 0.13 on, and so is the refresh lock: one account's renewal
// must not block another's. KEY is this file's single account.
const KEY = 'a1b2c3d4';

const FRESH = {
  client_id: 'cid', token_endpoint: 'https://x/oauth/token',
  access_token: 'at', refresh_token: 'rt', expires_at: 10_000_000,
};

test('returns null when not linked', async () => {
  assert.equal(await getAccessToken(KEY, { getCredentials: async () => null }), null);
});

test('returns the stored token while fresh, without refreshing', async () => {
  let refreshed = false;
  const token = await getAccessToken(KEY, {
    getCredentials: async () => ({ ...FRESH }),
    refreshTokens: async () => { refreshed = true; return { tokens: null }; },
    now: () => 1_000_000, // 9000s before expiry
  });
  assert.equal(token, 'at');
  assert.equal(refreshed, false);
});

test('refreshes an expiring token and persists the result', async (t) => {
  tmpHome(t);
  let saved;
  const token = await getAccessToken(KEY, {
    getCredentials: async () => ({ ...FRESH }),
    setCredentials: async (k, c) => { saved = c; return 'file'; },
    refreshTokens: async () => ({ tokens: { access_token: 'at2', refresh_token: 'rt2', expires_in: 86400 } }),
    now: () => 9_999_000, // 1s before expiry (< 60s skew)
  });
  assert.equal(token, 'at2');
  assert.equal(saved.access_token, 'at2');
  assert.equal(saved.refresh_token, 'rt2');
  assert.equal(saved.expires_at, 9_999_000 + 86_400_000);
});

test('invalid_grant wipes credentials and returns null', async (t) => {
  tmpHome(t);
  let deleted = false;
  const token = await getAccessToken(KEY, {
    getCredentials: async () => ({ ...FRESH }),
    deleteCredentials: async () => { deleted = true; },
    refreshTokens: async () => ({ invalidGrant: true }),
    now: () => 9_999_000,
  });
  assert.equal(token, null);
  assert.equal(deleted, true);
});

test('transient refresh failure yields no token rather than the stale one', async (t) => {
  tmpHome(t);
  // Handing back the token we already judged expired produces a 401 downstream, and callers
  // read a 401 as a revoked link — deleting credentials or dropping queued analytics.
  const token = await getAccessToken(KEY, {
    getCredentials: async () => ({ ...FRESH }),
    refreshTokens: async () => ({ tokens: null }),
    now: () => 9_999_000,
  });
  assert.equal(token, null);
});

test('an omitted expires_in is assumed to be one hour, not a day', async (t) => {
  tmpHome(t);
  let saved;
  await getAccessToken(KEY, {
    getCredentials: async () => ({ ...FRESH }),
    setCredentials: async (k, c) => { saved = c; return 'file'; },
    refreshTokens: async () => ({ tokens: { access_token: 'at2' } }),
    now: () => 9_999_000,
  });
  assert.equal(saved.expires_at, 9_999_000 + 3_600_000);
});

test('waits out a concurrent refresh and returns what the holder stored', async (t) => {
  const dir = tmpHome(t);
  const held = acquireLock(sharedLock(`token-refresh-${KEY}`), {});
  assert.equal(held.ok, true);
  t.after(() => held.handle.release());
  let reread = 0;
  const token = await getAccessToken(KEY, {
    getCredentials: async () => {
      reread += 1;
      // The holder finished between the two reads.
      return reread === 1 ? { ...FRESH } : { ...FRESH, access_token: 'at2', expires_at: 20_000_000 };
    },
    refreshTokens: async () => { throw new Error('must not refresh under contention'); },
    now: () => 9_999_000,
    sleep: async () => {},
  });
  assert.equal(token, 'at2');
  assert.equal(reread, 2);
});

test('a concurrent holder that never finished yields null, not the expired token', async (t) => {
  const dir = tmpHome(t);
  const held = acquireLock(sharedLock(`token-refresh-${KEY}`), {});
  assert.equal(held.ok, true);
  t.after(() => held.handle.release());
  const token = await getAccessToken(KEY, {
    getCredentials: async () => ({ ...FRESH }), // still expiring on the re-read
    refreshTokens: async () => { throw new Error('must not refresh under contention'); },
    now: () => 9_999_000,
    sleep: async () => {},
  });
  assert.equal(token, null);
});

test('forceRefresh renews even when expires_at still looks healthy', async (t) => {
  tmpHome(t);
  let refreshed = false;
  const token = await getAccessToken(KEY, {
    getCredentials: async () => ({ ...FRESH }),
    setCredentials: async () => 'file',
    refreshTokens: async () => {
      refreshed = true;
      return { tokens: { access_token: 'at2', expires_in: 3600 } };
    },
    now: () => 1_000_000, // 9000s before expiry — normally a no-op
  }, { forceRefresh: true });
  assert.equal(refreshed, true);
  assert.equal(token, 'at2');
});

test('forceRefresh under contention rejects the same token the holder still has', async (t) => {
  const dir = tmpHome(t);
  const held = acquireLock(sharedLock(`token-refresh-${KEY}`), {});
  assert.equal(held.ok, true);
  t.after(() => held.handle.release());
  // The stored token is the one that just 401'd, so "looks fresh" is not enough.
  const token = await getAccessToken(KEY, {
    getCredentials: async () => ({ ...FRESH }),
    refreshTokens: async () => { throw new Error('must not refresh under contention'); },
    now: () => 1_000_000,
    sleep: async () => {},
  }, { forceRefresh: true });
  assert.equal(token, null);
});

test('forceRefresh under contention accepts a token the holder actually replaced', async (t) => {
  const dir = tmpHome(t);
  const held = acquireLock(sharedLock(`token-refresh-${KEY}`), {});
  assert.equal(held.ok, true);
  t.after(() => held.handle.release());
  let reread = 0;
  const token = await getAccessToken(KEY, {
    getCredentials: async () => {
      reread += 1;
      return reread === 1 ? { ...FRESH } : { ...FRESH, access_token: 'at2' };
    },
    refreshTokens: async () => { throw new Error('must not refresh under contention'); },
    now: () => 1_000_000,
    sleep: async () => {},
  }, { forceRefresh: true });
  assert.equal(token, 'at2');
});

test('the refresh lock lives under this plugin\'s root, never the Claude plugin\'s ~/.beezi', async (t) => {
  const dir = tmpHome(t);
  await getAccessToken(KEY, {
    getCredentials: async () => ({ ...FRESH }),
    setCredentials: async () => 'file',
    refreshTokens: async () => ({ tokens: { access_token: 'at2', expires_in: 3600 } }),
    now: () => 9_999_000,
  });
  // The lock is created and removed inside the call; assert it was this root that got the dir.
  assert.ok(fs.existsSync(dir), 'the data root was used');
  const shared = path.join(os.homedir(), '.beezi', `token-refresh-${KEY}.lock`);
  assert.ok(!fs.existsSync(shared), 'no lock landed in the Claude Code plugin\'s data root');
});

// ── G-2-4: the diagnostic on a transient refresh failure ─────────────────────────────────────
//
// The null this branch returns is read by every caller as "not linked" — session-start prints that
// analytics are NOT being tracked, link-status answers NOT_LINKED — so without this call a network
// blip and a real logout are indistinguishable in every log there is. That is the shape of the bug
// users report as "Beezi keeps logging me out" with nothing to work from.

const transient = (deps) => getAccessToken(KEY, {
  getCredentials: async () => ({ ...FRESH }),
  refreshTokens: async () => ({ tokens: null }),
  now: () => 9_999_000,
  ...deps,
});

test('a transient refresh failure records exactly one diagnostic, and it is code-only', async (t) => {
  tmpHome(t);
  const issues = [];

  const token = await transient({ recordIssue: (issue) => { issues.push(issue); return true; } });

  assert.equal(token, null, 'the verdict the callers see is unchanged');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, DIAGNOSTIC_CODES.TOKEN_REFRESH_FAILED);
  // No source, deliberately: this branch is reached from every hook, so it must inherit whichever
  // one published itself through setCurrentSource rather than be mislabeled as the checkpoint.
  assert.equal(issues[0].source, undefined);
  // No error object either. The record has no field that could carry a message or a stack, but a
  // refresh failure's error can hold a URL with a token in it, so none is offered in the first place.
  assert.equal(issues[0].error, undefined);
});

test('a revoked grant is not a diagnostic — it is a normal, user-caused outcome', async (t) => {
  tmpHome(t);
  const issues = [];

  const token = await getAccessToken(KEY, {
    getCredentials: async () => ({ ...FRESH }),
    deleteCredentials: async () => {},
    refreshTokens: async () => ({ invalidGrant: true }),
    now: () => 9_999_000,
    recordIssue: (issue) => { issues.push(issue); return true; },
  });

  assert.equal(token, null);
  assert.deepEqual(issues, [], 'the credentials are deleted and the next session-start says so out loud');
});

test('a refresh that works records nothing', async (t) => {
  tmpHome(t);
  const issues = [];

  const token = await getAccessToken(KEY, {
    getCredentials: async () => ({ ...FRESH }),
    setCredentials: async () => 'file',
    refreshTokens: async () => ({ tokens: { access_token: 'at2', expires_in: 3600 } }),
    now: () => 9_999_000,
    recordIssue: (issue) => { issues.push(issue); return true; },
  });

  assert.equal(token, 'at2');
  assert.deepEqual(issues, []);
});

test('with the real module and no consent, the failure writes nothing at all', async (t) => {
  tmpHome(t);

  // No recordIssue stub: this is the production wiring, on a machine that has never answered the
  // consent question. Default-off is enforced inside recordIssue before anything is computed or
  // written, so there is no file to be shipped by a later "on".
  const token = await transient({});

  assert.equal(token, null, 'the refresh path behaves identically with diagnostics off');
  assert.equal(fs.existsSync(diagnosticsDir()), false, 'not even a directory is created');
  assert.equal(fs.existsSync(diagnosticsConsentFile()), false, 'and no answer is invented on the way past');
});

test('with consent, the same failure lands as one structured record', async (t) => {
  tmpHome(t);
  grantConsent();

  const token = await transient({});

  assert.equal(token, null);
  const files = fs.readdirSync(diagnosticsDir()).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const record = JSON.parse(fs.readFileSync(path.join(diagnosticsDir(), files[0]), 'utf-8'));
  assert.equal(record.code, DIAGNOSTIC_CODES.TOKEN_REFRESH_FAILED);
  assert.equal(record.count, 1);
  assert.equal(record.errorName, null, 'nothing about the failure itself is carried');
  assert.equal(record.errorCode, null);
});

// ── keying (0.13): the account the token belongs to ─────────────────────────────────────────────

// The key is validated before anything is read. accounts.json is hand-editable and the key reaches
// keyring argv and, on Windows, PowerShell script text, so a malformed one must be refused at the
// door rather than reaching a backend.
test('a malformed account key is refused before any credential is read', async () => {
  let read = false;
  await assert.rejects(
    () => getAccessToken('../etc', { getCredentials: async () => { read = true; return { ...FRESH }; } }),
    /account key/i,
  );
  assert.equal(read, false, 'the credential store was never reached');
});

// The client id travels WITH the token now; there is no module-level machine identity left to
// prime. A caller posting with this token attaches this id and no other account's.
test('getAuthentication returns the credential\'s client id alongside the token', async () => {
  const auth = await getAuthentication(KEY, {
    getCredentials: async () => ({ ...FRESH }),
    now: () => 1_000_000,
  });
  assert.equal(auth.state, 'ready');
  assert.equal(auth.accessToken, 'at');
  assert.equal(auth.clientId, 'cid');
});

// An older credentials blob may carry no client_id at all. That is a session with no machine
// header, not a failure — lib/http.mjs omits the header and the post still goes through.
test('a credentials blob with no client_id yields a null client id, not undefined', async () => {
  const { client_id, ...noClient } = FRESH;
  const auth = await getAuthentication(KEY, {
    getCredentials: async () => ({ ...noClient }),
    now: () => 1_000_000,
  });
  assert.equal(auth.state, 'ready');
  assert.strictEqual(auth.clientId, null);
});

// The refreshed blob is what the caller must post with, so the rotated client id has to come back
// from the refresh path too — not just the fresh-token fast path above.
test('a refreshed token carries the client id the refresh committed', async (t) => {
  tmpHome(t);
  const auth = await getAuthentication(KEY, {
    getCredentials: async () => ({ ...FRESH, client_id: 'cid-rotated' }),
    setCredentials: async () => 'file',
    refreshTokens: async () => ({ tokens: { access_token: 'at2', expires_in: 3600 } }),
    now: () => 9_999_000,
  });
  assert.equal(auth.accessToken, 'at2');
  assert.equal(auth.clientId, 'cid-rotated');
});

// The refresh lock is named PER ACCOUNT, so two accounts never contend for one lock file across
// processes. Asserted on the file the lock actually creates, because the name is the whole of the
// guarantee.
//
// Note what this does NOT claim. Within ONE process, holding account A's refresh lock still blocks
// account B: both are rank-3 `shared` locks under different names, and lib/single-instance-lock.mjs
// refuses that by design (LOCK_ORDER, checkLockOrder). That is not a bug to route around here — it
// is exactly why lib/accounts.mjs's linkedSessions() retries a 'refreshing' account serially
// instead of resolving every account under one Promise.all, and test 8 of
// test/account-session.test.mjs is what pins it.
test('the refresh lock is named per account, not one lock for the machine', async (t) => {
  const dir = tmpHome(t);
  let seenDuringRefresh = null;
  await getAccessToken(KEY, {
    getCredentials: async () => ({ ...FRESH }),
    setCredentials: async () => 'file',
    refreshTokens: async () => {
      seenDuringRefresh = fs.readdirSync(path.join(dir, 'locks')).filter((n) => n.endsWith('.lock'));
      return { tokens: { access_token: 'at2', expires_in: 3600 } };
    },
    now: () => 9_999_000,
  });
  assert.deepEqual(seenDuringRefresh, [`shared-token-refresh-${KEY}.lock`],
    'the account key is in the lock name, so another account takes a different file');
});

// The same-process refusal, pinned deliberately rather than left as folklore. A second account
// reaching getAuthentication while this process holds the first account's refresh lock is refused
// by lock order and reports 'refreshing' — it does NOT get a token, and it does NOT throw. Callers
// that fan out over accounts have to handle this state; linkedSessions() does, by retrying serially.
test('a second account under a held refresh lock reports refreshing, not a token', async (t) => {
  tmpHome(t);
  const held = acquireLock(sharedLock(`token-refresh-${KEY}`), {});
  assert.equal(held.ok, true);
  t.after(() => held.handle.release());

  const other = await getAuthentication('99887766', {
    getCredentials: async () => ({ ...FRESH }),
    refreshTokens: async () => { throw new Error('must not refresh while refused'); },
    now: () => 9_999_000,
    sleep: async () => {},
  });
  assert.equal(other.state, 'refreshing');
  assert.equal(other.accessToken, null);
});
